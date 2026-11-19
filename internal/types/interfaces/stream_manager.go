package interfaces

import (
	"context"
	"time"

	"github.com/Tencent/WeKnora/internal/types"
)

// StreamEvent 表示流中的单个事件
type StreamEvent struct {
	ID        string                 `json:"id"`              // 事件唯一 ID
	Type      types.ResponseType     `json:"type"`            // 事件类型（thinking、tool_call、complete 等）
	Content   string                 `json:"content"`         // 事件内容（流式事件中为增量 chunk）
	Done      bool                   `json:"done"`            // 该事件是否已完成
	Timestamp time.Time              `json:"timestamp"`       // 事件发生的时间
	Data      map[string]interface{} `json:"data,omitempty"`  // 附加事件数据（引用、元数据等）
	Usage     *types.TokenUsage      `json:"usage,omitempty"` // 整个回合聚合的 LLM token 用量（complete 事件）
}

// StreamManager 流管理器接口——极简的只追加（append-only）设计。
// 所有流状态都通过事件管理：元数据、引用、完成状态等。
type StreamManager interface {
	// AppendEvent 向流中追加单个事件。
	// 使用 Redis RPush 实现 O(1) 的追加性能。
	// 所有事件类型（thinking、tool_call、references、complete）都走这个方法。
	AppendEvent(ctx context.Context, sessionID, messageID string, event StreamEvent) error

	// GetEvents 从 offset 开始读取事件。
	// 使用 Redis LRange 做增量读取。
	// 返回：事件切片、供后续读取使用的下一个 offset、错误。
	GetEvents(ctx context.Context, sessionID, messageID string, fromOffset int) ([]StreamEvent, int, error)

	// ResetEvents 丢弃某条消息的流事件，使恢复运行到同一条消息时
	// 从全新的流开始。Steer 事件会被保留。
	ResetEvents(ctx context.Context, sessionID, messageID string) error

	// AppendSteerEvents 把控制事件（steer 指令）追加到每个运行专用的
	// 子列表中，该子列表不会出现在 SSE 流上。生产方是“向运行中的回合
	// 追加消息”的 HTTP 请求；唯一的消费方是正在运行的那个回合本身。
	AppendSteerEvents(ctx context.Context, sessionID, messageID string, events []StreamEvent) error

	// GetSteerEvents 从 fromOffset 开始排空 steer 子列表，语义与
	// GetEvents 一致。子列表不存在时返回空结果，而不是错误。
	GetSteerEvents(ctx context.Context, sessionID, messageID string, fromOffset int) ([]StreamEvent, int, error)

	// UpdateSteerEventData 把若干键合并进排队中的 steer 事件的 Data map
	//（提升为 inject、标记已消费）。事件不存在时返回 false。
	// 实现必须原子地应用这次修改，否则并发的 AppendSteerEvents 可能丢失。
	UpdateSteerEventData(
		ctx context.Context, sessionID, messageID, eventID string, data map[string]interface{},
	) (bool, error)

	// DeleteSteerEvent 按 ID 删除排队中的 steer 事件。事件不存在时返回
	// false。用于用户关闭浮层中的条目。
	DeleteSteerEvent(ctx context.Context, sessionID, messageID, eventID string) (bool, error)

	// SetLiveRun 记录某个会话当前正在生成的 assistant 消息。它是排他的：
	// 如果已有另一个 assistant 处于 live 状态，则返回错误，防止 executeQA
	// 启动第二个引擎。对同一个 assistant 重复调用是 no-op。
	// 需要替换上一次运行的后续交接应使用 ClaimLiveRun。
	SetLiveRun(ctx context.Context, sessionID, assistantMessageID, requestID string) error

	// ClaimLiveRun 覆盖 live-run 标记。用于正在结束的回合先把自己
	// 交接给后续运行、再由后续运行 CAS 清除标记的场景。
	ClaimLiveRun(ctx context.Context, sessionID, assistantMessageID, requestID string) error

	// GetLiveRun 返回会话中正在生成的 assistant 消息；没有标记为
	// live 的运行则返回空字符串。
	GetLiveRun(ctx context.Context, sessionID string) (assistantMessageID, requestID string, err error)

	// ClearLiveRun 清除标记，但仅当它仍指向 assistantMessageID 时才清除：
	// 后续运行可能已经替换了它。
	ClearLiveRun(ctx context.Context, sessionID, assistantMessageID string) error
}
