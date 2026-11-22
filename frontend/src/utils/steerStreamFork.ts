import { markRaw } from 'vue'

export type ChatMessage = Record<string, unknown>

/**
 * Display a steer immediately; the receipt, not this preview, splits execution.
 *
 * 在消息列表中立即插入一条 steer 用户消息的乐观预览（标记 `_steerPending`）。
 * 预览只用于展示，不代表服务端已注入；真正的分段以服务端回执为准。
 * 按 `steer_id` 幂等：列表里已有同 ID 的用户消息（重试、升级为 inject，
 * 或 SSE 回执先到）时直接返回它，不会重复插入。
 *
 * @param list 消息列表
 * @param item steer 队列项（steer_id、content、mentioned_items）
 * @returns 列表中对应的用户消息对象（已有的或新插入的）
 */
export function previewSteerMessage(list: ChatMessage[], item: { steer_id: string; content: string; mentioned_items?: unknown[] }): ChatMessage {
  /**
   * 它在消息列表里找一条用户消息，条件是 steer_id 与要预览的这条相同。
   * 找到了就直接返回它，不再新建气泡。
   * 防止同一条 steer 消息被重复插入消息列表。
   */
  const existing = list.find(m => m.role === 'user' && m.steer_id === item.steer_id)
  if (existing) return existing
  /**新建一个 ChatMessage */
  const message: ChatMessage = {
    id: `steer-user-${item.steer_id}`, steer_id: item.steer_id,
    role: 'user', content: item.content, mentioned_items: item.mentioned_items || [],
    isSteer: true, is_completed: true, _steerPending: true,
  }
  list.push(message)
  return message
}

/**从消息列表里删掉某条 steer 消息的乐观预览气泡。 */
export function discardSteerPreview(list: ChatMessage[], steerId: string): void {
  const index = list.findIndex(m => m.steer_id === steerId && m._steerPending)
  if (index >= 0) list.splice(index, 1)
}

/**
 * Reconcile older servers that assign their own ID instead of echoing the client UUID.
 *
 * 请求返回后，对账消息列表里同一条 steer 消息的两个来源：
 * 前端的乐观预览（steer_id 为 clientId，带 `_steerPending`）和
 * SSE 回执插入的持久化行（steer_id 为 serverId），保证只留一个气泡。
 * - 两者都在且不是同一个对象：删掉预览，保留真实行（位置与服务端数据正确），
 *   并把预览里的 @ 提及复制过去，然后返回真实行。
 * - 只有预览：把它的 steer_id 改成 serverId，之后 SSE 回执才能按 ID 对上。
 * - clientId 与 serverId 相同（常见情况）：两次查找得到同一对象，原样返回。
 *
 * @param list     消息列表
 * @param clientId 前端发送时生成的 steer_id
 * @param serverId 服务端确认的 steer_id（响应缺失时调用方会传 clientId）
 * @returns 对账后列表中的那条消息；没有 `_steerPending` 说明送达回执已到
 */
export function reconcileSteerMessageId(list: ChatMessage[], clientId: string, serverId: string): ChatMessage | undefined {
  const preview = list.find(m => m.role === 'user' && m.steer_id === clientId)
  const received = list.find(m => m.role === 'user' && m.steer_id === serverId)
  if (preview && received && preview !== received && preview._steerPending) {
    // SSE may have already inserted the persisted row. Keep its position and
    // server metadata while preserving mentions from the optimistic message.
    if (Array.isArray(preview.mentioned_items) && preview.mentioned_items.length) {
      received.mentioned_items = preview.mentioned_items
    }
    list.splice(list.indexOf(preview), 1)
    return received
  }
  if (preview) preview.steer_id = serverId
  return received || preview
}

/**
 * The row id the server knows this assistant message by.
 *
 * A turn that absorbed a mid-run message is shown as several assistant
 * segments, and every segment after the first carries a synthetic id so Vue
 * can key the list. Only the persisted id addresses a real message, so
 * anything that talks to the backend — continue-stream, stop, artifacts —
 * must resolve through here rather than reading `id` directly.
 */
export function persistedAssistantId(message: ChatMessage | undefined): string {
  if (!message) return ''
  if (typeof message.assistant_message_id === 'string' && message.assistant_message_id) {
    return message.assistant_message_id
  }
  return typeof message.id === 'string' ? message.id : ''
}

/**它把一条 assistant 消息当作一个"已经结束的分段"来封口 */
export function sealAssistantSegment(message: ChatMessage): void {
  message.thinking = false
  message.is_completed = true
  message.steerForked = true
  const stream = message.agentEventStream
  if (!Array.isArray(stream)) return
  for (const raw of stream) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as ChatMessage
    if (event.type === 'thinking' || event.type === 'answer') {
      event.done = true
      event.thinking = false
    }
  }
}

