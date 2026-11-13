import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const graphPath = path.join(root, '.ua', 'knowledge-graph.json')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const nodes = []
const edges = []
const layers = []
const tour = []
const ids = new Set()
const edgeKeys = new Set()
const lines = new Map()

function sourceLines(filePath) {
  if (!lines.has(filePath)) {
    const absolute = path.join(root, ...filePath.split('/'))
    lines.set(filePath, fs.readFileSync(absolute, 'utf8').split(/\r?\n/).length)
  }
  return lines.get(filePath)
}
function addNode(node) {
  if (ids.has(node.id)) throw new Error(`duplicate node: ${node.id}`)
  if (node.filePath) {
    const count = sourceLines(node.filePath)
    if (node.lineRange && (node.lineRange[0] < 1 || node.lineRange[1] > count || node.lineRange[0] > node.lineRange[1])) {
      throw new Error(`invalid lineRange: ${node.id}`)
    }
  }
  ids.add(node.id)
  nodes.push(node)
  return node.id
}
function file(filePath, summary, category, complexity = 'complex') {
  return addNode({ id: `file:${filePath}`, type: 'file', name: path.basename(filePath), filePath, summary, tags: [category], complexity })
}
function fn(filePath, name, start, end, summary, category, complexity = 'complex') {
  const id = addNode({ id: `function:${filePath}:${name}`, type: 'function', name, filePath, lineRange: [start, end], summary, tags: [category], complexity })
  edge(`file:${filePath}`, id, 'contains')
  return id
}
function point(name, summary, category, type = 'concept') {
  return addNode({ id: `${type}:${name}`, type, name, summary, tags: [category], complexity: 'moderate' })
}
function endpoint(method, url, summary, category) {
  return addNode({ id: `endpoint:${method}:${url}`, type: 'endpoint', name: `${method} ${url}`, summary, tags: [category], complexity: 'moderate' })
}
function edge(source, target, type = 'calls', weight) {
  const key = `${source}|${target}|${type}`
  if (edgeKeys.has(key)) return
  edgeKeys.add(key)
  edges.push({ source, target, type, direction: 'forward', weight: weight ?? ({ contains: 1, calls: 0.8, imports: 0.7, routes: 0.7, validates: 0.7, triggers: 0.7, writes_to: 0.6, reads_from: 0.6, configures: 0.6, depends_on: 0.6, tested_by: 0.5, related: 0.5 }[type] ?? 0.5) })
}
function category(id, name, description, members, reading, lesson) {
  const group = new Set(members)
  // In file-level view we show file/endpoint nodes; in class view we explicitly
  // list the important functions as well, so cross-file call chains remain visible.
  for (const node of nodes) {
    if (node.type === 'function' && node.filePath && group.has(`file:${node.filePath}`) && node.tags?.includes(name.replace(/^\d+ (前端|后端) · /, ''))) group.add(node.id)
  }
  const nodeIds = [...group]
  layers.push({ id: `layer:${id}`, name, description, nodeIds })
  tour.push({ order: tour.length + 1, title: name, description: reading, nodeIds: members.slice(0, 12), languageLesson: lesson })
}

// 01. Bootstrap, auth and cross-tenant state.
const bootstrapFile = file('frontend/src/main.ts', '启动前安装全局能力，已有会话先校准 /auth/me；首屏导航完成后再挂载。', '启动与认证', 'moderate')
const routerFile = file('frontend/src/router/index.ts', '路由门禁负责会话恢复、Lite 自动登录、能力限制与页面跳转；只提供 UI 层保护。', '启动与认证')
const authFile = file('frontend/src/stores/auth.ts', 'Pinia 持有当前身份及活动租户；登出使飞行请求失效并清空空间资源缓存。', '启动与认证')
const authApiFile = file('frontend/src/api/auth/index.ts', '封装 /auth/me、自动登录和刷新 Token 的前端 API 契约。', '启动与认证')
const sequencedFile = file('frontend/src/stores/sequencedRefresh.ts', '区分 share 共用当前请求与 refresh 排队发起新请求；invalidate 让旧代际不能回写身份。', '启动与认证')
const sequenced = fn('frontend/src/stores/sequencedRefresh.ts', 'createSequencedRefresh', 18, 60, '并发 refresh 共用一个后继请求，share 复用当前请求，登出递增 revision 供调用方判断是否仍有效。', '启动与认证')
const mainBootstrap = fn('frontend/src/main.ts', 'bootstrap', 30, 60, '安装 Pinia 后先刷新已存在会话，再等待 router.isReady，避免页面闪跳。', '启动与认证')
const guard = fn('frontend/src/router/index.ts', 'beforeEach', 287, 408, '认证、租户 onboarding、Lite 和能力门禁合并于异步导航流程；后端仍独立授权。', '启动与认证')
const authRefresh = fn('frontend/src/stores/auth.ts', 'refreshFromAuthMe', 361, 361, '借助 authMeRequest 排序校准请求；登出后忽略旧 /auth/me 响应。', '启动与认证')
const getMe = fn('frontend/src/api/auth/index.ts', 'getCurrentUser', 354, 364, '通过 /auth/me 获取用户、租户、成员关系与部署能力。', '启动与认证')
const loginEndpoint = endpoint('GET', '/api/v1/auth/me', '后端认证中间件校验身份并返回当前会话视图。', '启动与认证')
const backendAuthFile = file('internal/handler/auth.go', '服务端验证 JWT/API Key 身份并返回当前用户、租户与部署能力。', '启动与认证')
const backendGetMe = fn('internal/handler/auth.go', 'GetCurrentUser', 643, 699, '构造当前调用者可见的用户/租户、成员关系与部署能力。', '启动与认证')
edge(mainBootstrap, authRefresh); edge(mainBootstrap, guard, 'depends_on'); edge(guard, authRefresh); edge(authRefresh, getMe); edge(getMe, loginEndpoint, 'routes'); edge(loginEndpoint, backendGetMe, 'routes')
edge(bootstrapFile, routerFile, 'imports'); edge(bootstrapFile, authFile, 'imports'); edge(routerFile, authFile, 'imports'); edge(authFile, authApiFile, 'depends_on'); edge(authApiFile, loginEndpoint, 'routes'); edge(loginEndpoint, backendAuthFile, 'routes')
edge(authFile, sequencedFile, 'imports'); edge(authRefresh, sequenced); edge(sequenced, getMe, 'related')
category('frontend-auth', '01 前端 · 启动与认证', 'Pinia 身份源、异步首屏守卫与多租户会话恢复；区分当前读取复用、强制刷新排队及登出代际失效。', [bootstrapFile, routerFile, authFile, sequencedFile, authApiFile, loginEndpoint, backendAuthFile], '从 bootstrap 的等待顺序读到路由校准，沿 /auth/me 追踪 share/refresh/invalidate，再回到 Auth Store。路由权限不是后端权限。', '学习首屏一致性、异步请求代际和身份状态单一事实源。')

