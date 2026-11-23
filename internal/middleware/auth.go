package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Tencent/WeKnora/internal/config"
	"github.com/Tencent/WeKnora/internal/logger"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// 外部用户身份相关的常量。
//
// 使用空间 API Key 调用时，调用方可以通过请求头声明「本次请求代表哪个终端用户」：
//   - direct_header 模式：X-External-User-ID: <调用方系统里的用户 ID>
//   - signed_token 模式：X-External-User-Token: <HS256 JWT，sub 为用户 ID>
//
// 该身份仅用于隔离会话、消息历史与 MCP 授权，不授予任何权限——
// 能做什么仍由 APIKeyScope 的 Capabilities / KnowledgeBaseIDs 决定。
//
// 安全边界：外部用户 ID 最长 128 字符；签名 Token 的 exp 生存期不得超过
// 24 小时，避免超长标识撑爆存储、长期有效的 Token 放大泄露风险。
//
// 注意：APIPrincipalConfig 里的 DirectHeaderName / SignedTokenHeaderName
// 目前不生效，中间件固定读取下面两个默认头名。
const (
	// direct_header 模式下读取外部用户 ID 的请求头。
	defaultExternalUserIDHeader = "X-External-User-ID"
	// signed_token 模式下读取签名 JWT 的请求头。
	defaultExternalUserTokenHeader = "X-External-User-Token"
	// 外部用户 ID 的最大长度（会被拼进 Principal.ID 和 sessions.user_id）。
	maxExternalUserIDLen = 128
	// 签名 JWT 允许的最长有效期，防止调用方签发超长期 Token。
	maxExternalUserTokenTTL = 24 * time.Hour
)

var (
	errMissingDirectHeader      = errors.New("missing external user id header")
	errInvalidExternalUserID    = errors.New("invalid external user id")
	errInvalidExternalUserToken = errors.New("invalid external user token")
)

// 无需认证的API列表
var noAuthAPI = map[string][]string{
	"/health":                 {"GET"},
	"/api/v1/auth/register":   {"POST"},
	"/api/v1/auth/login":      {"POST"},
	"/api/v1/auth/auto-setup": {"POST"},
	// Share-link surfaces accept a plaintext invite token from anonymous
	// callers (an invitee who hasn't registered yet). They are registered
	// as public routes in RegisterAuthRoutes and rate-limited by IP, so the
	// global Auth middleware must let them through — otherwise opening a
	// share link while logged out 401s and the frontend bounces the user to
	// /login instead of the register page (issue #1617).
	"/api/v1/auth/invitations/lookup": {"POST"},
	"/api/v1/auth/register-by-invite": {"POST"},
	"/api/v1/auth/config":             {"GET"},
	"/api/v1/auth/oidc/config":        {"GET"},
	"/api/v1/auth/oidc/url":           {"GET"},
	"/api/v1/auth/oidc/start":         {"GET"},
	"/api/v1/auth/oidc/callback":      {"GET"},
	// MCP OAuth provider redirect: the third-party authorization server
	// redirects the browser here without a WeKnora bearer token. The request
	// is authenticated by the opaque, single-use `state` parameter instead.
	"/api/v1/mcp-oauth/callback": {"GET"},
	"/api/v1/auth/refresh":       {"POST"},
	// IM platforms (Feishu, Slack, etc.) commonly issue a HEAD request
	// before GET to validate Content-Type / Content-Length when rendering
	// image previews — both verbs must be allowed for image links to work.
	"/api/v1/files/presigned": {"GET", "HEAD"},
}

// 检查请求是否在无需认证的API列表中
func isNoAuthAPI(path string, method string) bool {
	for api, methods := range noAuthAPI {
		// 如果以*结尾，按照前缀匹配，否则按照全路径匹配
		if strings.HasSuffix(api, "*") {
			if strings.HasPrefix(path, strings.TrimSuffix(api, "*")) && slices.Contains(methods, method) {
				return true
			}
		} else if path == api && slices.Contains(methods, method) {
			return true
		}
	}
	return false
}

// isTenantOptionalAPI lists authenticated identity-level operations that are
// meaningful before a user belongs to any tenant. Every other authenticated
// route remains tenant-scoped and returns TENANT_REQUIRED when the JWT and
// request headers do not resolve a tenant.
//
// isTenantOptionalAPI 判断一个已认证的 path+method 请求能否在"未解析出
// 租户"的情况下继续执行。这些是身份级和入驻流程类操作，必须让尚未加入
// 任何工作区的用户也能完成：
//
//   - 读取/修改自己的资料、偏好、密码；
//   - 校验或结束当前会话；
//   - 切换工作区、创建第一个工作区、处理邀请。
//
// 该函数只在租户解析结果为 0 时被调用；走到这里时认证已经通过。匹配是
// 路径与方法的精确匹配（邀请类接口是唯一的前缀匹配例外）。未列出的路由
// 都是租户作用域：解析不出租户时返回 409 TENANT_REQUIRED。
//
// 白名单条目的代码必须能安全地处理 tenant_id = 0，且不得读写属于租户的
// 数据。不要为了绕过"缺少租户"而把业务路由加进来。
func isTenantOptionalAPI(path, method string) bool {
	switch {
	case path == "/api/v1/auth/me" && (method == http.MethodGet || method == http.MethodPut):
		return true
	case path == "/api/v1/auth/me/preferences" && method == http.MethodPut:
		return true
	case path == "/api/v1/auth/logout" && method == http.MethodPost:
		return true
	case path == "/api/v1/auth/change-password" && method == http.MethodPost:
		return true
	case path == "/api/v1/auth/validate" && method == http.MethodGet:
		return true
	case path == "/api/v1/auth/switch-tenant" && method == http.MethodPost:
		return true
	case path == "/api/v1/tenants" && method == http.MethodPost:
		return true
	case strings.HasPrefix(path, "/api/v1/me/invitations"):
		return true
	default:
		return false
	}
}

