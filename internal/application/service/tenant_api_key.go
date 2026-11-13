package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	apprepo "github.com/Tencent/WeKnora/internal/application/repository"
	"github.com/Tencent/WeKnora/internal/logger"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
)

// apiKeyLastUsedMinInterval bounds how often we persist last_used_at per key.
// The UI only needs minute-level freshness; throttling avoids a DB write on
// every authenticated request under high QPS.
const apiKeyLastUsedMinInterval = time.Minute

type tenantAPIKeyService struct {
	repo          interfaces.TenantAPIKeyRepository
	lastUsedTouch sync.Map // key ID (uint64) -> time.Time of last persisted touch
}

func NewTenantAPIKeyService(repo interfaces.TenantAPIKeyRepository) interfaces.TenantAPIKeyService {
	return &tenantAPIKeyService{repo: repo}
}

func (s *tenantAPIKeyService) CreateAPIKey(
	ctx context.Context, req interfaces.TenantAPIKeyCreateRequest,
) (*interfaces.TenantAPIKeyCreateResult, error) {
	scopeType := types.NormalizeAPIKeyScopeType(req.ScopeType)
	if scopeType == types.APIKeyScopeTenant && req.TenantID == 0 {
		return nil, errors.New("tenant_id is required")
	}
	if scopeType == types.APIKeyScopePlatform && req.FullAccess {
		return nil, errors.New("platform API keys require explicit capabilities")
	}
	capabilities := types.NormalizeAPIKeyCapabilities(types.StringArray(req.Capabilities))
	if scopeType == types.APIKeyScopePlatform && len(capabilities) == 0 {
		return nil, errors.New("platform API keys require at least one capability")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return nil, errors.New("name is required")
	}
	token, err := generateTenantAPIKeyToken()
	if err != nil {
		return nil, err
	}
	expiresAt := req.ExpiresAt
	if expiresAt != nil {
		utc := expiresAt.UTC()
		expiresAt = &utc
	}
	var tenantID *uint64
	if scopeType == types.APIKeyScopeTenant {
		tenantID = &req.TenantID
	}
	key := &types.TenantAPIKey{
		TenantID:         tenantID,
		ScopeType:        scopeType,
		Name:             name,
		KeyHash:          hashTenantAPIKey(token),
		APIKey:           token,
		FullAccess:       req.FullAccess,
		KnowledgeBaseIDs: normalizeAPIKeyIDs(req.KnowledgeBaseIDs),
		Capabilities:     capabilities,
		ExpiresAt:        expiresAt,
	}
	if key.FullAccess {
		key.KnowledgeBaseIDs = nil
		key.Capabilities = nil
	}
	if err := s.repo.CreateAPIKey(ctx, key); err != nil {
		return nil, err
	}
	return &interfaces.TenantAPIKeyCreateResult{APIKey: key, Token: token}, nil
}

func (s *tenantAPIKeyService) AuthenticateAPIKey(ctx context.Context, token string) (*types.TenantAPIKey, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, apprepo.ErrTenantAPIKeyNotFound
	}
	key, err := s.repo.GetAPIKeyByHash(ctx, hashTenantAPIKey(token))
	if err != nil {
		return nil, err
	}
	if key.RevokedAt != nil {
		return nil, apprepo.ErrTenantAPIKeyNotFound
	}
	if key.ExpiresAt != nil && time.Now().UTC().After(key.ExpiresAt.UTC()) {
		return nil, apprepo.ErrTenantAPIKeyNotFound
	}
	s.touchAPIKeyLastUsedAsync(key.ID)
	return key, nil
}

