package middleware

import (
	stderrors "errors"
	"net/http"
	"strings"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
)

var errTenantAPIKeyScopeForbidden = stderrors.New("workspace API key scope forbidden")

// APIKeyRoutePolicy declares how an X-API-Key caller may use a single route.
//
// Design: API-key authorization is a SEPARATE authority from the JWT
// role/ownership guards. Ownership ("creator OR Admin+") is a human concept
// and never applies to a machine principal; instead every API-key-accessible
// route declares one policy here, and the APIKeyGate is the single place that
// enforces it. Routes that declare no policy are denied for API keys by
// default (fail-closed), which removes the old "remember to add APIKeyDeny"
// footgun.
// 这是每一个路由的 API Key 的一张规则卡
// API Key 是给程序用的"账号密码"。人用 JWT 登录，程序就带一个 X-API-Key 头来调用接口：
// POST /api/v1/knowledge-bases
// X-API-Key: wk_abc123...
// 但是程序调用接口，也得有权限区分，所以这个规则卡就是用来筛选哪些 X-API-Key 可以调用接口
type APIKeyRoutePolicy struct {
	// PlatformOnly rejects workspace-bound keys even when they are full-access.
	// It is used for control-plane routes under /system/admin and cross-workspace
	// tenant lifecycle APIs.
	// 
	// 身份层级：只准平台级 Key
	PlatformOnly bool
	// RequireFullAccess admits only full-access tenant API keys unless one of
	// the listed capabilities also matches. Routes with neither full-access
	// requirement nor capabilities are open to any valid API key.
	// 
	// 权限档位：只准全权限 Key
	RequireFullAccess bool

	// Capabilities is an any-of allow-list for scoped API keys. A capability
	// never widens which knowledge bases a key may touch; KB scoping is
	// enforced downstream by KBAccess guards and handler scope checks.
	// 
	// 	能力清单：Key 至少有其中一种
	Capabilities []types.APIKeyCapability
}

// WithCapability returns a copy of the policy that additionally admits keys
// carrying capability c. Multiple calls accumulate (any-of semantics);
// duplicates are ignored.
func (p APIKeyRoutePolicy) WithCapability(c types.APIKeyCapability) APIKeyRoutePolicy {
	for _, existing := range p.Capabilities {
		if existing == c {
			return p
		}
	}
	// Copy the slice so mutating the returned policy never aliases the
	// receiver's backing array.
	next := make([]types.APIKeyCapability, len(p.Capabilities), len(p.Capabilities)+1)
	copy(next, p.Capabilities)
	p.Capabilities = append(next, c)
	return p
}

// APIKeyRouteAuthorizer is the registry of per-route API-key policies. It is
// populated at router-construction time (single-threaded) and only read at
// request time, so it needs no locking.
// 
// APIKeyRouteAuthorizer 是按路由登记的 API Key 策略注册表。
// 它在构建路由阶段（单线程）写入，在请求处理阶段只读，因此不需要加锁。
type APIKeyRouteAuthorizer struct {
	// policies is keyed by HTTP method, then by the gin full-path
	// template (e.g. "/api/v1/knowledge-bases/:id/knowledge/file").
	// policies 的第一层键是 HTTP 方法，第二层键是 gin 的完整路径模板
	// （例如 "/api/v1/knowledge-bases/:id/knowledge/file"）。
	policies map[string]map[string]APIKeyRoutePolicy
}

// NewAPIKeyRouteAuthorizer returns an empty authorizer.
// 
// NewAPIKeyRouteAuthorizer 返回一个空的（尚未登记任何策略的）授权器。
func NewAPIKeyRouteAuthorizer() *APIKeyRouteAuthorizer {
	return &APIKeyRouteAuthorizer{policies: map[string]map[string]APIKeyRoutePolicy{}}
}

// Register records the API-key policy for (method, fullPath). fullPath MUST be
// the same string gin reports via c.FullPath() for the route, otherwise the
// gate lookup will miss and the route will be denied for API keys. Router-side
// helpers build fullPath from the group's BasePath so the two stay in sync.
// 
// 接受方法和 fullPath 用来选取对应的键，接受 policy 用来配置对应的规则卡
func (a *APIKeyRouteAuthorizer) Register(method, fullPath string, policy APIKeyRoutePolicy) {
	method = strings.ToUpper(strings.TrimSpace(method))
	fullPath = normalizeRoutePath(fullPath)
	// 如果目标方法的规则表还不存在，先创建一个空的
	if a.policies[method] == nil {
		a.policies[method] = map[string]APIKeyRoutePolicy{}
	}
	a.policies[method][fullPath] = policy
}

// Lookup returns the policy for (method, fullPath) if one was declared.
// 
// 接受一个 method 和 fullPath ，返回相对应的 APIKeyRouterPolicy (规则卡) 和 是否成功的布尔值
func (a *APIKeyRouteAuthorizer) Lookup(method, fullPath string) (APIKeyRoutePolicy, bool) {
	byPath, ok := a.policies[strings.ToUpper(method)]
	if !ok {
		return APIKeyRoutePolicy{}, false
	}
	policy, ok := byPath[normalizeRoutePath(fullPath)]
	return policy, ok
}

