import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { UserInfo, TenantInfo, KnowledgeBaseInfo } from '@/api/auth'
import { userInfoFromApi } from '@/api/auth'
import type { TenantInfo as TenantInfoFromAPI } from '@/api/tenant'
import i18n from '@/i18n'
import { reloadFontFromStorage } from '@/composables/useFont'
import { reloadThemeFromStorage } from '@/composables/useTheme'
import { resetMigrationLatch } from '@/composables/preferenceStorage'
import { BUILTIN_QUICK_ANSWER_ID } from '@/api/agent'
import { useChatResourcesStore } from '@/stores/chatResources'
import { useEditorResourcesStore } from '@/stores/editorResources'
import { useOrganizationStore } from '@/stores/organization'
import { createSequencedRefresh } from '@/stores/sequencedRefresh'

/** 登出时丢弃 Pinia 内的空间级资源缓存，避免 SPA 重登复用上一账号数据。 */
function clearSessionResourceCaches() {
  useChatResourcesStore().invalidate()
  useEditorResourcesStore().invalidate()
  useOrganizationStore().clearState()
}

// Per-user UI preferences are namespaced by user id in localStorage.
// Reload them whenever the active user changes.
/**
 * 重载偏好设置
 */
function reloadUserPreferences() {
  // Reset the latch so migration runs once for the new active user.
  resetMigrationLatch()
  reloadFontFromStorage()
  reloadThemeFromStorage()
}

/**
 * 全局认证与空间状态 store。
 *
 * 管理的内容：
 * - 会话状态：当前用户、当前空间、token / refreshToken、知识库快照
 * - 派生状态：isLoggedIn、effectiveTenantId、currentTenantRole、hasRole
 * - 操作：登录状态写入、/auth/me 校准（refreshFromAuthMe / ensureAuthMe）、
 *   邀请接受与待处理数量轮询、登出清理
 *
 * 状态会持久化到 localStorage，页面刷新时由 initFromStorage 恢复；
 * 角色相关判断仅用于 UI 显隐，服务端仍是权限的唯一事实来源。
 *
 * 首次调用 useAuthStore() 时执行 setup，整个应用共享同一个实例。
 */
