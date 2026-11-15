package types

import (
	"context"
	"fmt"
	"strings"
)

const (
	PrincipalWebUser         = "web_user"
	PrincipalAPITenant       = "api_tenant"
	PrincipalAPIPlatform     = "api_platform"
	PrincipalAPIExternalUser = "api_external_user"
	PrincipalIMUser          = "im_user"
	PrincipalEmbedChannel    = "embed_channel"
	PrincipalEmbedSession    = "embed_session"
	PrincipalEmbedVisitor    = "embed_visitor"
	PrincipalMCPEndpoint     = "mcp_endpoint"
)

// EmbedVisitorHeader is sent by the embed widget to identify a browser visitor
// across chat sessions within the same channel.
const EmbedVisitorHeader = "X-Embed-Visitor"

// SessionOwnerAPITenantKeyPrefix prefixes sessions.user_id for rows created by a
// tenant API key. The full owner id is "api_tenant_key:<tenantID>:<keyID>", so a
// LIKE '<prefix>%' selects every API-key session in the tenant.
const SessionOwnerAPITenantKeyPrefix = "api_tenant_key:"

// SessionOwnerAPIExternalUserPrefix prefixes sessions.user_id for rows created
// by a tenant API key whose request resolved an external-user identity. The
// remainder is "<tenantID>:<externalUserID>".
const SessionOwnerAPIExternalUserPrefix = PrincipalAPIExternalUser + ":"

// IsAPISessionOwnerID reports whether a stored session owner was produced by
// a tenant API-key request, with or without an external-user identity.
func IsAPISessionOwnerID(ownerID string) bool {
	ownerID = strings.TrimSpace(ownerID)
	return strings.HasPrefix(ownerID, SessionOwnerAPITenantKeyPrefix) ||
		strings.HasPrefix(ownerID, SessionOwnerAPIExternalUserPrefix)
}

// Principal 表示一次请求的最终调用主体，用于按主体做数据隔离。
//
// 它有意与 UserID 分开：IM 用户、嵌入访客、API Key 等主体并不是 WeKnora
// 账号，不能也不应因此获得 RBAC 权限。Type 与 ID 共同构成 StorageID
// （"type:id"），在会话归属等场景作为隔离键。
type Principal struct {
	// Type 是主体类型，如 web_user、api_tenant、api_platform、
	// api_external_user、im_user、embed_*、mcp_endpoint。
	Type string
	// ID 是主体在该类型下的标识。不同 Type 的 ID 可能重复，
	// 因此必须和 Type 一起使用，不能单独当作全局唯一 ID。
	ID   string
	// ActingVia 记录「主体不在场时，谁在替它执行」，如 "automation:<id>"。
	// 为空表示主体本人操作。它不改变授权主体，也不参与 StorageID：
	// 本次运行仍归 Type+ID 所有，审批也由它负责。
	ActingVia string
}

func (p Principal) Normalize() Principal {
	return Principal{
		Type:      strings.TrimSpace(p.Type),
		ID:        strings.TrimSpace(p.ID),
		ActingVia: strings.TrimSpace(p.ActingVia),
	}
}

func (p Principal) Valid() bool {
	p = p.Normalize()
	return p.Type != "" && p.ID != ""
}

// 拼接 p.Type + ":" + p.ID 用来当作其 ID,
// 主要是用来区分用户 ID
func (p Principal) StorageID() string {
	p = p.Normalize()
	if !p.Valid() {
		return ""
	}
	return p.Type + ":" + p.ID
}

func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	principal = principal.Normalize()
	if !principal.Valid() {
		return ctx
	}
	return context.WithValue(ctx, PrincipalContextKey, principal)
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	if ctx == nil {
		return Principal{}, false
	}
	if p, ok := ctx.Value(PrincipalContextKey).(Principal); ok && p.Valid() {
		return p.Normalize(), true
	}
	if uid, ok := UserIDFromContext(ctx); ok && strings.TrimSpace(uid) != "" {
		return Principal{Type: PrincipalWebUser, ID: uid}, true
	}
	return Principal{}, false
}

func WithEmbedVisitorID(ctx context.Context, visitorID string) context.Context {
	visitorID = strings.TrimSpace(visitorID)
	if visitorID == "" {
		return ctx
	}
	return context.WithValue(ctx, EmbedVisitorContextKey, visitorID)
}

func EmbedVisitorIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(EmbedVisitorContextKey).(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// EmbedSessionPrincipal identifies a single embed visitor chat session.
// MCPEndpointPrincipal identifies calls made through a workspace MCP
// endpoint. Sessions and messages created by the ask tool are owned by it.
func MCPEndpointPrincipal(tenantID uint64, endpointID string) Principal {
	return Principal{
		Type: PrincipalMCPEndpoint,
		ID:   fmt.Sprintf("%d:%s", tenantID, endpointID),
	}
}

func EmbedSessionPrincipal(tenantID uint64, channelID, sessionID string) Principal {
	return Principal{
		Type: PrincipalEmbedSession,
		ID:   fmt.Sprintf("%d:%s:%s", tenantID, strings.TrimSpace(channelID), strings.TrimSpace(sessionID)),
	}
}

// EmbedVisitorPrincipal identifies one anonymous embed visitor (browser).
func EmbedVisitorPrincipal(tenantID uint64, channelID, visitorID string) Principal {
	return Principal{
		Type: PrincipalEmbedVisitor,
		ID:   fmt.Sprintf("%d:%s:%s", tenantID, strings.TrimSpace(channelID), strings.TrimSpace(visitorID)),
	}
}

// ValidateEmbedVisitorID checks the client-supplied anonymous visitor id.
func ValidateEmbedVisitorID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("empty embed visitor id")
	}
	if len(id) > 128 {
		return fmt.Errorf("embed visitor id too long (max 128)")
	}
	for _, r := range id {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("embed visitor id contains invalid characters")
		}
	}
	return nil
}

