type MessageWithTimestamp = Record<string, unknown> & { created_at?: unknown }

/**
 * 校验一个值是不是有效的时间字符串，有效就返回清理过空白的原字符串，无效就返回空串。
 *
 * 注意：它只做校验，不转换格式，也不会补默认值。
 * 补默认值由 ensureMessageCreatedAt 负责，它靠这里返回的空串判断“没有有效时间”。
 *
 * @param value 待检查的值，通常是消息的 created_at，类型不确定（可能是 null、数字等）
 * @returns 有效时间：去掉首尾空白后的原字符串；
 *          不是字符串、是空串、或无法被 Date 解析：返回 ''
 */
export function normalizeMessageCreatedAt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''

  // 去掉首位空白
  const trimmed = value.trim()
  // 只用来检查这个字符串能不能被解析成有效时间，返回的仍是原字符串，不是 Date
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return ''
  return trimmed
}

/**
 * 先校验是不是有效的时间字符串，
 * 如果是，就将清空过空白的原字符串赋值给 message.create_at
 * 
 * @param message 
 * @param candidate 
 * @returns 传入的那个 message 对象本身
 */
export function applyMessageCreatedAt<T extends MessageWithTimestamp>(
  message: T,
  candidate: unknown,
): T {
  const next = normalizeMessageCreatedAt(candidate)
  if (next) message.created_at = next
  return message
}

/**
 * ensureMessageCreatedAt 检测是是否有创建事件 createAt ，
 * 如果没有就手动创建一个，并赋值给 message.created_at
 */
export function ensureMessageCreatedAt<T extends MessageWithTimestamp>(
  message: T,
  fallback = new Date().toISOString(),
): T {
  if (!normalizeMessageCreatedAt(message.created_at)) {
    message.created_at = fallback
  }
  return message
}

/**
 * 用服务端下发的时间，校准这一轮对话里“用户提问”和“AI 回复”两条消息的创建时间。
 *
 * 背景：消息刚显示在界面上时，时间可能是前端本地生成的；服务端真正保存后有自己的时间，
 * 这里把两边对齐，让界面显示的时间和数据库一致。
 *
 * 做两件事：
 * 1. 如果传了 assistant，用 payload.assistant_created_at（没有就用 payload.created_at）
 *    更新它的 created_at；
 * 2. 从 messages 末尾往前找到最近的一条用户消息，用 payload.user_created_at 更新它的
 *    created_at；如果这条用户消息还没有 id，再用 payload.user_message_id 补上。
 *    只处理这一条，找到就停。
 *
 * 直接修改传入的对象，没有返回值。payload 里没有对应的值时，不会改动任何东西。
 *
 * @param messages 当前的消息列表，用来找到那条用户消息
 * @param payload 服务端事件的载荷；为空则直接返回
 * @param assistant 这一轮的 assistant 消息，可选
 */
export function bindServerTurnTimestamps(
  messages: MessageWithTimestamp[],
  payload: Record<string, unknown> | undefined,
  assistant?: MessageWithTimestamp,
): void {
  if (!payload) return

  if (assistant) {
    applyMessageCreatedAt(assistant, payload.assistant_created_at ?? payload.created_at)
  }

  const userCreatedAt = payload.user_created_at
  const userMessageId = typeof payload.user_message_id === 'string' ? payload.user_message_id : ''
  if (!normalizeMessageCreatedAt(userCreatedAt) && !userMessageId) return

  // 消息列表里找到最近的一条用户消息,把服务端给的时间和消息 ID 写到它身上。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    applyMessageCreatedAt(message, userCreatedAt)
    if (userMessageId && (typeof message.id !== 'string' || !message.id)) {
      message.id = userMessageId
    }
    break
  }
}

export function formatMessageTimestamp(value: unknown): string {
  const normalized = normalizeMessageCreatedAt(value)
  if (!normalized) return ''

  const date = new Date(normalized)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Insert a flow divider after this much idle time, or when the calendar day changes. */
export const CONVERSATION_TIMESTAMP_GAP_MS = 5 * 60 * 1000

export type ConversationTimestampKind = 'today' | 'yesterday' | 'thisYear' | 'otherYear'

export type ConversationTimestampModel = {
  datetime: string
  kind: ConversationTimestampKind
  time: string
  year: number
  month: number
  day: number
}

type ConversationTimestampMessage = {
  role?: unknown
  created_at?: unknown
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function formatClock(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function getConversationTimestampKind(date: Date, now = new Date()): ConversationTimestampKind {
  const day = startOfLocalDay(date)
  const today = startOfLocalDay(now)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()

  if (day === today) return 'today'
  if (day === yesterday) return 'yesterday'
  if (date.getFullYear() === now.getFullYear()) return 'thisYear'
  return 'otherYear'
}

export function getConversationTimestampModel(
  value: unknown,
  now = new Date(),
): ConversationTimestampModel | null {
  const datetime = normalizeMessageCreatedAt(value)
  if (!datetime) return null

  const date = new Date(datetime)
  return {
    datetime,
    kind: getConversationTimestampKind(date, now),
    time: formatClock(date),
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  }
}

export function shouldInsertConversationTimestamp(
  previous: ConversationTimestampMessage | undefined,
  current: ConversationTimestampMessage | undefined,
  gapMs = CONVERSATION_TIMESTAMP_GAP_MS,
): boolean {
  if (!current || !normalizeMessageCreatedAt(current.created_at)) return false
  if (current.role === 'assistant' && previous?.role === 'user') return false

  const previousCreatedAt = normalizeMessageCreatedAt(previous?.created_at)
  if (!previousCreatedAt) return true

  const previousDate = new Date(previousCreatedAt)
  const currentDate = new Date(current.created_at as string)
  if (startOfLocalDay(previousDate) !== startOfLocalDay(currentDate)) return true
  return currentDate.getTime() - previousDate.getTime() >= gapMs
}

export function shouldShowConversationTimestamp(
  messages: ConversationTimestampMessage[],
  index: number,
  gapMs = CONVERSATION_TIMESTAMP_GAP_MS,
): boolean {
  return shouldInsertConversationTimestamp(messages[index - 1], messages[index], gapMs)
}
