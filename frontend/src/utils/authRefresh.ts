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

export class StreamAuthError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'StreamAuthError'
  }
}

export function isStreamAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if (err instanceof StreamAuthError) return true
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
 * Replay an SSE handshake once after a 401. Refresh failure already
 * redirected; a second 401 after a successful refresh is surfaced to the
 * caller without wiping the newly minted session (axios does the same).
 *
 * Returns undefined when a newer send or an abort superseded the replay.
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
