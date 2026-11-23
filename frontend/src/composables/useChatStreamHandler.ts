import { emitAssistantDataChange } from '@/utils/assistantDataChange'
import { approvalEventFromRecord, clearComposerApproval, showComposerApproval } from '@/views/chat/components/hostApproval'
import { applyFinalArtifactContent } from '@/utils/finalArtifactContent'
import { parseThinkBlocks } from '@/utils/thinkBlocks'
import { markRaw, nextTick, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ensureRagPipelineHistoryStream } from '@/utils/rag-pipeline-history'
import { applyMessageCreatedAt, bindServerTurnTimestamps, ensureMessageCreatedAt } from '@/utils/messageTimestamp'
import { expandSteerForksInHistory, forkAfterInjectedUser, persistedAssistantId, steerStepEvents, resetSteerTurnForReplay } from '@/utils/steerStreamFork'
import type { CollaborationStatus, CollaborationTaskStatus } from '@/api/chat/streamTypes'

export type { CollaborationStatus, CollaborationTaskStatus } from '@/api/chat/streamTypes'
/**
 * 聊天消息的类型。历史消息、SSE 流事件、时间线事件都用它。
 *
 * 本质是“什么字段都能放”的对象（id、role、content 等都没有逐个声明）：
 * 后端加新字段时前端不会报错，但字段名写错了编译器也发现不了，
 * 读取字段前要自己判断类型。
 *
 * 只单独声明了协作快照的两个字段：
 * - `collaboration_status`：后端接口返回的原始字段。
 * - `collaborationStatus`：前端加载历史时从上面拷贝过来的，界面统一读这个。
 */
export type ChatMessage = Record<string, unknown> & {
  collaborationStatus?: CollaborationStatus
  collaboration_status?: CollaborationStatus
}

const TERMINAL_COLLABORATION_STATES = new Set(['succeeded', 'completed', 'failed', 'interrupted', 'cancelled', 'canceled'])

// Tools whose results tell open pages what changed (see dataChangeTools on
// the server).
const DATA_CHANGE_TOOLS = new Set([
  'run_operation', 'wiki_write_page', 'wiki_replace_text', 'wiki_rename_page', 'wiki_delete_page', 'wiki_update_issue',
])

/**
 * useChatStreamHandler 的入参，由聊天页面传进来。分两类：
 * - 数据/状态：页面里的变量，handler 直接读写它们；
 * - on 开头的回调：handler 在某个时机调用它们，让页面自己去处理（回调都是可选的）。
 */
export interface UseChatStreamHandlerOptions {
  /** 当前会话的消息列表（用户消息和 assistant 消息混在一起），handler 往里新增、修改消息。 */
  messagesList: ChatMessage[]
  /** 已发出请求、但第一批内容还没到的等待状态；第一批内容到达时 handler 把它设为 false。 */
  loading: Ref<boolean>
  /** AI 是否正在回复；回复结束、停止、出错时 handler 把它设为 false。 */
  isReplying: Ref<boolean>
  /** 当前正在写入的那条 assistant 消息的 ID。 */
  currentAssistantMessageId: Ref<string>
  /** 当前这条回复已累计的完整正文；回复结束后清空。 */
  fullContent: Ref<string>
  /** 当前会话是否是 Agent 流会话（用来给新建的消息打 isRagMode 标记）。 */
  isAgentStreamSession: () => boolean
  /** 把聊天区域滚到最底部（用户正在往上翻历史时页面会忽略这次滚动）。 */
  scrollToBottom: (force?: boolean) => void
  /** 一次回复完成时调用，参数是回复的完整正文。 */
  onReplyComplete?: (content: string) => void
  /** 一整轮对话结束时调用，参数是这一轮的 assistant 消息。 */
  onTurnComplete?: (message: ChatMessage) => void
  /** 出错时调用，参数是错误提示文字，由页面负责展示。 */
  onError?: (message: string) => void
  /** Main chat: keep the last incomplete message reactive for continue-stream. */
  preserveIncompleteStreamReactive?: boolean
  /** 是否是刚进入会话的首次加载；为 true 时，加载完历史消息会滚到底部。 */
  isFirstEnter?: Ref<boolean>
  /** 聊天区域的滚动容器；向上翻页加载更早的历史消息后，用它保持原来的滚动位置不跳。 */
  scrollContainer?: Ref<HTMLElement | null>
  /** 历史消息加载并渲染完之后调用（页面用它去加载建议问题等）。 */
  onAfterMsgList?: () => void | Promise<void>
  /** 收到 agent_query 事件（一轮 Agent 查询开始）时调用；created 表示这条消息是不是刚新建的。 */
  onAgentQuery?: (
    data: ChatMessage,
    existingMessage: ChatMessage | undefined,
    created: boolean,
  ) => void
  /** 新建了一条 assistant 消息时调用。 */
  onMessageCreated?: (message: ChatMessage) => void
  /** 已有的 assistant 消息被新事件更新时调用；payload 是触发更新的那个事件。 */
  onMessageUpdated?: (message: ChatMessage, payload?: ChatMessage) => void
  /** 一段回答生成完毕时调用。 */
  onAgentAnswerDone?: (message: ChatMessage) => void
  /** 流事件绑定到某条 assistant 消息时调用；created 表示这条消息是不是刚新建的。 */
  onAgentChunkBound?: (message: ChatMessage, created: boolean) => void
  /** 用户中途插话（steer）的消息被服务端接收时调用，参数是插话的 ID。 */
  onUserMessageInjected?: (steerId: string) => void
  /** The assistant asks to read or fill the page; answered by the page, not shown. */
  onPageAction?: (prompt: ChatMessage) => void
  /** Remote or local stop: the composer overlay must drop server-discarded items. */
  onGenerationStopped?: () => void
  /** 为 true 时在控制台打印调试日志（页面开发环境下开启）。 */
  debug?: boolean
}

function mergeToolCallArguments(previous: unknown, incoming: unknown): Record<string, unknown> {
  const prev =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {}
  const next =
    incoming && typeof incoming === 'object' && !Array.isArray(incoming)
      ? (incoming as Record<string, unknown>)
      : { value: incoming }
  return { ...prev, ...next }
}

const AWAITING_INPUT = 'awaiting_input'

const PROMPT_CARD_TYPES = new Set(['tool_approval_required', 'agent_prompt_required'])

/** Whether e is the card of a prompt the user answers (approval, question). */
export function isPromptCard(e: ChatMessage | undefined): boolean {
  return PROMPT_CARD_TYPES.has(String(e?.type || ''))
}

/**是否此次 assistant 消息是否正在等待用户输入 */
export function isAwaitingInput(message: ChatMessage | undefined): boolean {
  return message?.run_state === AWAITING_INPUT
}

/**
 * 把数据库里保存的一条“待用户处理的提示记录”，转成界面能渲染的提示卡片事件。
 *
 * 用在刷新页面、加载历史消息的时候：实时事件已经没了，要靠库里的记录把
 * “工具审批”“向用户提问”这类卡片重新画出来。转换后的格式和流式事件一致，
 * 所以实时和历史可以共用同一套渲染。
 *
 * 按记录的 kind 分三种情况：
 * - `ask_user`：转成 agent_prompt_required 卡片（Agent 向用户提问）；
 * - `tool_approval`：转成 tool_approval_required 卡片（工具等用户批准）；
 * - 其他 kind，或记录没有 id：返回空数组，不生成卡片。
 *
 * 卡片是否“已解决”由 status 决定：除了 pending / suspended，其余都算已解决；
 * canceled 标记为已取消，expired / superseded 标记为已作废。
 *
 * @param prompt 后端保存的提示记录（类型不确定，函数内部自行判断）
 * @returns 提示卡片事件数组，最多一个元素
 */
export function pendingPromptEvents(prompt: unknown): ChatMessage[] {
  const p = prompt as Record<string, any> | undefined
  if (!p?.id) return []
  const request = (p.request || {}) as Record<string, any>
  const createdAt = Date.parse(String(p.created_at || ''))
  const requestedAt = Number.isNaN(createdAt) ? undefined : Math.floor(createdAt / 1000)
  const response = p.response || {}
  const resolved = Boolean(p.status && !['pending', 'suspended'].includes(p.status))
  const state = {
    resolved,
    timestamp: Number.isNaN(createdAt) ? undefined : createdAt,
    canceled: p.status === 'canceled',
    abandoned: ['expired', 'superseded'].includes(p.status),
    resolve_reason: p.close_reason || response.reason,
    suspended: !resolved,
  }
  if (p.kind === 'ask_user') {
    return [{
      type: 'agent_prompt_required',
      pending_id: p.id,
      kind: p.kind,
      delegated_task: p.delegated_task,
      request: p.delegated_task ? { ...request, question: `${p.delegated_task}: ${request.question || ""}` } : request,
      tool_call_id: p.tool_call_id,
      requested_at: requestedAt,
      suspendable: true,
      expires_at: p.expires_at,
      ...state,
      answered: resolved && Boolean(p.response) && !response.declined,
      response,
      resolve_reason: response.declined ? 'declined' : state.resolve_reason,
      timed_out: p.status === 'expired',
    }]
  }
  if (p.kind !== 'tool_approval') return []
  return [{
    type: 'tool_approval_required',
    pending_id: p.id,
    service_name: request.service_name,
    mcp_tool_name: request.mcp_tool_name,
    delegated_task: p.delegated_task,
    description: request.description,
    args_json: response.approved && response.modified_args !== undefined
      ? JSON.stringify(response.modified_args)
      : request.args === undefined ? '' : JSON.stringify(request.args),
    grant_scope: request.grant_scope,
    grant_lapsed: request.grant_lapsed,
    tool_call_id: p.tool_call_id,
    requested_at: requestedAt,
    suspendable: true,
    expires_at: p.expires_at,
    ...state,
    approved: Boolean(response.approved),
  }]
}

/** The card of an ask_user call that finished, from the stored tool result. */
function askUserHistoryCard(toolCallId: string, data: ChatMessage): ChatMessage {
  return {
    type: 'agent_prompt_required',
    pending_id: `history-${toolCallId}`,
    kind: 'ask_user',
    request: data.question,
    tool_call_id: toolCallId,
    resolved: true,
    answered: Boolean(data.answered),
    response: data.answer,
    resolve_reason: data.reason,
    timed_out: Boolean(data.timed_out),
    canceled: Boolean(data.canceled),
  }
}

