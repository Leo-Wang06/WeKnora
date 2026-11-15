package interfaces

import (
	"context"

	"github.com/Tencent/WeKnora/internal/types"
)

// UserService 定义用户的业务接口（业务逻辑层）。
type UserService interface {
	// Register 注册新用户账号。
	Register(ctx context.Context, req *types.RegisterRequest) (*types.User, error)
	// Login 校验用户身份并返回令牌。
	Login(ctx context.Context, req *types.LoginRequest) (*types.LoginResponse, error)
	// GetOIDCAuthorizationURL 构造第三方 OIDC 授权地址。
	GetOIDCAuthorizationURL(ctx context.Context, redirectURI string) (*types.OIDCAuthURLResponse, error)
	// LoginWithOIDC 用回调 code 换取令牌、必要时自动创建用户并完成登录。
	// provisioning 是自动创建新用户时使用的默认空间模式
	// （由调用方根据 auth.default_tenant_mode 解析）。
	LoginWithOIDC(
		ctx context.Context, code, redirectURI string,
		provisioning types.TenantProvisioningMode, codeVerifier string,
	) (*types.OIDCCallbackResponse, error)
	// GetUserByID 按 ID 获取用户。
	GetUserByID(ctx context.Context, id string) (*types.User, error)
	// GetUsersByIDs 按 ID 批量获取用户，返回以用户 ID 为键的 map。
	// 不存在的 ID 不会出现在结果中，部分 ID 查不到不算错误。
	// 用于成员列表、审计日志等热路径，避免 N+1 查询。
	GetUsersByIDs(ctx context.Context, ids []string) (map[string]*types.User, error)
	// GetUserByEmail 按邮箱获取用户。
	GetUserByEmail(ctx context.Context, email string) (*types.User, error)
	// GetUserByUsername 按用户名获取用户。
	GetUserByUsername(ctx context.Context, username string) (*types.User, error)
	// GetUserByTenantID 获取某个空间的第一个用户（所有者）。
	GetUserByTenantID(ctx context.Context, tenantID uint64) (*types.User, error)
	// UpdateUser 更新用户资料，但不改变账号状态；启停用请用 SetUserActive。
	UpdateUser(ctx context.Context, user *types.User) error
	// DeleteUser 删除用户。
	DeleteUser(ctx context.Context, id string) error
	// ChangePassword 修改用户密码（需要旧密码）。
	ChangePassword(ctx context.Context, userID string, oldPassword, newPassword string) error
	// AdminResetPassword 由管理员重置密码，无需旧密码，并吊销该用户全部现有会话。
	// 调用方必须先落实「系统管理员」和「不能重置自己」两道校验。
	AdminResetPassword(ctx context.Context, userID string, newPassword string) error
	// ValidatePassword 校验用户密码。
	ValidatePassword(ctx context.Context, userID string, password string) error
	// GenerateTokens 为用户生成 access token 与 refresh token。
	GenerateTokens(ctx context.Context, user *types.User) (accessToken, refreshToken string, err error)
	// BuildLoginMemberships 把用户的成员关系投影成登录响应的结构。
	// activeTenant 会被复用（不额外查询）来填匹配记录的 TenantName。
	// 返回的切片保证非 nil，便于成员表不可用时序列化为空 JSON 数组。
	BuildLoginMemberships(ctx context.Context, user *types.User, activeTenant *types.Tenant) []types.Membership
	// SwitchTenant 签发绑定 targetTenantID 的新令牌对，并返回对应的 LoginResponse。
	// 调用方传入的旧 refresh token 会被吊销。签发前通过 TenantMember 服务校验成员关系。
	// 成功后把目标空间记录为用户的「上次活跃空间」偏好（下次登录和刷新落在这里）。
	// 偏好写入失败会让整个切换失败，不签发令牌。
	SwitchTenant(ctx context.Context, user *types.User, targetTenantID uint64, currentRefreshToken string) (*types.LoginResponse, error)
	// ValidateToken 校验 access token，返回 token 所属的用户以及该 token 绑定的租户。
	//
	// 校验内容：
	//  1. 签名算法必须是 HMAC 家族（防算法混淆），签名和有效期由 jwt.Parse 校验；
	//  2. 不能是 refresh token，也不能是 sandbox 终端票据；
	//  3. auth_tokens 表中必须存在该 token 且未被吊销；
	//  4. 用户必须存在且启用——以数据库为准，令牌有效不等于账号可用。
	//
	// 第二个返回值是 token 中 tenant_id claim 声明的激活租户，可能因
	// /auth/switch-tenant 而不同于 user.TenantID；老 token 没有该 claim 时
	// 回退到 user.TenantID。
	//
	// 本函数不做授权判断：不校验成员关系、角色，也不校验租户是否存在。
	// 这些由认证中间件负责，且中间件可能用 X-Tenant-ID 覆盖这里返回的租户。
	//
	// 查询 token/user 记录失败会作为基础设施错误返回，不会伪装成"已吊销"。
	ValidateToken(ctx context.Context, token string) (*types.User, uint64, error)
	// GetAccessTokenByValue 按 JWT 字符串查询已存储的 access token 记录。
	// Token 字段会被脱敏。用于把沙箱终端票据绑定到签发它的会话，
	// 而不必把 JWT 放进票据里。
	GetAccessTokenByValue(ctx context.Context, token string) (*types.AuthToken, error)
	// GetAccessTokenByID 按主键查询已存储的 access token 记录。
	// Token 字段会被脱敏。用于沙箱终端的二次校验。
	GetAccessTokenByID(ctx context.Context, id string) (*types.AuthToken, error)
	// RefreshToken 用 refresh token 刷新 access token。
	RefreshToken(ctx context.Context, refreshToken string) (accessToken, newRefreshToken string, err error)
	// RevokeToken 吊销指定令牌。
	RevokeToken(ctx context.Context, token string) error
	// Logout 吊销当前 JWT 对应用户的所有未过期 access/refresh token。
	Logout(ctx context.Context, token string) error
	// GetCurrentUser 从请求上下文获取当前用户。
	GetCurrentUser(ctx context.Context) (*types.User, error)
	// SearchUsers 按用户名或邮箱搜索用户。
	SearchUsers(ctx context.Context, query string, limit int) ([]*types.User, error)
	// SetUserActive 启用或停用账号（系统管理员操作）。
	// 停用时会吊销该用户所有未过期令牌。
	// 仓储层负责「不能停用自己」和「至少保留一位系统管理员」的校验。
	SetUserActive(ctx context.Context, userID, actorID string, active bool) (*types.User, error)
	// ListAllUsers 列出平台所有用户（跨空间），按最新优先排序。
	// 返回当前页和 has_more 标志，便于系统管理员的用户列表分页，无需额外 count 查询。
	// 处理器层已做 SystemAdmin 校验，服务层不再重复。
	ListAllUsers(ctx context.Context, offset, limit int) ([]*types.User, bool, error)
	// ListSystemAdmins 列出 IsSystemAdmin=true 的用户。
	// 返回当前页和总数（用于分页 UI）；调用方传 offset/limit 翻页。
	// 供 /api/v1/system/admin/list 使用，仅系统管理员可调用。
	ListSystemAdmins(ctx context.Context, offset, limit int) ([]*types.User, int64, error)
	// AdminCreateUser 由系统管理员代建本地用户。
	// 当 req.Password 为 nil 时自动生成随机密码，并通过第二个返回值仅返回一次。
	// provisioning 由调用方按共享的 auth.default_tenant_mode 策略解析。
	AdminCreateUser(
		ctx context.Context, req *types.AdminCreateUserRequest, provisioning types.TenantProvisioningMode,
	) (*types.User, string, error)
	// RevokeSystemAdmin 撤销系统管理员权限，并以原子方式完成
	// 「最后一位管理员」「不能撤销自己」的校验。
	RevokeSystemAdmin(ctx context.Context, userID, actorID string) (*types.User, error)
	// UpdateUserPreferences 部分更新调用者的偏好数据（PATCH 语义：
	// 只覆盖 patch 中出现的 key）。返回更新后已持久化的偏好。
	UpdateUserPreferences(ctx context.Context, userID string, patch types.UserPreferences) (types.UserPreferences, error)
}