// touchAPIKeyLastUsedAsync 异步更新 API Key 的 last_used_at，
// 但保证同一个 Key 每个 apiKeyLastUsedMinInterval（1 分钟）最多写一次库。
//
// 认证是高频热路径，而前端只需要分钟级的"最后使用"精度，因此：
//   - 先在内存节流表 lastUsedTouch 中检查/记录时间，窗口内的请求直接返回；
//   - 通过独立 goroutine 写库，认证延迟不依赖这次 UPDATE；
//   - 使用 context.Background()，即使原请求已取消，使用记录仍会写入；
//   - 写库失败时删除节流记录，让下一次请求可以重试。
//
// 节流表只存在于进程内存中，重启即清空；多副本部署时每个实例各自节流，
// 最坏情况下每个 Key 每分钟最多产生"副本数"次写入。
func (s *tenantAPIKeyService) touchAPIKeyLastUsedAsync(keyID uint64) {
	now := time.Now().UTC()
	// 1.距离上次写库不足 1 分钟 -> 直接跳过
	if v, ok := s.lastUsedTouch.Load(keyID); ok {
		if now.Sub(v.(time.Time)) < apiKeyLastUsedMinInterval {
			return
		}
	}
	// 2.先记录本次写入时间（并发请求也会看到，从而一并跳过）
	s.lastUsedTouch.Store(keyID, now)
	// 3.后台 goroutine 写库，不阻塞认证
	go func(id uint64, at time.Time) {
		// 写库操作
		if err := s.repo.UpdateAPIKeyLastUsed(context.Background(), id, at); err != nil {
			logger.Warnf(context.Background(),
				"failed to update tenant api key last_used_at (id=%d): %v", id, err)
			s.lastUsedTouch.Delete(id)
		}
	}(keyID, now)
}

func (s *tenantAPIKeyService) ListAPIKeys(ctx context.Context, tenantID uint64) ([]*types.TenantAPIKey, error) {
	return s.repo.ListAPIKeys(ctx, tenantID)
}

func (s *tenantAPIKeyService) ListPlatformAPIKeys(ctx context.Context) ([]*types.TenantAPIKey, error) {
	return s.repo.ListPlatformAPIKeys(ctx)
}

// UpdateAPIKey 按创建接口的相同语义更新租户 API Key 配置。
// scoped Key 需要至少一个能力；full-access Key 会清空细粒度能力和知识库范围。
func (s *tenantAPIKeyService) UpdateAPIKey(
	ctx context.Context, req interfaces.TenantAPIKeyUpdateRequest,
) (*types.TenantAPIKey, error) {
	if req.TenantID == 0 {
		return nil, errors.New("tenant_id is required")
	}
	if req.APIKeyID == 0 {
		return nil, errors.New("api_key_id is required")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return nil, errors.New("name is required")
	}
	capabilities := types.NormalizeAPIKeyCapabilities(types.StringArray(req.Capabilities))
	if !req.FullAccess && len(capabilities) == 0 {
		return nil, errors.New("capabilities are required for scoped API keys")
	}
	expiresAt := req.ExpiresAt
	if expiresAt != nil {
		utc := expiresAt.UTC()
		expiresAt = &utc
	}
	key := &types.TenantAPIKey{
		Name:             name,
		FullAccess:       req.FullAccess,
		KnowledgeBaseIDs: normalizeAPIKeyIDs(req.KnowledgeBaseIDs),
		Capabilities:     capabilities,
		ExpiresAt:        expiresAt,
	}
	if key.FullAccess {
		key.KnowledgeBaseIDs = nil
		key.Capabilities = nil
	}
	return s.repo.UpdateAPIKey(ctx, req.TenantID, req.APIKeyID, key)
}

func (s *tenantAPIKeyService) RevokeAPIKey(ctx context.Context, tenantID uint64, id uint64) error {
	return s.repo.RevokeAPIKey(ctx, tenantID, id)
}

func (s *tenantAPIKeyService) RevokePlatformAPIKey(ctx context.Context, id uint64) error {
	return s.repo.RevokePlatformAPIKey(ctx, id)
}

func (s *tenantAPIKeyService) BackfillMissingKeyHashes(ctx context.Context) (int, error) {
	has, err := s.repo.HasKeysWithPlaceholderHash(ctx)
	if err != nil {
		return 0, err
	}
	if !has {
		return 0, nil
	}
	keys, err := s.repo.ListKeysWithPlaceholderHash(ctx)
	if err != nil {
		return 0, err
	}
	backfilled := 0
	for _, key := range keys {
		if key == nil || strings.TrimSpace(key.APIKey) == "" {
			continue
		}
		hash := hashTenantAPIKey(key.APIKey)
		if key.KeyHash == hash {
			continue
		}
		if err := s.repo.UpdateAPIKeyHash(ctx, key.ID, hash); err != nil {
			return backfilled, err
		}
		backfilled++
	}
	return backfilled, nil
}

func generateTenantAPIKeyToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "sk-" + base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func hashTenantAPIKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func normalizeAPIKeyIDs(in []string) types.StringArray {
	out := types.StringArray{}
	seen := map[string]struct{}{}
	for _, id := range in {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
