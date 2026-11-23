import { del, get, post } from "../../utils/request";

export type SteerDelivery = 'inject' | 'after'

export type SteerQueueItem = {
  steer_id: string
  content: string
  delivery: SteerDelivery
  mentioned_items?: unknown[]
  promoting?: boolean
  awaitingIdleSend?: boolean
  // POST /steer 请求在途时为 true。客户端生成的稳定 UUID 同时也是服务端持久化的 ID；
  // 在对应的队列项存在之前，禁用相关操作。
  pending?: boolean
  failed?: boolean
  expected_assistant_message_id?: string
  client_id?: string
}

/**
 * 向正在运行的 agent 这一轮追加一条消息。
 * 返回 { success, status: 'queued' | 'already_injected' | 'new_run', steer_id?, delivery?, assistant_message_id? }。
 * - delivery 为 'after'（默认）：等当前运行退出后，再启动一轮后续对话。
 * - delivery 为 'inject'：运行中的引擎在下一个推理轮次的边界注入它。
 * - 'new_run'：当前没有运行中的 run，调用方应回退为普通发送。
 * 查询失败（503）时直接 reject，不返回 new_run：把它当作空闲，
 * 会在仍在生成的那一轮之上再启动第二轮。
 */
export async function steerSession(
  session_id: string,
  query: string,
  mentionedItems: any[] = [],
  delivery: SteerDelivery = 'after',
  expectedAssistantMessageId?: string,
  steerId?: string,
) {
  return post(`/api/v1/sessions/${session_id}/steer`, {
    query,
    expected_assistant_message_id: expectedAssistantMessageId,
    steer_id: steerId,
    mentioned_items: mentionedItems,
    channel: 'web',
    delivery,
  });
}

/** 把排队中的 after 消息改为 inject，让正在运行的这一轮接下来读取它。 */
export async function promoteSteerSession(session_id: string, steer_id: string) {
  return post(`/api/v1/sessions/${session_id}/steer/${steer_id}/inject`, {});
}

/** 当前运行中待处理的 overlay 项。没有在生成时为空。 */
export async function listSteerSession(session_id: string) {
  return get(`/api/v1/sessions/${session_id}/steer`);
}

/** 删除一条排队中的 overlay 项，使它既不被注入，也不作为后续对话发送。 */
export async function removeSteerSession(session_id: string, steer_id: string) {
  return del(`/api/v1/sessions/${session_id}/steer/${steer_id}`);
}