// 调用 applyAuthSession
// applyAuthSession 把认证会话同时写入 gin 请求的两个上下文载体：
//
//   - c.Keys（通过 c.Get 或接收 *gin.Context 的辅助函数读取）
//   - c.Request.Context()（通过 types.*FromContext 系列函数读取）
//
// 所有认证中间件都必须经过这个辅助函数，而不是各自手写这对赋值；
// 只在其中一个载体上设置 key 是一种隐蔽的缺陷，会表现为
// "在 handler A 里正常，到 handler B 就失效"——具体取决于该 handler
// 用的是哪种读取方式。
func attachTenantlessUserContext(c *gin.Context, user *types.User) {
	applyAuthSession(c, authSession{
		User:        user,
		Principal:   types.Principal{Type: types.PrincipalWebUser, ID: user.ID},
		SystemAdmin: user.IsSystemAdmin,
		AuthSource:  types.AuthSourceWeb,
	})
}

// Auth 认证中间件。按顺序尝试三条通道：
//
//  1. 白名单（isNoAuthAPI）/ OPTIONS 预检 —— 直接放行；
//  2. Bearer JWT —— 成功则走 authenticateJWTUser 完成空间/角色解析；
//     校验失败不立即拒绝，继续尝试 X-API-Key（保持既有兼容行为：
//     携带过期 JWT 但同时带有效 API key 的客户端仍可通过）；
//  3. X-API-Key —— authenticateAPIKeyRequest。
//
// 三条通道都未命中时返回 401；若调用方提交过 Bearer token，错误消息
// 明确指出 token 无效而不是笼统的 "missing authentication"，方便客户端
// 区分「没登录」和「登录态过期」。
func Auth(
	tenantService interfaces.TenantService,
	userService interfaces.UserService,
	memberService interfaces.TenantMemberService,
	apiKeyService interfaces.TenantAPIKeyService,
	cfg *config.Config,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		// ignore OPTIONS request
		// 如果是 OPTIONS 请求，就跳过
		// 虽然 Auth 前面会有 CORS 中间件消费掉 OPTIONS 预检请求，
		// 但是仍然会有其他是 OPTIONS 但不是预检请求的情况，
		// 这种不属于 Auth 的业务范围，所以需要跳过
		if c.Request.Method == http.MethodOptions {
			c.Next()
			return
		}

		// 检查请求是否在无需认证的API列表中
		if isNoAuthAPI(c.Request.URL.Path, c.Request.Method) {
			c.Next()
			return
		}

		// 这里是服务器进程内部自己派发给自己的请求（用于 agent 操作）：
		// 身份信息只存在于 Go 的 context 里 —— 外部的 HTTP 请求不可能携带它；
		// 而且这份身份不会直接被信任，仍会像 JWT 会话那样去数据库重新核验。
		if dispatch, ok := types.InternalDispatchFromContext(c.Request.Context()); ok {
			if authenticateInternalDispatch(c, tenantService, userService, memberService, cfg, dispatch) {
				c.Next()
			}
			return
		}

		// 尝试JWT Token认证
		bearerPresented := false // bearerPresented = “Bearer（令牌）已出示/已提交”
		if token, ok := bearerToken(c); ok {
			bearerPresented = true
			// 获取用户信息以及其他的激活租户
			user, jwtTenantID, err := userService.ValidateToken(c.Request.Context(), token)
			if err == nil && user != nil {
				if authenticateJWTUser(c, tenantService, memberService, cfg, user, jwtTenantID) {
					c.Next()
				}
				return
			}
			logger.Warnf(c.Request.Context(), "[auth] bearer token rejected: %v", err)
		}

		// 尝试X-API-Key认证（兼容模式）
		if apiKey := c.GetHeader("X-API-Key"); apiKey != "" {
			if apiKeyService == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: API key service is not configured"})
				c.Abort()
				return
			}
			if authenticateAPIKeyRequest(c, tenantService, userService, apiKeyService, apiKey) {
				c.Next()
			}
			return
		}

		// 没有任何通道认证成功
		if bearerPresented {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: invalid or expired token"})
		} else {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: missing authentication"})
		}
		c.Abort()
	}
}

// authenticateInternalDispatch authenticates a request the server dispatched
// to itself on behalf of a signed-in user. The user is reloaded so a disabled
// account or revoked membership takes effect immediately, and tenant/role
// resolution goes through the same path as a JWT session pinned to the
// dispatch tenant. Credential headers are ignored: the dispatcher never sets
// them, and honoring them here would let a caller switch identities.
func authenticateInternalDispatch(
	c *gin.Context,
	tenantService interfaces.TenantService,
	userService interfaces.UserService,
	memberService interfaces.TenantMemberService,
	cfg *config.Config,
	dispatch types.InternalDispatch,
) bool {
	ctx := c.Request.Context()
	user, err := userService.GetUserByID(ctx, dispatch.UserID)
	if err != nil || user == nil || !user.IsActive {
		logger.Warnf(ctx, "[auth] internal dispatch rejected: user=%s err=%v", dispatch.UserID, err)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: invalid dispatch identity"})
		c.Abort()
		return false
	}
	c.Request.Header.Del("Authorization")
	c.Request.Header.Del("X-API-Key")
	c.Request.Header.Set("X-Tenant-ID", strconv.FormatUint(dispatch.TenantID, 10))
	return authenticateJWTUser(c, tenantService, memberService, cfg, user, dispatch.TenantID)
}

// 从请求头中的 token 去除掉 Bearer 前缀
func bearerToken(c *gin.Context) (string, bool) {
	authHeader := c.GetHeader("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		return "", false
	}
	return strings.TrimPrefix(authHeader, "Bearer "), true // 删除 Bearer 前缀
}