// 02. One refresh queue shared by Axios and the independent SSE transport.
const requestFile = file('frontend/src/utils/request.ts', 'Axios 请求附 Bearer/Embed 鉴权、语言与租户上下文；401 则通过共享刷新器重放。', '共享鉴权刷新')
const refreshFile = file('frontend/src/utils/authRefresh.ts', '单次刷新、多请求排队及 Refresh Token 轮换；SSE 的 401 也复用此机制。', '共享鉴权刷新')
const requestInterceptor = fn('frontend/src/utils/request.ts', 'request.use', 72, 108, 'Axios 请求拦截器区分 Bearer 与嵌入 Embed 身份，注入语言和租户 Header。', '共享鉴权刷新')
const responseInterceptor = fn('frontend/src/utils/request.ts', 'response.use', 125, 229, 'Axios 响应拦截器排除 Embed/公开路由的 401 后刷新一次 Token 并重放原请求。', '共享鉴权刷新')
const sharedRefresh = fn('frontend/src/utils/authRefresh.ts', 'refreshAccessTokenShared', 109, 148, '并发请求进入等待队列，只有一次刷新；轮换失败清凭证并拒绝等待者。', '共享鉴权刷新')
const streamRetry = fn('frontend/src/utils/authRefresh.ts', 'runStreamWithAuthRetry', 157, 189, 'SSE 握手 401 后刷新 Token 并且仅当当前流未被替换时重试。', '共享鉴权刷新')
const refreshEndpoint = endpoint('POST', '/api/v1/auth/refresh', '短期 Access Token 失效后轮换会话凭证。', '共享鉴权刷新')
const refreshApi = fn('frontend/src/api/auth/index.ts', 'refreshToken', 402, 428, '使用 Refresh Token 向认证路由交换新的令牌对。', '共享鉴权刷新')
const backendRefresh = fn('internal/handler/auth.go', 'RefreshToken', 599, 631, '服务端校验 Refresh Token 并返回新令牌对。', '共享鉴权刷新')
edge(authApiFile, requestFile, 'imports'); edge(getMe, requestInterceptor, 'depends_on'); edge(responseInterceptor, sharedRefresh); edge(sharedRefresh, refreshApi); edge(refreshApi, refreshEndpoint, 'routes'); edge(refreshEndpoint, backendRefresh, 'routes'); edge(streamRetry, sharedRefresh)
edge(requestFile, refreshFile, 'imports'); edge(refreshFile, refreshEndpoint, 'routes')
category('frontend-token', '02 前端 · 共享鉴权刷新', 'Axios 与 fetch-event-source 是独立传输，只有刷新协调器共享。', [requestFile, refreshFile, refreshEndpoint, refreshApi, backendRefresh], '先看两类 401 处理：Axios 响应拦截器与 SSE 重试都汇入共享刷新队列，不能画成 SSE 经过 Axios。', '练习 single-flight、令牌轮换和过期请求淘汰。')

// 03. Streaming UI and event projections.
const chatPageFile = file('frontend/src/views/chat/index.vue', '聊天页组合发送请求、流状态、消息视图和事件回调。', '流式聊天')
const streamFile = file('frontend/src/api/chat/streame.ts', 'fetch-event-source 建立可取消的 SSE；重连、续传和旧流代际隔离。', '流式聊天')
const streamHandlerFile = file('frontend/src/composables/useChatStreamHandler.ts', '把 query、工具、回答、审批和完成事件归并为可渲染消息状态。', '流式聊天')
const forkPointFile = file('frontend/src/views/chat/forkPoint.ts', '分叉按钮只做前端提示；user 在提问处、assistant 在回答后分叉，实际约束由后端重验。', '流式聊天')
const steerForkFile = file('frontend/src/utils/steerStreamFork.ts', 'Steer 注入时封存展示段，并以同一持久 assistant ID 创建续段；回放时防止重复分叉。', '流式聊天')
const promptDockFile = file('frontend/src/composables/usePromptDock.ts', '汇集工具审批、ask_user、MCP 授权等未解决提示，跨 Steer 展示段保持可操作卡片。', '流式聊天')
const childTabsFile = file('frontend/src/composables/useChildAgentTabs.ts', '子 Agent 标签按 session/task 持久身份寻址，从最新快照恢复状态。', '流式聊天')
const collaborationFile = file('frontend/src/utils/collaborationDisplay.ts', '从工具事件和协作快照重建子 Agent 时间线，合并 wait 轮询并补恢复时缺失的 spawn 行。', '流式聊天')
const ragProgressFile = file('frontend/src/views/chat/components/RagPipelineProgress.vue', '将 RAG 工具调用与引用投影成可展开的检索进度和等待阶段。', '流式聊天')
const chatStart = fn('frontend/src/api/chat/streame.ts', 'startStream', 74, 349, '组装流请求，处理认证重试、断线续接与 assistant 消息的增量事件。', '流式聊天')
const processChunk = fn('frontend/src/composables/useChatStreamHandler.ts', 'processStreamChunk', 1548, 1807, '归并 agent_query、answer、工具与完成事件，保持持久化消息的身份。', '流式聊天')
const forkAffordance = fn('frontend/src/views/chat/forkPoint.ts', 'resolveForkAffordance', 25, 45, '流未完成时前端隐藏分叉入口；用户消息/助手回答的截点不同，服务端仍重验。', '流式聊天')
const steerFork = fn('frontend/src/utils/steerStreamFork.ts', 'forkAfterInjectedUser', 73, 153, '按 request_id 及持久 assistant ID 切分展示段；回放已分叉的事件时幂等复用续段。', '流式聊天')
const promptDock = fn('frontend/src/composables/usePromptDock.ts', 'pendingPrompts', 43, 63, '只选 live/suspended 回合未解决且未提交的提示；Steer 已封存段仍可由 live 同回合继续响应。', '流式聊天')
const childLookup = fn('frontend/src/composables/useChildAgentTabs.ts', 'findChildAgentTask', 31, 37, '按 sessionId/task.id 扫描最新协作快照，避免 Steer 后持有过时子任务状态。', '流式聊天')
const collaborationTimeline = fn('frontend/src/utils/collaborationDisplay.ts', 'collaborationTimeline', 65, 100, '子任务放回 spawn/followup 位置，恢复缺失调用时在回答前补子任务行；省略成功轮询。', '流式聊天')
const agentChatEndpoint = endpoint('POST', '/api/v1/agent-chat/:session_id', '发起 Agent 回合并开始生成。', '流式聊天')
const continueEndpoint = endpoint('GET', '/api/v1/sessions/continue-stream/:session_id', '通过 message_id 获取运行中消息的事件回放。', '流式聊天')
const forkEndpoint = endpoint('POST', '/api/v1/sessions/:session_id/fork', '服务端重验活跃租约与指定截点后创建会话分支。', '流式聊天')
edge(chatPageFile, streamFile, 'depends_on'); edge(chatPageFile, streamHandlerFile, 'depends_on'); edge(chatPageFile, chatStart); edge(chatStart, streamRetry); edge(chatStart, agentChatEndpoint, 'routes'); edge(chatStart, continueEndpoint, 'routes'); edge(chatStart, processChunk, 'publishes')
edge(streamFile, agentChatEndpoint, 'routes'); edge(streamFile, continueEndpoint, 'routes'); edge(streamFile, refreshFile, 'imports')
edge(chatPageFile, forkPointFile, 'imports'); edge(chatPageFile, forkEndpoint, 'routes'); edge(forkAffordance, forkEndpoint, 'related'); edge(streamHandlerFile, steerForkFile, 'imports'); edge(streamHandlerFile, steerFork, 'calls')
edge(chatPageFile, promptDockFile, 'related'); edge(streamHandlerFile, collaborationFile, 'related'); edge(collaborationFile, childTabsFile, 'related'); edge(childLookup, collaborationTimeline, 'related'); edge(promptDock, steerFork, 'depends_on'); edge(chatPageFile, ragProgressFile, 'related')
category('frontend-chat', '03 前端 · 流式聊天', 'SSE 续传、历史分叉与 Steer 展示段；协作 revision/run、防重复恢复、审批提示和 RAG 工具可视化按事件投影。', [chatPageFile, streamFile, streamHandlerFile, forkPointFile, steerForkFile, promptDockFile, childTabsFile, collaborationFile, ragProgressFile, agentChatEndpoint, continueEndpoint, forkEndpoint], '从聊天页沿 SSE/分叉入口到事件处理：对照 collaboration_status 的 group/revision/run 防回退，再看 Steer、审批 dock、子任务标签及 RAG 进度如何重建。', '分清持久 assistant ID 与显示段、完成事件与 answer.done、客户端操作提示与服务端分叉授权。')

