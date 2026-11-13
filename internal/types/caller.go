package types

import "context"

// Caller 是用于资源授权的已认证身份。
// 即使查询在"资源所属租户"下执行，它的租户和角色也不会改变。
// 机器能力仍然保存在 TenantAPIKeyScope 中；Principal 是另一个独立概念。
type Caller struct {
	TenantID uint64 // 调用者自己所属的租户（身份属性）
	UserID   string // 调用者用户 ID
	Role     TenantRole // 调用者在该租户里的角色
}

// Normalize defaults an invalid tenant role to Viewer.
func (caller Caller) Normalize() Caller {
	if !caller.Role.IsValid() {
		caller.Role = TenantRoleViewer
	}
	return caller
}

// WithCaller captures the authenticated identity independently of execution scope.
func WithCaller(ctx context.Context, caller Caller) context.Context {
	return context.WithValue(ctx, CallerContextKey, caller.Normalize())
}

// CallerFromContext 兼容那些旧的、没有显式保存 Caller 的服务层 context。
// 在切换执行租户之前，一定要先把 Caller 捕获下来，即使身份是缺失的也要捕获。
func CallerFromContext(ctx context.Context) Caller {
	if caller, ok := ctx.Value(CallerContextKey).(Caller); ok {
		return caller
	}
	tenantID, _ := TenantIDFromContext(ctx)
	userID, _ := UserIDFromContext(ctx)
	return Caller{TenantID: tenantID, UserID: userID, Role: TenantRoleFromContext(ctx)}
}

// WithExecutionTenant changes repository/model scope, never authorization.
// It does not grant access to any resources in the destination tenant.
func WithExecutionTenant(ctx context.Context, tenantID uint64) context.Context {
	ctx = WithCaller(ctx, CallerFromContext(ctx))
	return context.WithValue(ctx, TenantIDContextKey, tenantID)
}