// authenticateJWTUser finishes authentication for a validated JWT user:
// it resolves the target tenant (X-Tenant-ID switch / JWT claim / first
// active membership), resolves the caller's role inside that tenant, and
// attaches the session context. Returns true when the request may proceed;
// on false the response has already been written and the request aborted.
// authenticateJWTUser 为已通过 JWT 校验的用户完成认证收尾：
// 解析目标租户（X-Tenant-ID 切换 / JWT claim / 首个有效成员关系），
// 解析调用者在该租户内的角色，并写入会话上下文。
// 返回 true 表示请求可以继续；返回 false 时响应已经写出、请求已被中止。
func authenticateJWTUser(
	c *gin.Context,
	tenantService interfaces.TenantService,
	memberService interfaces.TenantMemberService,
	cfg *config.Config,
	user *types.User,
	jwtTenantID uint64,
) bool {
	ctx := c.Request.Context()

	targetTenantID, tenant, crossTenantSwitch, ok := resolveTargetTenant(c, tenantService, memberService, cfg, user, jwtTenantID)
	if !ok {
		return false
	}

	if targetTenantID == 0 {
		// 无可用空间：身份级路由（/auth/me 等）放行为 tenantless 会话，
		// 其余路由返回 TENANT_REQUIRED 让前端引导用户创建/加入空间。
		if isTenantOptionalAPI(c.Request.URL.Path, c.Request.Method) {
			attachTenantlessUserContext(c, user)
			return true
		}
		c.JSON(http.StatusConflict, gin.H{
			"error": "Workspace required",
			"code":  "TENANT_REQUIRED",
		})
		c.Abort()
		return false
	}

	// 获取空间信息（X-Tenant-ID 切换路径已在 resolveTargetTenant 内取到，
	// 避免二次查库）。
	if tenant == nil {
		var err error
		tenant, err = tenantService.GetTenantByID(ctx, targetTenantID)
		if err != nil || tenant == nil {
			logger.Warnf(ctx, "[auth] tenant lookup failed: tenant=%d user=%s err=%v", targetTenantID, user.ID, err)
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Unauthorized: invalid workspace",
			})
			c.Abort()
			return false
		}
	}

	// 解析当前空间内的角色 (issue #1303)
	role, ok := resolveTenantRole(ctx, memberService, user, targetTenantID, crossTenantSwitch, cfg)
	if !ok {
		// 强制 RBAC 时，缺少 active membership 即拒绝；fail-open 路径已在
		// resolveTenantRole 内部处理。
		logger.Warnf(ctx, "User %s has no active membership in tenant %d", user.ID, targetTenantID)
		c.JSON(http.StatusForbidden, gin.H{
			"error": "Forbidden: not a member of the target workspace",
		})
		c.Abort()
		return false
	}

	logger.Infof(ctx,
		"[auth] resolved role=%s for user=%s in tenant=%d (jwt_tenant=%d, header=%q, cross_switch=%v)",
		role, user.ID, targetTenantID, jwtTenantID, c.GetHeader("X-Tenant-ID"), crossTenantSwitch)
	applyAuthSession(c, authSession{
		User:        user,
		Principal:   types.Principal{Type: types.PrincipalWebUser, ID: user.ID},
		TenantID:    targetTenantID,
		Tenant:      tenant,
		Role:        role,
		SystemAdmin: user.IsSystemAdmin,
		AuthSource:  types.AuthSourceWeb,
	})
	return true
}

// resolveTargetTenant decides which tenant this request operates in.
//
// Priority:
//  1. X-Tenant-ID header — must parse to a positive integer, the user must
//     be allowed to access it (home tenant / cross-tenant superuser / active
//     membership, see IsTenantAccessible) and the tenant must exist. The
//     fetched tenant is returned so the caller doesn't refetch it.
//  2. JWT tenant claim (falling back to user.TenantID when the claim is 0).
//  3. First active membership — lets a tenantless session become usable as
//     soon as an invitation is accepted (see resolveFirstMembershipTarget).
//
// Returns ok=false when the response has already been written (malformed
// header, inaccessible or missing target tenant). targetTenantID == 0 with
// ok=true means "authenticated but no usable workspace" — the caller decides
// between tenantless routes and TENANT_REQUIRED.
//
// resolveTargetTenant 决定这次请求在哪个租户下执行，并告知调用方是否已顺带
// 取到租户记录。
//
// 解析顺序：
//
//  1. jwtTenantID —— token 签发时绑定的租户（登录或 /auth/switch-tenant）。
//     若为 0，退回 user.TenantID（主租户）；租户级 RBAC 之前签发的 token
//     依赖这层兜底。
//  2. 请求头 X-Tenant-ID 如果存在，会覆盖上面的结果。它必须能解析为正整数
//     （否则 400）；用户必须有权访问——主租户、跨租户超管、或 tenant_members
//     中的 active 记录（否则 403）；租户还必须存在（否则 400）。这条路径
//     会顺带查出租户，因此一并返回，调用方无需重复查询。
//  3. 如果结果仍为 0（无主租户用户），取第一条 active 的成员关系，使已有
//     JWT 在邀请被接受后立即可用（见 resolveFirstMembershipTarget）。
//
// 返回值：
//   - targetTenantID：本次请求的目标租户。为 0 且 ok=true 表示"已认证但
//     没有可用工作区"，由调用方决定走 tenantless 路由还是返回 TENANT_REQUIRED。
//   - tenant：仅当走 X-Tenant-ID 路径时非 nil；其它路径调用方需自行查询。
//   - crossTenantSwitch：targetTenantID != user.TenantID，表示请求离开了
//     主租户；供角色解析使用。
//   - ok：false 表示响应已经写好（header 非法、无权限、租户不存在），
//     调用方必须立即停止。
//
// 本函数只读：不写数据库、不修改 gin context；会话写入由后续的
// applyAuthSession 完成。
func resolveTargetTenant(
	c *gin.Context,
	tenantService interfaces.TenantService,
	memberService interfaces.TenantMemberService,
	cfg *config.Config,
	user *types.User,
	jwtTenantID uint64,
) (targetTenantID uint64, tenant *types.Tenant, crossTenantSwitch bool, ok bool) {
	ctx := c.Request.Context()

	// 默认 target = JWT 里的 tenant_id（来自登录或 /auth/switch-tenant），
	// 兼容 ValidateToken 的 fallback：claim 缺失时 jwtTenantID == user.TenantID。
	targetTenantID = jwtTenantID
	// 它是一层兜底——当上游没给出租户（jwtTenantID == 0）时，用用户的主租户补上，避免把"有主租户的用户"误判成"无工作区"。
	if targetTenantID == 0 {
		targetTenantID = user.TenantID
	}

	// X-Tenant-ID 是一个自定义 HTTP 请求头，值是工作区（租户）ID 的十进制字符串，是本次生效的租户 ID
	// 也就是想要请求访问的租户ID
	if tenantHeader := c.GetHeader("X-Tenant-ID"); tenantHeader != "" {
		// 解析目标空间ID。畸形 / 零值必须显式拒绝：静默忽略会让坏掉的
		// 前端/SDK 悄悄写错空间，反而看不到问题。与 RequirePathTenantMatch
		// 中对 :id 的校验保持一致（非空、可解析、>0）。
		parsedTenantID, err := strconv.ParseUint(tenantHeader, 10, 64)
		if err != nil || parsedTenantID == 0 {
			logger.Warnf(ctx, "Invalid X-Tenant-ID header from user=%s: %q (err=%v)", user.ID, tenantHeader, err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid X-Tenant-ID header"})
			c.Abort() // 终止 gin 的中间件链：后面的中间件和 handler 都不会再执行
			return 0, nil, false, false
		}
		// 检查用户是否有权限访问目标空间：自家空间、跨空间超管、或
		// 有 active membership 行——三选一，由 IsTenantAccessible 统一判定。
		if !IsTenantAccessible(ctx, user, parsedTenantID, memberService, cfg) {
			logger.Warnf(ctx, "User %s attempted to access tenant %d without permission", user.ID, parsedTenantID)
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Forbidden: insufficient permissions to access target workspace",
			})
			c.Abort()
			return 0, nil, false, false
		}
		// 验证目标空间是否存在
		targetTenant, err := tenantService.GetTenantByID(ctx, parsedTenantID)
		if err != nil || targetTenant == nil {
			logger.Warnf(ctx, "Error getting target tenant by ID: %v, tenantID: %d", err, parsedTenantID)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid target workspace ID"})
			c.Abort()
			return 0, nil, false, false
		}
		logger.Infof(ctx, "User %s switching to tenant %d", user.ID, parsedTenantID)
		return parsedTenantID, targetTenant, parsedTenantID != user.TenantID, true
	}

	if targetTenantID == 0 {
		targetTenantID = resolveFirstMembershipTarget(ctx, user, memberService, tenantService)
	}
	return targetTenantID, nil, targetTenantID != user.TenantID, true
}

