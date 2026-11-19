import { fetchEventSource } from '@microsoft/fetch-event-source';
import { ref, onUnmounted } from 'vue';
import { generateRandomString } from '@/utils/index';
import i18n from '@/i18n';
import { getApiBaseUrl } from '@/utils/api-base';
import type { AssistantAccessLevel } from '@/api/assistant';
export type { CollaborationStatus, CollaborationTaskStatus, CollaborationProgress,
  CollaborationStatusStreamEvent, ProgressStreamEvent, AgentStepRecord, ChatHistoryMessage } from './streamTypes';
import {
  sanitizeStreamRequestBody,
  type StreamRequestMeta,
} from '@/utils/chatRequestDebug';
import {
  StreamAuthError,
  isStreamAuthError,
  refreshAccessTokenShared,
  runStreamWithAuthRetry,
} from '@/utils/authRefresh';

/** 用户当前打开的 WeKnora 页面；仅 agent-chat 使用。 */
export interface PageContextPayload {
  page?: string
  section?: string
  agent_id?: string
  knowledge_base_id?: string
  knowledge_id?: string
  wiki_slug?: string
  wiki_issue_ids?: string[]
  model_id?: string
  mcp_service_id?: string
  session_id?: string
  message_id?: string
  /** 页面名称，与侧边栏中显示的一致。 */
  title?: string
  /** 覆盖在该页面之上的弹窗或抽屉。 */
  view?: string
  selection?: PageSelectionPayload
}

export interface PageSelectionPayload {
  text: string
  field?: string
  ref?: string
  start_line?: number
  end_line?: number
}

interface StreamOptions {
  // 请求方法 (默认POST)
  method?: 'GET' | 'POST'
  // 请求头
  headers?: Record<string, string>
  // 请求体自动序列化
  body?: Record<string, any>
  // 流式渲染间隔 (ms)
  chunkInterval?: number
}

