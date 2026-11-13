package types

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/Tencent/WeKnora/internal/errors"
	"github.com/Tencent/WeKnora/internal/utils"
	"gorm.io/gorm"
)

// TenantAPIKey is a revocable machine credential. Tenant-scoped and platform
// keys intentionally share one table; platform keys have tenant_id=NULL and
// choose a target workspace per request. KeyHash is used for authentication
// lookup; APIKey is stored encrypted when SYSTEM_AES_KEY is set.
type TenantAPIKey struct {
	ID               uint64          `json:"id" gorm:"primaryKey;autoIncrement"`
	TenantID         *uint64         `json:"tenant_id,omitempty" gorm:"index"`
	ScopeType        APIKeyScopeType `json:"scope_type" gorm:"type:varchar(16);not null;default:tenant;index"`
	Name             string          `json:"name" gorm:"type:varchar(128);not null"`
	KeyHash          string          `json:"-" gorm:"type:varchar(64);not null;uniqueIndex"`
	APIKey           string          `json:"api_key" gorm:"column:api_key;type:text;not null;default:''"`
	FullAccess       bool            `json:"full_access" gorm:"not null;default:false"`
	KnowledgeBaseIDs StringArray     `json:"knowledge_base_ids" gorm:"type:jsonb;not null;default:'[]'"`
	// Capabilities are bounded grants for non-full-access keys. Each
	// capability maps to an integration persona (retrieval, chat, ingest,
	// tenant infrastructure management, and history access). KB scoping
	// (KnowledgeBaseIDs) still applies on top where a route targets knowledge
	// bases.
	Capabilities StringArray `json:"capabilities" gorm:"type:jsonb;not null;default:'[]'"`
	LastUsedAt   *time.Time  `json:"last_used_at,omitempty"`
	ExpiresAt    *time.Time  `json:"expires_at,omitempty"`
	RevokedAt    *time.Time  `json:"revoked_at,omitempty" gorm:"index"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
}

type APIKeyScopeType string

const (
	APIKeyScopeTenant   APIKeyScopeType = "tenant"
	APIKeyScopePlatform APIKeyScopeType = "platform"
)

// NormalizeAPIKeyScopeType 是把类型字符串规整成 tenant 或 platform，
// 未知值一律保守地当作 tenant。两者的根本区别是：
// tenant 绑定并局限于一个工作区；
// platform 不绑定工作区、可跨租户操作，
// 但被强制要求逐项 capability 授权且不能全权限。
// 返回 SopeType 
func NormalizeAPIKeyScopeType(scope APIKeyScopeType) APIKeyScopeType {
	switch APIKeyScopeType(strings.ToLower(strings.TrimSpace(string(scope)))) {
	case APIKeyScopePlatform:
		return APIKeyScopePlatform
	default:
		return APIKeyScopeTenant
	}
}

func (k *TenantAPIKey) IsPlatform() bool {
	return k != nil && NormalizeAPIKeyScopeType(k.ScopeType) == APIKeyScopePlatform
}

func (k *TenantAPIKey) TenantIDValue() uint64 {
	if k == nil || k.TenantID == nil {
		return 0
	}
	return *k.TenantID
}

func (TenantAPIKey) TableName() string {
	return "tenant_api_keys"
}

// APIKeyCapability is a bounded grant on a tenant API key. See
// TenantAPIKey.Capabilities.
type APIKeyCapability string

const (
	// APIKeyCapabilityRetrieve lets a key read and search knowledge-base data
	// within its allowed KB scope without granting chat or content writes.
	APIKeyCapabilityRetrieve APIKeyCapability = "retrieve"
	// APIKeyCapabilityChat lets a scoped key run the conversation flow
	// (sessions + agent listing + self identity) without granting broader
	// tenant management access.
	APIKeyCapabilityChat APIKeyCapability = "chat"
	// APIKeyCapabilityReadAgents lets a scoped key list and inspect agents
	// without allowing chat sessions or agent authoring.
	APIKeyCapabilityReadAgents APIKeyCapability = "read_agents"
	// APIKeyCapabilityIngest lets a key write content into its allowed
	// knowledge bases (upload documents, edit chunks/FAQ/tags/wiki). It only
	// lifts the content-write routes: it never allows creating new knowledge
	// bases or agents, nor destructive KB clears, and the key's
	// knowledge_base_ids allow-list still bounds every write.
	APIKeyCapabilityIngest APIKeyCapability = "ingest"
	// APIKeyCapabilityManageKnowledgeBases lets a scoped key manage the full
	// knowledge-base lifecycle: create, copy, duplicate, rename/reconfigure,
	// and delete. For operations that target an existing KB (copy/duplicate
	// source, update, delete) the key's allowed KB scope still bounds which
	// KBs it may touch; create has no source to bound against, so a
	// scope-restricted key may add a new KB to its tenant (same-tenant, no
	// cross-tenant reach — the new KB simply falls outside the key's
	// allow-list and stays unmanageable by it). It is separate from ingest:
	// uploading or editing KB contents does not imply permission to manage
	// the KB itself.
	APIKeyCapabilityManageKnowledgeBases APIKeyCapability = "manage_kbs"
	// APIKeyCapabilityManageAgents lets a key create/read/update/delete/copy
	// agents. Agent config can carry sensitive model/MCP bindings, so this is
	// opt-in and off by default.
	APIKeyCapabilityManageAgents APIKeyCapability = "manage_agents"
	// APIKeyCapabilityMessageHistory lets a key search and inspect the
	// tenant-level chat-history knowledge base without granting full Owner
	// access. It is separate from chat: chat only covers the caller's own
	// live conversation flow, while message_history can expose historical
	// messages across the tenant.
	APIKeyCapabilityMessageHistory APIKeyCapability = "message_history"
	// APIKeyCapabilityManageModels lets a key manage tenant model
	// definitions, credentials, model checks, and WeKnoraCloud credentials.
	APIKeyCapabilityManageModels APIKeyCapability = "manage_models"
	// APIKeyCapabilityManageMCPServices lets a key manage tenant MCP service
	// definitions, credentials, tool policies, and per-principal OAuth state.
	APIKeyCapabilityManageMCPServices APIKeyCapability = "manage_mcp_services"
	// APIKeyCapabilityManageDataSources lets a key manage data-source
	// connectors and sync jobs. KB scoping applies to data sources bound to a
	// knowledge base.
	APIKeyCapabilityManageDataSources APIKeyCapability = "manage_datasources"
	// APIKeyCapabilityManageChannels lets a key manage embed and IM channel
	// integrations for agents.
	APIKeyCapabilityManageChannels APIKeyCapability = "manage_channels"
	// APIKeyCapabilityManageVectorStores lets a key manage retrieval
	// infrastructure such as vector stores, parser engines, and storage checks.
	APIKeyCapabilityManageVectorStores APIKeyCapability = "manage_vector_stores"
	// APIKeyCapabilityManageStorageBackends lets a key manage object/file
	// storage backend instances (e.g. S3-compatible or local file storage):
	// their CRUD lifecycle, connectivity tests, and the tenant default
	// selection. It is separate from manage_vector_stores because storage
	// backends are the file-persistence layer (holding object-store
	// credentials and user-controllable endpoints) rather than retrieval
	// infrastructure.
	APIKeyCapabilityManageStorageBackends APIKeyCapability = "manage_storage_backends"
	// APIKeyCapabilityManageWebSearch lets a key manage tenant web-search
	// provider configurations and credentials.
	APIKeyCapabilityManageWebSearch APIKeyCapability = "manage_web_search"
	// APIKeyCapabilityRunEvaluations lets a key run and inspect evaluation
	// jobs without full tenant ownership.
	APIKeyCapabilityRunEvaluations APIKeyCapability = "run_evaluations"
	// APIKeyCapabilityManageMembers lets a key list and manage tenant
	// members and invitations. It does not include API key management,
	// tenant deletion, or ownership transfer.
	APIKeyCapabilityManageMembers APIKeyCapability = "manage_members"
	// APIKeyCapabilityManageSpaces lets a key manage organization/space
	// collaboration surfaces such as space membership and join flows. It does
	// not grant KB/agent share management: share management is reserved for
	// full-access keys (and JWT) and scoped keys stay default-deny. This
	// capability never lifts it.
	APIKeyCapabilityManageSpaces APIKeyCapability = "manage_spaces"
	// APIKeyCapabilityManageTenantSettings lets a key read and update
	// tenant-scoped integration settings exposed under /tenants, such as API
	// principal mode, request headers, and tenant KV. It does not include API
	// key management, member management, tenant deletion, or ownership transfer.
	APIKeyCapabilityManageTenantSettings APIKeyCapability = "manage_tenant_settings"
	APIKeyCapabilitySystemTenantsRead    APIKeyCapability = "system_tenants_read"
	APIKeyCapabilitySystemTenantsManage  APIKeyCapability = "system_tenants_manage"
	APIKeyCapabilitySystemSettingsRead   APIKeyCapability = "system_settings_read"
	APIKeyCapabilitySystemSettingsManage APIKeyCapability = "system_settings_manage"
	APIKeyCapabilitySystemRuntimeRead    APIKeyCapability = "system_runtime_read"
	APIKeyCapabilitySystemRuntimeManage  APIKeyCapability = "system_runtime_manage"
	APIKeyCapabilitySystemAuditRead      APIKeyCapability = "system_audit_read"
)

// NormalizeAPIKeyCapability maps an input capability string to a known
// capability, returning "" for anything unrecognised so callers can drop it.
func NormalizeAPIKeyCapability(c APIKeyCapability) APIKeyCapability {
	switch APIKeyCapability(strings.ToLower(strings.TrimSpace(string(c)))) {
	case APIKeyCapabilityRetrieve:
		return APIKeyCapabilityRetrieve
	case APIKeyCapabilityChat:
		return APIKeyCapabilityChat
	case APIKeyCapabilityReadAgents:
		return APIKeyCapabilityReadAgents
	case APIKeyCapabilityIngest:
		return APIKeyCapabilityIngest
	case APIKeyCapabilityManageKnowledgeBases:
		return APIKeyCapabilityManageKnowledgeBases
	case APIKeyCapabilityManageAgents:
		return APIKeyCapabilityManageAgents
	case APIKeyCapabilityMessageHistory:
		return APIKeyCapabilityMessageHistory
	case APIKeyCapabilityManageModels:
		return APIKeyCapabilityManageModels
	case APIKeyCapabilityManageMCPServices:
		return APIKeyCapabilityManageMCPServices
	case APIKeyCapabilityManageDataSources:
		return APIKeyCapabilityManageDataSources
	case APIKeyCapabilityManageChannels:
		return APIKeyCapabilityManageChannels
	case APIKeyCapabilityManageVectorStores:
		return APIKeyCapabilityManageVectorStores
	case APIKeyCapabilityManageStorageBackends:
		return APIKeyCapabilityManageStorageBackends
	case APIKeyCapabilityManageWebSearch:
		return APIKeyCapabilityManageWebSearch
	case APIKeyCapabilityRunEvaluations:
		return APIKeyCapabilityRunEvaluations
	case APIKeyCapabilityManageMembers:
		return APIKeyCapabilityManageMembers
	case APIKeyCapabilityManageSpaces:
		return APIKeyCapabilityManageSpaces
	case APIKeyCapabilityManageTenantSettings:
		return APIKeyCapabilityManageTenantSettings
	case APIKeyCapabilitySystemTenantsRead:
		return APIKeyCapabilitySystemTenantsRead
	case APIKeyCapabilitySystemTenantsManage:
		return APIKeyCapabilitySystemTenantsManage
	case APIKeyCapabilitySystemSettingsRead:
		return APIKeyCapabilitySystemSettingsRead
	case APIKeyCapabilitySystemSettingsManage:
		return APIKeyCapabilitySystemSettingsManage
	case APIKeyCapabilitySystemRuntimeRead:
		return APIKeyCapabilitySystemRuntimeRead
	case APIKeyCapabilitySystemRuntimeManage:
		return APIKeyCapabilitySystemRuntimeManage
	case APIKeyCapabilitySystemAuditRead:
		return APIKeyCapabilitySystemAuditRead
	default:
		return ""
	}
}

// NormalizeAPIKeyCapabilities dedups and drops unknown capabilities.
func NormalizeAPIKeyCapabilities(in StringArray) StringArray {
	out := make(StringArray, 0, len(in))
	seen := map[string]struct{}{}
	for _, item := range in {
		norm := NormalizeAPIKeyCapability(APIKeyCapability(item))
		if norm == "" {
			continue
		}
		s := string(norm)
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func (k *TenantAPIKey) BeforeSave(tx *gorm.DB) error {
	if key := utils.GetAESKey(); key != nil && k.APIKey != "" {
		encrypted, err := utils.EncryptAESGCM(k.APIKey, key)
		if err != nil {
			// Never fall through to storing the plaintext key: abort the
			// write so the caller sees the failure instead of silently
			// persisting an unencrypted secret.
			return fmt.Errorf("encrypt tenant_api_keys.api_key (id=%d): %w", k.ID, err)
		}
		tx.Statement.SetColumn("api_key", encrypted)
	}
	return nil
}

func (k *TenantAPIKey) AfterFind(tx *gorm.DB) error {
	decrypted, err := utils.DecryptStoredSecret(k.APIKey)
	if err != nil {
		return fmt.Errorf("decrypt tenant_api_keys.api_key (id=%d): %w", k.ID, err)
	}
	k.APIKey = decrypted
	return nil
}

// TenantAPIKeyScope 是中间件使用的、存放在请求上下文中的作用域投影。
// 也就是 TenantAPIKey（数据库模型(完整记录)）的一个缩影，
// 故意不带密钥哈希、明文密钥、过期时间等这些字段。
// 供 middleware 这个中间件使用
type TenantAPIKeyScope struct {
	KeyID            uint64
	Name             string
	ScopeType        APIKeyScopeType
	FullAccess       bool
	KnowledgeBaseIDs StringArray // 这个 API Key 被允许访问的知识库 ID 列表
	Capabilities     StringArray
}

func WithTenantAPIKeyScope(ctx context.Context, scope TenantAPIKeyScope) context.Context {
	return context.WithValue(ctx, TenantAPIKeyScopeContextKey, scope.Normalize())
}

// TenantAPIKeyScopeFromContext：从请求上下文中取出（租户）API Key 的作用域信息
// 返回 (Scope) 作用域范围，以及是否成功的布尔值
// 用来校验规则卡
func TenantAPIKeyScopeFromContext(ctx context.Context) (TenantAPIKeyScope, bool) {
	if ctx == nil {
		return TenantAPIKeyScope{}, false
	}
	scope, ok := ctx.Value(TenantAPIKeyScopeContextKey).(TenantAPIKeyScope)
	if !ok {
		return TenantAPIKeyScope{}, false
	}
	return scope.Normalize(), true
}

// 进行格式化
func (s TenantAPIKeyScope) Normalize() TenantAPIKeyScope {
	return TenantAPIKeyScope{
		KeyID:            s.KeyID,
		Name:             s.Name,
		ScopeType:        NormalizeAPIKeyScopeType(s.ScopeType),
		FullAccess:       s.FullAccess,
		KnowledgeBaseIDs: normalizeIDArray(s.KnowledgeBaseIDs),
		Capabilities:     NormalizeAPIKeyCapabilities(s.Capabilities),
	}
}

// 判断 ScopeType 是不是属于 platform
// 返回布尔值
func (s TenantAPIKeyScope) IsPlatform() bool {
	return NormalizeAPIKeyScopeType(s.ScopeType) == APIKeyScopePlatform
}

// HasCapability reports whether the scope carries the given additive grant.
func (s TenantAPIKeyScope) HasCapability(c APIKeyCapability) bool {
	c = NormalizeAPIKeyCapability(c)
	if c == "" {
		return false
	}
	for _, item := range NormalizeAPIKeyCapabilities(s.Capabilities) {
		if item == string(c) {
			return true
		}
	}
	return false
}

// AllowsKnowledgeBase 判断请求的目标知识库是否落在 Key 的白名单内。
// 白名单为空表示该 Key 不受知识库范围限制。
func (s TenantAPIKeyScope) AllowsKnowledgeBase(kbID string) bool {
	kbID = strings.TrimSpace(kbID)
	// 如果是空字符串，就返回 false
	if kbID == "" {
		return false
	}
	// 格式化
	s = s.Normalize()
	// 白名单为非空，但是没有指定要访问哪个 KB -> 拒绝
	if len(s.KnowledgeBaseIDs) == 0 {
		return true
	}
	// 检查此 TenantAPIKeyScope 是否包含此次想要访问的知识库ID
	for _, allowed := range s.KnowledgeBaseIDs {
		if allowed == kbID {
			return true
		}
	}
	return false
}

// 检查这个 API Key 是否被限制在指定的一批知识库内，
// 因为有一个选项是可以选择此 API Key 的知识库范围的
func (s TenantAPIKeyScope) IsKnowledgeBaseRestricted() bool {
	return len(s.Normalize().KnowledgeBaseIDs) > 0
}

// AllowsKnowledgeBases 判断请求的目标知识库是否全部落在 Key 的白名单内。
// 白名单为空表示该 Key 不受知识库范围限制。
func (s TenantAPIKeyScope) AllowsKnowledgeBases(kbIDs []string) bool {
	// 格式化
	s = s.Normalize()
	// 白名单为空 -> Key 不受 KB 限制 -> 放行
	if len(s.KnowledgeBaseIDs) == 0 {
		return true
	}
	// Key 限制了范围，但调用方没指定目标 KB：无法验证，按 fail-closed 拒绝。
	// 正常调用方会先判 len(kbIDs) > 0，这里是防御性处理
	if len(kbIDs) == 0 {
		return false
	}
	// 遍历要访问的 kbIDs
	// 要求"全部包含"，而不是"任一命中"：只要有一个越界就拒绝
	for _, kbID := range kbIDs {
		// 
		if !s.AllowsKnowledgeBase(kbID) {
			return false
		}
	}
	return true
}

func normalizeIDArray(in StringArray) StringArray {
	out := make(StringArray, 0, len(in))
	seen := map[string]struct{}{}
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

// AuthorizeTenantAPIKeyKnowledgeBases rejects KB-restricted API key callers that
// target one or more knowledge bases outside their allow-list.
// 
// AuthorizeTenantAPIKeyKnowledgeBases 校验 API Key 调用方是否有权访问
// 指定的知识库：kbIDs 中只要有任何一个不在 Key 的知识库白名单内，就返回 403。
//
// 以下情况直接放行（本层检查不适用）：
//   - 不是 API Key 调用方（ctx 中没有 TenantAPIKeyScope）；
//   - 该 Key 没有设置知识库白名单；
//   - 本次没有指定具体知识库（kbIDs 为空）。
//
// 本函数只检查"知识库范围"，不检查 capability、full-access 或租户归属；
// 那些由 APIKeyGate、租户隔离、HasKBGrant 等分别负责。
func AuthorizeTenantAPIKeyKnowledgeBases(ctx context.Context, kbIDs ...string) error {
	// 取出上下文中的 TenantAPIKeyScope 的 Scope
	scope, ok := TenantAPIKeyScopeFromContext(ctx)
	// 非 API Key 调用方，或该 Key 没有设置 KB 白名单 → 本层不做限制
	if !ok || !scope.IsKnowledgeBaseRestricted() {
		return nil
	}
	// 只有指定了具体 KB 才校验；要求全部在白名单内，任意一个越界即拒绝
	if len(kbIDs) > 0 && !scope.AllowsKnowledgeBases(kbIDs) {
		return errors.NewForbiddenError("API key scope does not allow one or more knowledge bases")
	}
	return nil
}

// AuthorizeTenantAPIKeyKnowledgeTargets rejects KB-restricted API key callers
// that reference knowledge_ids without a verified KB binding, or kb_ids outside
// the allow-list.
func AuthorizeTenantAPIKeyKnowledgeTargets(ctx context.Context, kbIDs, knowledgeIDs []string) error {
	scope, ok := TenantAPIKeyScopeFromContext(ctx)
	if !ok || !scope.IsKnowledgeBaseRestricted() {
		return nil
	}
	if len(knowledgeIDs) > 0 {
		return errors.NewForbiddenError("API key scope does not allow knowledge_ids without a verified knowledge base")
	}
	if len(kbIDs) > 0 && !scope.AllowsKnowledgeBases(kbIDs) {
		return errors.NewForbiddenError("API key scope does not allow one or more knowledge bases")
	}
	return nil
}

// AuthorizeTenantAPIKeyOptionalTagIDs rejects tag_ids for KB-restricted keys
// because tag resolution can pull documents from arbitrary knowledge bases.
func AuthorizeTenantAPIKeyOptionalTagIDs(ctx context.Context, tagIDs []string) error {
	scope, ok := TenantAPIKeyScopeFromContext(ctx)
	if !ok || !scope.IsKnowledgeBaseRestricted() {
		return nil
	}
	if len(tagIDs) > 0 {
		return errors.NewForbiddenError("API key scope does not allow tag_ids without a verified knowledge base")
	}
	return nil
}

// FilterKnowledgeBasesForTenantAPIKeyScope intersects resolved KB IDs with the
// API key allow-list. When the caller supplied explicit kb_ids, every ID must
// be allowed; implicit agent defaults are intersected instead of rejected.
func FilterKnowledgeBasesForTenantAPIKeyScope(
	ctx context.Context, requestedKBIDs, resolvedKBIDs []string,
) ([]string, error) {
	scope, ok := TenantAPIKeyScopeFromContext(ctx)
	if !ok || !scope.IsKnowledgeBaseRestricted() {
		return resolvedKBIDs, nil
	}
	if len(requestedKBIDs) > 0 {
		if !scope.AllowsKnowledgeBases(requestedKBIDs) {
			return nil, errors.NewForbiddenError("API key scope does not allow one or more knowledge bases")
		}
		return resolvedKBIDs, nil
	}
	allowed := make(map[string]struct{}, len(scope.KnowledgeBaseIDs))
	for _, id := range scope.KnowledgeBaseIDs {
		allowed[id] = struct{}{}
	}
	filtered := make([]string, 0, len(resolvedKBIDs))
	for _, id := range resolvedKBIDs {
		if _, ok := allowed[id]; ok {
			filtered = append(filtered, id)
		}
	}
	return filtered, nil
}
