package interfaces

import (
	"context"
	"time"

	"github.com/Tencent/WeKnora/internal/types"
)

// TenantService 定义空间（租户）的业务接口（业务逻辑层）。
type TenantService interface {
	// CreateTenant 创建空间。
	CreateTenant(ctx context.Context, tenant *types.Tenant) (*types.Tenant, error)
	// GetTenantByID 按 ID 获取空间。
	GetTenantByID(ctx context.Context, id uint64) (*types.Tenant, error)
	// GetTenantsByIDs 一次查询批量获取多个空间，返回以空间 ID 为键的 map，
	// 便于调用方 O(1) 查找；不存在的 ID 不会出现在 map 中。
	GetTenantsByIDs(ctx context.Context, ids []uint64) (map[uint64]*types.Tenant, error)
	// ListTenants 列出所有空间。
	ListTenants(ctx context.Context) ([]*types.Tenant, error)
	// UpdateTenant 更新空间。
	UpdateTenant(ctx context.Context, tenant *types.Tenant) (*types.Tenant, error)
	// UpdateTenantProfile 只更新传入的展示字段（名称、描述），允许把描述置空。
	UpdateTenantProfile(ctx context.Context, id uint64, name, description *string) (*types.Tenant, error)
	// DeleteTenant 删除空间（软删除）。
	DeleteTenant(ctx context.Context, id uint64) error
	// ListAllTenants 列出所有空间，供拥有跨空间访问权限的用户使用。
	ListAllTenants(ctx context.Context) ([]*types.Tenant, error)
	// BulkSetStorageQuota 用 quotaBytes 覆盖所有空间的 storage_quota，返回受影响行数。
	// 供系统管理员「把默认配额套用到所有空间」使用；它绕过 PUT /tenants/:id 的
	// 逐字段白名单（该接口刻意禁止 Owner 修改存储配额）。
	// quotaBytes 必须 > 0；GB→字节的换算由调用方负责。
	BulkSetStorageQuota(ctx context.Context, quotaBytes int64) (int64, error)
	// SearchTenants 按关键字和空间 ID 分页搜索空间。
	SearchTenants(ctx context.Context, keyword string, tenantID uint64, page, pageSize int) ([]*types.Tenant, int64, error)
	// GetTenantByIDForUser 按 ID 获取空间，并校验指定用户是否有权访问。
	GetTenantByIDForUser(ctx context.Context, tenantID uint64, userID string) (*types.Tenant, error)
	// GetWeKnoraCloudCredentials 返回当前空间解密后的 WeKnoraCloud 凭据。
	GetWeKnoraCloudCredentials(ctx context.Context) *types.WeKnoraCloudCredentials
}

// TenantRepository 定义空间的存储接口（数据访问层）。
type TenantRepository interface {
	// CreateTenant 创建空间。
	CreateTenant(ctx context.Context, tenant *types.Tenant) error
	// GetTenantByID 按 ID 获取空间。
	GetTenantByID(ctx context.Context, id uint64) (*types.Tenant, error)
	// GetTenantsByIDs 批量查询空间，语义见 TenantService.GetTenantsByIDs。
	GetTenantsByIDs(ctx context.Context, ids []uint64) (map[uint64]*types.Tenant, error)
	// ListTenants 列出所有空间。
	ListTenants(ctx context.Context) ([]*types.Tenant, error)
	// SearchTenants 按关键字和空间 ID 分页搜索空间。
	SearchTenants(ctx context.Context, keyword string, tenantID uint64, page, pageSize int) ([]*types.Tenant, int64, error)
	// UpdateTenant 更新空间。
	UpdateTenant(ctx context.Context, tenant *types.Tenant) error
	// UpdateTenantProfile 只更新传入的展示字段（名称、描述）。
	UpdateTenantProfile(ctx context.Context, id uint64, name, description *string) error
	// DeleteTenant 删除空间（软删除）。
	DeleteTenant(ctx context.Context, id uint64) error
	// AdjustStorageUsed 调整已用存储量，delta 可正可负。
	AdjustStorageUsed(ctx context.Context, tenantID uint64, delta int64) error
	// BulkSetStorageQuota 语义见 TenantService.BulkSetStorageQuota。
	BulkSetStorageQuota(ctx context.Context, quotaBytes int64) (int64, error)
}

type TenantAPIKeyCreateRequest struct {
	TenantID         uint64
	ScopeType        types.APIKeyScopeType
	Name             string
	FullAccess       bool
	KnowledgeBaseIDs []string
	Capabilities     []string
	ExpiresAt        *time.Time
}

type TenantAPIKeyCreateResult struct {
	APIKey *types.TenantAPIKey
	Token  string
}

// TenantAPIKeyUpdateRequest 修改已创建租户 API Key 的可配置属性。
// 配置语义与创建接口一致：FullAccess 为 true 时忽略细粒度能力和知识库范围。
type TenantAPIKeyUpdateRequest struct {
	TenantID         uint64
	APIKeyID         uint64
	Name             string
	FullAccess       bool
	KnowledgeBaseIDs []string
	Capabilities     []string
	ExpiresAt        *time.Time
}

