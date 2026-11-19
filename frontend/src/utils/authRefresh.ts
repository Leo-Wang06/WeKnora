/**
 * Shared access-token refresh used by both axios and the chat SSE client.
 *
 * Refresh tokens rotate, so concurrent 401s must queue behind one in-flight
 * /auth/refresh. The SSE handshake runs on raw fetch and cannot use the
 * axios interceptor; both planes call {@link refreshAccessTokenShared}.
 */

const AUTH_STORAGE_KEYS = [
  'weknora_token',
  'weknora_refresh_token',
  'weknora_user',
  'weknora_tenant',
  'weknora_knowledge_bases',
  'weknora_current_kb',
  'weknora_selected_tenant_id',
  'weknora_selected_tenant_name',
  'weknora_memberships',
] as const

let isRefreshing = false
let failedQueue: Array<{
  resolve: (token: string) => void
  reject: (error: unknown) => void
}> = []

export type TokenRefreshResult = {
  success: boolean
  data?: { token: string; refreshToken: string }
  message?: string
}

export type RefreshAccessTokenOptions = {
  refresh?: (refreshToken: string) => Promise<TokenRefreshResult>
  messages?: {
    pleaseRelogin: string
    tokenRefreshFailed: string
  }
}

const defaultMessages = {
  pleaseRelogin: 'Please log in again',
  tokenRefreshFailed: 'Token refresh failed',
}

/**
 * 流式请求的“认证失败”错误标记（目前用于 SSE 握手的 401）。
 *
 * 用专门的类而不是普通 Error，是为了让错误跨越多层
 * （onopen → fetchEventSource → 重试逻辑）后仍能被准确识别：
 * 只有它可以触发“刷新 token 并重放一次”，其他错误不能误触发刷新，
 * 也不能在包装过程中丢失类型。
 */
export class StreamAuthError extends Error {
  /**
   * @param status HTTP 状态码（通常是 401）；保留下来用于日志和判断。
   *               `readonly` 是 TS 参数属性语法，等价于声明字段并赋值。
   */
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    // 固定 name：当 instanceof 因跨 realm/转译而失效时，isStreamAuthError 仍可按名称兜底识别。
    this.name = 'StreamAuthError'
  }
}

/**
 * 判断错误是否为可恢复的流式认证失败（StreamAuthError）。
 *
 * 采用“原型优先、名称兜底”的双重判断：
 * - instanceof 在同一运行时内最准确，但跨 realm、模块重复加载或错误被
 *   序列化重建时可能失效；
 * - name 兜底保证错误经过多层包装后仍能被识别，避免把 token 过期
 *   误判成普通失败、直接要求用户重新登录。
 */
export function isStreamAuthError(err: unknown): boolean {
  // catch 捕获的错误在严格 TS 下是 unknown，先排除 null/undefined 和原始值。
  if (!err || typeof err !== 'object') return false
  // 主判断：同一运行时内沿原型链确认类型。
  if (err instanceof StreamAuthError) return true
  // 兜底：原型链断裂时按固定的 name 识别。
  return (err as { name?: string }).name === 'StreamAuthError'
}

/**
 * 判断是否为嵌入页 `/embed/...`
 * 
 * @returns 返回布尔值，true 就是是嵌入页，false 就不是嵌入页
 */
export function isEmbedPage(): boolean {
  if (typeof window === 'undefined') return false
  // window.location.pathname 当前页面的路径部分，不含域名、查询参数、hash
  return window.location.pathname.startsWith('/embed/')
}

/**
 * 将用户打回登录页
 */
export function redirectToLogin() {
  // 非浏览器环境
  if (typeof window === 'undefined') return
  // 已经在登录页了
  if (window.location.pathname === '/login') return
  // 嵌入页
  if (isEmbedPage()) return
  window.location.href = '/login'
}

/**
 * 清除所有 localStorage 内的 token 信息
 */
export function clearAuthStorage() {
  for (const key of AUTH_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Storage may be unavailable. Still attempt the remaining keys and
      // allow callers to reject waiting requests and redirect to login.
    }
  }
}

export function forceReloginRedirect() {
  clearAuthStorage()
  redirectToLogin()
}