// RegisteredRoutes returns every (method, fullPath) pair the authorizer knows
// about. Used by the router startup self-check to detect stale path templates.
// 
// RegisteredRoutes 把"方法 → 路径 → 规则"的内部结构，投影成"方法 → 路径列表"，
// 用于启动时校验这些路径是否真的存在；它取的是方法和路径，不碰规则内容。
func (a *APIKeyRouteAuthorizer) RegisteredRoutes() map[string][]string {
	out := make(map[string][]string, len(a.policies))
	for method, byPath := range a.policies {
		paths := make([]string, 0, len(byPath))
		for path := range byPath {
			paths = append(paths, path)
		}
		out[method] = paths
	}
	return out
}

// Middleware returns the gate middleware. It runs as the first handler on the
// authenticated API group, after routing (so c.FullPath() is populated). JWT
// principals pass straight through; API-key principals are authorized purely
// from the declared policy table.
// 
// Middleware() 是 API Key 的统一闸门：JWT 请求直接放行；
// API Key 请求用 c.FullPath() 查路由策略表，匹配就放行、不匹配或没登记就 403。
// 它必须挂在认证之后、路由守卫之前，才能既拿到 scope，又成为唯一的授权点。
// 也就是判断这个 API Key 是否可以被放行
func (a *APIKeyRouteAuthorizer) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 获取此 APIKey 的作用域范围
		scope, ok := types.TenantAPIKeyScopeFromContext(c.Request.Context())
		if !ok {
			c.Next()
			return
		}
		if err := a.authorize(scope, c.Request.Method, c.FullPath()); err != nil {
			// 不符合就返回 403
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "Forbidden: API key scope does not allow this operation",
			})
			return
		}
		c.Next()
	}
}

// authorize applies the declared policy to an API-key scope. Absent policy =>
// default deny.
// 
// 判断此APIKey的作用域范围是否符合对应的 APIKeyRouterPolicy（规则卡），返回值为 error 则不符合，为 nil 则符合
func (a *APIKeyRouteAuthorizer) authorize(scope types.TenantAPIKeyScope, method, fullPath string) error {
	policy, ok := a.Lookup(method, fullPath)
	if !ok {
		return errTenantAPIKeyScopeForbidden
	}
	// 接口要求是平台级(platform)，但调用方拿的是工作区 (tenant) 级 Key，直接拒绝
	if policy.PlatformOnly && !scope.IsPlatform() {
		return errTenantAPIKeyScopeForbidden
	}
	// 接口时平台级，但是能力为 0，可能是配置错误，直接拒绝
	if policy.PlatformOnly && len(policy.Capabilities) == 0 {
		return errTenantAPIKeyScopeForbidden
	}
	// 如果是 Key 是 FullAccess，放行 
	if scope.FullAccess {
		return nil
	}
	// Key 不是 full-access，但是配置了 capability 
	for _, cap := range policy.Capabilities {
		if cap != "" && scope.HasCapability(cap) {
			return nil
		}
	}
	// 这里是判断的 policy 内是空的，也就是对任何 API Key 都开放，所以直接放行
	if !policy.RequireFullAccess && len(policy.Capabilities) == 0 {
		return nil
	}
	// 如果上面都不是，那就拒绝
	return errTenantAPIKeyScopeForbidden
}

// DenyAPIKeyPrincipal returns a middleware that rejects any X-API-Key
// principal outright. Use it on routes registered directly on the engine
// (outside the /api/v1 group) where the APIKeyRouteAuthorizer.Middleware
// gate does NOT run — the JWT role guards (RequireRole / RequireSystemAdmin
// / RequireOwnershipOrRole) short-circuit API-key principals on the
// assumption the gate already authorized them, so an ungated route would
// otherwise let any valid key through. JWT sessions pass straight through.
func DenyAPIKeyPrincipal() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := types.TenantAPIKeyScopeFromContext(c.Request.Context()); ok {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "Forbidden: API keys cannot access this endpoint",
			})
			return
		}
		c.Next()
	}
}

// AllowFileServeAPIKey guards the tenant-scoped file-proxy routes (/files and
// the KB-scoped image proxy) for X-API-Key callers. Those routes serve an
// arbitrary storage path that only carries a tenant segment — there is no KB
// id in the path a KB-restricted key's allow-list could be checked against —
// so a KB-restricted key is denied outright (it must download KB content via
// the KB-scoped routes such as /knowledge/:id/download, which DO enforce the
// allow-list). A key passes when it is full-access, or when it is NOT
// KB-restricted and carries the retrieve capability: that is exactly the class
// of key that can already read any of the tenant's KB content, so exposing the
// tenant-bounded raw file path (the handler still enforces
// ValidateStoragePathTenant / the KB owner tenant) grants it nothing new. JWT
// sessions carry no API-key scope and pass straight through.
func AllowFileServeAPIKey() gin.HandlerFunc {
	return func(c *gin.Context) {
		scope, ok := types.TenantAPIKeyScopeFromContext(c.Request.Context())
		if !ok {
			c.Next()
			return
		}
		if scope.FullAccess ||
			(!scope.IsKnowledgeBaseRestricted() &&
				scope.HasCapability(types.APIKeyCapabilityRetrieve)) {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": "Forbidden: API key scope does not allow this operation",
		})
	}
}

// normalizeRoutePath collapses duplicate slashes and trims a trailing slash so
// helper-built paths (BasePath()+rel) match gin's c.FullPath() exactly.
// 把路径字符串规范化成统一形式
func normalizeRoutePath(p string) string {
	if p == "" {
		return ""
	}
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	return p
}
