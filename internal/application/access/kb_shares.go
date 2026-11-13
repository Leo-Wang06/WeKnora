package access

import (
	"context"

	"github.com/Tencent/WeKnora/internal/types"
)

// KBSharePermissions resolves organization grants for one caller during one
// operation. It deliberately does not grant tenant ownership or shared-agent
// access. Callers retain their own policy for lookup failures (abort or filter).
// Create a new instance for each operation; it is not a cross-request cache and
// must not be shared between goroutines.
// 
// KBSharePermissions 在一次操作内解析某个调用者（租户 + 角色）获得的组织共享权限，
// 并对同一 KB 的重复查询做请求内缓存。
//
// 它只覆盖"组织共享"这一种授权来源：既不处理租户所有权，也不处理共享 Agent 访问。
// 查询失败时的策略（中止还是过滤）由调用方决定。
//
// 生命周期为一次操作：每次操作新建实例；它不是跨请求缓存，也不能在 goroutine
// 之间共享（results 是无锁 map）。
type KBSharePermissions struct {
	ctx      context.Context
	lookup   KBShareLookup // 实际查共享数据的依赖接口（生产环境是数据库实现）
	tenantID uint64 // 调用者所属租户——要查的是"这个租户有没有被共享"
	role     types.TenantRole // 调用者在该租户中的角色，作为共享权限的上限
	results  map[string]kbSharePermission // 本次操作内的缓存：kbID → 共享判定结果
}

// kbSharePermission 是 KBSharePermissions.results 的缓存项：
// 记录某个 KB 对当前租户的共享判定结果，包括失败结果。
type kbSharePermission struct {
	role   types.OrgMemberRole
	shared bool
	err    error
}

// NewKBSharePermissions 创建一个请求级（单次操作内有效）的共享权限判定缓存。
// 调用者的租户和角色在这里被固定下来，后续每次 Check 都以同一个调用者为基准；
// results 在此初始化，调用方无需判空。
//
// 本函数不发起任何查询：真正的共享数据在第一次 Permission/Check 时才通过
// lookup 读取。lookup、tenantID 或 role 为空时，Check 一律返回 false。
func NewKBSharePermissions(
	ctx context.Context,
	lookup KBShareLookup,
	tenantID uint64,
	role types.TenantRole,
) *KBSharePermissions {
	return &KBSharePermissions{
		ctx:      ctx,
		lookup:   lookup,
		tenantID: tenantID,
		role:     role,
		results:  make(map[string]kbSharePermission),
	}
}

// Permission caches both grants and failures so multiple documents/chunks in a
// KB observe the same decision, without repeating the membership queries.
func (p *KBSharePermissions) Permission(kbID string) (types.OrgMemberRole, bool, error) {
	if kbID == "" || p.tenantID == 0 || p.lookup == nil {
		return "", false, nil
	}
	result, ok := p.results[kbID]
	if !ok {
		result.role, result.shared, result.err = p.lookup.CheckTenantKBPermission(p.ctx, kbID, p.tenantID, p.role)
		p.results[kbID] = result
	}
	return result.role, result.shared, result.err
}

// Check tests the required role against the cached organization permission.
func (p *KBSharePermissions) Check(kbID string, required types.OrgMemberRole) (bool, error) {
	role, shared, err := p.Permission(kbID)
	return err == nil && shared && role.IsValid() && required.IsValid() && role.HasPermission(required), err
}