export function useStream() {
  // 响应式状态
  const output = ref('')              // 显示内容
  const isStreaming = ref(false)      // 流状态
  const isLoading = ref(false)        // 初始加载
  const error = ref<string | null>(null)// 错误信息
  const lastStreamRequest = ref<StreamRequestMeta | null>(null) //最近一次流式请求的元数据快照
  /**
   * 外层的取消控制器
   * 
   * 对应的业务需求是，这一轮的对话还要不要继续？
   * 例如：用户点“停止生成”、上一轮还没打完，用户又发了新问题、切花回答/离开页面/组件卸载、连续快速发送
   */
  let controller = new AbortController()
  // streamGeneration 是一个代际计数器（epoch），
  // 用来解决“旧的异步回调在新一轮开始后仍然执行”的竞态问题。
  let streamGeneration = 0

  // 流式渲染缓冲
  let buffer: string[] = []
  let renderTimer: number | null = null

  // 启动流式请求
  /**
   * 发起一次流式对话请求。
   * - POST：新建一轮问答，`query` 是用户问题文本；
   * - GET：续传/接入一条仍在生成中的 assistant 消息，`query` 复用为消息 ID。
   */
  const startStream = async (params: {
    /** 会话 ID，拼进请求 URL 的路径段 */
    session_id: any;
    /**
     * 请求载荷，含义随 method 变化：
     * - POST：用户的问题文本，写入请求体的 `query` 字段；
     * - GET：被复用为 assistant 消息 ID，拼进 URL 的 `?message_id=`（见下方 URL 拼接）。
     */
    query: any;
    /** 参与检索的知识库 ID 列表；空数组时不传 */
    knowledge_base_ids?: string[];
    /** 指定的知识/文档 ID 列表 */
    knowledge_ids?: string[];
    /** 按标签过滤的标签 ID 列表 */
    tag_ids?: string[];
    /** 是否启用 Agent 模式；缺省为 true */
    agent_enabled?: boolean;
    /** 指定 Agent；后端据此解析共享 Agent 及其来源空间 */
    agent_id?: string;
    /** 共享 Agent 所属空间 ID；后端会转成 Number 后写入请求体 */
    agent_source_tenant_id?: string | number;
    /** 是否启用网络搜索 */
    web_search_enabled?: boolean;
    /** 是否启用本地浏览器 */
    local_browser_enabled?: boolean;
    /** 非 Agent 模式下用于生成回答的模型 ID */
    summary_model_id?: string;
    /** 推理强度；不传则沿用 Agent 当前的默认值 */
    reasoning_effort?: string;
    /** 启用的 MCP 服务 ID 列表 */
    mcp_service_ids?: string[];
    /** 启用的技能名称列表 */
    skill_names?: string[];
    /** @ 提及的条目（知识库、文档、标签、MCP、技能等） */
    mentioned_items?: Array<{
      id: string;
      name: string;
      type: string;
      kb_type?: string;
      kb_id?: string;
      kb_name?: string;
      service_id?: string;
      skill_name?: string;
    }>;
    /** 多模态图片，`data` 为 base64 data URI */
    images?: Array<{ data: string }>;
    /** 随消息上传的附件（文档、音频等），`data` 为 base64 内容 */
    attachment_uploads?: Array<{ data: string; file_name: string; file_size: number }>;
    /** 已上传附件的 ID 列表 */
    attachment_ids?: string[];
    /** 点击推荐问题的归因信息（来自哪一组建议、哪一条问题）；会写入用户消息，用于统计时区分“用户自己输入”与“点击推荐” */
    suggestion_attribution?: { suggestion_set_id: string; question_id: string };
    /** 推荐问题所源自的知识库/文档；作为本轮检索的提示，让模型先检索该来源再回答 */
    question_origin?: { knowledge_base_id: string; knowledge_id?: string };
    /** 当前页面上下文；仅 Agent 模式使用 */
    page_context?: PageContextPayload;
    /** WeKnora 助手对工作区执行修改的权限级别（read_only / confirm / auto_write）；仅内置 WeKnora 助手使用，且受空间上限与 Agent 自身上限约束 */
    assistant_access?: AssistantAccessLevel;
    /** HTTP 方法：POST 发起新提问；GET 续传/接入进行中的回答 */
    method: string;
    /** 接口路径（不含 API base），如 /api/v1/agent-chat */
    url: string;
    /** 审批恢复：等待该审批通过后再接收事件流（仅 GET） */
    resume_pending_id?: string;
    /** 嵌入模式 token；存在时使用 Embed 认证并禁用自动重连 */
    embed_token?: string;
    /** 嵌入会话签名 */
    embed_session_sig?: string;
    /** 嵌入访客 ID */
    embed_visitor_id?: string;
  }) => {
    const myGeneration = ++streamGeneration
    const streamAbort = controller
    // 重置状态
    output.value = '';
    error.value = null;
    isStreaming.value = true;
    isLoading.value = true;

    // 获取API配置
    const apiUrl = getApiBaseUrl();
    
    const embedToken = params.embed_token;
    const token = embedToken || localStorage.getItem('weknora_token');
    if (!token) {
      error.value = i18n.global.t('error.tokenNotFound');
      stopStream();
      return;
    }

    // 读取当前激活空间，供流式请求的 X-Tenant-ID 使用。
    // 只要 setSelectedTenant 写过激活空间就附，不做“是否等于默认空间”的判断：
    // 早期版本为省 header 体积，在 selectedTenantId === defaultTenantId 时跳过；
    // 但 OIDC 同步 / UserMenu loadUserInfo / router hydrate 会把 weknora_tenant
    // 改写成激活空间，使两者经常相等，导致后续流式请求悄悄丢 header、落回
    // home 空间，用其他空间的 session_id 查询就返回 404。
    // 直接附不会越权：后端 IsTenantAccessible 允许 header 指向用户自己的空间。
    const selectedTenantId = localStorage.getItem('weknora_selected_tenant_id');
    // 归一化：空字符串视为“没有激活空间”，下面只在有值时附 header。
    const tenantIdHeader: string | null = selectedTenantId || null;

    // TTFB 埋点：记录请求发起的时刻，便于与从服务端收到的第一个回答分片做对比。
    // 借助 X-Request-ID，可以把前端观测到的延迟与后端
    // "TTFB:first_answer_chunk" 日志行关联起来，从而定位耗时发生在哪一段。
    const sentAt = performance.now();
    // 12位随机串子，用来给 StreamRequestMeta 的 requestID 以及 作为 X-Request-ID 的请求头发送给后端
    const requestID = generateRandomString(12);
    /** 是否已经记录过“首个回答分片”的 TTFB；只记一次，避免重复打日志。 */
    let firstAnswerLogged = false;
    /**
     * 持久化的 assistant 消息 ID，来自 agent_query 事件；断线重连（continue-stream）
     * 需要它定位要续传的消息，也是 canReconnect 成立的前提。
     */
    let receivedAssistantId = '';
    /** 是否已收到终止事件（complete / stop / error）；一旦终止就不再尝试重连。 */
    let receivedTerminal = false;
    /** 重连尝试次数：收到任意事件就清零；用于指数退避（最多 8 次，延迟 1s 起翻倍、封顶 5s）。 */
    let reconnectAttempts = 0;
    let streamMethod = params.method;
    // 已被服务端接受并开始推流的 POST 不重发：否则会重复创建一轮回答。
    // 传输中断时只允许用 GET continue-stream 接入它已持久化的 assistant 消息，
    // 因此这里要求已拿到 assistant ID、尚未收到终止事件、且仍是当前代际。
    // 注意：401 握手失败表示请求“未被接受”，上层刷新 token 后原样重放 POST 是安全的。
    const canReconnect = () => !embedToken && receivedAssistantId && !receivedTerminal &&
      (params.url === '/api/v1/agent-chat' || params.url === '/api/v1/sessions/continue-stream') &&
      myGeneration === streamGeneration && !streamAbort.signal.aborted;


    try {
      // 根据 method 来拼接不同的字符串
      let url =
        params.method == "POST"
          // POST（首次提问）
          // apiUrl = '' 或 '/app/weknora'，params.url = '/api/v1/agent-chat'
          // → /api/v1/agent-chat/{session_id}
          ? `${apiUrl}${params.url}/${params.session_id}`
          // GET（断线重连，params.query 这时装的是 messageId）
          // params.url = '/api/v1/sessions/continue-stream'
          // → /api/v1/sessions/continue-stream/{session_id}?message_id={assistant_message_id}
          : `${apiUrl}${params.url}/${params.session_id}?message_id=${params.query}`;
      if (params.method === "GET" && params.resume_pending_id) {
        // encodeURIComponent 将 resume_pending_id 做百分号编码，防止它出现 "&,=,#,+" 等特殊字符，避免弄乱URL
        url += `&resume_pending_id=${encodeURIComponent(params.resume_pending_id)}`;
      }
      console.log(`[TTFB] request:start request_id=${requestID} url=${url} sent_at=${Date.now()}`);
      
      // 为 agent-chat 准备包含必填字段的 POST 请求体
      // knowledge_base_ids 数组和 agent_enabled 可以更新 Session 的 SessionAgentConfig（会话级 Agent 配置）
      const postBody: any = { 
        query: params.query,
        agent_enabled: params.agent_enabled !== undefined ? params.agent_enabled : true
      };
      // agent-chat 始终携带 knowledge_base_ids（上方已做过校验）
      if (params.knowledge_base_ids !== undefined && params.knowledge_base_ids.length > 0) {
        postBody.knowledge_base_ids = params.knowledge_base_ids;
      }
      // 如果提供了 knowledge_ids 就带上
      if (params.knowledge_ids !== undefined && params.knowledge_ids.length > 0) {
        postBody.knowledge_ids = params.knowledge_ids;
      }
      // 如果提供了 agent_id 就带上（后端会根据共享关系解析共享 Agent 及其所属空间）
      if (params.agent_id) {
        postBody.agent_id = params.agent_id;
      }
      if (params.agent_source_tenant_id) {
        postBody.agent_source_tenant_id = Number(params.agent_source_tenant_id);
      }
      // 如果提供了 web_search_enabled 就带上
      if (params.web_search_enabled !== undefined) {
        postBody.web_search_enabled = params.web_search_enabled;
      }
      // 重建 HTTP 请求体时，保留用户显式选择的浏览器开关
      if (params.local_browser_enabled !== undefined) {
        postBody.local_browser_enabled = params.local_browser_enabled;
      }
      // 如果提供了 summary_model_id 就带上（用于非 Agent 模式）
      if (params.summary_model_id) {
        postBody.summary_model_id = params.summary_model_id;
      }
      // 不传继承值，让 Agent 当前的默认设置保持权威
      if (params.reasoning_effort) {
        postBody.reasoning_effort = params.reasoning_effort;
      }
      // 如果提供了 mcp_service_ids 就带上（用于 Agent 模式）
      if (params.mcp_service_ids !== undefined && params.mcp_service_ids.length > 0) {
        postBody.mcp_service_ids = params.mcp_service_ids;
      }
      if (params.skill_names !== undefined && params.skill_names.length > 0) {
        postBody.skill_names = params.skill_names;
      }
      if (params.tag_ids !== undefined && params.tag_ids.length > 0) {
        postBody.tag_ids = params.tag_ids;
      }
      // 如果提供了 mentioned_items 就带上（用于在聊天中展示 @ 提及）
      if (params.mentioned_items !== undefined && params.mentioned_items.length > 0) {
        postBody.mentioned_items = params.mentioned_items;
      }
      // 如果提供了 images 就带上（多模态聊天用的 base64 data URI）
      if (params.images !== undefined && params.images.length > 0) {
        postBody.images = params.images;
      }
      // 如果提供了 attachment_uploads 就带上（文档、音频等）
      if (params.attachment_uploads !== undefined && params.attachment_uploads.length > 0) {
        postBody.attachment_uploads = params.attachment_uploads;
      }
      if (params.attachment_ids !== undefined && params.attachment_ids.length > 0) {
        postBody.attachment_ids = params.attachment_ids;
      }
      if (params.suggestion_attribution) {
        postBody.suggestion_attribution = params.suggestion_attribution;
      }
      if (params.question_origin) {
        postBody.question_origin = params.question_origin;
      }
      if (params.page_context) {
        postBody.page_context = params.page_context;
      }
      if (params.assistant_access) {
        postBody.assistant_access = params.assistant_access;
      }
      postBody.channel = embedToken ? "embed" : "web";

      lastStreamRequest.value = {
        requestId: requestID,
        url,
        method: params.method,
        body: params.method === 'POST' ? sanitizeStreamRequestBody(postBody) : null,
        sentAt: Date.now(),
      };
      
      // 包一层，以便 access token 过期时先刷新、再重放一次请求。
      // 握手返回 401 时尚未向界面输出任何流式内容，因此这次重放对用户不可见。
      const runStream = async (authToken: string) => {
        // bortController 是浏览器内置的取消控制器，用来主动中止一个异步操作（最常见的就是 fetch）。
        // new AbortController() 会创建一个控制器对象。
        /** 
         * 内层请求取消控制器
         * 
         * 对应的业务需求为“这一次网络连接该不该活着？”
         * 例如：网络抖动、服务端重启、连接半开、access token 过期后刷新重放、重连 continue-stream、正常结束/异常结束、外层取消时
         */
        const connection = new AbortController();
        /**
         * 包一层请求取消的回调函数
         * 
         * @returns 返回 connection.abort()
         */
        const abortConnection = () => connection.abort();
        // 把外层的取消意图传导到本次连接：用户点“停止”或发起新对话时，
        // 外层 signal 触发 abort，这里随之取消内层 connection。
        // once: true 让监听器触发一次后自动解绑；若连接正常结束、事件从未触发，
        // 则由 finally 里的 removeEventListener 兜底移除，避免多次重连后监听器累积。
        streamAbort.signal.addEventListener('abort', abortConnection, { once: true });

        let idleTimer: ReturnType<typeof setTimeout>;
        let rejectIdle: (reason: Error) => void;
        // 一个只用于“手动失败”的 Promise：创建后一直 pending，
        // 由心跳超时定时器调用 rejectIdle 触发。它与 fetchEventSource 一起
        // 参与 Promise.race，谁先结束谁决定本次连接的结局。
        const idle = new Promise<never>((_, reject) => { rejectIdle = reject; });

        /**
         * 重置心跳看门狗。
         *
         * 每次收到服务端事件后重新计时；30 秒内没有任何事件就判定连接已死，
         * 主动 reject idle 并中止 connection，交给外层重连逻辑处理。
         * 不能重连的场景（嵌入模式、没有 assistant 消息、已结束等）不启动计时。
         */
        const armIdle = () => {
          clearTimeout(idleTimer);
          if (!canReconnect()) return;
          idleTimer = setTimeout(() => {
            rejectIdle(new Error('stream heartbeat timed out'));
            connection.abort();
          }, 30000);
        };
        armIdle();
        try {
          // fetchEventSource 就是 @microsoft/fetch-event-source 的一个 fetch 请求方法
          await Promise.race([idle, fetchEventSource(url, {
        method: streamMethod,
        headers: {
          "Content-Type": "application/json",
          "Authorization": embedToken ? `Embed ${embedToken}` : `Bearer ${authToken}`,
          "Accept-Language": i18n.global.locale?.value || localStorage.getItem('locale') || 'zh-CN',
          "X-Request-ID": requestID,
          // 如果有当前激活的空间，就无脑写入 headers ，用来表示用户请求的空间 ID
          ...(!embedToken && tenantIdHeader ? { "X-Tenant-ID": tenantIdHeader } : {}),
          ...(params.embed_session_sig ? { "X-Embed-Session": params.embed_session_sig } : {}),
          ...(params.embed_visitor_id ? { "X-Embed-Visitor": params.embed_visitor_id } : {}),
        },
        body:
          streamMethod == "POST"
            ? JSON.stringify(postBody)
            : null,
        signal: connection.signal,
        // openWhenHidden 控制当页面不可见时，是否关闭此次 SSE 连接。例如最小化、切换标签页等
        openWhenHidden: true,

        // 收到 HTTP 响应头时由 fetchEventSource 调用，此时尚未解析任何 SSE 事件。
        // 在这里 throw 会中止本次连接，并让 fetchEventSource 返回的 Promise 进入 reject。
        onopen: async (res) => {
          // 401 可恢复：交给上层刷新 token 后重放一次；
          // 其余非 2xx（403/404/429/5xx 等）视为不可恢复错误。
          if (res.status === 401) throw new StreamAuthError(res.status);
          // res 是 Fetch 的 Response 对象，ok 仅表示状态码在 200–299 之间。
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          // 记录握手完成时刻，用于把前端延迟与后端日志按 request_id 对齐。
          console.log(`[TTFB] response:headers request_id=${requestID} elapsed_ms=${(performance.now() - sentAt).toFixed(1)}`);

          // 握手成功，结束初始加载态；代际判断避免旧连接清掉新一轮的 loading。
          if (myGeneration === streamGeneration) isLoading.value = false;
        },

        /**
         * 每收到一条 SSE 事件时调用，是服务端事件的统一入口。
         *
         * 职责：丢弃过期流的事件 → 解析 JSON → 更新重连所需元信息 →
         * 维护心跳 → 记录 TTFB → 把事件交给缓冲区和消费方。
         * 这里只做“接收与分发”，不直接改回答内容；真正的渲染由 chunkHandler 的注册方决定。
         * 
         * ev 的结构：
         * interface EventSourceMessage {
         *  id: string;      // 来自 SSE 的 "id:" 字段，事件 ID
         *  event: string;   // 来自 "event:" 字段，事件类型名
         *  data: string;    // 来自 "data:" 字段的原始文本（多行会用 \n 拼接）
         *  retry?: number;  // 来自 "retry:" 字段，建议的重连间隔
         * }
         */
        onmessage: (ev) => {
          // 已被取代的旧流仍可能收到事件，直接丢弃，避免污染新一轮状态。
          if (myGeneration !== streamGeneration) return
          const parsed = JSON.parse(ev.data);

          // 收到任何事件都说明连接仍然活着：重置重连退避计数。
          reconnectAttempts = 0;

          // agent_query 携带持久化的 assistant 消息 ID；断线重连（continue-stream）
          // 依赖它定位要续传的那条消息。
          if (parsed?.response_type === 'agent_query' && typeof parsed.assistant_message_id === 'string') {
            receivedAssistantId = parsed.assistant_message_id;
          }

          // complete / stop / error 是终止事件：标记后不再尝试重连。
          if (['complete', 'stop', 'error'].includes(parsed?.response_type)) receivedTerminal = true;

          // 心跳看门狗：任何事件（包括 heartbeat）都重新计时。
          armIdle();

          // heartbeat 只用于保活，不应交给界面渲染。
          if (parsed?.response_type === 'heartbeat') return;

          // 记录第一个回答分片，用于端到端 TTFB 测量。
          // 按事件类型过滤，避免非回答事件（引用、工具调用等）被误算作“首个 token”。 
          if (!firstAnswerLogged && (parsed?.response_type === 'answer' || parsed?.type === 'answer')) {
            firstAnswerLogged = true;
            console.log(`[TTFB] response:first_answer request_id=${requestID} elapsed_ms=${(performance.now() - sentAt).toFixed(1)}`);
          }

          // 先入本地缓冲，再交给消费方（渲染/持久化由注册方决定）。
          buffer.push(parsed);
          // 将回传的 message 交给注册的 chunkHandler ，之后再传给回调函数，即业务层回调
          if (chunkHandler) {
            chunkHandler(parsed);
          }
        },

        // 网络错误，或 onopen / onmessage 里抛出的错误会进入这里。
        // StreamAuthError 只可能由 onopen 在握手 401 时抛出；库会把 onopen
        // 抛出的错误转交给 onerror，所以这里能收到它。
        // 库的约定：返回数字表示等待该毫秒数后重连；返回 undefined 会按默认
        // 1s 重连；抛异常才会终止连接并 reject。这里统一抛异常，
        // 把重连/刷新/续传交给外层逻辑处理。
        onerror: (err) => {
          // 原样抛出认证错误，否则外层无法识别为“可刷新并重放”的 401。
          if (isStreamAuthError(err)) throw err;
          // 其余错误包装成用户可读的本地化提示，再交给外层决定是否重连。
          throw new Error(`${i18n.global.t('error.streamFailed')}: ${err}`);
        },

        onclose: () => {
          // 排队的后续轮次会通过 continue-stream 接入，而前一个 POST 可能
          // 仍保持连接、等待会话标题。两者共用一个 controller，因此只有
          // 当前的流才有权停止它；否则旧连接关闭会把后续轮次的中途回答切断。
          if (canReconnect()) throw new Error('stream closed before the turn completed');
          if (myGeneration === streamGeneration) stopStream();
        },
          })]);
        } finally {
          clearTimeout(idleTimer!);
          streamAbort.signal.removeEventListener('abort', abortConnection);
          connection.abort();
        }
      };

      while (myGeneration === streamGeneration && !streamAbort.signal.aborted) {
        try {
          await runStreamWithAuthRetry({
            run: runStream,
            initialToken: token,
            isEmbed: Boolean(embedToken),
            isCurrent: () => myGeneration === streamGeneration && !streamAbort.signal.aborted,
            refreshAccessToken: () => refreshAccessTokenShared({
              messages: {
                pleaseRelogin: i18n.global.t('error.pleaseRelogin'),
                tokenRefreshFailed: i18n.global.t('error.tokenRefreshFailed'),
              },
            }),
            reloginMessage: i18n.global.t('error.pleaseRelogin'),
          });
          break;
        } catch (err) {
          if (!canReconnect() || isStreamAuthError(err) || reconnectAttempts >= 8) throw err;
          reconnectAttempts++;
          // 服务端可能仍在重启中。一次停止或新轮次会使本次重试失效，
          // 从而避免它在失效后接入或改变可见状态。
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              streamAbort.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, Math.min(1000 * 2 ** (reconnectAttempts - 1), 5000));
            streamAbort.signal.addEventListener('abort', done, { once: true });
          });
          if (myGeneration !== streamGeneration || streamAbort.signal.aborted) return;
          streamMethod = 'GET';
          url = `${apiUrl}/api/v1/sessions/continue-stream/${encodeURIComponent(params.session_id)}?message_id=${encodeURIComponent(receivedAssistantId)}`;
        }
      }
    } catch (err) {
      // 已被取代的流失败时，不能把它当作当前错误上报，
      // 也不能中止取代它的那条流（见 onclose）。
      if (myGeneration !== streamGeneration) return
      error.value = err instanceof Error ? err.message : String(err)
      stopStream()
    }
  }

  let chunkHandler: ((data: any) => void) | null = null
  // 注册块处理器
  const onChunk = (handler: (data: any) => void) => {
    chunkHandler = handler
  }


  // 停止流
  const stopStream = () => {
    streamGeneration++
    controller.abort();
    controller = new AbortController(); // 重置控制器（如需重新发起）
    isStreaming.value = false;
    isLoading.value = false;
  }

  // 组件卸载时自动清理
  onUnmounted(stopStream)

  return {
    output,          // 显示内容
    isStreaming,     // 是否在流式传输中
    isLoading,       // 初始连接状态
    error,
    lastStreamRequest,
    onChunk,
    startStream,     // 启动流
    stopStream       // 手动停止
  }
}