// resolveFirstMembershipTarget lets a tenantless session immediately become
// usable once an active membership exists (for example after accepting its
// first invitation or being added directly by an administrator). The user
// service persists the same earliest-membership choice on the next token
// issuance; middleware keeps the current JWT usable until then.
func resolveFirstMembershipTarget(
	ctx context.Context,
	user *types.User,
	memberService interfaces.TenantMemberService,
	tenantService interfaces.TenantService,
) uint64 {
	if user == nil || memberService == nil || tenantService == nil {
		return 0
	}
	members, err := memberService.ListByUser(ctx, user.ID)
	if err != nil {
		logger.Warnf(ctx, "Failed to list memberships for tenantless user %s: %v", user.ID, err)
		return 0
	}
	for _, member := range members {
		if member == nil || member.TenantID == 0 || member.Status != types.TenantMemberStatusActive {
			continue
		}
		tenant, err := tenantService.GetTenantByID(ctx, member.TenantID)
		if err == nil && tenant != nil {
			return member.TenantID
		}
	}
	return 0
}

// authenticateAPIKeyRequest 是 Auth 中间件的第三条认证通道，
// 是 X-API-Key 认证通道的实现：
// 用请求里的 API Key 换出一个「已认证的请求上下文」，
// 让后续 handler 知道这次请求是哪个 Key、哪个租户、有哪些权限。
func authenticateAPIKeyRequest(
	c *gin.Context,
	tenantService interfaces.TenantService,
	userService interfaces.UserService,
	apiKeyService interfaces.TenantAPIKeyService,
	apiKey string,
) bool {
	ctx := c.Request.Context()
	// AuthenticateAPIKey resolves the key by SHA-256 hash (see startup
	// BackfillMissingKeyHashes for migration 000065 placeholder rows).
	// 中文：按 SHA-256 哈希查找并校验 Key——存在、未撤销、未过期才有效；
	// 成功返回完整记录，任何失效情况都统一返回 ErrTenantAPIKeyNotFound。
	key, err := apiKeyService.AuthenticateAPIKey(ctx, apiKey)
	if err != nil || key == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: invalid API key"})
		c.Abort()
		return false
	}

	// 检查 Key 的作用域范围，如果是 Platform 则通过 X-Tenant-ID 来指定工作区
	if key.IsPlatform() {
		// 获取上下文那种 X-Tenant-ID 请求头
		tenantHeader := strings.TrimSpace(c.GetHeader("X-Tenant-ID"))
		// 判断是否携带空间，因为调用的平台级接口在免租户白名单内
		if tenantHeader == "" {
			// 判断接口是否在免租户白名单内,如果不在,就直接拒绝
			if !isPlatformTenantOptionalAPI(c.Request.URL.Path, c.Request.Method) {
				c.JSON(http.StatusConflict, gin.H{
					"error": "Workspace required: platform API keys must send X-Tenant-ID",
					"code":  "TENANT_REQUIRED",
				})
				c.Abort()
				return false
			}
			attachPlatformAPIKeyAuthContext(c, key)
		} else {
			// 获取 X-Tenatn-ID
			targetTenantID, parseErr := strconv.ParseUint(tenantHeader, 10, 64)
			if parseErr != nil || targetTenantID == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid X-Tenant-ID header"})
				c.Abort()
				return false
			}
			attachAPIKeyAuthContext(c, tenantService, userService, targetTenantID, key)
		}
	} else {
		tenantID := key.TenantIDValue()
		if tenantID == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: invalid API key scope"})
			c.Abort()
			return false
		}
		if tenantHeader := strings.TrimSpace(c.GetHeader("X-Tenant-ID")); tenantHeader != "" {
			requestedTenantID, parseErr := strconv.ParseUint(tenantHeader, 10, 64)
			if parseErr != nil || requestedTenantID == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid X-Tenant-ID header"})
				c.Abort()
				return false
			}
			if requestedTenantID != tenantID {
				c.JSON(http.StatusForbidden, gin.H{
					"error": "Forbidden: workspace API key cannot switch workspaces",
				})
				c.Abort()
				return false
			}
		}
		attachAPIKeyAuthContext(c, tenantService, userService, tenantID, key)
	}
	if c.IsAborted() {
		return false
	}
	// Per-route API-key authorization (full access + capabilities + KB scope)
	// is enforced by middleware.APIKeyRouteAuthorizer on the /api/v1 group.
	// Key-management and any other undeclared route is denied there.
	return true
}

