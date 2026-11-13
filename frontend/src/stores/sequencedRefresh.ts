/**
 * 「刷新」语义的请求排序器（/auth/me 这类单例读取用）。
 *
 * - `refresh()`：结果必须来自本次调用之后发出的请求。已有请求在飞行时，
 *   排一个新请求在它之后，多次并发的 refresh 共用同一个排队请求。
 * - `share()`：只要有请求在飞行就直接复用，否则发一个新的。首屏多个消费者
 *   同时要同一份数据时用它。
 * - `invalidate()`：让飞行中的请求作废。`run` 拿到的 `isCurrent()` 在 await 之后
 *   返回 false，调用方据此跳过落库；登出时用，避免迟到的响应把会话写回来。
 */
export interface SequencedRefresh<T> {
  refresh: () => Promise<T>
  share: () => Promise<T>
  invalidate: () => void
  hasInFlightRequest: () => boolean
}

/**
 * 创建一个「顺序刷新」协调器，用于 /auth/me 这类单例读取。
 *
 * 它保证同一时刻最多只有一个请求在飞行，并把并发调用按语义合并：
 * - `refresh()`：要求结果来自本次调用之后发出的请求。若已有请求在飞，
 *   会等它结束后补发一个；并发的多次 refresh 共享同一个尾随请求。
 * - `share()`：有请求在飞就直接复用，否则新发。适合首屏多个消费者
 *   同时读取同一份数据的场景。
 * - `invalidate()`：让已经发出的请求作废（`run` 里的 `isCurrent()` 返回
 *   false），调用方据此跳过落库。登出时使用，防止迟到的响应把会话写回来。
 *   注意它只作废结果，不取消 HTTP 请求。
 * - `hasInFlightRequest()`：纯查询当前是否有请求在飞。
 *
 * @typeParam T 请求结果的类型
 * @param run 真正的请求函数。它会在每次请求时被调用，并收到一个
 *            `isCurrent` 回调：应在 `await` 结束后调用它，返回 false
 *            表示结果已过期，不应再写入任何状态。该函数可能被多次执行，
 *            需要保证可重复调用。
 * @returns 包含 refresh / share / invalidate / hasInFlightRequest 的协调器
 */
export function createSequencedRefresh<T>(
  // run是函数参数，其中这个函数需要接受一个返回值为 boolean 的函数参数 isCurrent 
  run: (isCurrent: () => boolean) => Promise<T>,
): SequencedRefresh<T> {
  // revision —— 请求代次（版本号）
  // 用来实现 invalidate()：判断一个请求的结果是否已经过时。
  let revision = 0
  // inflight —— 当前正在飞行的请求
  // 保存"此刻正在执行的那个请求的 Promise"，没有就是 null。
  let inflight: Promise<T> | null = null
  // queued —— 排在飞行请求后面的"尾随请求"
  // 当 inflight 已存在、又有人调 refresh() 时，不能直接复用当前请求（那个请求是在本次调用之前发出的，结果可能不含最新数据）。
  let queued: Promise<T> | null = null

  /**
   * 发起一次新的请求，
   * 并顺带维护 revision / inflight 这两个状态。
   * 
   * @returns 
  */
  // 下面执行 run 函数时，就是在发起新的请求。
  const start = (): Promise<T> => {
    // 快照当前版本号。之后 invalidate() 把 revision 加一，这个快照就和最新值对不上了。
    const requestRevision = revision
    // 返回一个 current 回调函数，用来判断本次请求是否是最新一代，并返回一个 isCurrent 的回调函数
    const current = run(() => requestRevision === revision).finally(() => {
      if (inflight === current) inflight = null
    })
    inflight = current
    return current
  }

  /**
   * 重新发送请求，
   * 先判断是否有正在飞行的请求，
   * 如果有就尾随发送一个请求，
   * 不会重复发送尾随请求。
   * 
   * @returns Promise 对象
   */
  const refresh = (): Promise<T> => {
    // 没有飞行中的请求 -> 直接发一个
    if (!inflight) return start()
    // 如果没有尾随请求，就新建一个
    if (!queued) {
      // 先等正在飞行的请求，请求完毕
      const waitingFor = inflight
      queued = waitingFor.then(
        // 前一个请求成功之后，调用 start() 发送尾随请求
        () => {
          queued = null
          return start()
        },
        // 前一个请求失败，也要接着发
        () => {
          queued = null
          return start()
        },
      )
    }
    // 已经有请求在排队了，复用同一个排队请求，不再新增新的尾随请求
    return queued
  }

  return {
    refresh,
    share: () => inflight ?? start(),
    /**
     * 给 revision 加一，
     * 让已经发出的请求失效，
     * 具体体现在 if (!isCurrent()) return false
     */
    invalidate: () => {
      revision += 1
    },
    /**
     * 查询是否有正在飞行的请求
     * 
     * @returns 布尔值，true 为有，false 为没有
     */
    hasInFlightRequest: () => inflight !== null,
  }
}
