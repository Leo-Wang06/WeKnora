<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { MessagePlugin, NotifyPlugin } from 'tdesign-vue-next'
import ProtectedResourcePreview from '@/components/ProtectedResourcePreview.vue'
import ManualKnowledgeEditor from '@/components/manual-knowledge-editor.vue'
import UploadConfirmHost from '@/components/UploadConfirmHost.vue'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { getCurrentUser, userInfoFromApi } from '@/api/auth'
import { consumePendingTenantSwitchToast } from '@/utils/tenantSwitch'
import { useRoleLabel } from '@/composables/useRoleLabel'
import { notifyLoginSuccess } from '@/utils/loginNotify'
import { renderWorkspaceNotifyContent } from '@/utils/workspaceNotifyContent'

// TDesign locale configs
import enUSConfig from 'tdesign-vue-next/esm/locale/en_US'
import zhCNConfig from 'tdesign-vue-next/esm/locale/zh_CN'
import koKRConfig from 'tdesign-vue-next/esm/locale/ko_KR'
import jaJPConfig from 'tdesign-vue-next/esm/locale/ja_JP'
import ruRUConfig from 'tdesign-vue-next/esm/locale/ru_RU'
import zhTWConfig from 'tdesign-vue-next/esm/locale/zh_TW'

const { locale, t, tm } = useI18n()
const { formatRole, roleIcon } = useRoleLabel()
const router = useRouter()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()

const tdLocaleMap: Record<string, object> = {
  'en-US': enUSConfig,
  'zh-CN': zhCNConfig,
  'zh-TW': zhTWConfig,
  'ko-KR': koKRConfig,
  'ja-JP': jaJPConfig,
  'ru-RU': ruRUConfig,
}

const tdGlobalConfig = computed(() => tdLocaleMap[locale.value] || enUSConfig)