// isPlatformTenantOptionalAPI 判断该路由是否属于「平台级接口」：
// 平台 API Key 调用这类接口时可以不带 X-Tenant-ID，因为它们要么作用于
// 整个部署，要么发生在目标空间确定之前，本身不属于任何空间。
//
// 白名单只有三类（其余一律默认拒绝）：
//   - /api/v1/system/admin 及其子路径：部署级控制面；
//   - GET /api/v1/tenants/all、/api/v1/tenants/search：先查出目标空间；
//   - POST /api/v1/tenants：创建空间时尚无目标空间可指定。
//
// /tenants 相关接口还限定 HTTP 方法；空格和末尾斜杠会被归一化，
// 以便 "/tenants/all/" 与 "/tenants/all" 等价。
//
// 注意：本函数只决定「是否免除 X-Tenant-ID」，不授予任何权限——
// capability、FullAccess 与路由策略仍由 APIKeyRouteAuthorizer 校验。
func isPlatformTenantOptionalAPI(path, method string) bool {
	path = strings.TrimSuffix(strings.TrimSpace(path), "/")
	// 精确匹配 admin 控制面前缀（"/api/v1/system/admin" 本身或其子路径）。
	// 裸 HasPrefix 会误放行诸如 "/api/v1/system/admin-foo" 的同前缀路径。
	if path == "/api/v1/system/admin" || strings.HasPrefix(path, "/api/v1/system/admin/") {
		return true
	}
	if method == http.MethodGet && (path == "/api/v1/tenants/all" || path == "/api/v1/tenants/search") {
		return true
	}
	return method == http.MethodPost && path == "/api/v1/tenants"
}

// attachPlatformAPIKeyAuthContext 把「这把平台 Key 代表谁、能做什么、从哪认证的」写进请求上下文。
func attachPlatformAPIKeyAuthContext(c *gin.Context, key *types.TenantAPIKey) {
	// 获取创建好的机器用户身份
	principal, user := platformAPIKeyIdentity(key)
	// 把「这个请求是谁」写进请求上下文，让后续的中间件和 handler 能读到调用者身份。
	applyAuthSession(c, authSession{
		User:      user,
		Principal: principal,
		// This role context exists only for legacy guard compatibility after
		// RequireRole short-circuits API-key principals; the key's real
		// authority is its platform capabilities enforced by the APIKeyGate.
		Role: types.TenantRoleViewer,
		APIKeyScope: &types.TenantAPIKeyScope{
			KeyID:        key.ID,
			Name:         key.Name,
			ScopeType:    types.APIKeyScopePlatform,
			FullAccess:   false, // 强制 false -- 平台 Key 不允许全权限
			Capabilities: key.Capabilities,
		},
		AuthSource: types.AuthSourceAPIPlatformKey, // 用于记录「这次调用是通过平台 API Key 认证的」，便于审计和会话归属判断。
	})
}

// platformAPIKeyIdentity 为平台 API Key 构造一个稳定的机器身份。
//
// 返回的 Principal 是正统表示：Type=api_platform，ID 为 Key 的数据库 ID。
// 合成 User 只是兼容层——下游大量接口仍要求 *types.User，而平台 Key 不对应
// 任何真实账号，因此用 Principal.StorageID()（"api_platform:<keyID>"）作为
// 用户 ID，并给出不可投递的 @api-key.local 邮箱。
//
// 该 User 只存在于请求上下文，从不落库。判断调用方是否为机器身份请使用
// TenantAPIKeyScope / Principal / AuthSource，不要依赖 user != nil。
//
// key 为 nil 时按 ID=0 处理（防御性兜底，正常调用方不会传 nil）。
func platformAPIKeyIdentity(key *types.TenantAPIKey) (types.Principal, *types.User) {
	keyID := uint64(0)
	if key != nil {
		keyID = key.ID
	}
	principal := types.Principal{Type: types.PrincipalAPIPlatform, ID: strconv.FormatUint(keyID, 10)}
	userID := principal.StorageID()
	return principal, &types.User{
		ID:       userID,
		Username: userID,
		Email:    fmt.Sprintf("platform-api-key-%d@api-key.local", keyID),
		IsActive: true,
	}
}

