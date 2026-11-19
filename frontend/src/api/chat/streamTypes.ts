/**
 * 单个子任务（被委派的子 agent）当前 run 的运行遥测，独立于父 agent 的答案。
 *
 * 这是纯运营层进度信息，不包含模型推理内容、工具入参与工具返回原文；
 * 由后端 collaboration.Progress 投影而来。
 */
export interface CollaborationProgress {
  /** 当前阶段：`tool_running`（工具执行中）、`tool_succeeded`（工具成功）、`tool_failed`（工具失败）。 */
  phase?: string
  /** 当前或最近一次执行的工具名。 */
  tool_name?: string
  /** 对应的工具调用 ID，可与前端事件流中的 tool_call 对齐。 */
  tool_call_id?: string
  /** 子 agent 循环的轮次（第几轮迭代）。 */
  iteration?: number
  /** 遥测更新时间，用于判断进度是否新鲜。 */
  updated_at?: string
}

/**
 * 单个协作任务（协作组中的一个成员）在当前 run 下的公开状态。
 *
 * 只投影可公开字段：配置快照、租约、查询内容、执行结果等私有字段不会出现；
 * inherited 成员以及没有当前 run 的成员会被后端过滤，不会进入 tasks。
 */
export interface CollaborationTaskStatus {
  /** 成员稳定 ID，同一任务在多次续跑之间保持不变。 */
  id: string
  /** 任务路由名（如 `/root/xxx`），用于模型侧寻址。 */
  name: string
  /** 展示名：模板 agent 使用其固定名称，临时 worker 使用任务名。 */
  display_name?: string
  /** 子 agent 配置 ID。 */
  agent_id: string
  /** 子会话 ID，前端据此打开子 agent 会话标签页查看完整对话。 */
  session_id: string
  /** 当前执行 ID；每次续跑都会生成新值，用于区分新一轮与旧终态。 */
  run_id: string
  /** 任务状态：queued / running / waiting / succeeded / failed / interrupted / cancelled / needs_attention；已请求取消的活跃任务派生为 cancelling。 */
  status: string
  /** 当前 run 的进度遥测；尚未产生进度时为 null 或缺省。 */
  progress?: CollaborationProgress | null
  /** 当前 run 正在等待的人工提示 ID（工具审批 / 向用户提问），无等待时为空。 */
  prompt_id?: string
  /** 该 run 在协作邮箱中最后一条消息，用于卡片摘要预览。 */
  latest_message?: string
}

/**
 * 一次委派协作组的整体状态快照，也是 SSE 事件 `collaboration_status` 的 data 载荷。
 *
 * 用途：父 Agent 把任务拆给多个子 Agent 并行执行时，它描述"这一轮委派有哪些子任务、
 * 各自进行到哪一步"，前端据此在主对话时间线里渲染每个子任务的状态行
 * （如"进行中 · 搜索网页""等待你处理""已完成"）。它只包含状态，不包含子任务的
 * 回答正文；要看正文需按 tasks[].session_id 打开子会话。
 *
 * 更新方式是"全量覆盖"而不是增量事件：后端每次状态变化都推送一份完整快照，
 * 前端按 revision 单调合并——revision 不大于已应用值的快照必须丢弃，
 * 这样并发子任务、断线重连、历史重放造成的乱序都不会让 UI 状态倒退。
 */
export interface CollaborationStatus {
  /**
   * 协作组 ID：一次用户目标/一次父回合内的所有子任务共享同一个值。
   * 同一段主对话里可能有多次委派（如先"筹备读书会"、后"安排团建"），
   * 前端用它判断快照属于哪一次委派，避免把子任务挂到错误的消息上。
   */
  group_id: string
  /**
   * 数据库 CAS 版本号，随每次状态提交单调递增。
   * 前端只应用比当前已显示版本更新的快照，用于丢弃乱序到达或重连后重放的旧快照，
   * 防止 UI 从"已完成"倒退回"进行中"。
   */
  revision: number
  /**
   * 本次委派当前可见的子任务列表，每个元素对应时间线里的一行子任务状态。
   * 后端已过滤 inherited（历史继承、本轮未继续使用）成员以及没有当前 run 的成员，
   * 因此这里只包含"本轮真正在跑或跑过"的任务。
   */
  tasks: CollaborationTaskStatus[]
}

export interface CollaborationStatusStreamEvent {
  response_type: 'collaboration_status'
  /** Parent request identifier; child run identifiers live in tasks. */
  id: string
  assistant_message_id?: string
  data: CollaborationStatus
}

export interface ProgressStreamEvent {
  response_type: 'progress'
  id: string
  assistant_message_id?: string
  /** Cumulative visible progress text for this event, safe to replay. */
  content: string
  done: boolean
  data: { event_id: string; iteration?: number }
}

/** Persisted agent step fields used when rebuilding the visible timeline. */
export interface AgentStepRecord extends Record<string, unknown> {
  iteration?: number
  thought?: string
  reasoning_content?: string
  progress?: string
  progress_event_id?: string
}

export interface ChatHistoryMessage extends Record<string, unknown> {
  collaboration_status?: CollaborationStatus
  agent_steps?: AgentStepRecord[]
}

/** An explicit protocol correction replaces only this answer segment. */
export interface AnswerStreamMetadata {
  event_id: string
  replace?: boolean
  truncated?: boolean
  is_fallback?: boolean
}
