package middleware

import (
	"context"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
)

// authSession 是认证中间件附加到请求上的、已解析的身份。
// 作用就是统一所有请求的结构体。
// 一个结构体 + 一个 apply 函数，取代了过去分散在 JWT 分支、无租户分支、
// 两个 API Key 附加辅助函数以及 EmbedAuth 中的五处近乎重复的
// "c.Set + context.WithValue" 代码块——当每个调用方各写一遍时，
// 保持 gin 的 c.Keys 与 request.Context() 两个读取面同步，正是最容易被破坏的不变量。
type authSession struct {
	// User 是已认证（可能是合成）的用户，必填。
	User      *types.User
	Principal types.Principal
	// TenantID / Tenant 把请求限定到某个空间。TenantID == 0 表示无租户会话
	// （仅用于身份级路由），两个 key 都不会写入。即使 TenantID 有值，
	// Tenant 也可能为 nil（目前不应出现，但辅助函数保持容忍）。
	TenantID uint64
	Tenant   *types.Tenant
	// Role 是调用者在 TenantID 内的角色。空字符串表示「不写入角色 key」
	// （无租户会话）；读取方会回退到 TenantRoleFromContext 的
	// fail-closed 默认值 Viewer。
	Role        types.TenantRole
	SystemAdmin bool
	// APIKeyScope 标记机器主体；APIKeyGate 依据它在每个路由上做授权。
	APIKeyScope *types.TenantAPIKeyScope
	// Extra 携带与具体入口相关的上下文值（例如已认证的 embed 渠道），
	// 它们和其余字段一样，必须在两个读取面上都可见。
	Extra map[types.ContextKey]any
	// AuthSource 是 Principal 的验证方式（types.AuthSource*）。
	// 每个带主体的会话都必须设置。
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
