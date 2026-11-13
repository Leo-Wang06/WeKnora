package types

// ContextKey defines a type for context keys to avoid string collision
type ContextKey string

const (
	// TenantIDContextKey 限定执行范围（仓储/模型查询按它做租户隔离）。
	TenantIDContextKey ContextKey = "TenantID"
	// CallerContextKey 记录已认证的资源调用方（租户、用户、角色）。
	CallerContextKey ContextKey = "ResourceCaller"
	// KBGrantsContextKey 携带不可变的知识库操作授权（已解析好的访问许可）。
	KBGrantsContextKey ContextKey = "ResourceKBGrants"
	// KBTransferContextKey 携带一组已准入的资源对（知识库转移/复制场景）。
	KBTransferContextKey ContextKey = "ResourceKBTransfer"
	// SharedAgentGrantContextKey 携带已授权的共享 Agent 读取范围。
	SharedAgentGrantContextKey ContextKey = "ResourceSharedAgentGrant"
	// TenantInfoContextKey 是当前租户信息（*types.Tenant）。
	TenantInfoContextKey ContextKey = "TenantInfo"
	// RequestIDContextKey 是请求 ID，用于串联一次请求产生的所有日志。
	RequestIDContextKey ContextKey = "RequestID"
	// LoggerContextKey 携带请求级 logger（通常带 request_id 等字段）。
	LoggerContextKey ContextKey = "Logger"
	// UserContextKey 是当前用户信息（*types.User）。
	UserContextKey ContextKey = "User"
	// UserIDContextKey 是当前用户 ID。
	UserIDContextKey ContextKey = "UserID"
	// PrincipalContextKey 是终端调用主体（Principal），标识调用方类型与 ID。
	PrincipalContextKey ContextKey = "Principal"
	// PrincipalAuthSourceContextKey 记录认证中间件是如何验证该主体的
	// （Web 会话、API Key 模式、Embed、IM、MCP 端点）。
	PrincipalAuthSourceContextKey ContextKey = "PrincipalAuthSource"
	// TenantAPIKeyScopeContextKey 携带当前 API Key 的操作能力与知识库范围。
	TenantAPIKeyScopeContextKey ContextKey = "TenantAPIKeyScope"
	// AuditAPIKeyContextKey 携带 API Key 的 ID/名称，仅用于活动归属，
	// 不是授权凭证。
	AuditAPIKeyContextKey ContextKey = "AuditAPIKey"
	// TenantRoleContextKey 是调用者在当前激活租户中的角色
	// （由认证中间件从 tenant_members 表加载）。见 TenantRoleFromContext。
	TenantRoleContextKey ContextKey = "TenantRole"
	// SessionTenantIDContextKey 是会话所属租户的 ID。设置后（例如共享 Agent
	// 的流水线场景），会话/消息查询使用它而不是 TenantIDContextKey。
	SessionTenantIDContextKey ContextKey = "SessionTenantID"
	// SessionIDContextKey 携带当前会话 ID，贯穿聊天流水线，
	// 使有状态的沙箱后端（尤其是 CubeSandbox）能把脚本执行路由到
	// 该会话专属的持久 MicroVM 实例。
	SessionIDContextKey ContextKey = "SessionID"
	// SandboxTenantIDContextKey 携带被访问沙箱所属会话的租户 ID；
	// 它不总是等于 TenantIDContextKey 中的租户：共享 Agent 运行在
	// Agent 所有者的租户下，以便模型/知识库/命名沙箱配置在共享工作区中解析。
	//
	// 会话→沙箱的绑定必须仍然以会话所有者为准，因为会话删除是从一个
	// 普通 HTTP 请求触发的，而该请求只认识会话自己的租户。若把绑定键在
	// “借来的”租户上，删除时就会去查一个没人写过的键，导致暂停的 MicroVM
	// 被遗弃并持续计费。它刻意与 SessionTenantIDContextKey 区分——后者
	// 还会重新限定会话/消息的仓储查询。见 SandboxTenantIDFromContext。
	SandboxTenantIDContextKey ContextKey = "SandboxTenantID"
	// SandboxAdmissionExemptContextKey 携带当前请求及其聊天轮次中、
	// 免于共享机器准入限制的成员（[]string）。
	SandboxAdmissionExemptContextKey ContextKey = "sandbox_admission_exempt"
	// EmbedQueryContextKey 标记一次向量化调用是“搜索查询”；
	// 见 WithEmbedQuery。
	EmbedQueryContextKey ContextKey = "EmbedQuery"
	// WikiEditSourceContextKey 携带当前 Wiki 页面写入的作者来源
	// （user / agent / revert）。不存在时表示来自 Wiki 摄取流水线。
	// 见 types.WithWikiEditSource。
	WikiEditSourceContextKey ContextKey = "WikiEditSource"
	// WikiShrinkAllowedContextKey 标记本次 Wiki 页面写入允许删除
	// 已存页面中仍然存在的表格行；见 types.WithWikiShrinkAllowed。
	WikiShrinkAllowedContextKey ContextKey = "WikiShrinkAllowed"
	// LanguageContextKey 是用户语言偏好（例如 "zh-CN"、"en-US"）。
	LanguageContextKey ContextKey = "Language"
	// EmbedVisitorContextKey 是 Embed 场景下用于 OAuth 隔离的匿名访客 ID。
	EmbedVisitorContextKey ContextKey = "EmbedVisitorID"
	// EmbedChannelContextKey 在请求 context 上保存已认证的 Embed 渠道
	// （*EmbedChannel）。之所以在这里声明而不在认证它的中间件包里，
	// 原因同 LangfuseTraceContextKey：context_clone.go 的克隆表必须
	// 逐一声明所有 context key，而 middleware 包会 import 本包，
	// 若 key 定义在 middleware 里，克隆表就只能用原始字符串引用它。
	EmbedChannelContextKey ContextKey = "EmbedChannel"
	// MCPEndpointContextKey 在通过工作区 MCP Server 接口到达的请求
	// context 上保存已认证的 *MCPEndpoint。声明位置的理由同
	// EmbedChannelContextKey。
	MCPEndpointContextKey ContextKey = "MCPEndpoint"
	// LangfuseTraceContextKey 携带请求生命周期中活跃的 Langfuse *Trace。
	// 定义在这里（而不是 langfuse 包内），使 logger.CloneContext
	// 无需 import langfuse 也能保留它。
	LangfuseTraceContextKey ContextKey = "LangfuseTrace"
	// SystemAdminContextKey 表示当前用户是否为系统管理员。
	SystemAdminContextKey ContextKey = "SystemAdmin"
	// BackgroundTaskContextKey 标记该 context 中的模型调用来自 asynq
	// 后台 worker（文档解析/摘要/问题生成/图谱/多模态增强），而不是
	// 面向用户的 HTTP 请求。聊天并发控制器据此只限制后台 LLM 流量，
	// 不影响交互式聊天的延迟。见 WithBackgroundTask。
	BackgroundTaskContextKey ContextKey = "BackgroundTask"
	// LLMCallPurposeContextKey 标注模型请求在业务层面的用途
	// （例如 agent_round 或 wiki_page_modify）。
	LLMCallPurposeContextKey ContextKey = "LLMCallPurpose"
	// LLMPromptPrefixFingerprintContextKey 携带计划复用的提示词前缀的
	// 非敏感哈希，用于缓存诊断。
	LLMPromptPrefixFingerprintContextKey ContextKey = "LLMPromptPrefixFingerprint"
	// MCPOAuthNonInteractiveContextKey 标记该请求所在的渠道无法在会话内
	// 完成 MCP OAuth 授权（例如 IM 机器人：没有活跃客户端能点击“授权”
	// 并调用 resolve 端点）。设置后，Agent 会发一条一次性授权提示并继续
	// 执行，而不是阻塞到 OAuth 等待超时。见 IsMCPOAuthNonInteractive。
	MCPOAuthNonInteractiveContextKey ContextKey = "MCPOAuthNonInteractive"
	// RunModeContextKey 携带 Agent 运行的 RunMode。见 RunModeFromContext。
	RunModeContextKey ContextKey = "RunMode"
	// AccessLevelContextKey 携带 Agent 运行的有效访问级别。
	AccessLevelContextKey ContextKey = "AccessLevel"
	// GrantScopeContextKey 携带 Agent 运行的 GrantScope。
	GrantScopeContextKey ContextKey = "GrantScope"
	// StandingGrantScopeContextKey 携带 Agent 运行的常驻（standing）
	// GrantScope；见 WithStandingGrantScope。
	StandingGrantScopeContextKey ContextKey = "StandingGrantScope"
	// ChatParserEngineContextKey 携带从 Agent 的 ChatParserEngineRules
	// 解析出的解析引擎，用于聊天附件处理。
	ChatParserEngineContextKey ContextKey = "ChatParserEngine"
)

// String returns the string representation of the context key
func (c ContextKey) String() string {
	return string(c)
}
