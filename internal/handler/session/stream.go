package session

import (
	"context"
	stderrors "errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Tencent/WeKnora/internal/errors"
	"github.com/Tencent/WeKnora/internal/event"
	"github.com/Tencent/WeKnora/internal/logger"
	"github.com/Tencent/WeKnora/internal/storageurl"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	secutils "github.com/Tencent/WeKnora/internal/utils"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ContinueStream godoc
// @Summary      继续流式响应
// @Description  继续获取正在进行的流式响应
// @Tags         问答
// @Accept       json
// @Produce      text/event-stream
// @Param        session_id     path      string  true   "会话ID"
// @Param        message_id     query     string  true   "消息ID"
// @Param        resume_pending_id query  string  false  "等待此审批恢复后的事件流"
// @Param        resource_urls  query     string  false  "文件引用形式，public 返回可加载直链"  Enums(handle, public)  default(handle)
// @Success      200            {string}  string  "SSE 事件流"
// @Failure      404         {object}  errors.AppError         "会话或消息不存在"
// @Failure      409         {object}  errors.AppError         "审批恢复后的事件流尚未就绪"
// @Security     Bearer
// @Security     ApiKeyAuth
// @Router       /sessions/continue-stream/{session_id} [get]
func (h *Handler) ContinueStream(c *gin.Context) {
	ctx := c.Request.Context()

	logger.Info(ctx, "Start continuing stream response processing")

	// 从 URL 参数中获取会话 ID
	sessionID := secutils.SanitizeForLog(c.Param("session_id"))
	if sessionID == "" {
		logger.Error(ctx, "Session ID is empty")
		c.Error(errors.NewBadRequestError(errors.ErrInvalidSessionID.Error()))
		return
	}

	// 从查询参数中获取消息 ID
	messageID := secutils.SanitizeForLog(c.Query("message_id"))
	if messageID == "" {
		logger.Error(ctx, "Message ID is empty")
		c.Error(errors.NewBadRequestError("Missing message ID"))
		return
	}

	logger.Infof(ctx, "Continuing stream, session ID: %s, message ID: %s", sessionID, messageID)

	// 必须在写出任何 SSE 响应头之前完成解析，这样非法的 resource_urls 值
	// 仍能以普通 400 JSON 错误的形式返回。
	resourceRewriter, err := h.resolveStreamRewriter(c)
	if err != nil {
		logger.Warnf(ctx, "Rejected resource URL mode: %v", err)
		_ = c.Error(err)
		return
	}

	// 校验会话存在且属于当前租户
	if _, err := h.sessionService.GetSession(ctx, sessionID); err != nil {
		if stderrors.Is(err, errors.ErrSessionNotFound) {
			logger.Warnf(ctx, "Session not found, ID: %s", sessionID)
			c.Error(errors.NewNotFoundError(err.Error()))
		} else {
			logger.ErrorWithFields(ctx, err, nil)
			c.Error(errors.NewInternalServerError(err.Error()))
		}
		return
	}

	// 获取未完成的消息
	message, err := h.messageService.GetMessage(ctx, sessionID, messageID)
	if err != nil {
		if stderrors.Is(err, errors.ErrSessionNotFound) {
			// PR #1309 将用户范围（user-scope）接入 messageService.GetMessage 的
			// 会话存在性检查；非所有者 / 错误用户的查询现在会返回
			// ErrSessionNotFound。这里映射为 404，让客户端能区分“URL 有误”
			// 和真正的 5xx，而不是看到一个笼统的 500。
			logger.Warnf(ctx, "Session not found, ID: %s", sessionID)
			c.Error(errors.NewNotFoundError(err.Error()))
			return
		}
		if stderrors.Is(err, gorm.ErrRecordNotFound) {
			// message_id 不存在（例如错误的 / 未持久化的 ID，或已过期的
			// 回放缓冲区）。这属于客户端错误而非服务端故障：返回 404，
			// 调用方因此读到 resource.not_found（一种永久性错误，不应重试），
			// 而不是可重试的 5xx。与上面的 ErrSessionNotFound 分支以及
			// kb/doc/chunk 的未找到修复保持一致。
			logger.Warnf(ctx, "Message not found, session ID: %s, message ID: %s", sessionID, messageID)
			c.Error(errors.NewNotFoundError(err.Error()))
			return
		}
		logger.ErrorWithFields(ctx, err, nil)
		c.Error(errors.NewInternalServerError(err.Error()))
		return
	}

	if message == nil {
		logger.Warnf(ctx, "Incomplete message not found, session ID: %s, message ID: %s", sessionID, messageID)
		c.JSON(http.StatusNotFound, gin.H{
			"success": false,
			"error":   "Incomplete message not found",
		})
		return
	}

	// 从流中获取初始事件（偏移量 0）
	// 这里 events 就是该 assistant 消息的事件流中，从第 0 条到当前末尾的所有单个事件
	// currentOffset 表示下次读取应该从哪个位置开始——即“已经读掉的事件条数”也是下一条未读事件的索引
	events, currentOffset, err := h.streamManager.GetEvents(ctx, sessionID, messageID, 0)
	if err != nil {
		logger.ErrorWithFields(ctx, err, nil)
		c.Error(errors.NewInternalServerError(fmt.Sprintf("Failed to get stream data: %s", err.Error())))
		return
	}

	if len(events) == 0 {
		logger.Warnf(ctx, "No events found in stream, session ID: %s, message ID: %s", sessionID, messageID)
		c.JSON(http.StatusNotFound, gin.H{
			"success": false,
			"error":   "No stream events found",
		})
		return
	}

	// 调度器可能尚未重置上一段运行。绝不能把它的终结事件当作
	// 刚获批的这次续接已经完成来回放。
	if pendingID := c.Query("resume_pending_id"); pendingID != "" && !message.IsCompleted {
		ready := false
		for _, evt := range events {
			if (evt.Type == types.ResponseTypeAgentQuery && evt.Data["resume_pending_id"] == pendingID) ||
				(evt.Type == types.ResponseTypeRunResumed && evt.Data["pending_id"] == pendingID) {
				ready = true
				break
			}
		}
		if !ready {
			c.JSON(http.StatusConflict, gin.H{"success": false, "error": "The resumed stream is not ready yet"})
			return
		}
	}

	logger.Infof(
		ctx, "Preparing to replay %d events and continue streaming, session ID: %s, message ID: %s",
		len(events), sessionID, messageID,
	)

	// 设置 SSE 响应头
	setSSEHeaders(c)

	// 检查流是否已经完成
	streamCompleted := false
	for _, evt := range events {
		if evt.Type == "complete" {
			streamCompleted = true
			break
		}
	}

	// 回放已有事件，每帧合并一个分段内的 chunk
	replay := coalesceReplayEvents(events)
	logger.Debugf(ctx, "Replaying %d existing events as %d frames", len(events), len(replay))
	for _, evt := range replay {
		emitStreamEvent(ctx, c, evt, message.RequestID, resourceRewriter)
	}

	// 流已完成，发送结束事件并返回
	if streamCompleted {
		logger.Infof(ctx, "Stream already completed, session ID: %s, message ID: %s", sessionID, messageID)
		sendCompletionEvent(c, message.RequestID)
		return
	}

	// 继续轮询新事件
	logger.Debug(ctx, "Starting event update monitoring")
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			logger.Debug(ctx, "Client connection closed")
			return

		case <-heartbeat.C:
			c.SSEvent("message", gin.H{"response_type": "heartbeat"})
			c.Writer.Flush()
		case <-ticker.C:
			// 从当前偏移量获取新事件
			newEvents, newOffset, err := h.streamManager.GetEvents(ctx, sessionID, messageID, currentOffset)
			if err != nil {
				logger.Errorf(ctx, "Failed to get new events: %v", err)
				flushHeldStreamContent(ctx, c, message.RequestID, resourceRewriter)
				return
			}

			// 发送新事件
			streamCompletedNow := false
			for _, evt := range newEvents {
				// 检查是否是结束事件
				if evt.Type == "complete" {
					streamCompletedNow = true
				}

				emitStreamEvent(ctx, c, evt, message.RequestID, resourceRewriter)
			}

			// 更新偏移量
			currentOffset = newOffset

			// 流已完成，发送结束事件并退出
			if streamCompletedNow {
				logger.Infof(ctx, "Stream completed, session ID: %s, message ID: %s", sessionID, messageID)
				sendCompletionEvent(c, message.RequestID)
				return
			}
		}
	}
}