/**
 * 聊天消息的处理中心：把后端的流式事件和历史消息，整理成界面能渲染的 assistant 消息。
 *
 * 页面通过 options 传入消息列表、状态变量和各种回调；
 * 返回的主要方法：
 * - processStreamChunk：处理实时到达的流式事件；
 * - handleMsgList：处理从后端加载的历史消息；
 * - prepareForNewOutgoingMessage / prepareResumedMessage / markInFlightAssistantStopped：
 *   发送新消息、恢复运行、停止生成时，整理进行中的消息；
 * - findLastMessage / shouldRenderAssistantMessage / shouldShowGlobalTypingIndicator：
 *   查找和渲染判断用的辅助方法。
 */
export function useChatStreamHandler(options: UseChatStreamHandlerOptions) {
  const { t } = useI18n()
  const {
    messagesList,
    loading,
    isReplying,
    currentAssistantMessageId,
    fullContent,
    isAgentStreamSession,
    scrollToBottom,
    onReplyComplete,
    onTurnComplete,
    onError,
    preserveIncompleteStreamReactive = false,
    isFirstEnter,
    scrollContainer,
    onAfterMsgList,
    onAgentQuery,
    onMessageCreated,
    onMessageUpdated,
    onAgentAnswerDone,
    onAgentChunkBound,
    onUserMessageInjected,
    onGenerationStopped,
    debug = false,
  } = options

  /**
   * 有新消息创建了，告诉外部，让外部自己去处理。
   * 1. 先保证消息有创建时间（没有就用当前时间补上）；
   * 2. 再调用外部传进来的 onMessageCreated 函数，并把这条消息传给它
   *    （这个函数是可选的，外部没传就跳过）。
   * 目前聊天页面 views/chat/index.vue 传入的处理是 attachStreamDebugToMessage。
   */
  const emitMessageCreated = (message: ChatMessage) => {
    ensureMessageCreatedAt(message)
    // 调用外部传入的回调函数，将 message 传进去
    onMessageCreated?.(message)
  }

  const emitMessageUpdated = (message: ChatMessage, payload?: ChatMessage) => {
    if (payload) applyMessageCreatedAt(message, payload.created_at)
    onMessageUpdated?.(message, payload)
  }

  const log = (...args: unknown[]) => {
    if (debug) console.log(...args)
  }

  /**
   * findLastMesage 主要是用来寻找对应条件的 message 并返回，
   * 没找到就返回 undifined,
   * 它内部的逻辑主要是用来遍历 messageList ，
   * 然后调用 predicate 来进行匹配每一个 message
   * 
   * 对应的 message 匹配条件有由接受的 predicate 函数决定
   * 
   * @param predicate 一个函数，用来定义匹配条件
   * @returns 匹配成功返回对应的 message ，失败返回 undefined
   */
  const findLastMessage = (predicate: (item: ChatMessage) => boolean) => {
    for (let i = messagesList.length - 1; i >= 0; i--) {
      const item = messagesList[i]
      if (predicate(item)) return item
    }
    return undefined
  }

  /**
   * 取当前回合最近一条“未完成”的 assistant 消息。
   * 从列表末尾向前找；即使最后一条是 user 消息（如 steer 插入的输入），
   * 也会继续往前找。找不到返回 undefined。
   */
  const getTrailingIncompleteAssistant = () => {
    for (let i = messagesList.length - 1; i >= 0; i--) {
      const item = messagesList[i]
      if (item?.role === 'assistant' && !item.is_completed) return item
    }
    return undefined
  }

  const markAssistantStopped = (message: ChatMessage) => {
    if (!message) return
    message.run_state = ''
    message.is_completed = true
    if (message.isAgentMode) {
      if (!message.agentEventStream) message.agentEventStream = []
      const stream = message.agentEventStream as ChatMessage[]
      if (!stream.some((e) => e.type === 'stop')) {
        stream.push({
          type: 'stop',
          timestamp: Date.now(),
          reason: 'user_requested',
        })
      }
    }
  }

  /** Finalize any in-flight assistant rows before a new user query is sent. */
  const prepareForNewOutgoingMessage = () => {
    for (const msg of messagesList) {
      if (msg.role === 'assistant' && !msg.is_completed) {
        markAssistantStopped(msg)
      }
      if (msg.role === 'assistant' && isAwaitingInput(msg)) abandonPendingPrompts(msg)
    }
    fullContent.value = ''
    currentAssistantMessageId.value = ''
  }

  /** A new message supersedes the prompt a suspended run waits on. */
  const abandonPendingPrompts = (msg: ChatMessage) => {
    const stream = (msg.agentEventStream as ChatMessage[] | undefined) || []
    msg.agentEventStream = stream.map((e) =>
      isPromptCard(e) && !e.resolved ? { ...e, resolved: true, abandoned: true } : e,
    )
    msg.run_state = ''
  }

  /** Mark the assistant row being stopped without clearing its id (stop API still needs it). */
  const markInFlightAssistantStopped = (messageId?: string) => {
    let target: ChatMessage | undefined
    if (messageId) {
      target = messagesList.find(
        (m) =>
          m.role === 'assistant' &&
          (m.id === messageId ||
            m.assistant_message_id === messageId ||
            m.request_id === messageId),
      )
    }
    if (!target) target = getTrailingIncompleteAssistant() || findLastMessage(m => m.role === 'assistant')
    if (target) {
      const turnId = persistedAssistantId(target)
      for (const row of messagesList) {
        if (row.role !== 'assistant' || persistedAssistantId(row) !== turnId) continue
        row.run_state = ''
        for (const e of (row.agentEventStream as ChatMessage[] | undefined) || []) {
          if (isPromptCard(e) && !e.resolved) Object.assign(e, { resolved: true, canceled: true })
          if (e.pending) Object.assign(e, { pending: false, canceled: true })
        }
      }
      markAssistantStopped(target)
    }
    fullContent.value = ''
  }

  /**
   * extractKnowledgeReferences 取这条流式事件里携带的知识引用列表
   * 
   * @param data 一条流式事件
   * @returns 返回取出的知识库列表 refs
   */
  const extractKnowledgeReferences = (data: ChatMessage) => {
    // 取这条消息的荷载，即数据库等一些内容
    const dataPayload = data.data as ChatMessage | undefined
    // 同一份数据可能在不同的位置，依次尝试
    const refs =
      data.knowledge_references ||
      dataPayload?.references ||
      dataPayload?.knowledge_references ||
      []
    return Array.isArray(refs) ? refs : []
  }

  /**
   * 流式重放期间的"当前活动分段"指针表。
   *
   * - key：SSE 事件的 `data.id`，即本次请求的 request ID；
   * - value：该请求当前正在重放/续写的 assistant 消息对象。它是 messagesList 中
   *   同一条消息的引用，不是内容副本，因此消息后续流式更新也能看到。
   *
   * 一次请求可能因 steer 被拆成多条 request_id 相同的分段；断线重连或审批恢复后，
   * 后端会从头重放事件，此时不能靠"最后一条 assistant 消息"去猜，否则事件会写进
   * 错误的分段。resolveActiveAssistantMessage 会优先查这张表来钉住正确的分段。
   *
   * 写入：
   * - agent_query 重放时，记录 resetSteerTurnForReplay 返回的活动分段；
   * - user_message_injected（steer）时，更新为 fork 出的后段 continuation。
   *
   * 删除：complete / stop / 持久化失败错误到达时清理，因此只在重放期间存在。
   */
  const replaySegments = new Map<string, ChatMessage>()

  /** Match the in-flight assistant row by request id or assistant message id. */
  /** 
   * 根据一条 SSE 事件，找出它应该归属的那条 assistant 消息气泡 
   * 它返回这条事件该归属的 assistant 消息对象引用；找不到返回 undefined
   */
  const resolveActiveAssistantMessage = (data: ChatMessage) => {
    /** data.id = 这一次用户提问/这一轮生成的请求 ID，所有属于同一个回合的流事件都带同一个 data.id。*/
    const dataId = data.id as string | undefined
    /**获取子 agent 的ID */
    const assistantId =
      (data.assistant_message_id as string | undefined) ||
      currentAssistantMessageId.value ||
      undefined

    if (dataId && replaySegments.has(dataId)) return replaySegments.get(dataId)

    // A delayed event from an earlier request must not bind to the current
    // assistant merely because it appears later in the transcript.
    if (dataId) {
      const requestMatch = findLastMessage(item => item.role === 'assistant' &&
        (item.request_id === dataId || item.id === dataId))
      if (requestMatch) return requestMatch
    }

    const matched = findLastMessage((item) => {
      if (item.role !== 'assistant') return false
      if (dataId && (item.request_id === dataId || item.id === dataId)) return true
      if (assistantId && (item.id === assistantId || item.request_id === assistantId)) return true
      return false
    })
    if (matched) return matched

    return getTrailingIncompleteAssistant()
  }

  const applyKnowledgeReferences = (data: ChatMessage) => {
    // 获取知识库列表
    const refs = extractKnowledgeReferences(data)
    if (!refs.length) return undefined

    let message = resolveActiveAssistantMessage(data)
    const created = !message
    if (!message) {
      const rowId = (data.id as string | undefined) || currentAssistantMessageId.value
      message = {
        id: rowId,
        request_id: rowId,
        role: 'assistant',
        content: '',
        showThink: false,
        thinkContent: '',
        thinking: false,
        is_completed: false,
        knowledge_references: [],
      }
      ensureAgentMessageShell(message, data.id as string | undefined)
      messagesList.push(message)
      emitMessageCreated(message)
      loading.value = false
    } else {
      ensureAgentMessageShell(message, data.id as string | undefined)
    }

    message.knowledge_references = refs.slice()
    if (created) onAgentChunkBound?.(message, true)
    emitMessageUpdated(message, data)
    log('[References] Saved to message, count:', refs.length)
    return message
  }

  // Records which long-term memories the answer saw. Unlike references this
  // never creates a message shell: memory arrives before the first token, and
  // an empty bubble that only says "3 memories" would be worse than waiting
  // for the answer's own placeholder.
  const applyUsedMemories = (data: ChatMessage) => {
    const payload = (data.data ?? {}) as Record<string, unknown>
    const memories = (payload.memories ?? data.memories) as unknown
    if (!Array.isArray(memories) || memories.length === 0) return undefined

    const message = resolveActiveAssistantMessage(data)
    if (!message) {
      log('[Memory] No assistant message to attach memories to')
      return undefined
    }
    message.used_memories = memories.slice()
    emitMessageUpdated(message, data)
    log('[Memory] Saved to message, count:', memories.length)
    return message
  }

  /**
   * ensureAgentMessageShell 确保这条 assistant 消息具备渲染 Agent 事件所需的“外壳”，
   * 随后缺什么就补什么。
   */
  const ensureAgentMessageShell = (message: ChatMessage, requestId?: string) => {
    if (message.role === 'user') return
    message.isAgentMode = true
    if (!isAgentStreamSession()) {
      message.isRagMode = true
    }
    if (!message.agentEventStream) message.agentEventStream = []
    if (!message._eventMap) message._eventMap = new Map()
    if (!message._pendingToolCalls) message._pendingToolCalls = new Map()
    if (requestId) {
      if (!message.id) message.id = requestId
      if (!message.request_id) message.request_id = requestId
    }
  }

  const shouldRenderAssistantMessage = (session: ChatMessage) => {
    if (!session?.isAgentMode) return true
    if (!session.is_completed) return true
    if (session.collaborationStatus?.tasks.length) return true
    const stream = session.agentEventStream
    if (Array.isArray(stream) && stream.length > 0) return true
    if (Array.isArray(session.knowledge_references) && session.knowledge_references.length > 0) {
      return true
    }
    // A turn can carry its answer as plain content with no timeline events —
    // most visibly after a steer fork, where the events are split across
    // segments and one segment can end up holding only the answer text.
    // Hiding that row loses the reply entirely on reload.
    if (typeof session.content === 'string' && session.content.trim()) return true
    return false
  }

  const shouldShowGlobalTypingIndicator = (
    messages: ChatMessage[],
    isLoading: boolean,
    isRecovering = false,
  ) => {
    if (!isLoading && !isRecovering) return false
    if (messages.some((m) => m.role === 'assistant' && m.isAgentMode && !m.is_completed)) {
      return false
    }
    return true
  }

  /** Quick-answer sessions: restore flags lost after history reload. */
  const restoreQuickAnswerFlags = (item: ChatMessage) => {
    if (isAgentStreamSession() || item.role !== 'assistant') return
    item.isRagMode = true
    if (
      item.agent_steps &&
      Array.isArray(item.agent_steps) &&
      item.agent_steps.length > 0
    ) {
      item.isAgentMode = true
      item.hideContent = true
    }
    ensureRagPipelineHistoryStream(item as Parameters<typeof ensureRagPipelineHistoryStream>[0])
    if (item.isRagMode && item.agentEventStream) {
      item.agentEventStream = markRaw(item.agentEventStream as object)
    }
  }

  /**
   * 用来按顺序拼接已经发送过，但还未作废的 answer 流事件。
   * 为什么需要整体拼接呢？
   * 因为一条消息的回答可能由多个 answer 事件组成,而且它们会被撤回。有两处代码在做撤回:

   * 1290-1298:agent 先流出一段文字,紧接着发起了 tool_call。这说明刚才那段文字只是"工具调用前的过渡话",不是最终回答。代码把它标成 superseded = true。
   * 1499-1517:服务端发来 replace,要求把某个 event_id 的内容清空重写。
   * 
   * 撤回的是中间某一段。message.content 是已经拼好的一整段字符串,没法从里面把这一段单独剪掉。
   * 如果只用 +=,被撤回的文字会一直留在界面上。重拼时跳过 superseded 的事件,就能把它们去掉。
   */
  const recomposeAgentAnswer = (message: ChatMessage) => {
    const stream = message.agentEventStream as Array<{
      type?: string
      superseded?: boolean
      content?: string
    }> | undefined
    if (!stream) return ''
    let out = ''
    for (const e of stream) {
      if (e.type === 'answer' && !e.superseded && e.content) {
        out += e.content
      }
    }
    return out
  }

  const agentStepsAreTruncated = (agentSteps: unknown[] | undefined) =>
    Array.isArray(agentSteps) &&
    agentSteps.some((step) => (step as ChatMessage | undefined)?.truncated === true)

  // Steering splits presentation, not the collaboration group. Its current
  // snapshot appears only on the last assistant segment of the parent turn.
  const consolidateCollaborationStatus = () => {
    const turns = new Map<string, { last: ChatMessage; snapshot?: CollaborationStatus }>()
    for (const row of messagesList) {
      if (row.role !== 'assistant') continue
      const id = persistedAssistantId(row)
      if (!id) continue
      const prior = turns.get(id)?.snapshot
      const incoming = row.collaborationStatus
      const snapshot = !incoming || (prior?.group_id === incoming.group_id && prior.revision > incoming.revision)
        ? prior : incoming
      turns.set(id, { last: row, snapshot })
      delete row.collaborationStatus
    }
    for (const { last, snapshot } of turns.values()) {
      if (snapshot) last.collaborationStatus = snapshot
    }
  }

  const reconstructEventStreamFromSteps = (
    agentSteps: unknown[],
    messageContent: string,
    isCompleted = false,
    isFallback = false,
    agentDurationMs = 0,
    usage?: unknown,
  ) => {
    const events: ChatMessage[] = []

    if (agentSteps && Array.isArray(agentSteps) && agentSteps.length > 0) {
      agentSteps.forEach((rawStep) => {
        const step = rawStep as ChatMessage
        events.push(...steerStepEvents(step))
        const stepTimestamp = step.timestamp ? new Date(String(step.timestamp)).getTime() : 0
        const toolCalls = step.tool_calls
        const hasToolCalls = toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0

        const reasoningText =
          step.reasoning_content && String(step.reasoning_content).trim()
            ? String(step.reasoning_content)
            : ''
        if (reasoningText) {
          events.push({
            type: 'thinking',
            event_id: `step-${step.iteration}-thought`,
            content: reasoningText,
            done: true,
            thinking: false,
            timestamp: stepTimestamp || undefined,
            duration_ms: step.duration || undefined,
          })
        }
        const progressText = step.progress && String(step.progress).trim() ? String(step.progress) : ''
        const preambleText = step.thought && String(step.thought).trim() ? String(step.thought) : ''
        if (progressText) {
          events.push({ type: 'progress', event_id: step.progress_event_id || `step-${step.iteration}-progress`,
            content: progressText, done: true, iteration: step.iteration, timestamp: stepTimestamp || undefined })
        }
        if (!progressText && preambleText && step.intermediate_answer) {
          events.push({ type: 'answer', event_id: `step-${step.iteration}-answer`,
            content: preambleText, done: true, intermediate_answer: true, timestamp: stepTimestamp || undefined })
        }
        if (!progressText && preambleText && hasToolCalls && !step.intermediate_answer) {
          events.push({
            type: 'answer',
            event_id: `step-${step.iteration}-preamble`,
            content: preambleText,
            done: true,
            superseded: true,
            timestamp: stepTimestamp || undefined,
          })
        }

        const approvals = Array.isArray(step.approvals) ? step.approvals as ChatMessage[] : []
        approvals.forEach((record) => {
          events.push(approvalEventFromRecord(record))
        })

        if (toolCalls && Array.isArray(toolCalls)) {
          toolCalls.forEach((toolCall: ChatMessage) => {
            if (toolCall.name === 'final_answer') return
            const result = toolCall.result as ChatMessage | undefined
            const resultData = result?.data as ChatMessage | undefined
            const target = toolCall.target as ChatMessage | undefined
            if (resultData?.display_type === 'ask_user') {
              events.push(askUserHistoryCard(String(toolCall.id || ''), resultData))
              return
            }
            events.push({
              type: 'tool_call',
              tool_call_id: toolCall.id,
              tool_name: target?.name || toolCall.name,
              arguments: target?.args || toolCall.args,
              pending: false,
              success: result?.success !== false,
              output: result?.output || '',
              error: result?.error || undefined,
              timestamp: stepTimestamp || undefined,
              duration: toolCall.duration,
              duration_ms: toolCall.duration,
              display_type: resultData?.display_type,
              tool_data: result?.data,
            })
          })
        }
      })
    }

    if (isCompleted && (agentDurationMs > 0 || usage)) {
      events.push({
        type: 'agent_complete',
        total_duration_ms: agentDurationMs,
        usage,
      })
    }

    if (messageContent && messageContent.trim()) {
      const answerEvent: ChatMessage = {
        type: 'answer',
        content: messageContent,
        done: true,
      }
      if (isFallback) answerEvent.is_fallback = true
      // A round the completion cap cut off marks its step. Live streaming
      // carries the same fact on the answer event, but history is rebuilt from
      // agent_steps and never sees those events, so without this a reloaded
      // half-written answer looks finished.
      if (agentStepsAreTruncated(agentSteps)) answerEvent.truncated = true
      events.push(answerEvent)
    } else if (isCompleted) {
      events.push({
        type: 'stop',
        timestamp: Date.now(),
        reason: 'user_requested',
      })
    }

    return events
  }

  /**
   * 在提示（审批、提问）被回答、服务端已恢复运行之后，
   * 让一条处于挂起状态的消息重新进入"可接收流式数据"的状态。
   * 恢复后的流只携带新事件，所以由历史构建出的时间线要保留，
   * 而之前被阻塞的那次工具调用要删掉：恢复后的运行会重新上报它。
   */
  const prepareResumedMessage = (message: ChatMessage, pendingId: string) => {
    const stream = (message.agentEventStream as ChatMessage[] | undefined) || []
    const card = stream.find((e) => isPromptCard(e) && e.pending_id === pendingId)
    const blockedCall = card?.tool_call_id
    message.agentEventStream = stream.filter((e) => {
      if (e.type === 'agent_complete' || e.type === 'stop') return false
      return !(blockedCall && e.type === 'tool_call' && e.tool_call_id === blockedCall)
    })
    message._eventMap = new Map()
    message._pendingToolCalls = new Map()
    message.run_state = ''
    message.is_completed = false
  }

  /**
   * handleMsgList 处理的是从后端加载回来的"历史消息列表",不是流式事件。
   * 它把后端返回的原始消息,加工成前端界面能直接渲染的消息对象,再放进 messagesList。
   */
  const handleMsgList = async (
    data: ChatMessage[],
    isScrollType = false,
    newScrollHeight?: number,
  ) => {
    const chatlist = [...data]
    const existingIds = new Set(messagesList.map((m) => m.id).filter(Boolean))
    const processed: ChatMessage[] = []

    for (const raw of chatlist) {
      const item = preserveIncompleteStreamReactive ? raw : { ...raw }
      if (item.collaboration_status) item.collaborationStatus = item.collaboration_status
      if (item.id && existingIds.has(item.id)) continue
      if (item.id) existingIds.add(item.id)

      item.isAgentMode = false
      if (item.collaborationStatus) {
        item.isAgentMode = true
        item.hideContent = true
      }
      // A run awaiting input has ended for now: nothing streams until its
      // prompt is answered, so it renders as settled.
      const awaiting = isAwaitingInput(item)
      const willContinueStream = preserveIncompleteStreamReactive && (!item.is_completed || awaiting)
      if (willContinueStream) {
        item.agentEventStream = item.agentEventStream || []
        item._eventMap = new Map()
        item._pendingToolCalls = new Map()
      } else {
        item.agent_steps = item.agent_steps ? markRaw(item.agent_steps as object) : item.agent_steps
        item.agentEventStream = markRaw((item.agentEventStream as unknown[]) || [])
        item._eventMap = markRaw(new Map())
        item._pendingToolCalls = markRaw(new Map())
      }

      if (item.agent_steps && Array.isArray(item.agent_steps) && item.agent_steps.length > 0) {
        item.isAgentMode = true
        const restoredEvents = reconstructEventStreamFromSteps(
          item.agent_steps as unknown[],
          String(item.content || ''),
          Boolean(item.is_completed),
          Boolean(item.is_fallback),
          Number(item.agent_duration_ms) || 0,
          item.usage,
        )
        item.agentEventStream = willContinueStream ? restoredEvents : markRaw(restoredEvents)
        item.hideContent = true
        if (agentStepsAreTruncated(item.agent_steps as unknown[])) item.truncated = true
      }

      if (awaiting) {
        item.isAgentMode = true
        item.hideContent = true
        const awaitingEvents = (item.agentEventStream as ChatMessage[])
          .filter((e) => e.type !== 'agent_complete')

        item.agentEventStream = willContinueStream ? awaitingEvents : markRaw(awaitingEvents)
        item.is_completed = true
      }
      const promptCards = [
        ...(Array.isArray(item.prompt_history) ? item.prompt_history : []),
        ...(Array.isArray(item.delegated_prompts) ? item.delegated_prompts : []),
        ...(item.pending_prompt ? [item.pending_prompt] : []),
      ].flatMap(pendingPromptEvents)
      if (promptCards.length) {
        item.isAgentMode = true
        item.hideContent = true
        const events = [...(item.agentEventStream as ChatMessage[])]
        promptCards.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
        for (const card of promptCards) {
          if (events.some(e => isPromptCard(e) && e.pending_id === card.pending_id)) continue
          // Replace ask_user's tool-result fallback with the authoritative row.
          const fallback = events.findIndex(e => e.pending_id === `history-${card.tool_call_id}` && !card.delegated_task)
          if (fallback >= 0) events.splice(fallback, 1)
          const at = events.findIndex(e =>
            (!card.delegated_task && e.type === 'tool_call' && e.tool_call_id === card.tool_call_id) ||
            (card.timestamp && e.timestamp && Number(e.timestamp) > Number(card.timestamp)) ||
            e.type === 'agent_complete' || (e.type === 'answer' && !e.event_id))
          events.splice(at < 0 ? events.length : at, 0, card)
        }
        item.agentEventStream = willContinueStream ? events : markRaw(events)
      }
      restoreQuickAnswerFlags(item)

      if (item.content) {
        const parsed = parseThinkBlocks(String(item.content))
        if (parsed.found) {
          item.showThink = Boolean(parsed.think) || parsed.open
          item.thinking = parsed.open
          item.thinkContent = parsed.think
          item.content = parsed.answer.trim()
        } else {
          item.thinkContent = ''
          item.showThink = false
          item.thinking = false
        }
      }

      processed.push(item)
    }

    if (processed.length > 0) {
      if (isScrollType) {
        for (let i = processed.length - 1; i >= 0; i--) {
          messagesList.unshift(processed[i])
        }
        const expanded = expandSteerForksInHistory([...messagesList])
        messagesList.splice(0, messagesList.length, ...expanded)
      } else {
        messagesList.push(...expandSteerForksInHistory(processed))
      }
      consolidateCollaborationStatus()
    }

    if (isFirstEnter?.value) {
      scrollToBottom(true)
    } else if (isScrollType && scrollContainer?.value && typeof newScrollHeight === 'number') {
      nextTick(() => {
        if (!scrollContainer.value) return
        const { scrollHeight } = scrollContainer.value
        scrollContainer.value.scrollTop = scrollHeight - newScrollHeight
      })
    }

    if (onAfterMsgList) {
      await onAfterMsgList()
    }
  }

  const updateAssistantSession = (payload: ChatMessage) => {
    const message = findLastMessage((item) => {
      if (item.role !== 'assistant') return false
      if (item.request_id === payload.id) return true
      return item.id === payload.id
    })
    if (message) {
      if (payload.id && !message.request_id) message.request_id = payload.id
      message.content = payload.content
      message.thinking = payload.thinking
      message.thinkContent = payload.thinkContent
      message.showThink = payload.showThink
      if (!message.knowledge_references) {
        message.knowledge_references = payload.knowledge_references
      }
      if (payload.is_fallback) message.is_fallback = true
      if (payload.is_completed) message.is_completed = true
      emitMessageUpdated(message, payload)
    } else {
      const entry = { ...payload }
      if (entry.id && !entry.request_id) entry.request_id = entry.id
      messagesList.push(entry)
      emitMessageCreated(entry)
      emitMessageUpdated(entry, payload)
    }
    scrollToBottom()
  }

  const reportError = (errorMsg: string) => {
    if (onError) {
      onError(errorMsg)
    }
  }

  /**
   * 处理 Agent 模式下收到的每一个流式事件（SSE chunk），把它写进对应的 assistant 消息。
   *
   * 流程：
   * 1. 找出这条事件该归属的 assistant 气泡；
   * 2. 过滤掉不该处理的事件：
   *    - progress / collaboration_status 匹配不上现有回合 → 丢弃；
   *    - 找到的是用户消息 → 当作没找到；
   *    - 后台通知（work_*）没有可挂载的回合 → 丢弃，不新建气泡；
   * 3. 其他事件找不到气泡时，新建一个空的 assistant 气泡；
   * 4. 按 response_type（thinking / tool_call / answer / complete 等）分别更新消息内容。
   *
   * 由 processStreamChunk 判断事件属于 Agent 流之后调用。
   */
  const handleAgentChunk = (data: ChatMessage) => {
    const dataId = data.id as string | undefined
    let message = resolveActiveAssistantMessage(data)
    let created = false

    if (data.response_type === 'collaboration_status' || data.response_type === 'progress') {
      /**
       * 判断这条事件是不是始于当前找到的这条 assistant 消息（同一次请求）
       * dataId 是事件里的 id。对这两类事件来说,它是父请求的 request ID。streamTypes.ts 里写着 "Parent request identifier"。
       * message 是前面 resolveActiveAssistantMessage(data) 找到的、当前活跃的 assistant 消息。
       * 整个表达式的意思是:message 存在,事件带了 id,并且 message.request_id === dataId,或者 message.id === dataId。
       */
      const matchesRequest = message && dataId && (message.request_id === dataId || message.id === dataId)
      const matchesAssistant = message && data.assistant_message_id &&
        persistedAssistantId(message) === data.assistant_message_id &&
        (!dataId || !message.request_id || message.request_id === dataId)
      if (!matchesRequest && !matchesAssistant) return
    }

    // message 是前面 resolveActiveAssistantMessage 找到的、这条 Agent 事件要更新的目标。
    // 如果目标恰好是 role === 'user' 的消息,就说明找错了。
    // Agent 的思考、工具调用、回答只能写进 assistant 消息,
    // 所以代码把 message 置空,当作"没找到目标"。
    if (message?.role === 'user') {
      message = undefined
    }

    // 没有找到可挂载的消息
    if (!message) {
      // 后台通知只能挂在“已经存在的回合”上。如果在这里新建一个空的 assistant 气泡，
      // 就会在父任务结束之后凭空多出一个新的回复回合。
      // 所以如果没找到可挂载的信息，并且消息类型是后台类型，
      // 就直接 return ，不再处理此次消息
      if (
        data.response_type === 'work_event' ||
        data.response_type === 'work_started' ||
        data.response_type === 'work_finished'
      ) {
        return
      }
      const newMsg: ChatMessage = {
        id: dataId,
        request_id: dataId,
        role: 'assistant',
        content: '',
        isAgentMode: true,
        isRagMode: !isAgentStreamSession(),
        agentEventStream: [],
        _eventMap: new Map(),
        knowledge_references: [],
      }
      messagesList.push(newMsg)
      emitMessageCreated(newMsg)
      loading.value = false
      scrollToBottom(true)
      message = newMsg
      created = true
    } else {
      onAgentChunkBound?.(message, false)
    }

    if (created) {
      onAgentChunkBound?.(message, true)
    }

    ensureAgentMessageShell(message, dataId)
    applyMessageCreatedAt(message, data.created_at)

    if (
      loading.value &&
      (data.response_type === 'thinking' ||
        data.response_type === 'progress' ||
        data.response_type === 'answer' ||
        data.response_type === 'tool_call' ||
        data.response_type === 'tool_approval_required' ||
        data.response_type === 'agent_prompt_required')
    ) {
      log('[Agent Chunk] Closing loading for continued stream')
      loading.value = false
    }

    const responseType = data.response_type as string
    const dataPayload = data.data as ChatMessage | undefined
    /**
     * Child prompts can predate a steer boundary. Their resolution still
     * belongs to the same persisted turn, even when the active bubble changed.
     *
     * 收集"同一轮对话"内所有助手消息的 agent 事件流(扁平合并):
     * - 一轮对话在后端对应一条持久化的 assistant 消息,但前端经 steer/续流
     *   可能把它拆成多个气泡,这些气泡共享同一个 persistedAssistantId。
     * - 匹配条件:当前 message 本身,或持久化 ID 与之相同的其他助手消息。
     * - `turnID &&` 守卫:当前消息尚未落库(ID 为空)时,只匹配自身,
     *   避免把多条未落库消息误判为同一轮。
     * - 用途:子 prompt 的请求事件可能位于 steer 边界之前的气泡里,
     *   查找其结果/应答时需要跨气泡搜索,不能只看当前气泡。
     */
    const turnPromptEvents = () => {
      const turnID = persistedAssistantId(message)
      return messagesList
        .filter(m => m.role === 'assistant' && (m === message || (turnID && persistedAssistantId(m) === turnID)))
        .flatMap(m => (m.agentEventStream as ChatMessage[] | undefined) || [])
    }
    // work_* cases read `payload` so the source-extracted tests, which call
    // the case with the event object, and this handler share one binding.
    const payload = dataPayload

    // switch 根据 responseType 的值,选择对应的 case 去执行处理逻辑。
    switch (responseType) {
      case 'collaboration_status': {
        const snapshot = dataPayload as unknown as CollaborationStatus | undefined
        if (!snapshot?.group_id || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.tasks)) break
        const turnID = persistedAssistantId(message)
        const previous = messagesList
          .filter(m => m.role === 'assistant' && persistedAssistantId(m) === turnID)
          .map(m => m.collaborationStatus)
          .filter((s): s is CollaborationStatus => s?.group_id === snapshot.group_id)
          .sort((a, b) => b.revision - a.revision)[0]
        if (previous && snapshot.revision <= previous.revision) break
        const tasks = snapshot.tasks.map((task): CollaborationTaskStatus => {
          const prior = previous?.tasks.find(t => t.id === task.id && t.run_id === task.run_id)
          // A follow-up has a new run_id and can become queued/running again;
          // late updates to a completed run cannot undo its terminal state.
          return prior && TERMINAL_COLLABORATION_STATES.has(prior.status)
            ? { ...prior }
            : { ...task, progress: task.progress ? { ...task.progress } : task.progress }
        })
        message.collaborationStatus = { group_id: snapshot.group_id, revision: snapshot.revision, tasks }
        consolidateCollaborationStatus()
        break
      }
      case 'progress': {
        const eventId = String(dataPayload?.event_id || dataPayload?.id || '')
        if (!eventId) break
        const previous = turnPromptEvents().find(e => (e.type === 'progress' || e.type === 'answer') && e.event_id === eventId)
        if (previous?.type === 'progress' && previous.done) break
        if (previous) {
          const wasAnswer = previous.type === 'answer'
          previous.type = 'progress'
          delete previous.superseded
          if (typeof data.content === 'string') previous.content = data.content
          previous.done = Boolean(data.done)
          previous.iteration = dataPayload?.iteration
          if (wasAnswer) {
            // Older streams can emit the provisional text as answer first.
            // Reclassify that same event rather than displaying it twice or
            // seeding the final answer with the progress text.
            for (const row of messagesList) {
              if ((row.agentEventStream as ChatMessage[] | undefined)?.includes(previous)) {
                row.content = recomposeAgentAnswer(row)
                if (row === message) fullContent.value = String(row.content || '')
              }
            }
          }
        } else {
          ;(message.agentEventStream as ChatMessage[]).push({
            type: 'progress', event_id: eventId, content: String(data.content || ''),
            done: Boolean(data.done), iteration: dataPayload?.iteration,
          })
        }
        break
      }
      case 'thinking': {
        const eventId = dataPayload?.event_id as string | undefined
        log('[Thinking Event]', {
          event_id: eventId,
          done: data.done,
          content_length: (data.content as string | undefined)?.length || 0,
        })
        if (!message.agentEventStream) message.agentEventStream = []
        if (!message._eventMap) message._eventMap = new Map()
        const eventMap = message._eventMap as Map<string, ChatMessage>
        const stream = message.agentEventStream as ChatMessage[]

        if (!data.done) {
          let thinkingEvent = eventMap.get(eventId || '')
          if (!thinkingEvent) {
            log('[Thinking] Creating new thinking event, event_id:', eventId)
            thinkingEvent = {
              type: 'thinking',
              event_id: eventId,
              content: '',
              done: false,
              startTime: Date.now(),
              thinking: true,
            }
            stream.push(thinkingEvent)
            if (eventId) eventMap.set(eventId, thinkingEvent)
          }
          if (data.content) {
            thinkingEvent.content = String(thinkingEvent.content || '') + String(data.content)
            log('[Thinking] Event', eventId, 'accumulated:', String(thinkingEvent.content).length, 'chars')
          }
        } else {
          const thinkingEvent = eventMap.get(eventId || '')
          if (thinkingEvent) {
            thinkingEvent.done = true
            thinkingEvent.thinking = false
            thinkingEvent.duration_ms =
              dataPayload?.duration_ms || Date.now() - Number(thinkingEvent.startTime || Date.now())
            thinkingEvent.completed_at = dataPayload?.completed_at || Date.now()
            log('[Thinking] Event completed, duration:', thinkingEvent.duration_ms, 'ms')
          } else {
            console.warn('[Thinking] Received done for unknown event_id:', eventId)
          }
        }
        break
      }
      case 'context_compacted': {
        // Shown in the timeline rather than swallowed: after a compaction the
        // agent no longer sees the earlier rounds, and without a marker that
        // reads as the model ignoring what it was told.
        if (!message.agentEventStream) message.agentEventStream = []
        const d = dataPayload || {}
        ;(message.agentEventStream as ChatMessage[]).push({
          type: 'context_compacted',
          event_id: data.id || `compaction-${Date.now()}`,
          reason: d.reason,
          round: d.round,
          tokens_before: d.tokens_before,
          tokens_after: d.tokens_after,
          messages_before: d.messages_before,
          messages_after: d.messages_after,
          summary: d.summary,
          degraded: d.degraded,
          split_turn: d.split_turn,
        })
        break
      }
      case 'tool_approval_required': {
        if (!message.agentEventStream) message.agentEventStream = []
        const d = dataPayload || {}
        if (turnPromptEvents().some(e => e.pending_id === d.pending_id)) break
        const approvalEvent = {
          type: 'tool_approval_required',
          pending_id: d.pending_id,
          service_name: d.service_name,
          mcp_tool_name: d.mcp_tool_name,
          description: d.description,
          delegated_task: d.delegated_task,
          args_json: d.args_json,
          grant_scope: d.grant_scope,
          grant_lapsed: d.grant_lapsed,
          timeout_seconds: d.timeout_seconds,
          hot_wait_seconds: d.hot_wait_seconds,
          suspendable: d.suspendable,
          suspended: d.suspended,
          expires_at: d.expires_at,
          requested_at: d.requested_at,
          tool_call_id: d.tool_call_id,
          kind: d.kind,
          host: d.host,
          resolved: false,
        }
        // Replace the array. A markRaw stream ignores push, so the open chat
        // stayed on "running" until a session reload rebuilt it.
        message.agentEventStream = [
          ...(message.agentEventStream as ChatMessage[]),
          approvalEvent,
        ]
        message.pendingHostApproval = approvalEvent
        showComposerApproval(approvalEvent)
        break
      }
      case 'agent_prompt_required': {
        const d = dataPayload || {}
        if (d.kind === 'page_action') {
          options.onPageAction?.(d)
          break
        }
        if (!message.agentEventStream) message.agentEventStream = []
        if (turnPromptEvents().some(e => e.pending_id === d.pending_id)) break
        ;(message.agentEventStream as ChatMessage[]).push({
          type: 'agent_prompt_required',
          pending_id: d.pending_id,
          kind: d.kind,
          delegated_task: d.delegated_task,
          request: d.request,
          timeout_seconds: d.timeout_seconds,
          hot_wait_seconds: d.hot_wait_seconds,
          suspendable: d.suspendable,
          suspended: d.suspended,
          expires_at: d.expires_at,
          requested_at: d.requested_at,
          tool_call_id: d.tool_call_id,
          resolved: false,
        })
        break
      }
      case 'agent_prompt_resolved': {
        const d = dataPayload || {}
        const ev = turnPromptEvents().find(
          (e) => e.type === 'agent_prompt_required' && e.pending_id === d.pending_id,
        )
        if (ev) {
          ev.resolved = true
          ev.answered = d.answered
          ev.response = d.response
          ev.resolve_reason = d.reason
          ev.timed_out = d.timed_out
          ev.canceled = d.canceled
        }
        break
      }
      case 'run_suspended': {
        // The run ended waiting on this prompt; answering it resumes the run.
        const d = dataPayload || {}
        const card = (message.agentEventStream as ChatMessage[] | undefined)?.find(
          (e) => isPromptCard(e) && e.pending_id === d.pending_id,
        )
        if (card) {
          card.suspended = true
          card.expires_at = d.expires_at
        }
        message.run_state = AWAITING_INPUT
        break
      }
      case 'run_resumed': {
        message.run_state = ''
        message.is_completed = false
        break
      }
      case 'tool_approval_resolved': {
        const d = dataPayload || {}
        const pid = d.pending_id
        const ev = turnPromptEvents().find(
          (e) => e.type === 'tool_approval_required' && e.pending_id === pid,
        )
        if (ev) {
          ev.resolved = true
          ev.approved = d.approved
          ev.resolve_reason = d.reason
          ev.timed_out = d.timed_out
          ev.canceled = d.canceled
          ev.resolve_scope = d.scope
          message.agentEventStream = [...(message.agentEventStream as ChatMessage[])]
        }
        const pending = message.pendingHostApproval as { pending_id?: string } | undefined
        if (pending && pending.pending_id === pid) {
          message.pendingHostApproval = null
        }
        clearComposerApproval(typeof pid === 'string' ? pid : undefined)
        break
      }
      case 'mcp_oauth_required': {
        if (!message.agentEventStream) message.agentEventStream = []
        const d = dataPayload || {}
        ;(message.agentEventStream as ChatMessage[]).push({
          type: 'mcp_oauth_required',
          pending_id: d.pending_id,
          service_id: d.service_id,
          service_name: d.service_name,
          mcp_tool_name: d.mcp_tool_name,
          timeout_seconds: d.timeout_seconds,
          requested_at: d.requested_at,
          tool_call_id: d.tool_call_id,
          resolved: false,
        })
        break
      }
      case 'mcp_oauth_resolved': {
        const d = dataPayload || {}
        const pid = d.pending_id
        const sid = d.service_id
        const list = turnPromptEvents()
        // Resolve the matching card; also clear any other still-pending cards
        // for the same service (parallel tool calls dedup to a single auth).
        list?.forEach((e) => {
          if (e.type !== 'mcp_oauth_required' || e.resolved) return
          if (e.pending_id === pid || (sid && e.service_id === sid && d.authorized)) {
            e.resolved = true
            e.authorized = d.authorized
            e.resolve_reason = d.reason
            e.timed_out = d.timed_out
            e.canceled = d.canceled
          }
        })
        break
      }
      case 'tool_call': {
        if (dataPayload?.tool_name === 'final_answer') break
        // A page button follows the answer rather than starting more work; the
        // server retracts that text with a progress event if the turn goes on.
        if (message.agentEventStream && dataPayload?.tool_name !== 'open_page') {
          let retracted = false
          for (const ev of message.agentEventStream as ChatMessage[]) {
            if (ev.type === 'answer' && !ev.superseded && ev.content && String(ev.content).trim()) {
              ev.superseded = true
              ev.done = true
              retracted = true
            }
          }
          if (retracted) {
            message.content = recomposeAgentAnswer(message)
            fullContent.value = String(message.content || '')
          }
        }
        if (dataPayload && (dataPayload.tool_name || dataPayload.tool_call_id)) {
          if (!message.agentEventStream) message.agentEventStream = []
          if (!message._pendingToolCalls) message._pendingToolCalls = new Map()
          const pending = message._pendingToolCalls as Map<string, ChatMessage>
          const stream = message.agentEventStream as ChatMessage[]
          const incomingToolName = dataPayload.tool_name as string | undefined
          const incomingArguments = dataPayload.arguments
          const toolCallId =
            (dataPayload.tool_call_id as string) ||
            (incomingToolName ? `${incomingToolName}_${Date.now()}` : null)
          if (!toolCallId) {
            console.warn('[Tool Call] Received event without identifiable tool_call_id:', dataPayload)
            break
          }

          log('[Tool Call]', {
            tool_call_id: toolCallId,
            tool_name: incomingToolName,
            has_arguments: Boolean(incomingArguments),
          })

          let toolCallEvent = pending.get(toolCallId)
          if (!toolCallEvent) {
            toolCallEvent = stream.find(
              (event) => event.type === 'tool_call' && event.tool_call_id === toolCallId,
            )
          }
          if (toolCallEvent) {
            const resolvedMcpTarget =
              toolCallEvent.tool_name === 'call_mcp_tool' && incomingToolName?.startsWith('mcp_')
            if (incomingToolName) toolCallEvent.tool_name = incomingToolName
            if (incomingArguments) {
              if (resolvedMcpTarget) {
                // The executor now supplies the target's arguments; discard
                // the streamed proxy envelope instead of mixing the two.
                toolCallEvent.arguments = incomingArguments
              } else {
                toolCallEvent.arguments = mergeToolCallArguments(toolCallEvent.arguments, incomingArguments)
              }
            }
            toolCallEvent.pending = true
            if (!toolCallEvent.timestamp) toolCallEvent.timestamp = Date.now()
            pending.set(toolCallId, toolCallEvent)
          } else {
            const newToolCallEvent = {
              type: 'tool_call',
              tool_call_id: toolCallId,
              tool_name: incomingToolName,
              arguments: incomingArguments,
              timestamp: Date.now(),
              pending: true,
            }
            stream.push(newToolCallEvent)
            pending.set(toolCallId, newToolCallEvent)
          }
        }
        break
      }
      case 'command_output': {
        const toolCallId = dataPayload?.tool_call_id as string | undefined
        if (!toolCallId) break
        const tool = (message.agentEventStream as ChatMessage[] | undefined)?.find(
          event => event.type === 'tool_call' && event.tool_call_id === toolCallId,
        )
        // Late progress must not resurrect a completed command or attach to
        // another concurrent call just because it uses the same tool name.
        if (tool?.pending && tool.tool_name === 'shell_exec' && !(tool.command_output as ChatMessage | undefined)?.done) {
          tool.command_output = dataPayload
        }
        break
      }
      case 'work_event': {
        const inner = dataPayload?.inner as { response_type?: string; data?: ChatMessage } | undefined
        if (inner?.response_type === 'command_output' && inner.data?.tool_call_id) {
          // The async tool returns at the yield window, so later previews
          // arrive after pending is cleared. Attach them to that card anyway.
          // done on the preview hides the live tail; it does not complete the tool.
          const toolCallId = inner.data.tool_call_id
          const tool = (message.agentEventStream as ChatMessage[] | undefined)?.find(
            event => event.type === 'tool_call' && event.tool_call_id === toolCallId
              && (event.tool_name === 'shell_exec' || event.tool_name === 'shell_exec_async'),
          )
          if (tool) {
            tool.command_output = { ...inner.data }
          }
        }
        break
      }
      case 'work_started':
      case 'work_finished': {
        const event = payload as ChatMessage | undefined
        const workId = typeof event?.work_id === 'string' ? event.work_id : ''
        if (workId) {
          if (!message.background_work) message.background_work = {}
          const backgroundWork = message.background_work as Record<string, {
            state: unknown
            title: unknown
            kind: unknown
            payload: unknown
          }>
          backgroundWork[workId] = {
            state: (event?.state as string | undefined) ?? 'running',
            title: event?.title,
            kind: event?.kind,
            payload: event?.payload,
          }
        }
      }
      break
      case 'tool_result':
      case 'error': {
        if (dataPayload) {
          const toolCallId = dataPayload.tool_call_id as string | undefined
          const toolName = dataPayload.tool_name as string | undefined
          const success = responseType !== 'error' && dataPayload.success !== false
          if (responseType === 'tool_result' && dataPayload.success === true && toolName
            && DATA_CHANGE_TOOLS.has(toolName)) {
            emitAssistantDataChange(dataPayload.data_change)
          }
          log('[Tool Result]', {
            tool_call_id: toolCallId,
            tool_name: toolName,
            success,
          })
          let toolCallEvent: ChatMessage | undefined
          const pending = message._pendingToolCalls as Map<string, ChatMessage> | undefined
          if (pending) {
            if (toolCallId && pending.has(toolCallId)) {
              toolCallEvent = pending.get(toolCallId)
              pending.delete(toolCallId)
            } else if (!toolCallId) {
              Array.from(pending.entries()).some(([key, value]) => {
                if (value.tool_name === toolName) {
                  toolCallEvent = value
                  pending.delete(key)
                  return true
                }
                return false
              })
            }
          }
          if (toolCallEvent) {
            toolCallEvent.pending = false
            toolCallEvent.success = success
            // Keep stdout/markdown on failure. The error field is often just
            // "exited with code 1" plus a retry hint; the streams live on
            // output / tool_data and are what the terminal card should show.
            toolCallEvent.output = dataPayload.output || data.content
            toolCallEvent.error = !success ? dataPayload.error || data.content : undefined
            const duration =
              dataPayload.duration_ms !== undefined ? dataPayload.duration_ms : dataPayload.duration
            toolCallEvent.duration = duration
            toolCallEvent.duration_ms = duration
            toolCallEvent.display_type = dataPayload.display_type
            toolCallEvent.tool_data = dataPayload
            log('[Tool Result] Updated event in stream')
          } else {
            console.warn('[Tool Result] No pending tool call found for', toolCallId || toolName)
          }
          if (responseType === 'error' && !toolName) {
            const errorMsg = String(data.content || t('chat.processError'))
            message.content = errorMsg
            message.is_completed = true
            isReplying.value = false
            loading.value = false
            fullContent.value = ''
            currentAssistantMessageId.value = ''
            reportError(errorMsg)
            console.error('[Chat Error]', errorMsg)
          }
        } else if (responseType === 'error') {
          const errorMsg = String(data.content || t('chat.processError'))
          message.content = errorMsg
          message.is_completed = true
          isReplying.value = false
          loading.value = false
          fullContent.value = ''
          currentAssistantMessageId.value = ''
          reportError(errorMsg)
          console.error('[Chat Error]', errorMsg)
        }
        break
      }
      // 处理 answer 流事件
      case 'answer': {
        message.thinking = false
        const eventId = dataPayload?.event_id as string | undefined
        if (!message.agentEventStream) message.agentEventStream = []
        if (!message._eventMap) message._eventMap = new Map()
        const eventMap = message._eventMap as Map<string, ChatMessage>
        const stream = message.agentEventStream as ChatMessage[]

        let answerEvent = eventId
          ? eventMap.get(eventId)
          : stream.find((e) => e.type === 'answer' && !e.event_id)
        const replaceAnswer = dataPayload?.replace === true
        if (replaceAnswer && eventId) {
          const turnID = persistedAssistantId(message)
          // A protocol correction can arrive after a steer boundary or after
          // that provisional event was reclassified as progress. Retract only
          // this ID, never another round's legitimate answer.
          for (const row of messagesList) {
            if (row.role !== 'assistant' || (row !== message && persistedAssistantId(row) !== turnID)) continue
            const events = (row.agentEventStream as ChatMessage[] | undefined) || []
            for (const prior of events) {
              if (prior.event_id !== eventId || !['answer', 'progress'].includes(String(prior.type))) continue
              prior.content = ''
              prior.done = true
            }
            if (row !== message) {
              row.agentEventStream = events.filter(e => e.event_id !== eventId || !['answer', 'progress'].includes(String(e.type)))
              ;(row._eventMap as Map<string, ChatMessage> | undefined)?.delete(eventId)
            }
            row.content = recomposeAgentAnswer(row)
          }
          answerEvent = eventMap.get(eventId) || stream.find(e => e.event_id === eventId)
          if (answerEvent) {
            Object.assign(answerEvent, { type: 'answer', content: '', done: false, superseded: false })
            eventMap.set(eventId, answerEvent)
          }
        }
        // Replayed provisional answer chunks may follow a progress snapshot
        // for the same event. They must not append to or revive that answer.
        if (!replaceAnswer && (answerEvent?.type === 'progress' || (eventId && turnPromptEvents().some(
          e => e.type === 'progress' && e.event_id === eventId,
        )))) break
        if (!answerEvent) {
          answerEvent = { type: 'answer', event_id: eventId, content: '', done: false }
          stream.push(answerEvent)
          if (eventId) eventMap.set(eventId, answerEvent)
        }
        if (replaceAnswer) answerEvent.protocol_replaced = true
        if (!replaceAnswer && !answerEvent.protocol_replaced && !answerEvent.content && message.content && String(message.content).trim()) {
          // Seeding exists for resume paths where message.content holds text no
          // stream event carries. When a live prior answer event exists, its
          // text is already counted by recomposeAgentAnswer, so seeding the new
          // event would duplicate every prior round on the next recompose.
          const hasLivePriorAnswer = stream.some(
            (e) =>
              e !== answerEvent &&
              e.type === 'answer' &&
              !e.superseded &&
              e.content &&
              String(e.content).trim(),
          )
          if (!hasLivePriorAnswer) {
            answerEvent.content = message.content
          }
        }
        // 一个 answer 片段到达,追加到对应事件的 content 上:answerEvent.content += data.content。
        // 然后调用 message.content = recomposeAgentAnswer(message),把整条消息里所有未作废的 answer 事件按顺序拼起来。
        if (data.content || replaceAnswer) {
          answerEvent.content = replaceAnswer ? String(data.content || '') : String(answerEvent.content || '') + String(data.content)
          message.content = recomposeAgentAnswer(message)
          fullContent.value = String(message.content || '')
        }
        if (dataPayload?.is_fallback) {
          answerEvent.is_fallback = true
          message.is_fallback = true
        }
        // The completion cap cut this answer off. The backend sends it on the
        // content chunks and again on the Done marker, because an answer that
        // streamed live only learns of the cap at the close.
        if (dataPayload?.truncated) {
          answerEvent.truncated = true
          message.truncated = true
        }
        if (data.done && !answerEvent.done) {
          answerEvent.done = true
          onAgentAnswerDone?.(message)
          // This closes only the answer segment. Both Agent and quick-answer
          // turns still have to collect artifacts/checkpoint/persist before
          // `complete` makes their files readable and marks the session idle.
        }
        break
      }
      case 'artifacts_pending': {
        const pendingCount = Number((dataPayload as any)?.count)
        message.artifactsCollecting = true
        if (Number.isFinite(pendingCount) && pendingCount > 0) {
          message.artifactsPendingCount = pendingCount
        }
        break
      }
      // 处理用户在运行中插话时
      case 'user_message_injected': {
        // A message the user queued mid-run was accepted into the running
        // turn. Place it under the work so far, then fork a continuation
        // assistant so later thinking/tools/answer render below it.
        const steerId = dataPayload?.steer_id as string | undefined
        log('[Agent] User message injected, steer_id:', steerId)
        let injectedUser: ChatMessage | undefined
        let alreadyInList = false
        if (steerId) {
          const injectedId = dataPayload?.user_message_id as string | undefined
          // Resuming a turn replays this event from the start of the log, by
          // which point history has already loaded the persisted row. Reuse
          // it — synthesizing here would show the same message twice.
          injectedUser = messagesList.find(
            (item) =>
              item.role === 'user' &&
              ((!!injectedId && item.id === injectedId) || item.steer_id === steerId),
          )
          alreadyInList = Boolean(injectedUser)
          if (!injectedUser) {
            // A restored event or promoted follow-up may arrive before its preview.
            injectedUser = {
              id: injectedId || steerId,
              role: 'user',
              content: String(dataPayload?.content || ''),
              steer_id: steerId,
              channel: 'web',
              is_completed: true,
            }
            if (data.created_at) applyMessageCreatedAt(injectedUser, data.created_at)
          }
          if (injectedId) injectedUser.id = injectedId
          if (data.created_at) applyMessageCreatedAt(injectedUser, data.created_at)
        }
        if (injectedUser) {
          if (dataId && !injectedUser.request_id) injectedUser.request_id = dataId
          const continuation = forkAfterInjectedUser(
            messagesList,
            message,
            injectedUser,
            steerId,
          )
          consolidateCollaborationStatus()
          if (dataId && replaySegments.has(dataId)) replaySegments.set(dataId, continuation)
          if (!alreadyInList) emitMessageCreated(injectedUser)
          if (continuation !== message) {
            emitMessageCreated(continuation)
            onAgentChunkBound?.(continuation, true)
          }
          if (steerId) onUserMessageInjected?.(steerId)
        }
        break
      }
      case 'complete': {
        if (dataId) replaySegments.delete(dataId)
        log('[Agent] Complete event received')
        applyFinalArtifactContent(message, (dataPayload as any)?.final_content)
        loading.value = false
        isReplying.value = false
        message.is_completed = true
        onReplyComplete?.(String(message.content || ''))
        onTurnComplete?.(message)
        fullContent.value = ''
        currentAssistantMessageId.value = ''
        // Hydrate skill-generated artifacts as soon as the SSE completion
        // event arrives — without this the download button only appears
        // after a page refresh (the assistant message row is fetched via
        // getMessageList which does include the artifacts JSON column).
        // botmsg.vue / AgentStreamDisplay.vue read `message.artifacts`
        // reactively to decide whether to render the download button.
        const streamedArtifacts = (dataPayload as any)?.artifacts
        if (Array.isArray(streamedArtifacts) && streamedArtifacts.length) {
          message.artifacts = streamedArtifacts
        }
        message.artifactsCollecting = false
        const usage = (dataPayload as any)?.usage || (data as any).usage
        if (usage) {
          message.usage = usage
        }
        if (message.agentEventStream && !isAwaitingInput(message)) {
          ;(message.agentEventStream as ChatMessage[]).push({
            type: 'agent_complete',
            total_duration_ms: dataPayload?.total_duration_ms || 0,
            total_steps: dataPayload?.total_steps || 0,
            usage,
          })
        }
        break
      }
      case 'stop': {
        log('[Agent] Stop event received')
        if (!message.agentEventStream) message.agentEventStream = []
        ;(message.agentEventStream as ChatMessage[]).push({
          type: 'stop',
          timestamp: Date.now(),
          reason: dataPayload?.reason || 'user_requested',
        })
        markInFlightAssistantStopped(persistedAssistantId(message))
        message.is_completed = true
        loading.value = false
        isReplying.value = false
        fullContent.value = ''
        currentAssistantMessageId.value = ''
        message.artifactsCollecting = false
        break
      }
    }

    scrollToBottom()
  }

  /**
   * 所有后端 SSE 事件的统一处理入口（普通问答与 Agent 流共用）。
   *
   * 调用方：`useStream()` 每收到一帧 SSE 就通过 `onChunk` 注册的回调调用它
   * （见 api/chat/streame.ts 的 onmessage，以及 views/chat/index.vue 中 onChunk 的注册）。
   * `data` 就是 `JSON.parse(ev.data)` 之后的事件对象（后端 StreamResponse），
   * 常见字段：id（请求 ID）/ response_type / content / done / data /
   * session_id / assistant_message_id。本函数只做分发，不建立连接、不发起请求。
   *
   * 处理顺序：
   * 1. 打印调试日志；
   * 2. `error` 且 `data.stage === 'message_persistence'`：正文已流完但落库失败，
   *    单独挂错误后返回，避免覆盖已显示的回答；
   * 3. `agent_query`：一轮回答开始，重置 steer 分段、记录 assistant_message_id，
   *    必要时创建/复用消息气泡，然后返回；
   * 4. `references` / `memory_recalled`：更新引用与记忆，不进入消息时间线；
   * 5. 判断是否属于 Agent 流（shouldHandleAsAgent）→ 交给 handleAgentChunk 处理；
   * 6. 其余按普通（RAG）消息处理 answer / complete / stop 等事件。
   *
   * @param data 单帧 SSE 事件（后端 StreamResponse 反序列化后的对象）
   */
  const processStreamChunk = (data: ChatMessage) => {
    log('[Agent Event Received]', {
      response_type: data.response_type,
      id: data.id,
      done: data.done,
      content_length: (data.content as string | undefined)?.length || 0,
      content_preview: data.content ? String(data.content).substring(0, 50) : '',
      data: data.data,
      session_id: data.session_id,
      assistant_message_id: data.assistant_message_id,
    })

    // 持久化可能在整个回答流式输出完之后才失败。这类错误必须单独处理：
    // 通用错误路径会用错误文本替换已显示的回答，这里则要保留正文。
    if (data.response_type === 'error' && (data.data as ChatMessage | undefined)?.stage === 'message_persistence') {
      // 找到这条错误归属的 assistant 消息气泡（可能为 undefined）。
      const message = resolveActiveAssistantMessage(data)
      // 错误提示优先用事件顶层的 content，缺失时用本地化兜底文案。
      const errorMsg = String(data.content || t('chat.processError'))
      if (message) {
        // 只标记“保存失败”，不改 message.content，避免抹掉已经展示的回答。
        message.persistence_error = errorMsg
        // 结束生成态，停止思考与产物收集动画。
        message.is_completed = true
        message.thinking = false
        message.artifactsCollecting = false
        // 通知上层刷新这条消息，让 persistence_error / is_completed 生效。
        emitMessageUpdated(message)
      }
      // 收敛全局生成状态：不再加载/回复，清空流式累积器和当前消息指针。
      loading.value = false
      isReplying.value = false
      fullContent.value = ''
      currentAssistantMessageId.value = ''
      // 清掉本次请求的重放锚点，避免后续事件再绑定到这一轮。
      if (data.id) replaySegments.delete(String(data.id))
      // 向用户展示保存失败提示，并滚动到底部。
      reportError(errorMsg)
      scrollToBottom()
      // 提前返回：防止该错误继续落入通用处理逻辑而覆盖正文或重复触发。
      return
    }

    if (data.response_type === 'agent_query') {
      if (data.id) replaySegments.delete(String(data.id))
      const resumeData = (data.data || {}) as ChatMessage
      /**接下来要续写的那段 assistant 消息对象 */
      const replay = resetSteerTurnForReplay(messagesList, String(data.id || ''),
        String(resumeData.resume_pending_id || ''), String(resumeData.resume_tool_call_id || ''))
      /** 把这个"活动分段"登记成该请求的锚点。 */
      if (replay) replaySegments.set(String(data.id), replay)
      if (data.id) {
        // 取最近一条未完成的 assistant 消息
        const earlyMsg = getTrailingIncompleteAssistant()
        // 只认领还没绑定请求的占位气泡（或本来就属于本次请求的）。
        // 上一轮流被中断的消息会一直停在未完成状态；如果把它改绑到这一轮，
        // 本次回答就会被渲染到上一轮的位置里。
        if (earlyMsg && (!earlyMsg.request_id || earlyMsg.request_id === data.id)) {
          earlyMsg.request_id = data.id
        }
      }
      // 把"当前正在写入的 assistant 消息 ID"更新为事件里的新值。
      if (data.assistant_message_id) {
        currentAssistantMessageId.value = data.assistant_message_id as string
        log('[Agent Query] Saved assistant message ID:', data.assistant_message_id)
      }
      log('[Agent Query Event]', {
        session_id: data.session_id || (data.data as ChatMessage | undefined)?.session_id,
        assistant_message_id: data.assistant_message_id,
        query: (data.data as ChatMessage | undefined)?.query,
        request_id: (data.data as ChatMessage | undefined)?.request_id,
      })

      // 如果由 replay 就直接复用，如果没有就调用 findLastMessage 去 MessageList 寻找匹配的 message
      let existingMessage = replay || findLastMessage(
        (item) =>
          item.role === 'assistant' &&
          (item.id === data.id ||
            item.request_id === data.id ||
            (!!data.assistant_message_id && item.id === data.assistant_message_id)),
      )
      const created = !existingMessage
      // 如果既没有 replay 也没有之前的记录，
      // 说明这是本轮的第一条消息，
      // 也就是正常的新提问，
      // 就新建一个 assistant 占位消息。
      /**当 agent_query 事件到达(一轮 Agent 查询开始)时,确保界面上有一条正确的 assistant 消息来承接后面的流式内容,并让它和服务端对齐。 */
      if (!existingMessage) {
        const assistantId = data.assistant_message_id as string | undefined
        existingMessage = {
          id: assistantId || data.id,
          assistant_message_id: assistantId,
          request_id: data.id,
          role: 'assistant',
          content: '',
          isAgentMode: true,
          isRagMode: !isAgentStreamSession(),
          is_completed: false,
          agentEventStream: [],
          _eventMap: new Map(),
          _pendingToolCalls: new Map(),
          knowledge_references: [],
        }
        messagesList.push(existingMessage)
        // 调用 emitMessageCreated 通知外部有新的 message 创建了
        // 代表“新一轮 Agent 查询开始了”
        emitMessageCreated(existingMessage)
        // 通知第一批消息回来了
        loading.value = false
        // 通知该滚动页面了
        scrollToBottom(true)
        log('[Agent Query] Created agent placeholder message')
      } else {
        ensureAgentMessageShell(existingMessage, data.id as string | undefined)
        // assistant_message_id 是这条 AI 回复在数据库里的真实消息 ID
        // 事件里带了真实 ID,就把已有消息对象的 id 和 assistant_message_id 都改成这个值。
        // 这样前端消息和后端数据库对齐了。此前这条消息的 id 可能还是请求 ID 或临时值。
        if (data.assistant_message_id) {
          existingMessage.id = data.assistant_message_id as string
          existingMessage.assistant_message_id = data.assistant_message_id
        }
        log('[Agent Query] Continuing stream for existing message')
      }
      bindServerTurnTimestamps(
        messagesList,
        (data.data as Record<string, unknown> | undefined) || data,
        existingMessage,
      )
      onAgentQuery?.(data, existingMessage, created)
      return
    }

    const isAgentOnlyResponse =
      data.response_type === 'thinking' ||
      data.response_type === 'progress' ||
      data.response_type === 'collaboration_status' ||
      data.response_type === 'tool_call' ||
      data.response_type === 'tool_result' ||
      data.response_type === 'command_output' ||
      data.response_type === 'work_event' ||
      data.response_type === 'work_started' ||
      data.response_type === 'work_finished' ||
      data.response_type === 'reflection' ||
      data.response_type === 'artifacts_pending' ||
      data.response_type === 'context_compacted' ||
      data.response_type === 'user_message_injected' ||
      data.response_type === 'run_suspended' ||
      data.response_type === 'run_resumed' ||
      data.response_type === 'agent_prompt_required' ||
      data.response_type === 'agent_prompt_resolved' ||
      data.response_type === 'tool_approval_required' ||
      data.response_type === 'tool_approval_resolved' ||
      data.response_type === 'mcp_oauth_required' ||
      data.response_type === 'mcp_oauth_resolved'

    const activeAssistant = getTrailingIncompleteAssistant()
    // 判断这条 assistant 消息是不是按 Agent 方式生成和渲染的
    const isCurrentlyAgentMode = activeAssistant?.isAgentMode === true
    const targetsActiveAgentRequest =
      isAgentStreamSession() &&
      !!data.id &&
      (data.id === currentAssistantMessageId.value ||
        activeAssistant?.request_id === data.id ||
        activeAssistant?.id === data.id)
    const isAgentAnswerChunk =
      data.response_type === 'answer' && (isAgentStreamSession() || targetsActiveAgentRequest)
    const isAgentCompleteChunk =
      data.response_type === 'complete' && (isAgentStreamSession() || targetsActiveAgentRequest)

    const shouldHandleAsAgent =
      isAgentOnlyResponse ||
      isCurrentlyAgentMode ||
      isAgentAnswerChunk ||
      isAgentCompleteChunk

    if (data.response_type === 'references') {
      applyKnowledgeReferences(data)
      scrollToBottom()
      return
    }

    if (data.response_type === 'memory_recalled') {
      applyUsedMemories(data)
      return
    }

    if (shouldHandleAsAgent) {
      handleAgentChunk(data)
      if (data.response_type === 'stop') {
        log('[Stop Event] Generation stopped')
        const stoppedMessage = resolveActiveAssistantMessage(data)
        if (stoppedMessage) markAssistantStopped(stoppedMessage)
        if (data.id) replaySegments.delete(String(data.id))
        loading.value = false
        isReplying.value = false
        currentAssistantMessageId.value = ''
        onGenerationStopped?.()
      }
      return
    }

    if (data.response_type === 'stop') {
      log('[Stop Event] Non-agent generation stopped')
      const stoppedMessage = findLastMessage((item) => {
        if (item.role !== 'assistant') return false
        if (item.request_id === data.id) return true
        return item.id === data.id
      })
      if (stoppedMessage) stoppedMessage.is_completed = true
      loading.value = false
      isReplying.value = false
      fullContent.value = ''
      currentAssistantMessageId.value = ''
      onGenerationStopped?.()
      return
    }

    const existingMessage = findLastMessage((item) => {
      if (item.role !== 'assistant') return false
      if (item.request_id === data.id) return true
      return item.id === data.id
    })
    if (data.response_type === 'complete' && existingMessage) {
      if (existingMessage.is_completed) return
      const metadata = data.data as ChatMessage | undefined
      applyFinalArtifactContent(existingMessage, metadata?.final_content)
      if (Array.isArray(metadata?.artifacts)) existingMessage.artifacts = metadata.artifacts
      const usage = metadata?.usage || data.usage
      if (usage) existingMessage.usage = usage
      existingMessage.artifactsCollecting = false
      existingMessage.thinking = false
      existingMessage.is_completed = true
      loading.value = false
      isReplying.value = false
      fullContent.value = ''
      currentAssistantMessageId.value = ''
      emitMessageUpdated(existingMessage, { ...data, is_completed: true })
      onReplyComplete?.(String(existingMessage.content || ''))
      onTurnComplete?.(existingMessage)
      scrollToBottom()
      return
    }
    if (existingMessage?.is_completed && data.done && !data.content) {
      log('[Non-Agent] Ignoring duplicate completion event for completed message')
      return
    }

    fullContent.value += (data.content as string) || ''
    const obj: ChatMessage = {
      ...data,
      content: '',
      role: 'assistant',
      showThink: false,
      is_completed: false,
    }

    if ((data.data as ChatMessage | undefined)?.is_fallback) obj.is_fallback = true

    const parsed = parseThinkBlocks(fullContent.value)
    if (parsed.found) {
      obj.thinking = parsed.open
      obj.showThink = Boolean(parsed.think) || parsed.open
      obj.thinkContent = parsed.think
      obj.content = parsed.answer.trim()
    } else {
      obj.content = fullContent.value
    }

    if (!existingMessage) loading.value = false

    // answer.done closes the token stream, not the persisted turn. In
    // particular the final image retry must wait for the subsequent complete.
    // Untyped legacy streams retain their original done behavior.
    const turnDone = data.done && data.response_type !== 'answer'
    if (turnDone) {
      obj.is_completed = true
      onReplyComplete?.(String(obj.content || ''))
      isReplying.value = false
      fullContent.value = ''
      currentAssistantMessageId.value = ''
    }
    updateAssistantSession(obj)
    if (turnDone) {
      const completed = resolveActiveAssistantMessage(data) || obj
      onTurnComplete?.(completed)
    }
  }

  return {
    findLastMessage,
    shouldRenderAssistantMessage,
    shouldShowGlobalTypingIndicator,
    handleMsgList,
    processStreamChunk,
    prepareForNewOutgoingMessage,
    prepareResumedMessage,
    markInFlightAssistantStopped,
  }
}