// 把 URL 里的 Base64URL 还原成登录结果对象
const decodeOIDCResult = (encoded: string) => {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = window.atob(padded)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

// 把带 token 的地址从地址栏和历史记录里抹掉
const clearOIDCCallbackState = (path = '/') => {
  window.history.replaceState({}, document.title, path)
}
// 从后端获取 OIDC 登录后的信息，之后填到前端信息中
const syncOIDCUserContext = async () => {
  // 获取目前的用户信息
  const currentUserResponse = await getCurrentUser()
  if (!currentUserResponse.success || !currentUserResponse.data?.user) {
    throw new Error(currentUserResponse.message || 'Failed to get user information')
  }

  const { user, tenant, memberships, capabilities } = currentUserResponse.data
  // 把用户名、ID、系统管理员标记写进 store，并保存到 localStorage。
  authStore.setUser(userInfoFromApi(user, tenant?.id))
  // 填「我在哪个空间、空间长什么样」，侧栏顶部显示「研发空间」、存储用量条、空间设置页，全靠这个。
  if (tenant) {
    authStore.setTenant({
      id: String(tenant.id) || '',
      name: tenant.name || '',
      owner_id: tenant.owner_id || user.id || '',
      description: tenant.description,
      status: tenant.status,
      business: tenant.business,
      storage_quota: tenant.storage_quota,
      storage_used: tenant.storage_used,
      created_at: tenant.created_at || new Date().toISOString(),
      updated_at: tenant.updated_at || new Date().toISOString()
    })
  } else {
    authStore.setTenant(null)
  }
  // 填「我的角色和权限」,内部存储的是用户在所属空间内的身份，是 Admin 还是 Viewer。
  if (Array.isArray(memberships)) {
    authStore.setMemberships(memberships)
  }
  if (typeof capabilities?.can_create_tenant === 'boolean') {
    authStore.setCanCreateTenant(capabilities.can_create_tenant)
  }
  // 判断在哪个空间，并放置进去
  const activeIdNum = tenant?.id != null ? Number(tenant.id) : NaN
  const homeIdNum = user.tenant_id != null ? Number(user.tenant_id) : NaN
  if (Number.isFinite(activeIdNum) && Number.isFinite(homeIdNum) && activeIdNum !== homeIdNum) {
    authStore.setSelectedTenant(activeIdNum, tenant?.name || null)
  } else {
    authStore.setSelectedTenant(null, null)
  }
}

const persistOIDCLoginResponse = async (response: any) => {
  // 判断是否有 token
  if (!response.token) {
    throw new Error(response.message || 'OIDC login failed')
  }

  // 把 token 存到 Pinia + loaclStorage 中，refresh_token 是可选的，所以加 if。有了它，access token 过期时才能静默续期。
  authStore.setToken(response.token)
  if (response.refresh_token) {
    authStore.setRefreshToken(response.refresh_token)
  }

  // 这里就是调用上面的 syncOIDCUserContext，拿着 token 去询问后端用户的信息 
  await syncOIDCUserContext()

  // OIDC 跳转前暂存的邀请 token：拿到会话后兑换并进入对应空间。
  const pendingInviteToken = sessionStorage.getItem('weknora_pending_invite_token')
  if (pendingInviteToken) {
    sessionStorage.removeItem('weknora_pending_invite_token')
    const result = await authStore.acceptInvitationByTokenAndRefresh(pendingInviteToken)
    await nextTick()
    if (result.ok) MessagePlugin.success(t('inviteRegister.joined'))
    else MessagePlugin.warning(t('inviteRegister.invalidBody'))
    // 会话已有效，无论 token 是否兑换成功都进入应用。
    router.replace('/platform/knowledge-bases')
    return
  }

  // 普通跳转
  await nextTick()
  router.replace(authStore.hasValidTenant ? '/platform/knowledge-bases' : '/onboarding/workspace')
}

const handleGlobalOIDCCallback = async () => {
  // 取 hash，看是否有，如果没有就是普通访问，直接 return
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  if (!hash) return

  // 解析参数，解析 hash 中的参数
  const params = new URLSearchParams(hash)
  const oidcError = params.get('oidc_error')
  const oidcErrorDescription = params.get('oidc_error_description')
  const oidcResult = params.get('oidc_result')

  // 不是回调就退出（最常见的路径）
  if (!oidcError && !oidcResult) return

  // 错误分支
  if (oidcError) {
    clearOIDCCallbackState('/login')
    await router.replace('/login')
    MessagePlugin.error(oidcErrorDescription || 'OIDC login failed')
    return
  }

  try {
    if (!oidcResult) {
      clearOIDCCallbackState('/login')
      await router.replace('/login')
      MessagePlugin.error('OIDC login failed')
      return
    }

    // 成功分支
    const response = decodeOIDCResult(oidcResult)
    if (response.success) {
      clearOIDCCallbackState('/')
      await persistOIDCLoginResponse(response)
      notifyLoginSuccess(response, t, tm, formatRole, roleIcon)
      return
    }

    // 业务失败分支
    clearOIDCCallbackState('/login')
    await router.replace('/login')
    MessagePlugin.error(response.message || 'OIDC login failed')
  } catch (error: any) {
    console.error('Global OIDC callback handling failed:', error)
    authStore.logout()
    clearOIDCCallbackState('/login')
    await router.replace('/login')
    MessagePlugin.error(error.message || 'OIDC login failed')
  }
}

let updateCheckTimer: ReturnType<typeof setInterval> | null = null

// Pending invitations poll: fires once on mount (logged-in case) and
// then every 2 minutes. Light enough to keep the avatar-row badge
// near-live without slamming the API, and avoids the cost of a
// dedicated SSE/WebSocket connection. Stopped on logout via the
// computed below.
let invitationPollTimer: ReturnType<typeof setInterval> | null = null
const INVITATION_POLL_INTERVAL_MS = 2 * 60 * 1000

const startInvitationPolling = () => {
  if (invitationPollTimer || !authStore.isLoggedIn) return
  // Immediate fetch so the badge is correct before the first tick.
  authStore.fetchPendingInvitationCount()
  invitationPollTimer = setInterval(() => {
    if (!authStore.isLoggedIn) return
    authStore.fetchPendingInvitationCount()
  }, INVITATION_POLL_INTERVAL_MS)
}

const stopInvitationPolling = () => {
  if (invitationPollTimer) {
    clearInterval(invitationPollTimer)
    invitationPollTimer = null
  }
}

// React to login/logout via the store's isLoggedIn computed. Watching
// here (rather than only on first mount) handles the OIDC callback
// flow where the user logs in well after App.vue has already mounted.
watch(
  () => authStore.isLoggedIn,
  (logged) => {
    if (logged) startInvitationPolling()
    else stopInvitationPolling()
  },
  { immediate: true },
)

// 切换空间后会 hard reload；切换前 stash 的 toast 这里 consume 并弹出，
// 这样 toast 显示在新页面上，duration 才真正生效。
const showPendingTenantSwitchToast = () => {
  const pending = consumePendingTenantSwitchToast()
  if (!pending) return
  const templateKey = pending.role
    ? 'tenant.switchSuccessContentWithRole'
    : 'tenant.switchSuccessContent'
  // Use tm() not t() — vue-i18n v11's `t()` replaces unspecified named
  // placeholders with empty strings, which would strip {name}/{role}
  // before the chip renderer can split on them. tm() returns the raw
  // message verbatim.
  const rawTemplate = tm(templateKey)
  const template = typeof rawTemplate === 'string' ? rawTemplate : ''
  NotifyPlugin.success({
    title: t('tenant.switchSuccessTitle'),
    content: renderWorkspaceNotifyContent({
      template,
      name: pending.name,
      roleLabel: pending.role,
      roleEnum: pending.roleEnum,
      roleIconName: pending.roleEnum ? roleIcon(pending.roleEnum) : undefined,
    }),
    duration: 6000,
    closeBtn: true,
  })
}

onMounted(() => {
  handleGlobalOIDCCallback()
  showPendingTenantSwitchToast()

  // Auto check for updates on startup
  setTimeout(() => {
    if (settingsStore.isAutoCheckUpdateEnabled) {
      // @ts-ignore
      if (window.go && window.go.main && window.go.main.App && window.go.main.App.AutoCheckForUpdates) {
        // @ts-ignore
        window.go.main.App.AutoCheckForUpdates()
      }
    }
  }, 2000)

  // Periodically check for updates (every 4 hours)
  updateCheckTimer = setInterval(() => {
    if (settingsStore.isAutoCheckUpdateEnabled) {
      // @ts-ignore
      if (window.go && window.go.main && window.go.main.App && window.go.main.App.AutoCheckForUpdates) {
        // @ts-ignore
        window.go.main.App.AutoCheckForUpdates()
      }
    }
  }, 4 * 60 * 60 * 1000)
})

onUnmounted(() => {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
  }
  stopInvitationPolling()
})

</script>
<template>
  <t-config-provider :globalConfig="tdGlobalConfig">
    <div id="app">
      <RouterView />
      <ManualKnowledgeEditor />
      <ProtectedResourcePreview />
      <UploadConfirmHost />
    </div>
  </t-config-provider>
</template>
<style>
html {
  /* 提示 UA 使用对应配色绘制滚动条等，减少主题切换时的额外重绘 */
  color-scheme: light dark;
}

body,
html,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  font-size: 14px;
  font-family: var(--app-font-family);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: var(--td-bg-color-page);
  color: var(--td-text-color-primary);
}

#app {
  /* 独立合成层，减轻 WebKit 全量重绘时整窗与内容的撕裂感（桌面 WebView 尤其明显） */
  isolation: isolate;
  transform: translateZ(0);
  backface-visibility: hidden;
}
</style>