// TenantAPIKeyRepository 是 API Key 的存储协议（数据访问层）。
//
// 它只负责对 tenant_api_keys 表做基础读写，不包含任何业务规则：
// 生成密钥、计算哈希、校验权限等都在 TenantAPIKeyService 中完成。
// 抽成接口的目的：
//   - 生产环境注入基于 GORM/Postgres 的实现；
//   - 单元测试注入内存实现，无需连接数据库。
//
// 契约：查询不到时返回 ErrTenantAPIKeyNotFound（而不是 nil, nil）；
// 撤销是软删除，只写 RevokedAt 不删行；带 tenantID 的方法必须校验租户边界。
type TenantAPIKeyRepository interface {
	// CreateAPIKey 插入一条 Key 记录；key_hash 重复时返回错误（对应唯一索引）。
	CreateAPIKey(ctx context.Context, key *types.TenantAPIKey) error
	// GetAPIKeyByHash 按明文 Key 的 SHA-256 哈希查找记录，是认证的查询入口。
	GetAPIKeyByHash(ctx context.Context, hash string) (*types.TenantAPIKey, error)
	// ListAPIKeys 列出指定空间下未撤销的 Key。
	ListAPIKeys(ctx context.Context, tenantID uint64) ([]*types.TenantAPIKey, error)
	// ListPlatformAPIKeys 列出所有平台级 Key（TenantID 为 NULL）。
	ListPlatformAPIKeys(ctx context.Context) ([]*types.TenantAPIKey, error)
	// UpdateAPIKey 修改 Key 的可配置属性；必须校验目标 Key 属于 tenantID。
	UpdateAPIKey(ctx context.Context, tenantID uint64, id uint64, key *types.TenantAPIKey) (*types.TenantAPIKey, error)
	// RevokeAPIKey 软删除空间 Key：写入 revoked_at，记录本身保留。
	RevokeAPIKey(ctx context.Context, tenantID uint64, id uint64) error
	// RevokePlatformAPIKey 软删除平台级 Key。
	RevokePlatformAPIKey(ctx context.Context, id uint64) error
	// UpdateAPIKeyHash 回填 key_hash，仅供旧数据迁移使用。
	UpdateAPIKeyHash(ctx context.Context, id uint64, hash string) error
	// UpdateAPIKeyLastUsed 更新最近使用时间，由 service 的节流逻辑调用。
	UpdateAPIKeyLastUsed(ctx context.Context, id uint64, at time.Time) error
	// ListKeysWithPlaceholderHash returns keys whose key_hash is still the
	// migration placeholder (never authenticated since the 000065 upgrade),
	// so the real SHA-256 hash can be computed and backfilled.
	// 中文：返回 key_hash 仍是迁移占位值的记录（000065 升级后从未认证过），
	// 以便重新计算并写入真实的 SHA-256。
	ListKeysWithPlaceholderHash(ctx context.Context) ([]*types.TenantAPIKey, error)
	// HasKeysWithPlaceholderHash is a cheap existence probe used at startup
	// to skip loading/decrypting api_key rows once backfill is complete.
	// 中文：轻量探测是否还有未回填的记录；回填完成后启动时可直接跳过加载。
	HasKeysWithPlaceholderHash(ctx context.Context) (bool, error)
}

// TenantAPIKeyService 是 API Key 的业务协议（用例层）。
//
// 它在 TenantAPIKeyRepository 之上完成：
//   - 参数校验、生成 sk- 密钥、计算 SHA-256 哈希（CreateAPIKey）；
//   - 请求认证时的有效性检查与 last_used_at 节流更新（AuthenticateAPIKey）；
//   - 列表、编辑、撤销等管理操作；
//   - 旧数据哈希回填（BackfillMissingKeyHashes）。
//
// handler 与 middleware 只依赖本接口，不感知数据库实现。
type TenantAPIKeyService interface {
	// CreateAPIKey 校验参数、生成密钥与哈希并落库。
	// 返回的 Token 是明文 Key，仅在创建结果中出现。
	CreateAPIKey(ctx context.Context, req TenantAPIKeyCreateRequest) (*TenantAPIKeyCreateResult, error)
	// AuthenticateAPIKey 验证 Key 是否有效（存在、未撤销、未过期）。
	// 有效时返回完整记录，并异步节流更新 last_used_at。
	// 所有失效情况统一返回 ErrTenantAPIKeyNotFound，避免泄露具体原因。
	AuthenticateAPIKey(ctx context.Context, token string) (*types.TenantAPIKey, error)
	// ListAPIKeys 列出指定空间的 Key（含明文，供管理界面展示）。
	ListAPIKeys(ctx context.Context, tenantID uint64) ([]*types.TenantAPIKey, error)
	// ListPlatformAPIKeys 列出所有平台级 Key。
	ListPlatformAPIKeys(ctx context.Context) ([]*types.TenantAPIKey, error)
	// UpdateAPIKey 修改 Key 的名称、能力、知识库范围和过期时间；
	// FullAccess 为 true 时忽略细粒度能力与知识库范围。
	UpdateAPIKey(ctx context.Context, req TenantAPIKeyUpdateRequest) (*types.TenantAPIKey, error)
	// RevokeAPIKey 撤销空间 Key，立即失效。
	RevokeAPIKey(ctx context.Context, tenantID uint64, id uint64) error
	// RevokePlatformAPIKey 撤销平台级 Key，立即失效。
	RevokePlatformAPIKey(ctx context.Context, id uint64) error
	// BackfillMissingKeyHashes computes and persists the SHA-256 key_hash
	// for legacy keys still carrying the migration placeholder.
	// Returns the number of keys backfilled.
	// 中文：为仍带迁移占位哈希的旧 Key 计算并写入真实 SHA-256；
	// 返回回填条数，可重复调用（幂等）。
	BackfillMissingKeyHashes(ctx context.Context) (int, error)
}