export function forkAfterInjectedUser(
  list: ChatMessage[],
  sourceAssistant: ChatMessage,
  userMessage: ChatMessage,
  steerId?: string,
): ChatMessage {
  // continue-stream replays the whole event log, so after a refresh this runs
  // again for a transcript history has already split. Redoing the fork would
  // duplicate the bubble and seal the segment that is still streaming.
  //
  // "Already split" means the bubble sits *between* two segments of this turn.
  // A bubble merely sitting above the live assistant is the opposite case —
  // it still has to be moved underneath it.
  userMessage.isSteer = true
  delete userMessage._steerPending
  delete userMessage._steerFailed
  const existingIdx = list.indexOf(userMessage)
  if (existingIdx > 0) {
    /**前半段的 assistant 消息 */
    const before = list[existingIdx - 1]
    /**后半段的 assistant 消息 */
    const after = list[existingIdx + 1]
    if (
      before?.role === 'assistant' &&
      before.request_id === sourceAssistant.request_id &&
      after?.role === 'assistant' &&
      after.request_id === sourceAssistant.request_id
    ) {
      // 把前半段消息及进行封口
      sealAssistantSegment(before)
      // 把后半段重新标回“进行中”，用域重放场景
      if (after._steerReplayPending) {
        delete after._steerReplayPending
        after.is_completed = false
        after.steerForked = false
      }
      return after
    }
  }

  sealAssistantSegment(sourceAssistant)

  let userIdx = list.indexOf(userMessage)
  let sourceIdx = list.indexOf(sourceAssistant)
  if (userIdx < 0) {
    const insertAt = sourceIdx >= 0 ? sourceIdx + 1 : list.length
    list.splice(insertAt, 0, userMessage)
    userIdx = insertAt
  } else if (sourceIdx >= 0 && userIdx !== sourceIdx + 1) {
    list.splice(userIdx, 1)
    if (userIdx < sourceIdx) sourceIdx -= 1
    list.splice(sourceIdx + 1, 0, userMessage)
    userIdx = sourceIdx + 1
  }

  const afterUser = list[userIdx + 1]
  if (
    afterUser?.role === 'assistant' &&
    !afterUser.is_completed &&
    afterUser.request_id === sourceAssistant.request_id
  ) {
    return afterUser
  }

  const persistedId =
    (typeof sourceAssistant.assistant_message_id === 'string' && sourceAssistant.assistant_message_id) ||
    (typeof sourceAssistant.id === 'string' ? sourceAssistant.id : '')
  const continuation: ChatMessage = {
    id: `steer-cont-${steerId || String(Date.now())}`,
    assistant_message_id: persistedId,
    request_id: sourceAssistant.request_id,
    role: 'assistant',
    content: '',
    isAgentMode: true,
    isRagMode: sourceAssistant.isRagMode,
    is_completed: false,
    hideContent: true,
    agentEventStream: [],
    _eventMap: new Map(),
    _pendingToolCalls: new Map(),
    knowledge_references: [],
  }
  list.splice(userIdx + 1, 0, continuation)
  return continuation
}

function eventTime(event: ChatMessage): number {
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
    return event.timestamp
  }
  if (typeof event.timestamp === 'string') {
    const parsed = Date.parse(event.timestamp)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

function isTrailingTurnEvent(event: ChatMessage): boolean {
  if (event.type === 'agent_complete' || event.type === 'stop') return true
  return event.type === 'answer' && event.done === true && !event.superseded && !event.intermediate_answer
}

export function expandSteerForksInHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i]
    if (item.role !== 'assistant' || typeof item.request_id !== 'string' || !item.request_id) {
      out.push(item)
      continue
    }
    if (item.steerForked) {
      out.push(item)
      continue
    }
    const persisted = persistedAssistantId(item)
    if (persisted && item.id !== persisted) {
      out.push(item)
      continue
    }

    const forks: ChatMessage[] = []
    let j = i + 1
    while (
      j < messages.length &&
      messages[j].role === 'user' &&
      messages[j].request_id === item.request_id
    ) {
      forks.push(messages[j])
      j++
    }
    if (!forks.length) {
      out.push(item)
      continue
    }

    const stream = Array.isArray(item.agentEventStream) ? (item.agentEventStream as ChatMessage[]) : []
    const boundaryIDs = stream.filter(e => e.type === 'user_message_injected').map(e => e.user_message_id)
    const hasBoundaries = boundaryIDs.length > 0
    if (hasBoundaries) {
      forks.sort((a, b) => {
        const ai = boundaryIDs.indexOf(a.id), bi = boundaryIDs.indexOf(b.id)
        return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi)
      })
    }
    const cuts = forks.map((user) => {
      const parsed = Date.parse(String(user.created_at || ''))
      return Number.isNaN(parsed) ? 0 : parsed
    })
    const buckets: ChatMessage[][] = Array.from({ length: forks.length + 1 }, () => [])
    const trailing: ChatMessage[] = []
    let segmentIndex = 0
    for (const event of stream) {
      if (event.type === 'user_message_injected') {
        const index = forks.findIndex(user => user.id === event.user_message_id)
        if (index >= 0) segmentIndex = index + 1
        continue
      }
      if (isTrailingTurnEvent(event)) {
        trailing.push(event)
        continue
      }
      const t = eventTime(event)
      let idx = hasBoundaries ? segmentIndex : 0
      while (!hasBoundaries && idx < cuts.length && t >= cuts[idx]) idx += 1
      buckets[idx].push(event)
    }
    buckets[buckets.length - 1].push(...trailing)

    const persistedId =
      (typeof item.assistant_message_id === 'string' && item.assistant_message_id) ||
      (typeof item.id === 'string' ? item.id : '')
    // Segment 0 reuses the original object, and sealing it overwrites fields
    // the later segments still need. Snapshot first so every segment is built
    // from the message as it arrived — most importantly `is_completed`: a
    // trailing segment that inherits the prefix's sealed `true` tells the chat
    // view the turn is over, so a still-running agent is never resumed.
    const original: ChatMessage = { ...item }

    for (let s = 0; s < buckets.length; s++) {
      const isLast = s === buckets.length - 1
      const segment: ChatMessage = s === 0
        ? item
        : {
            ...original,
            id: `${persistedId}:steer:${s}`,
            assistant_message_id: persistedId,
          }
      segment.agentEventStream = markRaw(buckets[s])
      if (s > 0) segment.used_memories = undefined
      if (isLast) {
        segment.content = original.content
        segment.artifacts = original.artifacts
        segment.usage = original.usage
        segment.knowledge_references = original.knowledge_references
        segment.is_completed = original.is_completed
        segment.steerForked = original.steerForked
      } else {
        segment.steerForked = true
        segment.is_completed = true
        segment.content = buckets[s].filter(e => e.type === 'answer' && !e.superseded).map(e => e.content || '').join('')
        segment.artifacts = undefined
        segment.usage = undefined
        segment.knowledge_references = []
      }
      out.push(segment)
      if (s < forks.length) {
        forks[s].isSteer = true
        out.push(forks[s])
      }
    }
    i = j - 1
  }
  return out
}