// 04. Caching and request generations.
const cacheFile = file('frontend/src/stores/resourceCache.ts', '共享资源的 single-flight、失效和按 key 的快照缓存。', '异步竞态与缓存')
const versionFile = file('frontend/src/stores/versionedRequest.ts', '按请求版本抑制旧结果回写，force 刷新在飞行请求后执行。', '异步竞态与缓存')
const chatResourcesFile = file('frontend/src/stores/chatResources.ts', '将资源缓存实例连接到知识库、Agent、模型和聊天数据变更事件。', '异步竞态与缓存')
const localizedFile = file('frontend/src/stores/localizedResourceCache.ts', '按请求发起时的语言标记响应快照和飞行请求；语言切换时拒绝复用旧语言结果。', '异步竞态与缓存')
const localeUsable = fn('frontend/src/stores/localizedResourceCache.ts', 'isLocalizedSnapshotUsable', 11, 17, '只有 loadedLocale 与当前语言一致才复用列表快照。', '异步竞态与缓存')
const localeRefetch = fn('frontend/src/stores/localizedResourceCache.ts', 'shouldForceLocalizedRefetch', 33, 39, '异语言请求在飞行时强制排入后继读取，不能把旧响应标成当前语言。', '异步竞态与缓存')
const createCache = fn('frontend/src/stores/resourceCache.ts', 'createCachedResource', 26, 59, 'ensure 合并在飞行请求，invalidate 与 markLoaded 禁止迟到响应覆盖状态。', '异步竞态与缓存')
const keyedCache = fn('frontend/src/stores/resourceCache.ts', 'createKeyedSnapshotCache', 66, 111, '每个 key 按代际管理快照与在飞行请求，显式失效后重新获取。', '异步竞态与缓存')
const coordinator = fn('frontend/src/stores/versionedRequest.ts', 'createVersionedRequestCoordinator', 14, sourceLines('frontend/src/stores/versionedRequest.ts'), '给单次资源读取加 revision，识别旧响应并串行处理强制刷新。', '异步竞态与缓存')
edge(chatResourcesFile, createCache); edge(chatResourcesFile, keyedCache); edge(createCache, coordinator); edge(authFile, chatResourcesFile, 'configures'); edge(streamHandlerFile, chatResourcesFile, 'related')
edge(chatResourcesFile, cacheFile, 'imports'); edge(cacheFile, versionFile, 'imports'); edge(chatResourcesFile, localizedFile, 'imports'); edge(chatResourcesFile, localeUsable, 'calls'); edge(chatResourcesFile, localeRefetch, 'calls'); edge(localeRefetch, coordinator, 'related')
category('frontend-cache', '04 前端 · 异步竞态与缓存', '缓存新鲜度由失效和代际约束保证；本地化列表还要求响应、飞行请求和当前 UI 语言一致。', [chatResourcesFile, cacheFile, versionFile, localizedFile], '读资源实例化与请求发起时语言戳，对比旧语言飞行请求如何排入强制后继读取；再看 Pinia 登出清理。', '练习 single-flight、force 请求排队、stale response 丢弃与 Accept-Language 快照边界。')

// 05. Upload queue with bounded concurrency.
const uploadStoreFile = file('frontend/src/stores/uploadTasks.ts', '将上传任务队列接到知识库上传及批量查询 API。', '上传任务调度')
const uploadCoreFile = file('frontend/src/stores/uploadTasksCore.ts', '构造响应式任务与传输队列，将网络、定时器、回调作为依赖注入。', '上传任务调度')
const uploadQueueFile = file('frontend/src/stores/uploadQueue.ts', '有界并发传输、Abort 取消、失败重试和分块轮询解析状态。', '上传任务调度')
const uploadApiFile = file('frontend/src/api/knowledge-base/index.ts', '知识上传与批量状态查询的 HTTP API 适配层。', '上传任务调度')
const uploadApi = fn('frontend/src/api/knowledge-base/index.ts', 'uploadKnowledgeFile', 495, 520, '把文件数据打包为 FormData，传递进度回调和 AbortSignal。', '上传任务调度')
const uploadQueue = fn('frontend/src/stores/uploadQueue.ts', 'createUploadQueue', 92, 334, '任务与 File 句柄分离；并发 pump、分片状态轮询、取消与 clear 的代际隔离。', '上传任务调度')
const uploadEndpoint = endpoint('POST', '/api/v1/knowledge-bases/:id/knowledge/file', '文件入库的受保护上传入口。', '上传任务调度')
edge(uploadStoreFile, uploadCoreFile, 'calls'); edge(uploadCoreFile, uploadQueue); edge(uploadStoreFile, uploadApi); edge(uploadApi, uploadEndpoint, 'routes'); edge(uploadQueue, uploadApi, 'depends_on')
edge(uploadCoreFile, uploadQueueFile, 'imports'); edge(uploadStoreFile, uploadApiFile, 'imports'); edge(uploadApiFile, uploadEndpoint, 'routes')
category('frontend-upload', '05 前端 · 上传任务调度', '文件传输与后端解析状态分开，支持并发上限、取消和重试。', [uploadStoreFile, uploadCoreFile, uploadQueueFile, uploadApiFile, uploadEndpoint], '从上传 Store 的 API 注入开始，跟踪队列启动、传输完成和后续解析状态轮询。', '练习任务状态机、AbortController、资源隔离与可测试的依赖注入。')

// 06. Untrusted Markdown and protected assets.
const botFile = file('frontend/src/views/chat/components/botmsg.vue', '流式回答中的 Markdown 在插入 DOM 前按策略消毒，延后加载鉴权资源。', '内容安全')
const securityFile = file('frontend/src/utils/security.ts', 'DOMPurify 策略钩子与受保护文件的鉴权图片水合。', '内容安全')
const purifyFile = file('frontend/src/utils/markdownDomPurify.ts', '限制 Markdown、KaTeX、Mermaid 的 HTML/SVG 标签、属性与 URL 协议。', '内容安全')
const protectedAccess = file('frontend/src/utils/protectedFileAccess.ts', '带鉴权的源文件访问策略，不把身份凭证拼入图片 URL。', '内容安全')
const sanitize = fn('frontend/src/utils/security.ts', 'sanitizeMarkdownHTML', 170, 186, '预处理受保护图片后在 DOMPurify 安全钩子和配置下清洗 HTML。', '内容安全')
const prerenderImage = fn('frontend/src/utils/security.ts', 'buildProtectedImageTag', 211, 230, '预渲染查 protectedFileBySource 的键仅是源 URL；与下方 URL+headers 请求键不是同一缓存边界，需审查鉴权上下文变化。', '内容安全')
const hydrate = fn('frontend/src/utils/security.ts', 'hydrateProtectedFileImages', 606, 724, '水合读取按 URL+headers 生成 requestKey 缓存；替换 DOM 前检查请求键仍匹配，另有 source-only 预渲染缓存。', '内容安全')
edge(botFile, sanitize); edge(botFile, hydrate); edge(sanitize, prerenderImage); edge(prerenderImage, hydrate, 'related'); edge(sanitize, purifyFile, 'depends_on'); edge(hydrate, protectedAccess, 'depends_on')
edge(botFile, securityFile, 'imports'); edge(securityFile, purifyFile, 'imports'); edge(securityFile, protectedAccess, 'imports')
category('frontend-safe-content', '06 前端 · 内容安全', '不可信模型输出与受保护图片分别处理；水合按 URL+headers 请求键缓存，但预渲染另按源 URL 复用，二者边界需审查。', [botFile, securityFile, purifyFile, protectedAccess], '从 botmsg 到 DOMPurify hooks、URL 白名单，再比较 buildProtectedImageTag 的 source-only 查询与 hydrateProtectedFileImages 的 requestKey，勿臆断已发生跨身份读取。', '区分 Markdown 消毒、水合鉴权和缓存身份键的适用边界。')