// UserRepository 定义用户的存储接口（数据访问层）。
type UserRepository interface {
	// CreateUser 创建用户。
	CreateUser(ctx context.Context, user *types.User) error
	// GetUserByID 按 ID 获取用户。
	GetUserByID(ctx context.Context, id string) (*types.User, error)
	// GetUsersByIDs 按 ID 批量获取用户，返回以用户 ID 为键的 map；
	// 不存在的 ID 不会出现在结果中。
	GetUsersByIDs(ctx context.Context, ids []string) (map[string]*types.User, error)
	// GetUserByEmail 按邮箱获取用户。
	GetUserByEmail(ctx context.Context, email string) (*types.User, error)
	// GetUserByUsername 按用户名获取用户。
	GetUserByUsername(ctx context.Context, username string) (*types.User, error)
	// GetUserByTenantID 获取某个空间的第一个用户（所有者）。
	GetUserByTenantID(ctx context.Context, tenantID uint64) (*types.User, error)
	// UpdateUser 更新用户资料，但不改变账号状态；启停用请用 SetUserActive。
	UpdateUser(ctx context.Context, user *types.User) error
	// SetUserActive 原子地修改账号状态，停用时吊销会话，
	// 并保证至少保留一位启用的系统管理员。
	SetUserActive(ctx context.Context, userID, actorID string, active bool) (*types.User, error)
	// DeleteUser 删除用户。
	DeleteUser(ctx context.Context, id string) error
	// ListUsers 分页列出用户。
	ListUsers(ctx context.Context, offset, limit int) ([]*types.User, error)
	// ListSystemAdmins 列出 is_system_admin = true 的用户。
	// 走 idx_users_is_system_admin 索引；返回切片和总数（分页元数据）。
	// 供系统管理员管理接口使用。
	ListSystemAdmins(ctx context.Context, offset, limit int) ([]*types.User, int64, error)
	// RevokeSystemAdmin 撤销系统管理员权限，并以原子方式完成
	// 「最后一位管理员」「不能撤销自己」的校验。
	RevokeSystemAdmin(ctx context.Context, userID, actorID string) (*types.User, error)
	// SearchUsers 按用户名或邮箱搜索用户。
	SearchUsers(ctx context.Context, query string, limit int) ([]*types.User, error)
}

// AuthTokenRepository 定义认证令牌的存储接口（数据访问层）。
type AuthTokenRepository interface {
	// CreateToken 创建认证令牌。
	CreateToken(ctx context.Context, token *types.AuthToken) error
	// GetTokenByValue 按令牌值查询。
	GetTokenByValue(ctx context.Context, tokenValue string) (*types.AuthToken, error)
	// GetTokenByID 按主键查询令牌。
	GetTokenByID(ctx context.Context, id string) (*types.AuthToken, error)
	// GetTokensByUserID 获取某个用户的全部令牌。
	GetTokensByUserID(ctx context.Context, userID string) ([]*types.AuthToken, error)
	// UpdateToken 更新令牌。
	UpdateToken(ctx context.Context, token *types.AuthToken) error
	// DeleteToken 删除令牌。
	DeleteToken(ctx context.Context, id string) error
	// DeleteExpiredTokens 删除所有已过期的令牌。
	DeleteExpiredTokens(ctx context.Context) error
	// RevokeTokensByUserID 吊销某个用户的全部令牌。
	RevokeTokensByUserID(ctx context.Context, userID string) error
}
