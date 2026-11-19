package session

import (
	"strings"

	"github.com/Tencent/WeKnora/internal/types/interfaces"
)

// coalesceReplayEvents 把同一条流中连续、未结束的 delta chunk（类型与事件 ID
// 相同；类型取 deltaResponseTypes，即客户端按 event_id 累积的那些）合并成一条
// 事件，携带该段拼接后的正文、最后一个 chunk 的时间戳，以及各 chunk data 的
// 并集（后出现的键覆盖先前的）。遇到 Done chunk、其他类型或其他段的 chunk 时
// 该段结束，这些事件原样透传，因此完成标记、时长和引用各自保留独立的帧，
// 客户端按 event_id 累积得到的最终文本也保持一致。
//
// 事件按模型输出的粒度存储，一场长回答在回放时可能意味着数万帧，每帧都要一次
// SSE 写入、刷出和客户端处理（#3362）；合并后每个段只剩少数几帧。
// 存储中的事件及其 data map 不会被修改。
func coalesceReplayEvents(events []interfaces.StreamEvent) []interfaces.StreamEvent {
	if len(events) < 2 {
		return events
	}
	out := make([]interfaces.StreamEvent, 0, 16)
	var run strings.Builder // content of the open run, written to out's last event when it ends
	open := false           // whether out's last event is an unfinished run
	ownsData := false       // whether that event's Data is already a private copy
	// closeRun 结算当前打开的一段：把 run 里累积的正文写回 out 末尾那条代表事件，
	// 然后清空缓冲并复位 open；当前没有打开的段时什么也不做。
	// 在段边界（遇到不同类型/ID 的事件或非 delta 事件）以及循环结束时调用。
	closeRun := func() {
		if open {
			out[len(out)-1].Content = run.String()
			run.Reset()
			open = false
		}
	}
	for _, evt := range events {
		mergeable := deltaResponseTypes[evt.Type] && !evt.Done
		if open {
			// last 永远获取的都是最近被写入 out 的那段文本的地址
			last := &out[len(out)-1]
			// 判断是否为同一个 evt.Type 以及 evt.ID，保证只合并“同一条流”。
			// 例如 type: thinking 和 type: answer 不是同一条信息，
			// 所对应的 id 也是不同的。
			if mergeable && last.Type == evt.Type && last.ID == evt.ID {
				run.WriteString(evt.Content)
				last.Timestamp = evt.Timestamp
				if len(evt.Data) > 0 {
					if !ownsData {
						last.Data = copyEventData(last.Data, len(evt.Data))
						ownsData = true
					}
					//
					for key, value := range evt.Data {
						last.Data[key] = value
					}
				}
				continue
			}
			closeRun()
		}
		// 结构体值拷贝：out[k].Data = evt.Data（复制的是指针），
		// 也就是 out 和 evt 指向的是同一个 map，
		// 所以后续相关操作可能会污染数据。
		out = append(out, evt)
		if mergeable {
			run.WriteString(evt.Content)
			open = true
			ownsData = false
		}
	}
	closeRun()
	return out
}

// copyEventData 返回存储事件 data map 的私有副本，并预留额外键的空间；
// 原 map 可能与事件存储自身的缓冲区共享，因此不能直接就地修改。
func copyEventData(data map[string]interface{}, extra int) map[string]interface{} {
	copied := make(map[string]interface{}, len(data)+extra)
	for key, value := range data {
		copied[key] = value
	}
	return copied
}