// StopSession godoc
// @Summary      停止生成
// @Description  停止当前正在进行的生成任务
// @Tags         问答
// @Accept       json
// @Produce      json
// @Param        session_id  path      string              true  "会话ID"
// @Param        request     body      StopSessionRequest  true  "停止请求"
// @Success      200         {object}  map[string]interface{}  "停止成功"
// @Failure      404         {object}  errors.AppError         "会话或消息不存在"
// @Security     Bearer
// @Security     ApiKeyAuth
// @Router       /sessions/{session_id}/stop [post]
func (h *Handler) StopSession(c *gin.Context) {
	ctx := logger.CloneContext(c.Request.Context())
	sessionID := secutils.SanitizeForLog(c.Param("session_id"))

	if sessionID == "" {
		c.JSON(400, gin.H{"error": "Session ID is required"})
		return
	}

	// 解析请求体以获取 message_id
	var req StopSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		logger.ErrorWithFields(ctx, err, map[string]interface{}{
			"session_id": sessionID,
		})
		c.JSON(400, gin.H{"error": "message_id is required"})
		return
	}

	assistantMessageID := secutils.SanitizeForLog(req.MessageID)
	logger.Infof(ctx, "Stop generation request for session: %s, message: %s", sessionID, assistantMessageID)

	// 从上下文中获取租户 ID
	tenantID, exists := c.Get(types.TenantIDContextKey.String())
	if !exists {
		logger.Error(ctx, "Failed to get tenant ID")
		c.JSON(401, gin.H{"error": "Unauthorized"})
		return
	}
	tenantIDUint := tenantID.(uint64)

	// 校验消息归属与状态
	message, err := h.messageService.GetMessage(ctx, sessionID, assistantMessageID)
	if err != nil {
		logger.ErrorWithFields(ctx, err, map[string]interface{}{
			"session_id": sessionID,
			"message_id": assistantMessageID,
		})
		c.JSON(404, gin.H{"error": "Message not found"})
		return
	}

	// 再次确认消息属于该会话
	if message.SessionID != sessionID {
		logger.Warnf(ctx, "Message %s does not belong to session %s", assistantMessageID, sessionID)
		c.JSON(403, gin.H{"error": "Message does not belong to this session"})
		return
	}

	// 校验消息属于当前租户。停止生成会修改正在运行的任务，因此这里使用
	// 严格的所有者范围：租户管理员可以读取 API Key 创建的会话，但不得中断
	// 其（外部）API 调用。
	session, err := h.sessionService.GetOwnedSession(ctx, sessionID)
	if err != nil {
		logger.ErrorWithFields(ctx, err, map[string]interface{}{
			"session_id": sessionID,
		})
		c.JSON(404, gin.H{"error": "Session not found"})
		return
	}

	if session.TenantID != tenantIDUint {
		logger.Warnf(ctx, "Session %s does not belong to tenant %d", sessionID, tenantIDUint)
		c.JSON(403, gin.H{"error": "Access denied"})
		return
	}

	if h.stopCollaboration != nil {
		if err := h.stopCollaboration(ctx, sessionID, assistantMessageID); err != nil {
			c.JSON(500, gin.H{"error": "Failed to stop delegated tasks"})
			return
		}
	}

	// 检查消息是否已经完成（已停止）
	if message.IsCompleted {
		logger.Infof(ctx, "Message %s is already completed, no need to stop", assistantMessageID)
		c.JSON(200, gin.H{
			"success": true,
			"message": "Message already completed",
		})
		return
	}

	// 向 StreamManager 写入停止事件，以支持分布式部署
	stopEvent := interfaces.StreamEvent{
		ID:        fmt.Sprintf("stop-%d", time.Now().UnixNano()),
		Type:      types.ResponseType(event.EventStop),
		Content:   "",
		Done:      true,
		Timestamp: time.Now(),
		Data: map[string]interface{}{
			"session_id": sessionID,
			"message_id": assistantMessageID,
			"reason":     "user_requested",
		},
	}

	if err := h.streamManager.AppendEvent(ctx, sessionID, assistantMessageID, stopEvent); err != nil {
		logger.ErrorWithFields(ctx, err, map[string]interface{}{
			"session_id": sessionID,
			"message_id": assistantMessageID,
		})
		c.JSON(500, gin.H{"error": "Failed to write stop event"})
		return
	}

	logger.Infof(ctx, "Stop event written successfully for session: %s, message: %s", sessionID, assistantMessageID)
	h.notifyBackgroundStop(ctx, session)
	c.JSON(200, gin.H{
		"success": true,
		"message": "Generation stopped",
	})
}

