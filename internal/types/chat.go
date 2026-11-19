package types

import (
	"database/sql/driver"
	"encoding/json"
)

// PromptCacheStatus distinguishes a real cache miss from providers that do not
// expose prompt-cache accounting. Treating both as zero makes fleet-level hit
// rate dashboards misleading.
type PromptCacheStatus string

const (
	PromptCacheStatusUnsupported PromptCacheStatus = "unsupported"
	PromptCacheStatusUnreported  PromptCacheStatus = "unreported"
	PromptCacheStatusMiss        PromptCacheStatus = "miss"
	PromptCacheStatusHit         PromptCacheStatus = "hit"
)

// TokenUsage holds token consumption statistics returned by the model API.
type TokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	// CachedTokens is the legacy alias for CacheReadTokens. It remains on the
	// wire for compatibility with existing API consumers.
	CachedTokens     int               `json:"cached_tokens,omitempty"`
	CacheReadTokens  int               `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int               `json:"cache_write_tokens,omitempty"`
	CacheMissTokens  int               `json:"cache_miss_tokens,omitempty"`
	CacheReported    bool              `json:"cache_reported"`
	CacheStatus      PromptCacheStatus `json:"cache_status,omitempty"`
	// ContextTokenScale is provider prompt tokens per cl100k-estimated token,
	// measured over the turn's rounds. Persisted with the turn so the next
	// turn's history loading and first compaction check are calibrated before
	// any provider count of their own. Zero when the turn measured none.
	ContextTokenScale float64 `json:"context_token_scale,omitempty"`
}

// SetPromptCacheUsage normalizes provider-specific cache counters into the
// shared usage model. promptTokens remains the provider's total input-token
// count; read/write/miss are descriptive subsets and must not be added to it.
func (u *TokenUsage) SetPromptCacheUsage(read, write, miss int, reported bool) {
	if u == nil {
		return
	}
	if read < 0 {
		read = 0
	}
	if write < 0 {
		write = 0
	}
	if miss < 0 {
		miss = 0
	}
	u.CachedTokens = read
	u.CacheReadTokens = read
	u.CacheWriteTokens = write
	u.CacheMissTokens = miss
	u.CacheReported = reported
	switch {
	case !reported:
		u.CacheStatus = PromptCacheStatusUnreported
	case read > 0:
		u.CacheStatus = PromptCacheStatusHit
	default:
		u.CacheStatus = PromptCacheStatusMiss
	}
}

// MarkPromptCacheUnsupported marks a provider/model path that cannot report
// provider-side prompt-cache usage.
func (u *TokenUsage) MarkPromptCacheUnsupported() {
	if u == nil {
		return
	}
	u.SetPromptCacheUsage(0, 0, 0, false)
	u.CacheStatus = PromptCacheStatusUnsupported
}

// Accumulate adds another call's usage into u, preserving the subset
// semantics: prompt/completion/total and every cache counter sum
// independently (cache counters stay subsets of the prompt count and are
// never folded into it). CacheReported ORs, and the cache status is
// recomputed from the combined counters so a single cache hit anywhere in
// the accumulated calls reads as a hit.
func (u *TokenUsage) Accumulate(other TokenUsage) {
	if u == nil {
		return
	}
	u.PromptTokens += other.PromptTokens
	u.CompletionTokens += other.CompletionTokens
	u.TotalTokens += other.TotalTokens
	u.CachedTokens += other.CachedTokens
	u.CacheReadTokens += other.CacheReadTokens
	u.CacheWriteTokens += other.CacheWriteTokens
	u.CacheMissTokens += other.CacheMissTokens
	u.CacheReported = u.CacheReported || other.CacheReported
	// A scale is a ratio, not a count: the newest measurement stands.
	if other.ContextTokenScale > 0 {
		u.ContextTokenScale = other.ContextTokenScale
	}
	switch {
	case !u.CacheReported:
		u.CacheStatus = mergeUnreportedCacheStatus(u.CacheStatus, other.CacheStatus)
	case u.CacheReadTokens > 0:
		u.CacheStatus = PromptCacheStatusHit
	default:
		u.CacheStatus = PromptCacheStatusMiss
	}
}

// mergeUnreportedCacheStatus folds the statuses of never-reported usage.
// "unsupported" survives only while every accumulated call was itself
// classified unsupported — the first accumulation adopts the incoming
// classification, and any later call that is not known-unsupported (an
// unreported or unclassified one) degrades the aggregate to unreported.
func mergeUnreportedCacheStatus(accumulated, incoming PromptCacheStatus) PromptCacheStatus {
	if accumulated == "" {
		if incoming == "" {
			return PromptCacheStatusUnreported
		}
		return incoming
	}
	if accumulated == PromptCacheStatusUnsupported && incoming == PromptCacheStatusUnsupported {
		return PromptCacheStatusUnsupported
	}
	return PromptCacheStatusUnreported
}

// PromptCacheHitRate returns cache-read tokens as a percentage of the
// provider's prompt total. Zero when the prompt is empty. A ReAct turn that
// reuses the system prefix therefore reads as a high hit rather than a miss.
func (u TokenUsage) PromptCacheHitRate() float64 {
	if u.PromptTokens <= 0 {
		return 0
	}
	return float64(u.CacheReadTokens) / float64(u.PromptTokens) * 100
}

// Value persists the usage as a jsonb column (assistant messages carry the
// turn's aggregate); nil writes SQL NULL. Mirrors the nullable-pointer
// pattern APIPrincipalConfig uses.
func (u *TokenUsage) Value() (driver.Value, error) {
	if u == nil {
		return nil, nil
	}
	return json.Marshal(u)
}

// Scan restores a jsonb usage column; NULL leaves the receiver zero-valued.
func (u *TokenUsage) Scan(value interface{}) error {
	if value == nil {
		return nil
	}
	var b []byte
	switch v := value.(type) {
	case []byte:
		b = v
	case string:
		b = []byte(v)
	default:
		return nil
	}
	return json.Unmarshal(b, u)
}

// LLMToolCall represents a function/tool call from the LLM
type LLMToolCall struct {
	ID               string           `json:"id"`
	Type             string           `json:"type"` // "function"
	Function         FunctionCall     `json:"function"`
	ProviderMetadata ToolCallMetadata `json:"provider_metadata,omitempty"`

	// ModelArguments and the resolution fields are request-local observability
	// state. ModelArguments preserves the exact JSON emitted by the model while
	// Function.Arguments is decoded to durable application identifiers before
	// tool execution. These fields must never be sent back to a provider or
	// persisted in chat history.
	ModelArguments     string   `json:"-"`
	ArgumentResolution string   `json:"-"`
	UnresolvedHandles  []string `json:"-"`
}

// ToolCallMetadata carries provider-specific tool-call state that must round-trip
// with the assistant tool call, without teaching core agent code vendor fields.
type ToolCallMetadata map[string]json.RawMessage

// ProviderMetadata carries opaque provider state attached to an assistant
// turn as a whole (OpenAI Responses reasoning items, OpenRouter
// reasoning_details, ...). Keyed by protocol / vendor namespace so several
// providers can coexist on one persisted message without collisions.
type ProviderMetadata map[string]json.RawMessage

// FunctionCall represents the function details
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON string
}

// ChatResponse chat response
type ChatResponse struct {
	Content string `json:"content"`
	// ReasoningContent 是支持思考链的模型（DeepSeek thinking、小米 MiMo、vLLM reasoning 等）
	// 在本轮输出的推理内容。需要在后续多轮请求中原样回传给那些严格校验的供应商。
	ReasoningContent string `json:"reasoning_content,omitempty"`
	// ReasoningSignature and ReasoningMetadata are the provider-issued
	// artifacts that must be replayed together with ReasoningContent on the
	// next turn (Anthropic thinking signatures, Gemini thought signatures,
	// OpenAI Responses encrypted reasoning items).
	ReasoningSignature string           `json:"reasoning_signature,omitempty"`
	ReasoningMetadata  ProviderMetadata `json:"reasoning_metadata,omitempty"`
	ToolCalls          []LLMToolCall    `json:"tool_calls,omitempty"`
	FinishReason       string           `json:"finish_reason,omitempty"`
	Usage              TokenUsage       `json:"usage"`

	// AnswerStreamed reports whether the user-facing answer text was already
	// streamed live to the final-answer UI area during this round (i.e. the
	// model answered with plain content). When true, the natural-stop branch
	// must only emit the closing
	// Done marker for AnswerEventID instead of re-emitting the whole answer —
	// otherwise the answer would render twice and "jump" at end of stream.
	// Transient, never persisted.
	AnswerStreamed bool `json:"-"`
	// AnswerEventID is the EventBus event ID under which the live answer
	// chunks were streamed, so the natural-stop branch can close the same
	// stream with a Done marker. Empty when AnswerStreamed is false.
	AnswerEventID string `json:"-"`
}

// Response type
type ResponseType string

const (
	// 回答（answer）响应类型
	ResponseTypeAnswer ResponseType = "answer"
	// 引用（references）响应类型
	ResponseTypeReferences ResponseType = "references"
	// 思考响应类型（用于 Agent 的思考过程）
	ResponseTypeThinking ResponseType = "thinking"
	// ResponseTypeProgress 携带用户可见的中间进度更新。
	ResponseTypeProgress ResponseType = "progress"
	// 工具调用响应类型（用于 Agent 发起工具调用）
	ResponseTypeToolCall ResponseType = "tool_call"
	// 工具结果响应类型（用于 Agent 的工具执行结果）
	ResponseTypeToolResult ResponseType = "tool_result"
	// ResponseTypeInstallOutput 携带安装器进度，但并不表示工具已完成。
	ResponseTypeInstallOutput ResponseType = "install_output"
	// ResponseTypeCommandOutput 更新待完成的工具卡片，但并不将其标记为完成。
	ResponseTypeCommandOutput ResponseType = "command_output"
	// ResponseTypeWorkStarted 是共享设计 §7 中的后台工作任务事件。
	// 各功能通过 service.BackgroundEventEmitter 发出，由它决定投递到哪条流。
	ResponseTypeWorkStarted ResponseType = "work_started"
	// ResponseTypeWorkEvent 是共享设计 §7 中的后台工作任务事件。
	// 各功能通过 service.BackgroundEventEmitter 发出，由它决定投递到哪条流。
	ResponseTypeWorkEvent ResponseType = "work_event"
	// ResponseTypeWorkFinished 是共享设计 §7 中的后台工作任务事件。
	// 各功能通过 service.BackgroundEventEmitter 发出，由它决定投递到哪条流。
	ResponseTypeWorkFinished ResponseType = "work_finished"
	// 错误响应类型
	ResponseTypeError ResponseType = "error"
	// 反思（reflection）响应类型（用于 Agent 的自我反思）
	ResponseTypeReflection ResponseType = "reflection"
	// 会话标题响应类型
	ResponseTypeSessionTitle ResponseType = "session_title"
	// Agent 查询响应类型（已收到查询并开始处理）
	ResponseTypeAgentQuery ResponseType = "agent_query"
	// 完成响应类型（Agent 运行结束）
	ResponseTypeComplete ResponseType = "complete"
	// ResponseTypeArtifactsPending 在回答已流式输出完毕、技能/沙箱产物
	// 正被复制到持久化存储期间发送。界面先显示工具栏占位，
	// 直到 ResponseTypeComplete 携带文件列表。
	ResponseTypeArtifactsPending ResponseType = "artifacts_pending"
	// ResponseTypeRunSuspended 在运行因等待用户回答而结束时先于 complete
	// 发送；在用户回答之前，该消息保持未完成状态。
	ResponseTypeRunSuspended ResponseType = "run_suspended"
	// ResponseTypeRunResumed 开启一条已挂起运行在提问被回答后恢复的事件流。
	// 挂起前已保存的步骤不会被重放；客户端保留它已经展示过的步骤。
	ResponseTypeRunResumed ResponseType = "run_resumed"
	// ToolApprovalRequired：MCP 工具被标记为危险——界面必须先收集用户批准，
	// 才能继续执行。
	ResponseTypeToolApprovalRequired ResponseType = "tool_approval_required"
	// ToolApprovalResolved：用户已批准/拒绝（或已超时）；仅用于界面回放。
	ResponseTypeToolApprovalResolved ResponseType = "tool_approval_resolved"
	// ResponseTypeAgentPromptRequired 表示 Agent 正在向用户提问（ask_user）；
	// data 携带提问类型及其请求 JSON。
	ResponseTypeAgentPromptRequired ResponseType = "agent_prompt_required"
	// ResponseTypeAgentPromptResolved 表示提问已被回答、拒绝、超时或取消。
	ResponseTypeAgentPromptResolved ResponseType = "agent_prompt_resolved"
	// MCPOAuthRequired：调用了启用了 OAuth 的 MCP 服务，但用户尚未授权
	// ——界面必须弹出“授权”提示，Agent 暂停，直到授权完成（或等待超时）。
	ResponseTypeMCPOAuthRequired ResponseType = "mcp_oauth_required"
	// MCPOAuthResolved：授权已完成 / 超时 / 被取消；仅用于界面回放。
	ResponseTypeMCPOAuthResolved ResponseType = "mcp_oauth_resolved"
	// MemoryRecalled：本次回答注入的长期记忆，界面可据此展示，
	// 并允许用户删除影响过回答的记忆。
	ResponseTypeMemoryRecalled ResponseType = "memory_recalled"
	// ResponseTypeSteer 是客户端在回合仍在运行时 POST 的、针对单次运行的控制信号。
	// 它与 stop 事件共用同一 StreamManager 键空间，但存放在专用子列表
	//（AppendSteerEvents/GetSteerEvents），因此永远不会出现在用户可见的
	// SSE 流上。运行中的引擎会在下一个轮次边界（SteerSink.PollSteer）
	// 取走它；若循环已经退出，则运行的收尾路径会把它交给下一次运行——
	// 除非该回合已被停止，此时它会被丢弃。
	ResponseTypeSteer ResponseType = "steer"
	// ResponseTypeUserMessageInjected 在被 steer 的消息被接纳入运行中的回合后，
	// 立即在用户可见流上发出：一条 user 角色的数据库记录已在该运行的
	// request_id 下持久化，文本也已追加到 Agent 的消息列表。前端据此把排队中的
	// 消息从输入框浮层移入对话记录。
	ResponseTypeUserMessageInjected ResponseType = "user_message_injected"
	// ResponseTypeContextCompacted 表示较早的对话已被摘要压缩以适配上下文窗口。
	// 之所以要展示，是因为它改变了 Agent 记得什么——否则一个忘记了早先指令的
	// 回答，与模型直接无视指令将无法区分。
	ResponseTypeContextCompacted ResponseType = "context_compacted"
	// ResponseTypeInstallPrompt 是技能安装交给安装器 Agent 的指令。
	// 只有技能安装记录会发出它，并且它总是最先发出，因此仅回放日志就能
	// 看出当初要求安装什么——控制台不必读取持久化的提问记录来为这次运行
	// 添加说明。
	ResponseTypeInstallPrompt ResponseType = "install_prompt"
)

// StreamResponse stream response
// FinishReasonIncomplete marks a stream that broke before the provider sent a
// finish reason (read error, timeout, stall). Whatever content and tool calls
// were collected are a partial response: callers must not treat them as a
// completed turn.
const FinishReasonIncomplete = "incomplete"

// StreamEndedEarlyError is what a consumer reports for an answer that arrived
// with FinishReasonIncomplete: the stream stopped before the provider said the
// message was finished, most often because a proxy cut the connection.
const StreamEndedEarlyError = "the model's response ended before it finished (connection interrupted)"

type StreamResponse struct {
	// 事件标识。流式问答中通常是本次请求的 Request ID（与 X-Request-ID 一致）。
	ID string `json:"id"`
	// 事件类型，决定前端如何处理：answer=回答分片、agent_query=问答开始、
	// tool_call/tool_result=工具调用与结果、references=知识引用、complete=整轮结束、
	// error=错误等。
	ResponseType ResponseType `json:"response_type"`
	// 文本内容。answer 事件中是回答的一个分片，前端按顺序拼接；其他事件通常为空。
	Content string `json:"content"`
	// 该事件是否表示结束：answer 的最后一个分片和 complete 事件为 true。
	Done bool `json:"done"`
	// 知识库检索引用，仅 references 事件携带。
	KnowledgeReferences References `json:"knowledge_references,omitempty"`
	// 会话 ID；目前仅 agent_query 事件填充。
	SessionID string `json:"session_id,omitempty"`
	// 助手消息 ID；仅 agent_query 事件填充，用于 continue-stream 续传和停止生成。
	AssistantMessageID string `json:"assistant_message_id,omitempty"`
	// LLM 工具调用信息，部分 tool_call 相关事件会携带。
	ToolCalls []LLMToolCall `json:"tool_calls,omitempty"`
	// 事件附加数据，结构随 response_type 变化，例如 tool_name、event_id、
	// duration_ms、final_content 等。
	Data map[string]interface{} `json:"data,omitempty"`
	// token 用量统计，通常在 complete 事件中返回。
	Usage *TokenUsage `json:"usage,omitempty"`
	// 模型结束原因，例如 stop、length、incomplete 等。
	FinishReason string `json:"finish_reason,omitempty"`
}

// References references
type References []*SearchResult

// Value implements the driver.Valuer interface, used to convert References to database values
func (c References) Value() (driver.Value, error) {
	return json.Marshal(c)
}

// Scan implements the sql.Scanner interface, used to convert database values to References
func (c *References) Scan(value interface{}) error {
	if value == nil {
		return nil
	}
	b, ok := value.([]byte)
	if !ok {
		return nil
	}
	return json.Unmarshal(b, c)
}
