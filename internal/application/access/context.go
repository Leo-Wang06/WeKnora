package access

import (
	"context"

	"github.com/Tencent/WeKnora/internal/types"
)

// Context grants contain values, not mutable KB objects. Deriving a context
// copies the grant slice so parallel search branches cannot widen each other.
// 一条已解析好的知识库访问授权
type kbGrant struct {
	caller     types.Caller // 授权给谁（精确身份）
	kbID       string // 哪个知识库
	tenantID   uint64 //知识库属于哪个租户（admin/editor/viewer）
	permission types.OrgMemberRole // 授予的级别
	task       bool // 是否后台任务型授权
}

// 调用者被授权的共享Agent 的作用域范围
type agentGrant struct {
	caller types.Caller
	scope  types.SharedAgentKBScope
}

// WithSharedAgent scopes execution after the caller has authorized this exact
// agent. Only its configured KBs receive read access; other source-tenant KBs
// and the source tenant's organization memberships are not inherited.
func WithSharedAgent(ctx context.Context, agent *types.CustomAgent) context.Context {
	grant := agentGrant{caller: types.CallerFromContext(ctx), scope: types.NewSharedAgentKBScope(agent)}
	ctx = context.WithValue(ctx, types.SharedAgentGrantContextKey, grant)
	if agent == nil {
		return ctx
	}
	return types.WithExecutionTenant(ctx, agent.TenantID)
}

// HasKBGrant checks only previously resolved resource access. It never infers
// ownership from the execution tenant, and always reapplies API-key scope.
// 
// HasKBGrant 判断 ctx 中是否已存在一条明确授权，允许 caller 以至少 required
// 的级别访问 tenantID 下的 kbID。
//
// 认可两类授权：
//  1. 逐 KB 的 kbGrant：调用者、KB、租户、权限级别必须全部匹配；
//  2. 共享 Agent 授权：只授予 viewer 级别的只读权限，且仅限该 Agent
//     配置范围内的知识库。
//
// 本函数不查数据库，也不从"执行租户"推断归属——授权必须由更早的步骤解析并
// 写入 context；同时会重新应用 API Key 的知识库白名单，grant 不能放宽 Key 的
// 知识库范围。
//
// required 非法、kbID/tenantID 为空、或没有任何授权匹配时，一律返回 false。
// 若还需考虑"所有者"或"组织共享"，调用方应与 KBPermissions.Check 组合使用。
func HasKBGrant(ctx context.Context, kbID string, tenantID uint64, required types.OrgMemberRole) bool {
	// 判断角色值是否合法以及目标 Scope 是否有访问此知识库的权限
	if !required.IsValid() || types.AuthorizeTenantAPIKeyKnowledgeBases(ctx, kbID) != nil {
		return false
	}
	// 返回调用者的 Context，包括其租户，用户 ID 以及其所属角色
	caller := types.CallerFromContext(ctx)
	if kbID == "" || tenantID == 0 {
		return false
	}
	grants, _ := ctx.Value(types.KBGrantsContextKey).([]kbGrant)
	for _, grant := range grants {
		if (caller.TenantID != 0 || grant.task) && grant.caller == caller && grant.kbID == kbID &&
			grant.tenantID == tenantID &&
			grant.permission.HasPermission(required) {
			return true
		}
	}
	// 这是 HasKBGrant 的最后兜底分支：
	// 普通 kbGrant 都没匹配上时，再检查"共享 Agent 授权"是否允许这次访问。
	grant, ok := ctx.Value(types.SharedAgentGrantContextKey).(agentGrant)
	return ok && caller.TenantID != 0 && required == types.OrgRoleViewer && grant.caller == caller &&
		grant.scope.Allows(kbID, tenantID)
}

// KBPermissions 在一次服务操作内综合三种授权来源，判断调用方能否访问某个知识库：
//  1. 同租户只读：调用方租户就是知识库所属租户，且本次只要求 viewer；
//  2. 显式授权：context 中已解析好的 kbGrant / 共享 Agent 授权；
//  3. 组织共享：由 shares 惰性查询并缓存结果。
//
// 它只做判断，不修改 context，也不直接查库。调用方身份在构造时快照，
// 之后即使执行租户被切换，授权基准也不会改变。
//
// shares 为 nil 表示该入口不允许通过组织共享扩展权限（例如没有用户的调用方），
// 此时跨租户共享分支一律不通过。
type KBPermissions struct {
	ctx    context.Context
	caller types.Caller
	shares *KBSharePermissions
}

// NewKBPermissions resolves reads for one caller and operation.
func NewKBPermissions(ctx context.Context, shares KBShareLookup) *KBPermissions {
	caller := types.CallerFromContext(ctx)
	return &KBPermissions{
		ctx:    ctx,
		caller: caller,
		shares: NewKBSharePermissions(ctx, shares, caller.TenantID, caller.Role),
	}
}

// Check 判断当前调用方能否以 required 级别访问 kbID，是三种授权来源的最终组合。
//
// 判定顺序：
//  1. 参数非法（kbID/ownerTenantID 为空、required 非法）→ 无权限；
//  2. API Key 的 KB 白名单不允许 → 返回 error（硬拒绝，不是普通的无权限）；
//  3. 同租户且只要求 viewer，或 context 中存在匹配的显式授权 → 允许；
//  4. 调用方无租户，或与 KB 同租户但没有授权 → 无权限（不再尝试组织共享）；
//  5. 跨租户 → 查询组织共享（惰性查询，结果按 kbID 缓存）。
//
// 返回值约定：
//   - (true, nil)   允许；
//   - (false, nil)  没有权限，调用方可据此过滤/跳过该 KB；
//   - (false, err)  明确的拒绝或查询失败，调用方应中止并报告。
//
// 本方法不检查路由级角色、API Key 的 capability/full-access，也不重新解析身份；
// 这些分别由中间件和 APIKeyGate 负责。
func (p *KBPermissions) Check(kbID string, ownerTenantID uint64, required types.OrgMemberRole) (bool, error) {
	if kbID == "" || ownerTenantID == 0 || !required.IsValid() {
		return false, nil
	}
	if err := types.AuthorizeTenantAPIKeyKnowledgeBases(p.ctx, kbID); err != nil {
		return false, err
	}
	if (p.caller.TenantID == ownerTenantID && required == types.OrgRoleViewer) ||
		HasKBGrant(p.ctx, kbID, ownerTenantID, required) {
		return true, nil
	}
	if p.caller.TenantID == 0 || p.caller.TenantID == ownerTenantID {
		return false, nil
	}
	return p.shares.Check(kbID, required)
}