// 07. Multi-format preview and bundle boundaries.
const previewFile = file('frontend/src/components/document-preview.vue', 'DOCX/PDF/PPTX/XLSX 等不同格式预览，支持定位原文和按需加载重依赖。', '文档预览与构建')
const pdfPreviewFile = file('frontend/src/components/source-preview/PdfSourceViewer.vue', '独立 PDF 预览与来源定位组件，按需加载。', '文档预览与构建')
const viteFile = file('frontend/vite.config.ts', 'Vite 主页面/Embed 双入口、依赖拆包、PDF.js WASM 资源和独立预加载优化。', '文档预览与构建')
const embedFile = file('frontend/src/embed-main.ts', 'Embed iframe 拥有独立入口、路由和 i18n；不复用主应用首屏。', '文档预览与构建', 'moderate')
const pdfLoaderFile = file('frontend/src/components/source-preview/pdfjsLoader.ts', 'PDF.js 模块动态加载并设置独立 worker URL；每份文档自行管理 worker 生命周期。', '文档预览与构建')
const pdfLoader = fn('frontend/src/components/source-preview/pdfjsLoader.ts', 'loadPdfJs', 13, 24, '一次懒加载库及 worker URL，失败清掉缓存以便重试；不复用已销毁文档的 worker port。', '文档预览与构建')
const embedApiFile = file('frontend/src/api/embed/index.ts', '宿主消息只接受父窗口及已固定来源；敏感消息不对未知 origin 广播。', '文档预览与构建')
const embedBridgeFile = file('frontend/src/composables/useEmbedBridge.ts', 'Embed 启动时从 publish token 换短期 session token；生产环境禁止兑换失败后降级。', '文档预览与构建')
const trustedParent = fn('frontend/src/api/embed/index.ts', 'isTrustedParentMessage', 483, 496, '校验 event.source、标记和来源；从 referrer 或首个受信握手固定父页面 origin。', '文档预览与构建')
const postToParent = fn('frontend/src/api/embed/index.ts', 'postToParent', 505, 514, '未知目标 origin 丢弃敏感内容；仅 ready/bootstrap 等非敏感握手可以回退为通配目标。', '文档预览与构建')
const embedExchange = fn('frontend/src/api/embed/index.ts', 'exchangeEmbedSession', 299, 305, '携 publish token 调用兑换接口获得短期 session token。', '文档预览与构建')
const embedBootstrap = fn('frontend/src/composables/useEmbedBridge.ts', 'bootstrap', 172, 204, '已收到短期 session token 时直用；其他情况兑换 publish token，生产环境兑换异常拒绝降级。', '文档预览与构建')
const embedExchangeEndpoint = endpoint('POST', '/api/v1/embed/:channel_id/exchange', '后端只接受 publish token 兑换短期 Embed session token。', '文档预览与构建')
edge(previewFile, pdfPreviewFile, 'depends_on'); edge(pdfPreviewFile, pdfLoaderFile, 'imports'); edge(previewFile, viteFile, 'depends_on'); edge(viteFile, embedFile, 'configures'); edge(viteFile, bootstrapFile, 'configures')
edge(embedFile, embedBridgeFile, 'depends_on'); edge(embedBridgeFile, embedApiFile, 'imports'); edge(embedBootstrap, embedExchange); edge(embedExchange, embedExchangeEndpoint, 'routes'); edge(trustedParent, postToParent, 'related'); edge(pdfLoaderFile, viteFile, 'depends_on')
category('frontend-build', '07 前端 · 文档预览与构建', '预览格式隔离、PDF.js 按需加载与独立 worker；Embed 双入口还需宿主 origin 固定与 publish/session token 兑换。', [previewFile, pdfPreviewFile, pdfLoaderFile, viteFile, embedFile, embedApiFile, embedBridgeFile, embedExchangeEndpoint], '先追 PDF 懒加载与 worker 生命周期，再沿 Embed 的父窗口消息校验、敏感消息目标 origin 和 publish token 兑换阅读前后端契约。', '学习动态 import、宿主消息来源校验和生产环境短期 Embed 凭证 fail-closed。')

// 08. Localization and debt ratchets.
const localeFile = file('frontend/src/i18n/localeKeyAudit.ts', '扫描源码中的固定和动态国际化键，检查各语言缺失与消息编译错误。', '国际化与质量门禁')
const localeTest = file('frontend/src/i18n/localeKeyAudit.test.ts', '为语言包 key 审计和裁剪后回归提供测试。', '国际化与质量门禁', 'moderate')
const styleTest = file('frontend/src/assets/theme/styleGuard.test.mjs', '基线棘轮阻止硬编码样式、!important 和旧颜色继续增长。', '国际化与质量门禁', 'moderate')
const localeUsage = fn('frontend/src/i18n/localeKeyAudit.ts', 'collectI18nUsageFromSources', 295, 369, '扫描源码中的静态键、模板键与特殊动态前缀。', '国际化与质量门禁')
edge(localeUsage, localeTest, 'tested_by'); edge(styleTest, viteFile, 'related'); edge(localeFile, embedFile, 'related'); edge(localeFile, localeTest, 'tested_by'); edge(styleTest, localeTest, 'related')
category('frontend-quality', '08 前端 · 国际化与质量门禁', '源码键审计和样式技术债棘轮，把回归变为自动化检查。', [localeFile, localeTest, styleTest], '读 i18n 静态分析与动态键前缀，再看样式 guard 如何只允许债务计数下降。', '学习把跨页面约束变成测试，而非全靠人工检查。')

// 09. Ingestion and asynchronous processing.
const uploadHandlerFile = file('internal/handler/knowledge.go', '文件上传 Handler 校验请求并调用知识摄入服务。', '文档入库')
const createFile = file('internal/application/service/knowledge_create.go', '文件、知识记录与任务队列之间以 pending/failed 状态和补偿维持一致性。', '文档入库')
const taskFile = file('internal/router/task.go', 'Asynq 任务分流及 worker pool 容量配置。', '文档入库')
const processFile = file('internal/application/service/knowledge_process.go', '后台校验租户和任务代际，解析、分块、持久化后构建索引。', '文档入库')
const chunkerFile = file('internal/infrastructure/chunker/strategy.go', '分块策略与父子块切分，输入不合法时选择受控降级。', '文档入库')
const indexerFile = file('internal/application/service/retriever/keywords_vector_hybrid_indexer.go', '对索引输入分窗计算 embedding 并有界并发持久化。', '文档入库')
const attemptFile = file('internal/application/service/knowledge_span_tracker.go', '数据库 attempt 编号和 root span 心跳隔离重试，新的 attempt 关闭旧开放 span。', '文档入库')
const finalizeRepoFile = file('internal/application/repository/knowledge.go', '同一数据库事务执行 pending 子任务计数原子递减和带状态条件的最终晋升。', '文档入库')
const taskContainerFile = file('internal/container/container.go', '按 REDIS_ADDR 启动时选择 Asynq Redis 池或无 Redis Lite 的内存 SyncTaskExecutor；不是运行中 Redis 故障自动切换。', '文档入库')
const releaseSlotFile = file('internal/application/service/knowledge.go', '子任务收尾从取消请求分离并有界重试数据库 FinalizeSubtask，仍不承诺任务 exactly-once。', '文档入库')
const uploadHandler = fn('internal/handler/knowledge.go', 'CreateKnowledgeFromFile', 313, 441, '校验上传参数并进入服务层；请求侧需先通过 KB 写入权限。', '文档入库')
const createKnowledge = fn('internal/application/service/knowledge_create.go', 'createKnowledgeFromFile', 36, 305, '先保存文件，再落 pending 记录，最后投递文档任务；失败状态和清理弥补跨系统事务。', '文档入库')
const processDocument = fn('internal/application/service/knowledge_process.go', 'ProcessDocument', 3770, 4304, '处理 Asynq 文档任务，核验租户、KB、重试代际后调用解析/分块流程。', '文档入库')
const processChunks = fn('internal/application/service/knowledge_process.go', 'processChunks', 402, 960, '持久化分块并筛选可检索子块建索引；失败时清理索引并决定重试或终态。', '文档入库')
const split = fn('internal/infrastructure/chunker/strategy.go', 'Split', 34, 58, '按配置分块并验证，异常时回退策略；父子分块入口另由 SplitParentChild 实现。', '文档入库')
const splitParent = fn('internal/infrastructure/chunker/strategy.go', 'SplitParentChild', 135, 138, '先按较大 parent 分块，再为每个 parent 生成细粒度 child。', '文档入库')
const openAttempt = fn('internal/application/service/knowledge_span_tracker.go', 'OpenAttempt', 257, 310, 'DB 分配新的 attempt、关闭旧开放 span 并建立 root 心跳；过期任务不能再写新代际状态。', '文档入库')
const finalizeSubtask = fn('internal/application/repository/knowledge.go', 'FinalizeSubtask', 679, 705, '事务内扣减 pending_subtasks_count，再用 WHERE parse_status=finalizing 且计数为零条件晋升，非 exactly-once 执行保证。', '文档入库')
const releaseSlot = fn('internal/application/service/knowledge.go', 'releaseSubtaskSlot', 285, 305, '后处理子任务完毕时有界重试 repo.FinalizeSubtask，重试失败留给 housekeeping 恢复。', '文档入库')
const batchIndex = fn('internal/application/service/retriever/keywords_vector_hybrid_indexer.go', 'BatchIndex', 88, 153, '40×5 条数据为一窗，先算 embedding 后有界并发写入，控制内存峰值。', '文档入库')
const docTask = point('document:process', 'Asynq 后台文档任务：上传接口可快速返回，解析、索引异步执行。', '文档入库', 'resource')
edge(uploadEndpoint, uploadHandler, 'routes'); edge(uploadHandler, createKnowledge); edge(createKnowledge, docTask, 'triggers'); edge(taskFile, docTask, 'routes'); edge(docTask, processDocument, 'triggers'); edge(processDocument, split); edge(processDocument, processChunks); edge(processChunks, batchIndex)
edge(uploadHandlerFile, createFile, 'calls'); edge(createFile, docTask, 'triggers'); edge(taskFile, processFile, 'routes'); edge(processFile, chunkerFile, 'calls'); edge(processFile, indexerFile, 'calls')
edge(taskContainerFile, taskFile, 'configures'); edge(processDocument, openAttempt, 'calls'); edge(processDocument, splitParent, 'calls'); edge(processChunks, releaseSlot, 'related'); edge(releaseSlot, finalizeSubtask, 'calls'); edge(attemptFile, processFile, 'related'); edge(releaseSlotFile, finalizeRepoFile, 'calls')
category('backend-ingestion', '09 后端 · 文档入库', '存储/DB/队列跨系统补偿、attempt 代际与心跳、父块只入库子块索引、最终子任务数据库条件晋升；Lite 仅在启动时无 Redis 时选内存执行器。', [uploadHandlerFile, createFile, taskFile, taskContainerFile, attemptFile, processFile, chunkerFile, releaseSlotFile, finalizeRepoFile, indexerFile, docTask], '沿上传到后台核对 attempt 过期保护：父块入库但不进向量索引，只有子文本块可检索；再查 finalizing 计数和 Redis/无 Redis 启动分支。', '重点理解跨系统补偿与条件更新，不把后台任务称为 exactly-once，也不把 Lite 启动分支当 Redis 宕机自动降级。')