// attachAPIKeyAuthContext 为「已确定目标空间」的 API Key 请求建立认证上下文。
//
// 调用方必须已完成：Key 有效性校验（AuthenticateAPIKey）、作用域判定，
// 以及目标空间的选择（平台 Key 从 X-Tenant-ID 解析，租户 Key 用自身的 TenantID）。
//
// 两类 Key 的身份来源不同：
//   - 平台 Key：使用稳定的机器身份 api_platform:<keyID>，切换空间只改 user.TenantID；
//     租户的 API principal 配置不得改写该身份。
//   - 租户 Key：借用该空间最早创建的用户（通常是 Owner）作为操作身份；
//     找不到时退回合成身份 system-<tenantID>，再按空间配置解析可选的终端用户身份
//     （direct_header / signed_token），最终主体可能是 api_external_user。
//
// 组装 authSession 后写入请求上下文。真实权限来自 APIKeyScope
// （FullAccess / Capabilities / KnowledgeBaseIDs）；Role 仅为兼容旧守卫。
// 内部失败（租户查询或终端用户解析）会直接写 401 并 Abort。
func attachAPIKeyAuthContext(
	c *gin.Context,
	tenantService interfaces.TenantService,
	userService interfaces.UserService,
	tenantID uint64,
	key *types.TenantAPIKey,
) {
	t, err := tenantService.GetTenantByID(c.Request.Context(), tenantID)
	if err != nil {
		logger.Warnf(c.Request.Context(), "[auth] API key tenant lookup failed: tenant=%d err=%v", tenantID, err)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized: invalid API key"})
		c.Abort()
		return
	}

	var user *types.User
	var principal types.Principal
	var authSource string
	if key != nil && key.IsPlatform() {
		// 平台 Key 始终保持一个稳定的机器身份，只是通过 X-Tenant-ID 选择目标空间。
		// 租户的 API principal 模式，以及租户下的合成用户，都不能改写这个身份。
		principal, user = platformAPIKeyIdentity(key)
		user.TenantID = tenantID
		authSource = types.AuthSourceAPIPlatformKey
	} else {
		// 走到这个分支代表是空间级 API Key，也就是租户 Key
		// 租户 Key 代表空间而非个人：借用空间最早创建的用户作操作身份，
		// 仅用于归属和审计，权限仍由 APIKeyScope 决定。
		user, err = userService.GetUserByTenantID(c.Request.Context(), tenantID)
		if err != nil || user == nil {
			// 空间里找不到可代表的用户时（成员可能都来自其他空间、用户已被删除，
			// 或查询失败），构造一个确定性的合成身份 system-<tenantID>：
			//   - 不落库，只存在于本次请求上下文；
			//   - 用于满足下游对 *types.User 的契约，避免自动化中断；
			//   - 审计里能明确看出这是空间机器凭证的操作，而非某个真人。
			//
			// 注意：查询失败也会走到这里（可用性优先）。若怀疑是基础设施问题，
			// 请结合下面这条日志排查，而不是只根据合成用户判断「空间没人」。
			user = &types.User{
				ID:       fmt.Sprintf("system-%d", tenantID),
				Username: fmt.Sprintf("system-%d", tenantID),
				Email:    fmt.Sprintf("system-%d@api-key.local", tenantID),
				TenantID: tenantID,
				IsActive: true,
			}
			logger.Infof(c.Request.Context(),
				"No user found for tenant %d via API key, using synthetic system user %s", tenantID, user.ID)
		}

		var principalErr error
		// 解析终端用户身份：默认是 api_tenant:<tenantID>（整把 Key 一个身份）；
		// 若空间配置了 direct_header / signed_token，则按请求头识别具体的终端用户，
		// 用于隔离会话、消息历史和 MCP 授权。识别失败（缺头或签名无效）直接 401。
		// 注意：这里只决定「是谁」，不改变 Key 的能力与知识库范围。
		// 因为可能有多个终端用户，使用同一把 API Key，所以需要将他们的会话区分开来。
		principal, authSource, principalErr = resolveAPIPrincipal(c.Request.Context(), t, c.Request.Header)
		if principalErr != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": apiPrincipalAuthErrorMessage(principalErr)})
			c.Abort()
			return
		}
	}

	// 这里的角色上下文仅用于兼容旧版守卫：RequireRole 遇到 API Key 主体时
	// 会直接短路放行，不会读取这个角色。API Key 的真实权限来自
	// FullAccess + Capabilities + KnowledgeBaseIDs。
	apiKeyTenantRoleContext := types.TenantRoleViewer
	fullAccess := key != nil && key.FullAccess && !key.IsPlatform()
	if fullAccess {
		apiKeyTenantRoleContext = types.TenantRoleOwner
	}
	session := authSession{
		User:       user,
		Principal:  principal,
		TenantID:   tenantID,
		Tenant:     t,
		Role:       apiKeyTenantRoleContext,
		AuthSource: authSource,
	}
	if key != nil {
		session.APIKeyScope = &types.TenantAPIKeyScope{
			KeyID:            key.ID,
			Name:             key.Name,
			ScopeType:        key.ScopeType,
			FullAccess:       fullAccess,
			KnowledgeBaseIDs: key.KnowledgeBaseIDs,
			Capabilities:     key.Capabilities,
		}
	}
	applyAuthSession(c, session)
}