export function steerStepEvents(step: ChatMessage): ChatMessage[] {
  const events: ChatMessage[] = []
  if (Array.isArray(step.user_messages_before)) {
    for (const id of step.user_messages_before) {
      events.push({ type: 'user_message_injected', user_message_id: id })
    }
  }
  return events
}

/** Rebuild the current stream generation. Approval continuations replay only
 * their suffix, so retain an immutable baseline for each presentation segment. */
export function resetSteerTurnForReplay(
  list: ChatMessage[], requestId: string, resumeId = '', blockedCallId = '',
): ChatMessage | undefined {
  const segments = list.filter(m => m.role === 'assistant' && m.request_id === requestId)
  if (!requestId || segments.length === 0) return undefined
  const sameResume = resumeId && segments.some(m => m._resumeReplayId === resumeId)
  const boundary = resumeId ? segments.findIndex(m =>
    ((m.agentEventStream || []) as ChatMessage[]).some(e =>
      e.type === 'tool_call' && e.tool_call_id === blockedCallId)) : -1
  let active = segments[0]
  for (const [index, segment] of segments.entries()) {
    if (resumeId && !sameResume) {
      delete segment._resumeReplayId
      delete segment._resumeReplayEvents
    }
    if (resumeId && !sameResume && (boundary < 0 || index <= boundary)) {
      segment._resumeReplayId = resumeId
      const events = (segment.agentEventStream || []) as ChatMessage[]
      const blocked = events.findIndex(e => e.type === 'tool_call' && e.tool_call_id === blockedCallId)
      // The resumed call starts the suffix in reloaded history. Events arriving
      // while approval was pending still belong to the prefix and must survive.
      segment._resumeReplayEvents = (blocked < 0 ? events : events.slice(0, blocked))
        .filter(e => e.type !== 'agent_complete' && e.type !== 'stop' &&
          !(blockedCallId && e.type === 'tool_call' && e.tool_call_id === blockedCallId))
        .map(e => ({ ...e }))
    }
    const hasBaseline = resumeId && segment._resumeReplayId === resumeId
    segment.content = ''
    segment.agentEventStream = hasBaseline
      ? (segment._resumeReplayEvents as ChatMessage[]).map(e => ({ ...e })) : []
    segment._eventMap = new Map()
    segment._pendingToolCalls = new Map()
    segment.is_completed = true
    segment._steerReplayPending = true
    if (hasBaseline) {
      active = segment
      delete segment._steerReplayPending
    } else if (!resumeId) {
      delete segment._resumeReplayId
      delete segment._resumeReplayEvents
    }
  }
  active.is_completed = false
  active.steerForked = false
  delete active._steerReplayPending
  return active
}

/** Individual answer.done events close a message, not the running task. */
export function isAssistantTurnComplete(message: ChatMessage | undefined): boolean {
  if (!message || message.steerForked) return false
  return Boolean(message.is_completed) || (Array.isArray(message.agentEventStream) &&
    message.agentEventStream.some(e => e.type === 'agent_complete' || e.type === 'stop'))
}