// 10. Hybrid retrieval and reranking are distinct stages.
const searchFile = file('internal/application/service/knowledgebase_search.go', '逐 KB 授权与模型一致性检查，多索引分组召回和融合。', '混合检索与重排')
const fusionFile = file('internal/application/service/knowledgebase_search_fusion.go', '纯向量去重保留原分；纯关键词仅当列表最大 BM25 >1 才缩放；双路按各列表排名加权 RRF 融合。', '混合检索与重排')
const rerankServiceFile = file('internal/application/service/knowledgebase_search_rerank.go', '扩大候选后调用重排阶段，并补齐父块与相邻上下文。', '混合检索与重排')
const rerankFile = file('internal/reranking/rerank.go', 'rerank 模型失败时保留召回顺序；阈值、复合分数和 MMR 控制结果。', '混合检索与重排')
const retrieveFile = file('internal/types/interfaces/retriever.go', '检索/索引接口隔离算法与 PostgreSQL、SQLite、ES 等持久化实现。', '混合检索与重排')
const hybrid = fn('internal/application/service/knowledgebase_search.go', 'hybridSearchCandidates', 212, 384, '逐 KB 授权与 embedding identity 校验，分组并发召回后进入融合。', '混合检索与重排')
const fusion = fn('internal/application/service/knowledgebase_search_fusion.go', 'fuseOrDeduplicate', 58, 84, '仅向量保留原分；仅关键词逐列表对 BM25 最大值大于 1 的输入缩放；双路加权 RRF。', '混合检索与重排')
const rescaleBM25 = fn('internal/application/service/knowledgebase_search_fusion.go', 'rescaleUnboundedScores', 125, 154, '当有限最大分 <=1 时不改原分；仅超过 1 才除以该列表最大值，避免 BM25 压平重排复合分。', '混合检索与重排')
const rrf = fn('internal/application/service/knowledgebase_search_fusion.go', 'fuseWithRRF', 170, 219, '分别取检索列表的排名，计算加权 RRF 并归一到可比较分数。', '混合检索与重排')
const rerankService = fn('internal/application/service/knowledgebase_search_rerank.go', 'HybridSearchWithRerank', 64, 152, '独立于 HybridSearch 的重排入口：扩候选、重排并富化上下文。', '混合检索与重排')
const rerank = fn('internal/reranking/rerank.go', 'Rerank', 111, 231, '模型失败回退原召回顺序；阈值、TopK 与 MMR 选择并保留图像结果。', '混合检索与重排')
const rerankCandidates = fn('internal/application/service/knowledgebase_search_rerank.go', 'rerankCandidates', 157, 198, '解析租户 rerank 模型，并将候选结果传入独立重排器。', '混合检索与重排')
edge(hybrid, fusion); edge(fusion, rescaleBM25, 'calls'); edge(fusion, rrf); edge(rerankService, hybrid); edge(rerankService, rerankCandidates); edge(rerankCandidates, rerank); edge(searchFile, retrieveFile, 'related')
edge(searchFile, fusionFile, 'calls'); edge(rerankServiceFile, searchFile, 'calls'); edge(rerankServiceFile, rerankFile, 'calls')
category('backend-retrieval', '10 后端 · 混合检索与重排', '先授权与模型一致性验证；纯向量保留分数，纯关键词按最大值条件缩放，双路按列表名次 RRF；rerank 独立可降级。', [searchFile, fusionFile, rerankServiceFile, rerankFile, retrieveFile], '从 HybridSearchWithRerank 追候选池及逐 KB 授权，对照三种融合分支及父块/相邻块富化，再看模型重排失败的回退。', '分清原始向量分、条件归一的 BM25、跨列表 RRF、rerank 和 MMR。')

// 11. Agent loop, read concurrency and write barriers.
const sessionAgentFile = file('internal/application/service/session_agent_qa.go', '会话 Agent 回合从历史恢复工具状态，装配引擎并执行/恢复。', 'Agent 执行')
const engineFile = file('internal/agent/engine.go', 'ReAct 循环包含 token 预算、轮数限制、取消和工具调用防死循环机制。', 'Agent 执行')
const actFile = file('internal/agent/act.go', '拒绝截断参数；有限并行内建只读工具，写入/未知/MCP 工具形成屏障。', 'Agent 执行')
const policyFile = file('internal/agent/tools/execution_policy.go', '显式可并发内建读取白名单，默认串行以维护工具的执行顺序。', 'Agent 执行')
const ragQAFile = file('internal/application/service/session_knowledge_qa.go', '按实际 KB/搜索范围和 web/分析配置拼装纯聊或 RAG 阶段，而非固定管线。', 'Agent 执行')
const pipelineFile = file('internal/application/service/chat_pipeline/chat_pipeline.go', '按事件类型注册插件，并以链式 OnEvent/next 组合阶段处理器。', 'Agent 执行')
const historyFile = file('internal/application/service/agent_history.go', 'ReAct 每回合从 DB 翻页恢复消息，优先加载持久 checkpoint 摘要，再按 token 预算选完整回合。', 'Agent 执行')
const compactionFile = file('internal/agent/compaction/compactor.go', '压缩较早对话并产出 checkpoint；引擎另行持久化，摘要失败时使用有预算的原文归档降级，不保证零丢失。', 'Agent 执行')
const agentService = fn('internal/application/service/session_agent_qa.go', 'AgentQA', 46, 439, '从会话历史恢复工具上下文，校验访问范围并创建 ReAct 引擎。', 'Agent 执行')
const executeLoop = fn('internal/agent/engine.go', 'executeLoop', 705, 836, '循环思考-执行-观察，处理取消、轮数预算与最终回答合成。', 'Agent 执行')
const toolCalls = fn('internal/agent/act.go', 'executeToolCalls', 228, 264, '模型输出被截断时拒绝所有可能不完整的工具参数。', 'Agent 执行')
const parallelTools = fn('internal/agent/act.go', 'executeToolCallsParallel', 297, 355, '只并行显式白名单中的只读工具；限并发 8，屏障隔离写操作，按模型序提交结果。', 'Agent 执行')
const buildRAG = fn('internal/application/service/session_knowledge_qa.go', 'KnowledgeQA', 24, 258, '无 KB 且无 web search 走纯聊；否则按历史、记忆、查询理解、搜索、重排、可选 Web/分析、合并与流式回答动态拼装。', 'Agent 执行')
const registerPipeline = fn('internal/application/service/chat_pipeline/chat_pipeline.go', 'Register', 40, 51, '按插件 ActivationEvents 注册处理链，执行按事件类型触发。', 'Agent 执行')
const loadHistory = fn('internal/application/service/agent_history.go', 'LoadAgentHistory', 72, 157, 'DB 是消息源，倒序按 200 页/最多 5000 行选完整回合和 token 预算；checkpoint 之后的过量旧回合可能被丢弃。', 'Agent 执行')
const compactHistory = fn('internal/agent/compaction/compactor.go', 'Compact', 112, 141, '保留近期回合并压缩旧历史为 checkpoint；摘要失败时用有预算原文归档兜底。', 'Agent 执行')
edge(agentService, executeLoop); edge(executeLoop, toolCalls); edge(toolCalls, parallelTools); edge(parallelTools, policyFile, 'depends_on')
edge(sessionAgentFile, engineFile, 'calls'); edge(engineFile, actFile, 'calls'); edge(actFile, policyFile, 'imports')
edge(agentService, loadHistory, 'calls'); edge(loadHistory, compactHistory, 'related'); edge(engineFile, compactHistory, 'calls'); edge(buildRAG, registerPipeline, 'depends_on'); edge(buildRAG, hybrid, 'related'); edge(ragQAFile, pipelineFile, 'depends_on'); edge(sessionAgentFile, historyFile, 'calls'); edge(engineFile, compactionFile, 'calls')
category('backend-agent', '11 后端 · Agent 执行', 'ReAct 历史从 DB 重放并用持久 checkpoint 控 token；另有按知识范围、Web 与分析选项动态装配的事件插件 RAG 管线。', [sessionAgentFile, historyFile, compactionFile, engineFile, actFile, policyFile, ragQAFile, pipelineFile], '沿 AgentQA 的 DB 历史回放、压缩与工具屏障，再比较 KnowledgeQA 纯聊/RAG 两个阶段列表及事件插件链。', '区分有预算历史恢复与无损保证、模型工具意图与副作用授权、动态阶段开关与固定执行顺序。')