// resolveAPIPrincipal 根据空间的 api-principal-config 解析请求的终端用户身份。
//
// 三种模式：
//   - tenant（默认）：不区分终端用户，返回 api_tenant:<tenantID>；
//   - direct_header：信任 X-External-User-ID，保证级别低，
//     仅适用于可信的服务端到服务端调用。RequireDirectHeader 为 true 时
//     缺头直接报错，否则回退到 tenant 身份；
//   - signed_token：校验 X-External-User-Token 中的 HS256 JWT
//     （aud=weknora、exp 存在且 ≤24h、tenant_id 与目标空间一致、sub 为外部用户 ID）。
//
// 返回的 Principal.ID 形如 "<tenantID>:<externalUserID>"，authSource 会写入
// 会话，用于审计区分 api_tenant_key / api_direct_header / api_signed_token。
//
// 该身份只用于隔离与归属（会话、消息历史、MCP OAuth），不授予任何权限；
// 能做什么仍由 APIKeyScope 的 Capabilities / KnowledgeBaseIDs 决定。
func resolveAPIPrincipal(
	ctx context.Context, tenant *types.Tenant, header http.Header,
) (types.Principal, string, error) {
	tenantID := uint64(0)
	if tenant != nil {
		tenantID = tenant.ID
	}
	fallback := types.Principal{Type: types.PrincipalAPITenant, ID: strconv.FormatUint(tenantID, 10)}
	// 这是一个防御性判断：拿不到空间或空间 ID 无效时，直接退回「空间级默认身份」，不报错。
	if tenant == nil || tenantID == 0 {
		return fallback, types.AuthSourceAPITenantKey, nil
	}
	// 读取空间配置
	cfg := tenant.APIPrincipalConfig
	// 返回「空间级默认身份」
	if cfg == nil || cfg.Mode == "" || cfg.Mode == types.APIPrincipalModeTenant {
		return fallback, types.AuthSourceAPITenantKey, nil
	}
	// 判断是 direct_header 还是 signed_token
	switch cfg.Mode {
	case types.APIPrincipalModeDirect:
		// direct_header 模式下读取外部请求头
		externalUserID := strings.TrimSpace(header.Get(defaultExternalUserIDHeader))
		// 请求未携带（或只含空白）外部用户 ID。
		//
		// RequireDirectHeader 为 true：视为身份缺失，直接返回 401；
		// 为 false（默认）：退回空间统一身份 api_tenant，兼容后台任务、
		// 定时同步等没有具体终端用户的调用。
		//
		// 注意：只有「缺失」可以回退；下面「带了但格式非法」的值一律报错。
		if externalUserID == "" {
			if cfg.RequireDirectHeader {
				return types.Principal{}, "", errMissingDirectHeader
			}
			return fallback, types.AuthSourceAPITenantKey, nil
		}
		// 验证 externalUserID 是否可用
		if err := validateExternalUserID(externalUserID); err != nil {
			return types.Principal{}, "", fmt.Errorf("%w: %v", errInvalidExternalUserID, err)
		}
		return types.Principal{
			Type: types.PrincipalAPIExternalUser,
			ID:   strconv.FormatUint(tenantID, 10) + ":" + externalUserID,
		}, types.AuthSourceAPIDirectHeader, nil
	case types.APIPrincipalModeSignedToken:
		// 获取外部用户 ID，也就是终端用户
		externalUserID, err := verifyExternalUserJWT(header.Get(defaultExternalUserTokenHeader), tenantID, cfg.HMACSecret)
		if err != nil || externalUserID == "" {
			logger.Warnf(ctx, "invalid external user token for tenant=%d: %v", tenantID, err)
			return types.Principal{}, "", fmt.Errorf("%w: %w", errInvalidExternalUserToken, err)
		}
		// 检验外部用户 ID 是否可用，有效
		if err := validateExternalUserID(externalUserID); err != nil {
			return types.Principal{}, "", fmt.Errorf("%w: %v", errInvalidExternalUserID, err)
		}
		// 
		return types.Principal{
			Type: types.PrincipalAPIExternalUser,
			ID:   strconv.FormatUint(tenantID, 10) + ":" + externalUserID,
		}, types.AuthSourceAPISignedToken, nil
	default:
		// 默认仍然是「空间级默认身份」
		return fallback, types.AuthSourceAPITenantKey, nil
	}
}

// verifyExternalUserJWT 校验调用方提供的签名 Token，并返回其中的外部用户 ID（sub）。
//
// 信任链：
//   - 签名：使用空间配置的 HMACSecret，算法限定 HS256；
//   - 受众：aud 必须包含 weknora；
//   - 时效：exp 必填，剩余有效期不超过 24h；nbf（如存在）必须已到；
//   - 空间：tenant_id claim 必须与目标空间一致，防止跨空间重放；
//   - 身份：sub 非空（长度与字符格式由调用方继续用 validateExternalUserID 校验）。
//
// 任一条件不满足都返回错误，调用方会将其转换为 401。
// 本函数只验证「是谁」，不判断「能做什么」——权限仍由 APIKeyScope 决定。
func verifyExternalUserJWT(tokenString string, tenantID uint64, secret string) (string, error) {
	tokenString = strings.TrimSpace(tokenString)
	secret = strings.TrimSpace(secret)
	if tokenString == "" {
		return "", errors.New("missing external user token")
	}
	if secret == "" {
		return "", errors.New("external user token secret is not configured")
	}
	claims := jwt.MapClaims{}
	// 收紧 JWT 校验规则：
	//   - WithAudience("weknora")：只接受发给本服务的 Token，防止跨服务重放；
	//   - WithExpirationRequired()：必须带 exp，避免无过期时间的永久 Token；
	//   - WithValidMethods([HS256])：锁定对称签名算法，防止 alg=none 与算法混淆。
	//
	// 签名本身由下方 keyfunc 用共享密钥（HMACSecret）验证；有效期上限、
	// tenant_id 匹配、sub 非空等业务约束在解析之后单独检查。
	parser := jwt.NewParser(
		jwt.WithAudience("weknora"),
		jwt.WithExpirationRequired(),
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	token, err := parser.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return "", err
	}
	if token == nil || !token.Valid {
		return "", errors.New("invalid external user token")
	}
	// 获取过期时间
	exp, err := claims.GetExpirationTime()
	if err != nil || exp == nil {
		return "", errors.New("missing expiration")
	}
	// 防止签发超长时期的 token
	if time.Until(exp.Time) > maxExternalUserTokenTTL {
		return "", fmt.Errorf("token lifetime exceeds %s", maxExternalUserTokenTTL)
	}
	// 查看 token 生效时间，是否已经生效
	if nbf, nbfErr := claims.GetNotBefore(); nbfErr == nil && nbf != nil && time.Now().Before(nbf.Time) {
		return "", errors.New("token not yet valid")
	}
	// 进一步校验这个签名 Token 是否是发给当前这个空间的
	if got := principalTenantIDFromClaims(claims); got != tenantID {
		return "", fmt.Errorf("workspace mismatch: got %d want %d", got, tenantID)
	}
	// 这里就是获取的持证人，也就是所谓的终端用户
	sub, _ := claims["sub"].(string)
	sub = strings.TrimSpace(sub)
	if sub == "" {
		return "", errors.New("missing subject")
	}
	return sub, nil
}

// validateExternalUserID 校验调用方传来的「外部用户 ID」是否可用，
// 防止它变成超长、空白或含控制字符的身份标识。
// 1.不能为空；2.不能超过128；3.不能包含控制字符
// 控制字符类似于：换行、Tab、回车、NUL 等控制字符以及DEL
func validateExternalUserID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("empty external user id")
	}
	if len(id) > maxExternalUserIDLen {
		return fmt.Errorf("external user id too long (max %d)", maxExternalUserIDLen)
	}
	for _, r := range id {
		if r < 0x20 || r == 0x7f {
			return errors.New("external user id contains invalid characters")
		}
	}
	return nil
}