export const useAuthStore = defineStore('auth', () => {
  // 状态
  const user = ref<UserInfo | null>(null)
  const tenant = ref<TenantInfo | null>(null)
  const token = ref<string>('')
  const refreshToken = ref<string>('')
  const knowledgeBases = ref<KnowledgeBaseInfo[]>([])
  const currentKnowledgeBase = ref<KnowledgeBaseInfo | null>(null)
  const selectedTenantId = ref<number | null>(null)
  const selectedTenantName = ref<string | null>(null)
  const allTenants = ref<TenantInfoFromAPI[]>([])
  // memberships lists every tenant the user can authenticate into,
  // along with their role in each. Populated from /auth/login response.
  // v1 deployments will typically have length 1; the field is wired now
  // so PR 3 can render a tenant-switcher UI without a store migration.
  const memberships = ref<Array<{ tenant_id: number; tenant_name?: string; role: string }>>([])
  const isLiteMode = ref(false)
  // pendingInvitationCount is the number of pending tenant invitations
  // addressed to the current user. Renders as a badge next to the
  // avatar; updated by fetchPendingInvitationCount, which runs after
  // login, after tenant switch, and on a polling interval. Polling
  // (vs SSE) is fine — the count is checked rarely and a 1-2 minute
  // staleness window is acceptable for an inbox indicator.
  const pendingInvitationCount = ref<number>(0)
  // Authoritative deployment capability returned by /auth/me. Defaults to
  // false (fail-closed): we hide the "create workspace" affordance until
  // /auth/me confirms the deployment allows it, so an invitation-only
  // deployment never briefly flashes a create action the backend would
  // then reject with 403/2005.
  const canCreateTenant = ref(false)

  const autoAcceptInvitation = ref(false)

  // 计算属性
  const isLoggedIn = computed(() => {
    return !!token.value && !!user.value
  })

  const hasValidTenant = computed(() => {
    return !!tenant.value && !!tenant.value.id
  })

  const currentTenantId = computed(() => {
    return tenant.value?.id || ''
  })

  // currentTenantName resolves the active tenant's display name across the
  // app (sidebar, breadcrumbs, headers). It MUST follow the same active-
  // tenant rule as currentTenantRole / effectiveTenantId: the user's
  // selected override takes precedence over their home tenant. Reading
  // tenant.value.name alone would render the home tenant's name even after
  // the user switched, which is the bug TenantSelector already worked
  // around inline; this computed centralises that fallback ladder.
  const currentTenantName = computed(() => {
    const tid =
      selectedTenantId.value !== null && selectedTenantId.value !== undefined
        ? String(selectedTenantId.value)
        : tenant.value?.id
        ? String(tenant.value.id)
        : ''
    if (!tid) return ''
    if (selectedTenantId.value && selectedTenantName.value) {
      return selectedTenantName.value
    }
    const fromMembership = memberships.value.find((m) => String(m.tenant_id) === tid)
    if (fromMembership?.tenant_name) return fromMembership.tenant_name
    if (tenant.value && String(tenant.value.id) === tid) return tenant.value.name || ''
    return ''
  })

  const currentUserId = computed(() => {
    return user.value?.id || ''
  })

  const canAccessAllTenants = computed(() => {
    return user.value?.can_access_all_tenants || false
  })

  // isSystemAdmin reflects the platform-wide system-administrator flag
  // (User.IsSystemAdmin on the server). It is independent of per-tenant
  // Owner/Admin/Contributor/Viewer roles — a system admin can manage
  // global settings, built-in models, and other system admins regardless
  // of which tenant they're currently scoped into.
  //
  // SECURITY: same caveat as currentTenantRole — this value is hydrated
  // from localStorage on reload and is therefore tamper-prone client-side.
  // Use it ONLY to gate UI visibility (menu entries, route guards). All
  // real authorisation lives in the server-side RequireSystemAdmin
  // middleware (see internal/middleware/rbac.go). A user who flips this
  // bit in DevTools will get a 403 the moment they hit a guarded endpoint.
  const isSystemAdmin = computed(() => {
    return user.value?.is_system_admin === true
  })

  // currentTenantRole returns the user's role in the active tenant
  // (defaulting to '' when memberships have not been loaded). Used by
  // role-aware UI gating; PR 2 wires backend enforcement, PR 3 uses
  // this for menu/button visibility.
  //
  // It MUST read effectiveTenantId, not tenant.value.id. tenant.value is
  // the user's home tenant (set once on login from /auth/me's tenant
  // field); selectedTenantId is the active override applied by the
  // tenant switcher. Reading the wrong field used to leak Owner-level
  // UI to a Viewer who switched into a tenant where they were a Viewer
  // — every gate above (`hasRole(...)`) returned the home-tenant role.
  //
  // SECURITY: This value is read from localStorage (`weknora_memberships`)
  // and therefore MUST be treated as UI-rendering-only — any user can
  // tamper with localStorage and grant themselves "owner" here. All real
  // authorisation decisions live on the server (auth middleware resolves
  // the role from tenant_members on every request). Never branch
  // security-sensitive logic on this value alone.
  const currentTenantRole = computed(() => {
    const tid =
      selectedTenantId.value !== null && selectedTenantId.value !== undefined
        ? String(selectedTenantId.value)
        : tenant.value?.id
        ? String(tenant.value.id)
        : ''
    if (!tid) return ''
    const match = memberships.value.find((m) => String(m.tenant_id) === tid)
    if (match?.role) return match.role
    // Cross-tenant superuser visiting a tenant they're not a member of:
    // backend auth.go resolveTenantRole step2 grants a temporary Admin
    // role without writing tenant_members. Mirror that here so mutation
    // UIs aren't hidden in tenants the superuser switched into. Never
    // surface Owner — the backend caps the temporary grant at Admin too
    // (Owner-only ops like tenant deletion stay reserved for a real
    // Owner inside the target tenant).
    if (canAccessAllTenants.value) return 'admin'
    return ''
  })

  // hasRole answers "is the current tenant role at least <min>?", used by
  // role-aware UI gating across KB / Agent / settings views. The numeric
  // ordering (viewer < contributor < admin < owner) mirrors the server-side
  // matrix in middleware/rbac.go so a v-if here lines up with the 403 the
  // backend would return.
  //
  // SECURITY: shares the same caveat as currentTenantRole — derived from
  // localStorage, MUST be treated as UI-rendering-only. Never rely on
  // hasRole() for security decisions; the server is the source of truth.
  const ROLE_LEVEL: Record<string, number> = {
    viewer: 10,
    contributor: 20,
    admin: 30,
    owner: 40,
  }
  const hasRole = (min: 'viewer' | 'contributor' | 'admin' | 'owner'): boolean => {
    return (ROLE_LEVEL[currentTenantRole.value] ?? 0) >= ROLE_LEVEL[min]
  }

  const effectiveTenantId = computed(() => {
    // 如果选择了其他空间，使用选择的空间ID，否则使用用户默认空间ID
    return selectedTenantId.value || (tenant.value?.id ? Number(tenant.value.id) : null)
  })

  /**
   * 写入用户当前状态，并写入 localStroage 中
   * 
   * @param userData 新的用户信息
   */
  const setUser = (userData: UserInfo) => {
    const previousId = user.value?.id
    user.value = userData
    // 保存到localStorage
    localStorage.setItem('weknora_user', JSON.stringify(userData))
    // 若用户变更，则重新加载用户偏好设置
    if (previousId !== userData.id) {
      reloadUserPreferences()
    }
  }

  /**
   * 写入空间参数，并写进 localStroage 中
   * 
   * @param tenantData 当前的空间信息
   */
  const setTenant = (tenantData: TenantInfo | null) => {
    // const tenant = ref<TenantInfo | null>(null) 是一个ref响应式数据，而TenantInfo是空间参数的结构体定义
    tenant.value = tenantData
    if (tenantData) {
      // 将空间参数写进loaclStroage中
      localStorage.setItem('weknora_tenant', JSON.stringify(tenantData))
    } else {
      // 清除localStorage中的空间参数，以及调用setSelectedTenant，内存里把 selectedTenantId / selectedTenantName 重置为 null
      localStorage.removeItem('weknora_tenant')
      setSelectedTenant(null, null)
    }
  }

  /**
   * 写入访问令牌（access token）。
   *
   * 双写：Pinia 供 UI 判断登录态（isLoggedIn），localStorage 供 Axios
   * 请求拦截器读取——拦截器只认 localStorage 的 weknora_token，不读 store。
   *
   * 注意：令牌续期不经过这里。401 刷新成功后 refreshAccessTokenShared
   * 会直接覆盖 localStorage（utils/authRefresh.ts），store 里的旧值可能
   * 落后于 localStorage；不要拿 store.token 当请求凭据。
   * 
   * @param tokenValue 	每次业务请求放在 Authorization: Bearer ... 里，声明周期短（例如几十分钟），过期后接口返回 401
   */
  const setToken = (tokenValue: string) => {
    token.value = tokenValue
    localStorage.setItem('weknora_token', tokenValue)
  }

  /**
   * 写入刷新令牌（Pinia + localStorage）。
   *
   * 登录 / OIDC 回调 / auto-setup 用它写入首个令牌；之后每次刷新命中，
   * authRefresh.refreshAccessTokenShared 会用轮换后的新令牌覆盖这里。
   *
   * 注意：它不是 Bearer token，不能放进业务请求头。
   * 
   * @param refreshTokenValue 刷新令牌：只发给 /api/v1/auth/refresh 换新 access token，不参与任何业务请求。
   *                          服务端是轮换式的——每刷新一次就换发新的 refresh token，旧的立即作废，
   *                          所以并发 401 必须共用一次刷新（见 utils/authRefresh.ts），
   *                          否则后到的请求会拿已作废的令牌把会话踢下线。
   */
  const setRefreshToken = (refreshTokenValue: string) => {
    refreshToken.value = refreshTokenValue
    localStorage.setItem('weknora_refresh_token', refreshTokenValue)
  }

  /**
   * 覆盖写入当前用户可见的知识库列表，并同步到 localStorage。
   * 
   * @param kbList 知识库列表，通常来自后端接口的完整结果
   */
  const setKnowledgeBases = (kbList: KnowledgeBaseInfo[]) => {
    // 确保输入是数组
    knowledgeBases.value = Array.isArray(kbList) ? kbList : []
    localStorage.setItem('weknora_knowledge_bases', JSON.stringify(knowledgeBases.value))
  }

  /**
   * 设置或清空当前选中的知识库，并同步到 localStorage。
   *
   * 传 null 时清空内存状态并删除持久化键（登出 / 无可用知识库时使用）。
   * 不校验对象是否存在于 knowledgeBases 列表中，由调用方保证一致性。
   *
   * @param kb 选中的知识库对象；null 表示清空选择
   */
  const setCurrentKnowledgeBase = (kb: KnowledgeBaseInfo | null) => {
    currentKnowledgeBase.value = kb
    if (kb) {
      localStorage.setItem('weknora_current_kb', JSON.stringify(kb))
    } else {
      localStorage.removeItem('weknora_current_kb')
    }
  }

  // Wipe chat / KB selections that were saved under the previous tenant.
  // These keys are NOT tenant-scoped in storage; after a tenant switch they
  // would otherwise be reloaded verbatim and the chat input would post under
  // the new tenant with an Agent / model id that only existed in the old
  // tenant — backend 403s or "model not found". Called from setSelectedTenant
  // only on an actual tenant change, so logout / init paths are not touched.
  /**
   * 清除在上一个空间下保存的聊天 / 知识库选择。
   * 这些键在存储时不按空间隔离；
   * 切换空间后，它们本来会被原样重新加载，
   * 于是聊天输入会在新空间下携带只存在于旧空间的 Agent / 模型 id —— 后端会返回 403 或 "model not found"。
   * 该函数只在真正发生空间切换时由 setSelectedTenant 调用，因此登出 / 初始化流程不受影响。
   */
  const clearTenantScopedClientState = () => {
    try {
      localStorage.removeItem('weknora_last_chat_model_id')
      localStorage.removeItem('weknora_current_kb')
      const raw = localStorage.getItem('WeKnora_settings')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          parsed.selectedAgentId = BUILTIN_QUICK_ANSWER_ID
          parsed.selectedAgentSourceTenantId = null
          parsed.isAgentEnabled = false
          if (parsed.conversationModels && typeof parsed.conversationModels === 'object') {
            parsed.conversationModels.summaryModelId = ''
            parsed.conversationModels.rerankModelId = ''
            parsed.conversationModels.selectedChatModelId = ''
          }
          parsed.selectedKnowledgeBases = []
          parsed.selectedFiles = []
          parsed.selectedFileKbMap = {}
          parsed.knowledgeBaseId = ''
          localStorage.setItem('WeKnora_settings', JSON.stringify(parsed))
        }
      }
    } catch (e) {
      // localStorage may be disabled or contain malformed JSON — best effort.
      console.warn('[auth] failed to clear tenant-scoped client state', e)
    }
  }

  /**
    * 设置（或清空）当前选中的空间，并同步到 localStorage。
    *
    * 仅当空间 id 变化时才清理空间维度的客户端缓存（模型、知识库选择等），
    * 避免同一空间内重复调用时误清状态。
   * 
   * @param tenantId 目标空间 id
   * @param tenantName 目标空间名称
   */
  const setSelectedTenant = (tenantId: number | null, tenantName: string | null = null) => {
    const previousTenantId = selectedTenantId.value
    const tenantChanged = previousTenantId !== tenantId
    selectedTenantId.value = tenantId
    selectedTenantName.value = tenantName
    if (tenantId !== null) {
      localStorage.setItem('weknora_selected_tenant_id', String(tenantId))
      if (tenantName) {
        localStorage.setItem('weknora_selected_tenant_name', tenantName)
      }
    } else {
      localStorage.removeItem('weknora_selected_tenant_id')
      localStorage.removeItem('weknora_selected_tenant_name')
    }
    if (tenantChanged) {
      clearTenantScopedClientState()
    }
  }

  /**
   * 接受一个空间数组，并保存在 Pinia
   * 
   * @param tenants 目标空间数组
   */
  const setAllTenants = (tenants: TenantInfoFromAPI[]) => {
    allTenants.value = tenants
  }

  /**
   * 覆盖写入当前用户的空间成员关系，并同步到 localStorage。
   * 
   * 防御性处理：入参不是数组时（如接口异常返回 nll），按空列表处理，
   * 避免脏数据进入 store 导致后续 .find / .map 报错。
   * 
   * @param list 空间成员关系列表，每项包含 tenant_id、可选的 tenant_name 和 role
   */
  const setMemberships = (
    list: Array<{ tenant_id: number; tenant_name?: string; role: string }>
  ) => {
    memberships.value = Array.isArray(list) ? list : []
    localStorage.setItem('weknora_memberships', JSON.stringify(memberships.value))
  }

  // setPendingInvitationCount is the explicit setter used by the
  // polling composable below. Keeping the mutation behind a setter
  // matches the pattern of every other piece of auth state and lets
  // future devtools / strict-mode checks intercept the write.
  /**
   * 更新当前用户“待处理的空间邀请”数量
   * 
   * @param n 待处理邀请数量：非法值会被统一归一化为 0
   */
  const setPendingInvitationCount = (n: number) => {
    pendingInvitationCount.value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }

  /**
   * 设置用户是否被允许创建空间的权限
   * 
   * @param allowed 布尔值，true 为允许，false 为不允许
   */
  const setCanCreateTenant = (allowed: boolean) => {
    canCreateTenant.value = allowed
  }

  /**
   * 是否自动接受邀请的设置
   * 
   * @param enabled 布尔值，true 为允许，false 为不允许
   */
  const setAutoAcceptInvitation = (enabled: boolean) => {
    autoAcceptInvitation.value = enabled
  }

  // fetchPendingInvitationCount hits the dedicated /me/invitations/
  // pending-count endpoint and updates the store. Errors are
  // swallowed — the badge degrades to its last-known value instead
  // of nagging the user with a toast. The caller can choose to fire
  // and forget (login flow) or await (manual refresh button).
  /**
   * 拉取当前用户的待处理空间邀请数量，写入 store 供角标展示。
   * 失败时静默保留上次的值（best-effort），不打扰用户。
   * 动态导入 API，避免 auth store 与 axios/i18n 初始化形成循环依赖。
   */
  const fetchPendingInvitationCount = async () => {
    // Import lazily to avoid circular module ordering between auth
    // store, axios interceptor, and i18n bootstrapping. The store is
    // imported by very early modules in main.ts; a top-level api
    // import would tighten that graph unnecessarily.
    try {
      const { getMyPendingInvitationCount } = await import('@/api/tenant/invitations')
      const resp = await getMyPendingInvitationCount()
      if (resp.success && resp.data) {
        setPendingInvitationCount(resp.data.pending_count)
      }
    } catch {
      // best-effort; keep last known value
    }
  }

  // Reconcile user / home tenant / memberships with GET /api/v1/auth/me.
  // Login only populated memberships once; SPA navigations skip
  // hydrateSessionFromToken when isLoggedIn is already true — so inviting
  // flows or revokes would leave the sidebar switcher stale until reload.
  //
  // 请求排序：refreshFromAuthMe 是「刷新」，结果必须来自本次调用之后发出的请求
  // （接受邀请 / 建空间 / 改空间信息之后调用，不能吃到侧栏悬停早先发出的那次响应）；
  // ensureAuthMe 是「首屏共用」，有请求在飞行就直接复用。登出会作废飞行中的请求，
  // 迟到的响应不再把会话写回来。
  // 本次会话是否已经用 /auth/me 校准过。登录响应 / 自动初始化只写入登录时的快照，
  // 之后第一次进入平台布局仍需校准一次；此后由写操作显式 refresh。
  let authMeSynced = false

  /**
   * `/auth/me` 的顺序刷新协调器。
  *
  * 每次执行时：动态导入 getCurrentUser → 请求当前用户、空间和成员关系
  * → await 后检查 `isCurrent()`。若期间发生过登出（invalidate），
  * 结果直接丢弃，避免迟到的响应把已清空的会话写回来。
  *
   * `run` 的返回值表示本次校准是否成功：请求成功且数据有效时为 true；
   * 接口失败、或结果已过期时返回 false（不抛异常）。
   *
   * 对外通过两个入口使用：
   * - `refreshFromAuthMe()`：写操作（接受邀请 / 建空间 / 改空间信息）后调用，
   *   保证拿到的是本次调用之后发出的最新数据；
   * - `ensureAuthMe()`：首屏共享，已校准过则直接返回，否则复用飞行中的请求。
  */
  // 这里传进去一个带有 isCurrent 的函数参数，并在 createSequencedRefresh 调用之后，返回一个以 isCurrent 命名的回调函数，于是下面的 isCurrent() 就是这么来的
  const authMeRequest = createSequencedRefresh<boolean>(async (isCurrent) => {
    try {
      const { getCurrentUser } = await import('@/api/auth')
      const response = await getCurrentUser()
      if (!isCurrent()) return false
      return applyAuthMeResponse(response)
    } catch {
      return false
    }
  })

  /**
   * 强制重新拉取一次 /auth/me，
   * 并把结果写回 store（用户、当前空间、成员关系、能力开关等）。
   * 
   * @returns 返回的 Promise<boolean> 表示这次刷新是否成功应用。
   */
  const refreshFromAuthMe = (): Promise<boolean> => authMeRequest.refresh()

  /** 会话内已校准过就直接返回，否则复用飞行中的 /auth/me，没有就拉一次。 */
  const ensureAuthMe = (): Promise<boolean> => {
    if (authMeSynced) return Promise.resolve(true)
    return authMeRequest.share()
  }

  /** 
   * Awaited<ReturnType<typeof import('@/api/auth')['getCurrentUser']>> 这里一连串的操作最终返回的是
   * {
      success: boolean
      data?: {
        user: UserInfo
        tenant?: TenantInfo | null
        memberships?: MembershipInfo[]
        tenant_required?: boolean
        capabilities?: AuthCapabilities
        preference_defaults?: { browser_search_instructions: string }
      }
      message?: string
    }
    这个对象类型，也就是当前用户的信息
   * */ 
  type AuthMeResponse = Awaited<ReturnType<typeof import('@/api/auth')['getCurrentUser']>>
  /**
   * 把 /auth/me 的响应应用到 auth store。
   *
   * 写入内容：
   * - 用户信息（经 userInfoFromApi 规范化，tenant id 缺失时用响应里的兜底值）
   * - 当前空间快照；响应里没有 tenant 时调用 setTenant(null) 清空当前空间
   * - 成员关系列表（仅在返回数组时覆盖）
   * - can_create_tenant（仅在返回 boolean 时覆盖）
   * - auto_accept_invitation（严格按 === true 处理）
   *
   * 成功后标记本会话已完成 /auth/me 校准（authMeSynced = true），
   * 之后 ensureAuthMe() 会直接短路，不再重复请求。
   *
   * @param response getCurrentUser() 的完整返回结果
   * @returns 是否应用成功；success 为 false 或缺少 user 时返回 false，
   *          且不会修改任何状态
   */
  const applyAuthMeResponse = (response: AuthMeResponse): boolean => {
    const u = response.data?.user
    if (!response.success || !u) return false

    // 将当前用户空间 id 写入到 localStorage 中
    setUser(userInfoFromApi(u, response.data?.tenant?.id))

    const tenantSnapshot = response.data?.tenant
    if (tenantSnapshot) {
      setTenant({
        id: String(tenantSnapshot.id) || '',
        name: tenantSnapshot.name || '',
        owner_id: tenantSnapshot.owner_id || u.id || '',
        description: tenantSnapshot.description,
        status: tenantSnapshot.status,
        business: tenantSnapshot.business,
        storage_quota: tenantSnapshot.storage_quota,
        storage_used: tenantSnapshot.storage_used,
        created_at: tenantSnapshot.created_at || new Date().toISOString(),
        updated_at: tenantSnapshot.updated_at || new Date().toISOString(),
      })
    } else {
      setTenant(null)
    }

    const list = response.data?.memberships
    if (Array.isArray(list)) {
      setMemberships(list)
    }

    const createCapability = response.data?.capabilities?.can_create_tenant
    if (typeof createCapability === 'boolean') {
      setCanCreateTenant(createCapability)
    }

    setAutoAcceptInvitation(response.data?.capabilities?.auto_accept_invitation === true)

    authMeSynced = true
    return true
  }

  /**
   * 用邀请 token 加入空间，刷新会话后切换到新空间。
   *
   * 流程：
   * 1. 调用后端接受邀请；token 无效/过期时返回 `{ ok: false }`
   * 2. 成功后强制刷新 /auth/me，使 memberships 等状态包含刚加入的空间
   * 3. 把当前选中空间切到新空间
   *
   * 不会抛异常：网络错误与 token 失效都收敛为 `{ ok: false }`。
   * store 不负责弹提示或跳转，由调用方（App.vue / Login.vue）决定。
   * 注意第 2 步失败不会阻断第 3 步——加入本身已成功，成员列表可能短暂滞后。
   *
   * @param token 邀请 token，通常来自邀请链接或 sessionStorage 暂存
   * @returns `ok` 表示是否成功加入；成功时附带新空间的 id 与名称
   */
  const acceptInvitationByTokenAndRefresh = async (
    token: string,
  ): Promise<{ ok: boolean; tenantId?: number; tenantName?: string }> => {
    try {
      const { acceptInvitationByToken } = await import('@/api/tenant/invitations')
      const resp = await acceptInvitationByToken(token)
      if (!resp.success || !resp.data?.membership) {
        return { ok: false }
      }
      const tenantId = resp.data.membership.tenant_id
      const tenantName = resp.data.tenant_name
      // 重新获取成员关系
      await refreshFromAuthMe()
      // 同步到 localStorage 
      setSelectedTenant(tenantId, tenantName ?? null)
      return { ok: true, tenantId, tenantName }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 获取空间参数信息
   * 
   * @returns 返回空间 id
   */
  const getSelectedTenant = () => {
    return selectedTenantId.value
  }

  const setLiteMode = (value: boolean) => {
    isLiteMode.value = value
    if (value) {
      localStorage.setItem('weknora_lite_mode', 'true')
    } else {
      localStorage.removeItem('weknora_lite_mode')
    }
  }

  /**
   * 登出时用来清空所有数据
   */
  const logout = () => {
    // 清空状态
    user.value = null
    tenant.value = null
    token.value = ''
    refreshToken.value = ''
    knowledgeBases.value = []
    currentKnowledgeBase.value = null
    selectedTenantId.value = null
    selectedTenantName.value = null
    allTenants.value = []
    memberships.value = []
    pendingInvitationCount.value = 0
    canCreateTenant.value = false
    autoAcceptInvitation.value = false
    authMeSynced = false
    // 飞行中的 /auth/me 作废：登出之后才返回的响应不能再 setUser / setTenant。
    authMeRequest.invalidate()
    clearSessionResourceCaches()

    // 清空localStorage
    localStorage.removeItem('weknora_user')
    localStorage.removeItem('weknora_tenant')
    localStorage.removeItem('weknora_token')
    localStorage.removeItem('weknora_refresh_token')
    localStorage.removeItem('weknora_knowledge_bases')
    localStorage.removeItem('weknora_current_kb')
    localStorage.removeItem('weknora_selected_tenant_id')
    localStorage.removeItem('weknora_selected_tenant_name')
    localStorage.removeItem('weknora_memberships')
    localStorage.removeItem('weknora_lite_mode')
    isLiteMode.value = false
    try {
      sessionStorage.removeItem('weknora_lite_last_path')
    } catch {
      /* ignore */
    }
    reloadUserPreferences()
  }

  /**
   * 从 localStorage 恢复登录态（store 创建时调用一次）。
   *
   * 目的：页面刷新 / 新开标签页后，在 /auth/me 返回之前就有用户、
   * token、空间等状态，避免界面闪回未登录。仅恢复持久化的字段；
   * 邀请数、能力开关等由后续 /auth/me 校准填充。
   *
   * 所有 JSON 解析都做了容错：数据损坏时打日志并跳过，不阻断初始化。
   * 用户对象会经 userInfoFromApi 重新规范化，补齐旧版本缺少的字段。
   */
  const initFromStorage = () => {
    // 从localStorage恢复状态
    const storedUser = localStorage.getItem('weknora_user')
    const storedTenant = localStorage.getItem('weknora_tenant')
    const storedToken = localStorage.getItem('weknora_token')
    const storedRefreshToken = localStorage.getItem('weknora_refresh_token')
    const storedKnowledgeBases = localStorage.getItem('weknora_knowledge_bases')
    const storedCurrentKb = localStorage.getItem('weknora_current_kb')
    const storedSelectedTenantId = localStorage.getItem('weknora_selected_tenant_id')
    const storedSelectedTenantName = localStorage.getItem('weknora_selected_tenant_name')

    if (storedUser) {
      try {
        // 走 userInfoFromApi 把老 localStorage（可能缺新字段，如
        // is_system_admin）规范化一遍，避免「我新加了字段、但老登录态
        // 没经过登录响应处理过、字段就永远是 undefined」的死角。
        // 这是「漏拷 4 处」之外的第 5 个隐藏入口，专门给页面刷新走的。
        user.value = userInfoFromApi(JSON.parse(storedUser))
      } catch (e) {
        console.error(i18n.global.t('authStore.errors.parseUserFailed'), e)
      }
    }

    if (storedTenant) {
      try {
        tenant.value = JSON.parse(storedTenant)
      } catch (e) {
        console.error(i18n.global.t('authStore.errors.parseTenantFailed'), e)
      }
    }

    if (storedToken) {
      token.value = storedToken
    }

    if (storedRefreshToken) {
      refreshToken.value = storedRefreshToken
    }

    if (storedKnowledgeBases) {
      try {
        const parsed = JSON.parse(storedKnowledgeBases)
        knowledgeBases.value = Array.isArray(parsed) ? parsed : []
      } catch (e) {
        console.error(i18n.global.t('authStore.errors.parseKnowledgeBasesFailed'), e)
        knowledgeBases.value = []
      }
    }

    if (storedCurrentKb) {
      try {
        currentKnowledgeBase.value = JSON.parse(storedCurrentKb)
      } catch (e) {
        console.error(i18n.global.t('authStore.errors.parseCurrentKnowledgeBaseFailed'), e)
      }
    }

    if (storedSelectedTenantId) {
      try {
        selectedTenantId.value = Number(storedSelectedTenantId)
        if (storedSelectedTenantName) {
          selectedTenantName.value = storedSelectedTenantName
        }
      } catch (e) {
        console.error('Failed to parse selected tenant ID', e)
        selectedTenantId.value = null
        selectedTenantName.value = null
      }
    }

    const storedMemberships = localStorage.getItem('weknora_memberships')
    if (storedMemberships) {
      try {
        const parsed = JSON.parse(storedMemberships)
        memberships.value = Array.isArray(parsed) ? parsed : []
      } catch (e) {
        console.error('Failed to parse memberships', e)
        memberships.value = []
      }
    }

    isLiteMode.value = localStorage.getItem('weknora_lite_mode') === 'true'
  }

  // 初始化时从localStorage恢复状态
  initFromStorage()

  return {
    // 状态
    user,
    tenant,
    token,
    refreshToken,
    knowledgeBases,
    currentKnowledgeBase,
    selectedTenantId,
    selectedTenantName,
    allTenants,
    memberships,
    pendingInvitationCount,
    canCreateTenant,
    autoAcceptInvitation,

    // 计算属性
    isLoggedIn,
    hasValidTenant,
    currentTenantId,
    currentTenantName,
    currentUserId,
    canAccessAllTenants,
    isSystemAdmin,
    currentTenantRole,
    hasRole,
    effectiveTenantId,
    isLiteMode,

    // 方法
    setUser,
    setTenant,
    setToken,
    setRefreshToken,
    setKnowledgeBases,
    setCurrentKnowledgeBase,
    setSelectedTenant,
    setAllTenants,
    setMemberships,
    setPendingInvitationCount,
    setCanCreateTenant,
    setAutoAcceptInvitation,
    fetchPendingInvitationCount,
    refreshFromAuthMe,
    ensureAuthMe,
    acceptInvitationByTokenAndRefresh,
    getSelectedTenant,
    setLiteMode,
    logout,
    initFromStorage
  }
})