// 12. Server stream lifecycle and durable completion ordering.
const qaFile = file('internal/handler/session/qa.go', '接收聊天请求，分离 SSE 连接与后台生成，并协调生成结束后的消息落库。', '流式续传与一致性')
const eventHandlerFile = file('internal/handler/session/agent_stream_handler.go', '把内部 Agent 事件映射到流，暂存 complete 直到消息已保存。', '流式续传与一致性')
const redisStreamFile = file('internal/stream/redis_manager.go', '用 Redis 列表保存流事件和 offset 回放，SetNX/CAS 维护活跃回合标记。', '流式续传与一致性')
const continueFile = file('internal/handler/session/stream.go', '验证消息归属并按 offset 回放事件，独立于生成请求连接。', '流式续传与一致性')
const resourceModesFile = file('internal/handler/session/resource_urls.go', '按请求 resource_urls 选择文件 handle 或公开 URL；SSE 对跨帧引用增加 holdback。', '流式续传与一致性')
const detach = fn('internal/handler/session/qa.go', 'setupSSEStream', 779, 912, '建立独立运行上下文和 EventBus，HTTP 断线不取消生成，但执行租约失效会传播。', '流式续传与一致性')
const complete = fn('internal/handler/session/qa.go', 'completeStreamAssistantMessage', 2212, 2245, '只有 UpdateMessage 成功后才发布 complete，避免客户端误认为持久化完成。', '流式续传与一致性')
const publish = fn('internal/handler/session/agent_stream_handler.go', 'publishCompletion', 1105, 1129, '收到持久化成功信号后向事件流发布暂存的完成帧。', '流式续传与一致性')
const appendEvent = fn('internal/stream/redis_manager.go', 'AppendEvent', 72, 102, 'RPUSH 事件并刷新 TTL，维持活跃回合租约。', '流式续传与一致性')
const getEvents = fn('internal/stream/redis_manager.go', 'GetEvents', 114, 156, 'LRANGE 从 offset 读取增量事件供 SSE 断线续传。', '流式续传与一致性')
const continueHandler = fn('internal/handler/session/stream.go', 'ContinueStream', 37, 229, '校验可见会话及 assistant 消息后按偏移回放并维持心跳。', '流式续传与一致性')
const resolveResourceMode = fn('internal/handler/session/resource_urls.go', 'resolveResourceRewriter', 59, 66, '进入 SSE 前解析 handle/public/default 模式及授权，非法参数可用普通 JSON 错误拒绝。', '流式续传与一致性')
const resolveStreamMode = fn('internal/handler/session/resource_urls.go', 'resolveStreamRewriter', 72, 78, '对逐帧拆开的引用添加 holdback，避免把半截 file:// 引用发给客户端。', '流式续传与一致性')
edge(agentChatEndpoint, qaFile, 'routes'); edge(qaFile, agentService); edge(qaFile, detach); edge(qaFile, complete); edge(eventHandlerFile, appendEvent); edge(complete, publish); edge(publish, appendEvent); edge(continueEndpoint, continueHandler, 'routes'); edge(continueHandler, getEvents)
edge(qaFile, eventHandlerFile, 'calls'); edge(eventHandlerFile, redisStreamFile, 'calls'); edge(continueFile, redisStreamFile, 'reads_from')
edge(qaFile, resolveStreamMode, 'calls'); edge(continueFile, resolveStreamMode, 'calls'); edge(resolveStreamMode, resolveResourceMode, 'calls'); edge(resourceModesFile, eventHandlerFile, 'related')
category('backend-stream', '12 后端 · 流式续传与一致性', '生成生命周期、HTTP SSE、Redis 回放与落库完成顺序分别承担责任；resource_urls handle/public 模式和 SSE 跨帧引用在出帧前处理。', [qaFile, eventHandlerFile, redisStreamFile, continueFile, resourceModesFile], '沿 agent-chat 与 continue-stream 看 offset 回放、落库后 complete，再追请求模式授权及拆帧引用 holdback。', '理解断线不是停止、模式校验早于 SSE 头、不能将半截资源引用直接写入流。')

// 13. Connectors and resumable checkpoints.
const connectorFile = file('internal/datasource/connector.go', '标准连接器、流式 Emit/Checkpoint 接口，支持分页和恢复。', '数据源同步')
const datasourceFile = file('internal/application/service/datasource_service.go', '全量/增量同步，逐项 ingest 后保存游标与运行统计。', '数据源同步')
const processSync = fn('internal/application/service/datasource_service.go', 'ProcessSync', 628, 859, '处理 Asynq 同步任务，验证数据源与 KB 归属，分流流式/批量实现。', '数据源同步')
const syncStream = fn('internal/application/service/datasource_service.go', 'processSyncStreaming', 1190, 1261, '逐条摄入并在页边界 checkpoint，失败时保留已持久化游标供重试。', '数据源同步')
const emit = fn('internal/application/service/datasource_service.go', 'Emit', 1118, 1133, '先摄入 fetched item；发生不可忽略错误即中断，禁止游标越过失败项。', '数据源同步')
const checkpoint = fn('internal/application/service/datasource_service.go', 'Checkpoint', 1138, 1165, '摄入成功后落盘同步 cursor 和进度计数，以支持崩溃后恢复。', '数据源同步')
const syncTask = point('datasource:sync', 'Asynq 数据源同步任务，维护游标并隔离长运行的外部 API 工作。', '数据源同步', 'resource')
const applyItem = fn('internal/application/service/datasource_service.go', 'applyFetchedItem', 913, 1026, '根据 fetched item 状态路由到删除、跳过或摄入逻辑，返回可忽略失败标记。', '数据源同步')
const ingestItem = fn('internal/application/service/datasource_service.go', 'ingestItem', 1432, 1599, '根据 datasource_id/external_id 幂等新建或替换知识，区分文件和 URL 来源。', '数据源同步')
edge(taskFile, syncTask, 'routes'); edge(syncTask, processSync, 'triggers'); edge(processSync, syncStream); edge(syncStream, connectorFile, 'depends_on'); edge(connectorFile, emit, 'calls'); edge(connectorFile, checkpoint, 'calls'); edge(emit, applyItem); edge(applyItem, ingestItem); edge(ingestItem, createKnowledge, 'triggers'); edge(emit, checkpoint, 'triggers')
edge(datasourceFile, connectorFile, 'depends_on'); edge(datasourceFile, syncTask, 'triggers')
category('backend-connectors', '13 后端 · 数据源同步', '外部连接器协议、逐项处理与可恢复 checkpoint。', [datasourceFile, connectorFile, syncTask], '跟踪一个外部资源经过 Emit 入库再到 Checkpoint：失败时不能提前提交游标。', '学习长任务的幂等游标、内存上界、分页与外部系统错误处理。')