func apiPrincipalAuthErrorMessage(err error) string {
	switch {
	case errors.Is(err, errMissingDirectHeader):
		return "Unauthorized: missing external user id header"
	case errors.Is(err, errInvalidExternalUserID):
		return "Unauthorized: invalid external user id"
	case errors.Is(err, errInvalidExternalUserToken):
		return "Unauthorized: invalid external user token"
	default:
		return "Unauthorized: invalid external user token"
	}
}

// principalTenantIDFromClaims 把 tenant_id 从 JSON 值转成 uint64，并兼容多种类型：
func principalTenantIDFromClaims(claims jwt.MapClaims) uint64 {
	v, ok := claims["tenant_id"]
	if !ok {
		return 0
	}
	switch t := v.(type) {
	case float64:
		if t <= 0 {
			return 0
		}
		return uint64(t)
	case int64:
		if t <= 0 {
			return 0
		}
		return uint64(t)
	case uint64:
		return t
	case json.Number:
		n, err := strconv.ParseUint(t.String(), 10, 64)
		if err != nil {
			return 0
		}
		return n
	case string:
		n, err := strconv.ParseUint(strings.TrimSpace(t), 10, 64)
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}

// resolveTenantRole determines the caller's TenantRole inside targetTenantID.
//
// Order of resolution:
//  1. Active TenantMember row → return that role.
//  2. Cross-tenant superuser switch (X-Tenant-ID with CanAccessAllTenants=true)
//     → grant Admin in the target tenant. Org admins are intentionally not
//     promoted to Owner; tenant deletion / API-key rotation should always
//     stay with a real Owner inside the target tenant. Cross-tenant access
//     is also never allowed to trigger the orphan-tenant auto-promotion
//     below — a superuser only visits, never claims ownership.
//  3. No membership but the tenant currently has zero active members AND
//     the caller is authenticating into their own home tenant (i.e.
//     targetTenantID == user.TenantID and this is not a cross-tenant
//     switch). This is the API-key-only orphan-tenant self-heal path:
//     the registrant becomes Owner of the tenant their own user record
//     points to. Any other path (cross-tenant switch, JWT minted for a
//     foreign tenant, etc.) is intentionally excluded to avoid silent
//     ownership grabs.
//  4. Otherwise → return ok=false. Caller decides:
//     - When EnableRBAC=true (or cfg unavailable): treat as 403.
//     - When EnableRBAC=false: fail open with Admin so existing deployments
//     don't break in the rollout window where memberships might lag user
//     records.
//
// The boolean second return value reports whether enforcement should reject
// the request. It is true whenever a usable role was found OR fail-open
// applies; false only when we want callers to abort with 403.
func resolveTenantRole(
	ctx context.Context,
	memberService interfaces.TenantMemberService,
	user *types.User,
	targetTenantID uint64,
	crossTenantSwitch bool,
	cfg *config.Config,
) (types.TenantRole, bool) {
	// 1. 正常成员关系
	member, err := memberService.GetMembership(ctx, user.ID, targetTenantID)
	if err == nil && member != nil && member.Status == types.TenantMemberStatusActive {
		logger.Infof(ctx,
			"[auth] resolveTenantRole step1 hit: user=%s tenant=%d row_role=%s row_status=%s",
			user.ID, targetTenantID, member.Role, member.Status)
		return member.Role, true
	}
	if err != nil {
		logger.Warnf(ctx, "tenant_members lookup failed user=%s tenant=%d: %v",
			user.ID, targetTenantID, err)
		// Fall through; treat lookup errors the same as "no membership
		// found" so a transient DB hiccup doesn't lock everyone out.
	} else {
		var statusInfo string
		if member == nil {
			statusInfo = "no_row"
		} else {
			statusInfo = "row_exists status=" + string(member.Status) + " role=" + string(member.Role)
		}
		logger.Warnf(ctx,
			"[auth] resolveTenantRole step1 miss: user=%s tenant=%d (%s)",
			user.ID, targetTenantID, statusInfo)
	}

	// 2. 跨空间超管直通：CanAccessAllTenants 用户切到别的空间时不强制要求 membership。
	//    注意：这里只授予临时 Admin 角色，不写入 tenant_members，避免"看一眼别人空间"
	//    意外升级为持久化所有权。
	if crossTenantSwitch && user.CanAccessAllTenants {
		logger.Infof(ctx,
			"[auth] resolveTenantRole step2 (cross-tenant superuser) -> Admin: user=%s tenant=%d",
			user.ID, targetTenantID)
		return types.TenantRoleAdmin, true
	}

	// 3. 孤儿空间自愈：仅当用户登录的是自己的 home tenant、且该空间尚无任何活跃成员时
	//    允许自动晋升为 Owner。跨空间 switch / JWT 指向他人空间的场景一律不进入此分支，
	//    防止越权获得他人空间的 Owner 权限。
	isHomeTenant := !crossTenantSwitch && targetTenantID == user.TenantID
	if isHomeTenant {
		hasAny, anyErr := memberService.HasAnyMembers(ctx, targetTenantID)
		if anyErr == nil && !hasAny {
			if _, e := memberService.AddMember(
				ctx, user.ID, targetTenantID, types.TenantRoleOwner, nil,
			); e == nil {
				logger.Infof(ctx,
					"[audit] Auto-promoted user %s to Owner of orphan tenant %d (home_tenant=true)",
					user.ID, targetTenantID,
				)
				return types.TenantRoleOwner, true
			} else {
				logger.Warnf(ctx, "Failed to auto-promote user %s in tenant %d: %v",
					user.ID, targetTenantID, e)
			}
		}
	}

	// 4. 兜底：根据 EnableRBAC 决定 fail-closed 还是 fail-open
	if cfg != nil && cfg.Tenant.IsRBACEnforced() {
		logger.Warnf(ctx,
			"[auth] resolveTenantRole step4 fail-closed (EnableRBAC=true): user=%s tenant=%d",
			user.ID, targetTenantID)
		return "", false
	}
	logger.Warnf(ctx,
		"[auth] resolveTenantRole step4 fail-open (EnableRBAC=false) -> Admin: user=%s tenant=%d",
		user.ID, targetTenantID)
	// fail-open 期间保持现有行为（每个登录用户在自己空间里都是"管理员"）。
	return types.TenantRoleAdmin, true
}