// handleAgentEventsForSSE 使用已有的 handler 处理 SSE 流式过程中的智能体事件。
// 该 handler 已订阅事件，且 AgentQA 已在运行。
// 本函数轮询 StreamManager 并把事件推送到 SSE，从而能够优雅处理连接断开。
// waitForTitle：为 true 时在完成后等待标题事件（适用于尚无标题的新会话）。
func (h *Handler) handleAgentEventsForSSE(
	ctx context.Context,
	c *gin.Context,
	sessionID, assistantMessageID, requestID string,
	eventBus *event.EventBus,
	waitForTitle bool,
	resourceRewriter *storageurl.StreamRewriter,
) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()

	lastOffset := 0
	log := logger.GetLogger(ctx)
	// Agent 模式会在完成事件发布之前释放沙箱回合租约，从而取消 ctx。
	// 用这个 context 轮询 Redis 会丢掉终结事件，导致客户端一直卡在
	// 回答末尾等待。客户端断开仍可通过下面的请求 context 观察到。
	pollCtx := context.WithoutCancel(ctx)

	log.Infof("Starting pull-based SSE streaming for session=%s, message=%s", sessionID, assistantMessageID)

	for {
		select {
		case <-c.Request.Context().Done():
			// 连接已关闭，优雅退出，不触发 panic
			log.Infof(
				"Client disconnected, stopping SSE streaming for session=%s, message=%s",
				sessionID,
				assistantMessageID,
			)
			return

		case <-heartbeat.C:
			c.SSEvent("message", gin.H{"response_type": "heartbeat"})
			c.Writer.Flush()
		case <-ticker.C:
			// 按偏移量从 StreamManager 获取新事件
			events, newOffset, err := h.streamManager.GetEvents(pollCtx, sessionID, assistantMessageID, lastOffset)
			if err != nil {
				log.Warnf("Failed to get events from stream: %v", err)
				continue
			}

			// 发送所有新事件
			streamCompleted := false
			titleReceived := false
			for _, evt := range events {
				// 检查是否是停止事件
				if evt.Type == types.ResponseType(event.EventStop) {
					log.Infof("Detected stop event, triggering stop via EventBus for session=%s", sessionID)

					// 向 EventBus 广播停止事件，以触发上下文取消
					if eventBus != nil {
						eventBus.Emit(ctx, event.Event{
							Type:      event.EventStop,
							SessionID: sessionID,
							Data: event.StopData{
								SessionID: sessionID,
								MessageID: assistantMessageID,
								Reason:    "user_requested",
							},
						})
					}

					// 先释放缓冲的尾部内容：停止前已生成的答案仍是用户的内容，
					// 在 public 资源 URL 模式下，其中一部分可能还留在
					// holdback 缓冲区里。
					flushHeldStreamContent(ctx, c, requestID, resourceRewriter)

					// 向前端发送停止通知
					c.SSEvent("message", &types.StreamResponse{
						ID:           requestID,
						ResponseType: "stop",
						Content:      "Generation stopped by user",
						Done:         true,
					})
					c.Writer.Flush()
					return
				}

				// 检查是否是结束事件
				if evt.Type == "complete" {
					streamCompleted = true
				}

				// 检查是否是标题事件
				if evt.Type == types.ResponseTypeSessionTitle {
					titleReceived = true
				}

				// 写事件前先确认连接仍然存活。必须在检查之后再构建载荷：
				// 在 public 资源 URL 模式下，构建载荷会把 chunk 消费进
				// holdback 缓冲区，若在此处提前返回就会丢掉它。
				if c.Request.Context().Err() != nil {
					log.Info("Connection closed during event sending, stopping")
					return
				}

				emitStreamEvent(ctx, c, evt, requestID, resourceRewriter)
			}

			// 更新偏移量
			lastOffset = newOffset

			// 检查流是否完成——仅在需要且尚未收到标题事件时才等待
			if streamCompleted {
				if waitForTitle && !titleReceived {
					log.Infof("Stream completed for session=%s, message=%s, waiting for title event", sessionID, assistantMessageID)
					// 完成后最多等待 3 秒以接收标题事件
					titleTimeout := time.After(3 * time.Second)
				titleWaitLoop:
					for {
						select {
						case <-titleTimeout:
							log.Info("Title wait timeout, closing stream")
							break titleWaitLoop
						case <-c.Request.Context().Done():
							log.Info("Connection closed while waiting for title")
							return
						default:
							// 检查是否有新事件（标题事件）
							events, newOff, err := h.streamManager.GetEvents(c.Request.Context(), sessionID, assistantMessageID, lastOffset)
							if err != nil {
								log.Warnf("Error getting events while waiting for title: %v", err)
								break titleWaitLoop
							}
							if len(events) > 0 {
								for _, evt := range events {
									emitStreamEvent(ctx, c, evt, requestID, resourceRewriter)
									// 收到标题事件即可退出
									if evt.Type == types.ResponseTypeSessionTitle {
										log.Infof("Title event received: %s", evt.Content)
										break titleWaitLoop
									}
								}
								lastOffset = newOff
							} else {
								// 没有事件，稍作等待后再检查
								time.Sleep(100 * time.Millisecond)
							}
						}
					}
				} else {
					log.Infof("Stream completed for session=%s, message=%s", sessionID, assistantMessageID)
				}
				sendCompletionEvent(c, requestID)
				return
			}
		}
	}
}