// 14. Background worker isolation and tests.
const queueRules = file('internal/types/task.go', '声明任务类型与各 worker pool 的队列权重；共享池只借用配置允许的任务类型。', '后台任务隔离')
const wikiFile = file('internal/application/service/wiki_ingest.go', '初始 ingest 先持久化 pending op 再触发；后续 finalize 行另行写入，失败可无行恢复；超预算写死信只是尝试。', '后台任务隔离')
const wikiPostFile = file('internal/application/service/knowledge_post_process.go', '初始 Wiki 后处理使用事务同时提交 finalizing 槽位和 ingest pending 行，再尝试易失触发。', '后台任务隔离')
const pendingFile = file('internal/application/repository/task_queue.go', '初始 Wiki finalizing+pending 同事务；标准模式按 dedup_key 认领，Lite PeekBatch 排序为 fail_count,id。', '后台任务隔离')
const wikiBatchFile = file('internal/application/service/wiki_ingest_batch.go', '标准模式 claim DB 操作，Lite 模式 peek；每 KB 限并发，但 Lite 倒扫去重并非按最新 ID。', '后台任务隔离')
const wikiRecoveryFile = file('internal/container/recover_pending_wiki_tasks.go', '服务启动在 handler 注册后从持久 pending op 重建每条 Wiki 队列 lane 的触发任务。', '后台任务隔离')
const housekeepingFile = file('internal/application/service/knowledge_housekeeping.go', '结合 span 心跳与排队任务判断假卡住，有限期保护 Wiki 待处理操作并重触发丢失的任务。', '后台任务隔离')
const enqueueWiki = fn('internal/application/service/wiki_ingest.go', 'EnqueueWikiIngest', 527, 557, '先写 DB pending op，再尝试异步触发；若触发失败仍保留待处理行供重建。', '后台任务隔离')
const seedWiki = fn('internal/application/repository/task_queue.go', 'SeedKnowledgeFinalizingWithPendingOp', 131, 189, '初始 Wiki 入库将 finalizing 计数和 ingest pending op 在同一事务提交，使失去触发器的操作可在启动时恢复。', '后台任务隔离')
const peekWiki = fn('internal/application/repository/task_queue.go', 'PeekBatch', 203, 223, 'Lite 按 fail_count,id 排序读取，不保证同文档最后读出的操作拥有最新 id。', '后台任务隔离')
const decodeWiki = fn('internal/application/service/wiki_ingest.go', 'decodePendingRows', 1216, 1271, '按返回行顺序倒扫取每个知识的最后操作；Lite 重试排序可能让旧 ingest 覆盖较新 retract，不能概括为按最新 id。', '后台任务隔离')
const enqueueFinalize = fn('internal/application/service/wiki_ingest.go', 'enqueueFinalizeRow', 794, 801, '后续 finalize 行独立写入；写入失败仅告警并返回 false，此时没有 pending 行供启动补触发。', '后台任务隔离')
const requeueWiki = fn('internal/application/service/wiki_ingest.go', 'requeueFailedOps', 1327, 1392, '达到失败上限时尝试写死信，再删 pending 行；死信插入失败仍可能执行删除，不能承诺已归档。', '后台任务隔离')
const claimWiki = fn('internal/application/repository/task_queue.go', 'ClaimBatch', 260, 361, '按去重键领取可认领行，屏蔽新鲜 claim 并回收过期 claim；不是 exactly-once。', '后台任务隔离')
const recoverWiki = fn('internal/container/recover_pending_wiki_tasks.go', 'recoverPendingWikiTasks', 32, 122, '启动时丢弃已删除 KB/租户操作，并按存量 lane 恢复触发和语言配置。', '后台任务隔离')
const sweepKnowledge = fn('internal/application/service/knowledge_housekeeping.go', 'runSweep', 157, 231, '结合 span 心跳和未消费任务避免误杀运行中的摄入；Wiki 持久操作仅有限保护并尝试补触发。', '后台任务隔离')
const queueConfig = point('有界队列与隔离 worker', '核心解析、后处理、增强、维护、Wiki 各有保底容量，共享池借用空闲处理能力。', '后台任务隔离', 'pipeline')
edge(taskFile, queueConfig, 'configures'); edge(queueRules, queueConfig, 'configures'); edge(queueConfig, docTask, 'triggers'); edge(queueConfig, syncTask, 'triggers')
edge(enqueueWiki, pendingFile, 'writes_to'); edge(wikiPostFile, seedWiki, 'calls'); edge(seedWiki, pendingFile, 'writes_to'); edge(pendingFile, claimWiki, 'contains'); edge(wikiFile, wikiBatchFile, 'related'); edge(wikiBatchFile, claimWiki, 'calls'); edge(wikiBatchFile, peekWiki, 'calls'); edge(peekWiki, decodeWiki, 'related'); edge(wikiFile, enqueueFinalize, 'calls'); edge(wikiFile, requeueWiki, 'calls'); edge(wikiRecoveryFile, pendingFile, 'reads_from'); edge(wikiRecoveryFile, enqueueWiki, 'related'); edge(sweepKnowledge, wikiRecoveryFile, 'related'); edge(housekeepingFile, pendingFile, 'reads_from'); edge(queueConfig, wikiFile, 'triggers')
category('backend-workers', '14 后端 · 后台任务隔离', '按负载分池；初始 Wiki ingest 的 finalizing 槽位与 pending 行同事务，易失触发可由存量行恢复；后续 finalize 行独立写入，失败时可能无行可恢复。', [queueRules, queueConfig, wikiPostFile, wikiFile, pendingFile, wikiBatchFile, wikiRecoveryFile, housekeepingFile], '从初始事务交接到 Wiki claim/peek、启动补触发；特别比对 Lite 的 fail_count,id 排序和按返回顺序倒扫去重，后续 finalize 行与耗尽重试的死信处理边界。', 'Lite 重试时旧 ingest 可压过较新 retract；死信只是尝试，归档失败仍可能删除 pending 行。勿概称 Wiki 全程可恢复或 exactly-once。')