// MCPOAuthPrincipalFromContext resolves the OAuth token principal for ctx.
// Embed chat sessions map to a per-visitor principal when X-Embed-Visitor is
// present; otherwise OAuth falls back to the chat session principal.
func MCPOAuthPrincipalFromContext(ctx context.Context) Principal {
	p, ok := PrincipalFromContext(ctx)
	if !ok {
		return Principal{}
	}
	p = p.Normalize()
	if p.Type != PrincipalEmbedSession {
		return p
	}
	visitorID := EmbedVisitorIDFromContext(ctx)
	if visitorID == "" {
		return p
	}
	parts := strings.SplitN(p.ID, ":", 3)
	if len(parts) < 2 {
		return p
	}
	tenantPart := strings.TrimSpace(parts[0])
	channelPart := strings.TrimSpace(parts[1])
	if tenantPart == "" || channelPart == "" {
		return p
	}
	var tenantID uint64
	if _, err := fmt.Sscanf(tenantPart, "%d", &tenantID); err != nil || tenantID == 0 {
		return Principal{Type: PrincipalEmbedVisitor, ID: tenantPart + ":" + channelPart + ":" + visitorID}
	}
	return EmbedVisitorPrincipal(tenantID, channelPart, visitorID)
}

// SessionOwnerIDFromContext returns the sessions.user_id scope for the current
// caller. API external users and embed chat sessions use principal-derived IDs;
// tenant API keys are isolated per key id; MCP OAuth token storage uses
// MCPOAuthPrincipalFromContext (visitor-level for embed).
//
// PrincipalMCPEndpoint must resolve to StorageID() too: the MCP `ask` tool
// creates its session with `MCPEndpointPrincipal(...).StorageID()` and then
// looks it up through this function. Without the case below the lookup falls
// through to the raw user id ("mcp-<endpointID>"), which never matches the
// stored owner ("mcp_endpoint:<tenantID>:<endpointID>"), so every ask call
// failed with "failed to create user message: session not found".
func SessionOwnerIDFromContext(ctx context.Context) string {
	if p, ok := PrincipalFromContext(ctx); ok {
		switch p.Type {
		case PrincipalAPIExternalUser, PrincipalEmbedSession, PrincipalMCPEndpoint:
			return p.StorageID()
		case PrincipalAPITenant:
			if scope, ok := TenantAPIKeyScopeFromContext(ctx); ok && scope.KeyID > 0 {
				if tenantID, ok := TenantIDFromContext(ctx); ok && tenantID > 0 {
					return fmt.Sprintf("%s%d:%d", SessionOwnerAPITenantKeyPrefix, tenantID, scope.KeyID)
				}
			}
		}
	}
	userID, _ := UserIDFromContext(ctx)
	return userID
}

// Authentication sources recorded on sessions.owner_auth_source. The values
// match internal/sandbox/allocation.AuthSource.
const (
	AuthSourceWeb             = "web"
	AuthSourceAPITenantKey    = "api_tenant_key"
	AuthSourceAPIPlatformKey  = "api_platform_key"
	AuthSourceAPIDirectHeader = "api_direct_header"
	AuthSourceAPISignedToken  = "api_signed_token"
	AuthSourceEmbed           = "embed"
	AuthSourceIM              = "im"
	AuthSourceMCPEndpoint     = "mcp_endpoint"
	AuthSourceInternal        = "internal"
	AuthSourceUnknown         = "unknown"
)

// WithPrincipalAuthSource records how the request's principal was verified.
func WithPrincipalAuthSource(ctx context.Context, source string) context.Context {
	source = strings.TrimSpace(source)
	if source == "" {
		return ctx
	}
	return context.WithValue(ctx, PrincipalAuthSourceContextKey, source)
}

// PrincipalAuthSourceFromContext returns "" when no auth middleware ran.
func PrincipalAuthSourceFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(PrincipalAuthSourceContextKey).(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// StampSessionOwnerSource overwrites the owner's authentication source from
// the verified request context. The caller's credentials only vouch for a row
// whose owner is the caller's own owner scope; anything else (internal
// services, a row created on someone's behalf) is recorded as internal. The
// owner's kind is not stored: it follows from the source and user_id.
func StampSessionOwnerSource(ctx context.Context, s *Session) {
	if s == nil {
		return
	}
	if strings.TrimSpace(s.UserID) == "" {
		s.OwnerAuthSource = AuthSourceUnknown
		return
	}
	source := PrincipalAuthSourceFromContext(ctx)
	if _, ok := PrincipalFromContext(ctx); !ok || source == "" || SessionOwnerIDFromContext(ctx) != s.UserID {
		s.OwnerAuthSource = AuthSourceInternal
		return
	}
	s.OwnerAuthSource = source
}

// AuthSourceForBoundOwnerID describes an owner bound after creation (MCP ask,
// embed backfill). Those binders only ever bind shared-entry or channel
// owners, so the result can never qualify a session for a shared machine.
func AuthSourceForBoundOwnerID(ownerID string) string {
	switch {
	case strings.HasPrefix(ownerID, PrincipalMCPEndpoint+":"):
		return AuthSourceMCPEndpoint
	case strings.HasPrefix(ownerID, PrincipalEmbedSession+":"):
		return AuthSourceEmbed
	default:
		return AuthSourceInternal
	}
}