/**
 * 结算所有排队等待 token 刷新的请求。
 *
 * 第一个遇到 401 的请求负责刷新，期间其余 401 会把 Promise 的
 * resolve/reject 压入 failedQueue（见 refreshAccessTokenShared）。
 * 本函数在刷新结束时统一分发结果并清空队列：
 * - 成功（error 为 null）：所有等待者 resolve 同一个新 token，
 *   各自重放原请求；
 * - 失败：所有等待者 reject 同一个错误，随后由调用方清理登录态并跳转。
 *
 * @param error 刷新失败的错误对象；传 null 表示刷新成功
 * @param token 刷新成功后的新 access token；失败时传 null
 */
function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error)
    } else {
      resolve(token as string)
    }
  })
  failedQueue = []
}

async function defaultRefresh(refreshToken: string): Promise<TokenRefreshResult> {
  const { refreshToken: refreshTokenAPI } = await import('../api/auth/index')
  return refreshTokenAPI(refreshToken)
}

/**
 * Refresh the access token, de-duplicated across all callers.
 *
 * Resolves with the new access token. On failure it attempts to clear
 * credentials and redirects to /login, even when browser storage is blocked.
 */
export async function refreshAccessTokenShared(
  options: RefreshAccessTokenOptions = {},
): Promise<string> {
  const messages = { ...defaultMessages, ...options.messages }
  // 这里最终拿到的是刷新 refreshToekn 的方法，用来重新获取 token
  const refresh = options.refresh ?? defaultRefresh

  // 刷新 token 的"排队去重"机制：已经有刷新在进行了时，后来的调用者不自己再发请求，而是挂起等待同一个结果。
  if (isRefreshing) {
    return new Promise<string>((resolve, reject) => {
      // 这里 failedQueue 是一个数组，用来接受所有排队请求的 Promise 对象
      failedQueue.push({ resolve, reject })
    })
  }

  isRefreshing = true
  try {
    // 获取长期 refresh token
    const storedRefreshToken = localStorage.getItem('weknora_refresh_token')
    // 没有就走重新登录
    if (!storedRefreshToken) {
      throw new Error(messages.pleaseRelogin)
    }
    // 尝试重新获取 token
    const response = await refresh(storedRefreshToken)

    if (!response.success || !response.data?.token) {
      throw new Error(response.message || messages.tokenRefreshFailed)
    }

    // 获取新的短期 token，以及新的长期 refresh token
    const { token, refreshToken: newRefreshToken } = response.data
    localStorage.setItem('weknora_token', token)
    // 重新保存长期 refresh token 到 localStorage
    if (newRefreshToken) {
      localStorage.setItem('weknora_refresh_token', newRefreshToken)
    }
    processQueue(null, token)
    return token
  } catch (refreshError) {
    clearAuthStorage()
    processQueue(refreshError, null)
    redirectToLogin()
    throw refreshError
  } finally {
    isRefreshing = false
  }
}

/**
 * 在收到 401 后，重放一次 SSE 握手。
 *
 * 刷新失败时已经跳转过登录页；刷新成功后的第二次 401 会直接抛给调用方，
 * 不会清掉刚签发的新会话（axios 的处理方式相同）。
 *
 * 如果这次重放已被更新的发送或用户中止取代，则返回 undefined。
 */
export async function runStreamWithAuthRetry<T>(options: {
  run: (token: string) => Promise<T>
  initialToken: string
  isEmbed: boolean
  isCurrent: () => boolean
  refreshAccessToken: () => Promise<string>
  reloginMessage: string
}): Promise<T | undefined> {
  try {
    return await options.run(options.initialToken)
  } catch (err) {
    if (!isStreamAuthError(err) || options.isEmbed) throw err

    let refreshedToken: string
    try {
      refreshedToken = await options.refreshAccessToken()
    } catch {
      throw new Error(options.reloginMessage)
    }

    if (!options.isCurrent()) return undefined

    // 这里的“再试一次”是用刷新后的新 token 重放原请求，
    // 因为第一次请求失败的原因就是 token 过期。
    try {
      return await options.run(refreshedToken)
    } catch (retryErr) {
      if (isStreamAuthError(retryErr)) {
        throw new Error(options.reloginMessage)
      }
      throw retryErr
    }
  }
}

/** Reset module locks between unit tests. */
export function resetAuthRefreshStateForTests() {
  isRefreshing = false
  failedQueue = []
}
