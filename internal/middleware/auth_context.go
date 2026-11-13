package middleware

import (
	"context"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
)

// authSession is the resolved identity an auth middleware attaches to the
// request. One struct + one apply function replaces the five near-identical
// "c.Set + context.WithValue" blocks that used to live in the JWT branch,
// the tenantless branch, both API-key attach helpers and EmbedAuth — keeping
// the gin-keys surface (c.Keys) and the request-context surface in lockstep
// is exactly the invariant that was easy to break when each caller wrote the
// pairs out by hand.
type authSession struct {
	// User is the authenticated (possibly synthetic) user. Required.
	User      *types.User
	Principal types.Principal
	// TenantID / Tenant scope the request to a workspace. TenantID == 0 means
	// a tenantless session (identity-level routes only) and attaches neither
	// key. Tenant may be nil even when TenantID is set (not expected today,
	// but the helper stays tolerant).
	TenantID uint64
	Tenant   *types.Tenant
	// Role is the caller's resolved role inside TenantID. Empty string means
	// "attach no role key" (tenantless sessions); readers then fall back to
	// TenantRoleFromContext's fail-closed Viewer default.
	Role        types.TenantRole
	SystemAdmin bool
	// APIKeyScope marks machine principals; the APIKeyGate authorizes them
	// per-route from this scope.
	APIKeyScope *types.TenantAPIKeyScope
	// Extra carries surface-specific context values (e.g. the authenticated
	// embed channel) that must be visible on both surfaces like the rest.
	Extra map[types.ContextKey]any
	// AuthSource is how Principal was verified (types.AuthSource*). Required
	// for every principal-bearing session.
	AuthSource string
}

// applyAuthSession writes the session onto BOTH context surfaces of the
// gin request:
//
//   - c.Keys (read via c.Get / helpers that take *gin.Context)
//   - c.Request.Context() (read via types.*FromContext)
//
// Every auth middleware must go through this helper instead of hand-writing
// the pairs; a key set on only one surface is a latent bug that surfaces as
// "works in handler A, broken in handler B" depending on which read style
// the handler uses.
// 
// applyAuthSession 把认证会话同时写入 gin 请求的两个上下文载体：
//
//   - c.Keys（通过 c.Get 或接收 *gin.Context 的辅助函数读取）
//   - c.Request.Context()（通过 types.*FromContext 系列函数读取）
//
// 所有认证中间件都必须经过这个辅助函数，而不是各自手写这对赋值；
// 只在其中一个载体上设置 key 是一种隐蔽的缺陷，会表现为
// "在 handler A 里正常，到 handler B 就失效"——具体取决于该 handler
// 用的是哪种读取方式。
func applyAuthSession(c *gin.Context, s authSession) {
	ctx := c.Request.Context()
	set := func(key types.ContextKey, v any) {
		c.Set(key.String(), v)
		ctx = context.WithValue(ctx, key, v)
	}

	if s.TenantID != 0 {
		set(types.TenantIDContextKey, s.TenantID)
	}
	if s.Tenant != nil {
		set(types.TenantInfoContextKey, s.Tenant)
	}
	if s.User != nil {
		set(types.UserContextKey, s.User)
		set(types.UserIDContextKey, s.User.ID)
	}
	c.Set(types.PrincipalContextKey.String(), s.Principal)
	ctx = types.WithPrincipal(ctx, s.Principal)
	if s.AuthSource != "" {
		set(types.PrincipalAuthSourceContextKey, s.AuthSource)
	}
	if s.Role != "" {
		set(types.TenantRoleContextKey, s.Role)
	}
	set(types.SystemAdminContextKey, s.SystemAdmin)
	if s.APIKeyScope != nil {
		ctx = types.WithTenantAPIKeyScope(ctx, *s.APIKeyScope)
	}
	for key, v := range s.Extra {
		set(key, v)
	}

	userID := ""
	if s.User != nil {
		userID = s.User.ID
	}
	ctx = types.WithCaller(ctx, types.Caller{TenantID: s.TenantID, UserID: userID, Role: s.Role})
	c.Request = c.Request.WithContext(ctx)
}