// 15. Security boundaries that apply to every workload.
const gateFile = file('internal/middleware/api_key_gate.go', 'API Key 采用与 JWT/RBAC 分离的路由策略，未登记端点默认拒绝。', '多租户与出站安全')
const routeFile = file('internal/router/routes_knowledge.go', '上传路由串联 API Key ingest、KB owner/Admin 和 Editor grant 三道入口门禁。', '多租户与出站安全')
const routeAccessFile = file('internal/router/rbac.go', 'KBAccessWrite 用 Editor 门槛组装路由中间件，真正授权在 RequireKBAccess。', '多租户与出站安全')
const middlewareAccessFile = file('internal/middleware/kb_access.go', '路由中间件按 KB 共享 grant 授权并写入执行上下文。', '多租户与出站安全')
const kbWriteFile = file('internal/application/access/kb_write.go', 'KB 写入需明确授权，后台 worker 仅能为已核实归属的单个 KB 取得 task grant。', '多租户与出站安全')
const kbAccessFile = file('internal/application/service/knowledgebase_access.go', '业务操作通过 requireKBWrite 进入领域授权，再切换到知识库所属租户执行。', '多租户与出站安全')
const ssrfFile = file('internal/utils/security.go', '对出站 URL、重定向、DNS 解析与拨号目标做分层 SSRF 校验。', '多租户与出站安全')
const resolveKBFile = file('internal/application/access/knowledgebase.go', '保留认证调用者身份与资源所属租户的区别；KB 共享与特定共享 Agent grant 仅在实际可见时授予。', '多租户与出站安全')
const shareAgentFile = file('internal/application/service/agent_share.go', '校验 Agent 的源租户和目标租户共享关系后读取指定 Agent；未实现 viewer 对工具能力的额外硬限制。', '多租户与出站安全')
const embedAuthFile = file('internal/middleware/embed_auth.go', '服务端校验 Embed token、频道配额；API Origin 同源例外/跨源 allowlist，与限制 iframe 宿主的 HTML CSP frame-ancestors 是两层不同边界。', '多租户与出站安全')
const embedHandlerFile = file('internal/handler/embed_channel.go', '仅 publish token 可兑换短期 Embed session token，拒绝用短期 token 无限续签。', '多租户与出站安全')
const gate = fn('internal/middleware/api_key_gate.go', 'authorize', 130, 153, '机器身份需显式匹配路由策略和 capability，未注册路由默认拒绝。', '多租户与出站安全')
const routeRegister = fn('internal/router/routes_knowledge.go', 'RegisterKnowledgeRoutes', 67, 84, 'POST /knowledge/file 组合机器身份、owner/Admin 与 KB Editor 写权限。', '多租户与出站安全')
const routeGuard = fn('internal/router/rbac.go', 'KBAccessWrite', 571, 580, '构造要求 Editor 权限的 KB 写入中间件。', '多租户与出站安全')
const accessGuard = fn('internal/middleware/kb_access.go', 'RequireKBAccess', 184, 244, '验证 API Key KB 白名单并解析 KB grant，注入执行租户上下文。', '多租户与出站安全')
const kbWrite = fn('internal/application/access/kb_write.go', 'RequireKBWrite', 12, 24, '检查 API Key ingest 能力和 KB Editor 授权，租户身份本身不足以授予写权限。', '多租户与出站安全')
const requireKB = fn('internal/application/service/knowledgebase_access.go', 'requireKBWrite', 74, 79, '将领域写入授权和所属租户执行上下文收敛到共享入口。', '多租户与出站安全')
const taskGrant = fn('internal/application/access/kb_write.go', 'WithKBTaskWrite', 31, 45, 'worker 只能为 tenant 归属匹配的单个 KB 建立写入 grant。', '多租户与出站安全')
const ssrfURL = fn('internal/utils/security.go', 'ValidateURLForSSRF', 1332, 1376, '验证目标 URL 与域名/IP 出站策略。', '多租户与出站安全')
const ssrfDial = fn('internal/utils/security.go', 'SSRFSafeDialContext', 862, 937, '在拨号阶段验证解析后的 IP，防止仅在输入端做 SSRF 校验。', '多租户与出站安全')
const resolveSharedKB = fn('internal/application/access/knowledgebase.go', 'ResolveKB', 95, 156, '逐 KB 校验 API key、所属/组织共享；只有 viewer 读取可经 Agent 共享兜底，显式 agent 不回退别的 agent。', '多租户与出站安全')
const sharedAgent = fn('internal/application/service/agent_share.go', 'GetSharedAgentForTenant', 513, 562, '先查目标租户对指定源 Agent 的共享记录，再以真实源租户取 Agent。', '多租户与出站安全')
const embedAuth = fn('internal/middleware/embed_auth.go', 'EmbedAuth', 74, 185, '校验短期/发布 token、channel 及配额；API 来源会经同源例外或跨源 allowlist 检查，不代替 HTML frame-ancestors。', '多租户与出站安全')
const embedAllowed = fn('internal/middleware/embed_auth.go', 'embedRequestOriginAllowed', 211, 238, '无可嵌域时拒绝；同源 iframe 文档的 API 请求可按 Fetch Metadata/transport origin 放行，跨域 API 比对频道 allowlist；iframe 宿主单由 CSP 约束。', '多租户与出站安全')
const exchangeHandler = fn('internal/handler/embed_channel.go', 'ExchangeEmbedSession', 297, 329, '仅长效 publish token 可签发有期限 session token，短期 token 不可兑换自身。', '多租户与出站安全')
edge(uploadEndpoint, routeRegister, 'routes'); edge(routeRegister, uploadHandler, 'routes'); edge(routeRegister, gate, 'validates'); edge(routeRegister, routeGuard); edge(routeGuard, accessGuard); edge(accessGuard, uploadHandler, 'validates'); edge(requireKB, kbWrite); edge(uploadHandler, kbWrite, 'validates'); edge(processDocument, taskGrant, 'calls'); edge(processSync, taskGrant, 'calls'); edge(hybrid, kbAccessFile, 'related'); edge(processDocument, ssrfURL, 'validates'); edge(ssrfURL, ssrfDial, 'depends_on')
edge(routeFile, gateFile, 'configures'); edge(routeFile, routeAccessFile, 'calls'); edge(routeAccessFile, middlewareAccessFile, 'calls'); edge(middlewareAccessFile, kbWriteFile, 'related'); edge(kbAccessFile, kbWriteFile, 'calls'); edge(ssrfFile, gateFile, 'related')
edge(resolveSharedKB, sharedAgent, 'validates'); edge(resolveKBFile, shareAgentFile, 'depends_on'); edge(hybrid, resolveSharedKB, 'related'); edge(embedExchangeEndpoint, embedAuth, 'validates'); edge(embedAuth, embedAllowed, 'calls'); edge(embedAuth, exchangeHandler, 'validates'); edge(embedExchangeEndpoint, exchangeHandler, 'routes'); edge(embedHandlerFile, embedAuthFile, 'depends_on')
category('backend-security', '15 后端 · 多租户与出站安全', 'API Key、KB grant 与执行租户分开校验；共享 Agent 的来源租户按实际共享解析，Embed 令牌/同源 API 例外/跨域 API 白名单/频道配额由服务端校验，iframe 宿主由 CSP frame-ancestors 约束；出站防 SSRF。', [routeFile, routeAccessFile, middlewareAccessFile, gateFile, kbWriteFile, kbAccessFile, resolveKBFile, shareAgentFile, embedAuthFile, embedHandlerFile, ssrfFile], '从 KB 写 grant 和共享 Agent 的 viewer-only 读取权限，到 Embed publish/session 兑换、HTML CSP 宿主约束与后端 API 同源例外/跨域 allowlist，再看拨号 SSRF；调用者身份不因资源所属租户改变。', '勿把 Agent 共享 viewer 权限当成已经约束所有工具写入，或把前端 origin 校验当服务端授权。')

// Cross-feature links are intentionally limited to verifiable data/control hand-offs.
edge(requestFile, streamFile, 'related')
edge(uploadEndpoint, createFile, 'triggers')
edge(batchIndex, searchFile, 'related')
edge(rerankService, sessionAgentFile, 'related')
edge(executeLoop, eventHandlerFile, 'publishes')
edge(appendEvent, getEvents, 'related')
edge(chatStart, continueHandler, 'related')
edge(checkpoint, syncTask, 'related')

for (const item of edges) {
  if (!ids.has(item.source) || !ids.has(item.target)) throw new Error(`dangling edge ${item.source} -> ${item.target}`)
}
const assigned = new Set()
for (const layer of layers) {
  for (const id of layer.nodeIds) {
    if (!ids.has(id)) throw new Error(`missing layer node ${id}`)
    if (assigned.has(id)) throw new Error(`duplicate layer assignment ${id}`)
    assigned.add(id)
  }
}
for (const node of nodes) {
  if (['file', 'config', 'endpoint', 'pipeline', 'resource'].includes(node.type) && !assigned.has(node.id)) throw new Error(`unassigned visible node ${node.id}`)
}
const graph = {
  version: '1.0.0',
  project: {
    name: 'WeKnora 前后端亮点学习图',
    description: '按十五个前后端技术亮点分类的代码学习导航图；聚焦可核实的调用、依赖、安全与故障恢复链路。',
    languages: ['TypeScript', 'Vue', 'Go'],
    frameworks: ['Vue 3', 'Pinia', 'Vue Router', 'Vite', 'Gin', 'Asynq', 'Redis', 'GORM'],
    analyzedAt: new Date().toISOString(),
    gitCommitHash: commit,
  },
  nodes, edges, layers, tour,
}
fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ graphPath, nodes: nodes.length, edges: edges.length, layers: layers.length, tour: tour.length }, null, 2))
