# WeKnora 前后端项目学习计划

> 适用情况：项目已经成功启动；工作日每天约 3～4 小时，周六、周日每天约 6～8 小时。
>
> 总目标：不是读完仓库里的所有文件，而是能够独立追踪主要功能、定位问题、完成前后端修改，并理解 WeKnora 的文档入库、RAG（检索增强生成）和 Agent（智能体）主流程。

---

## 一、学习完成标准

完成本计划后，应能做到：

- 能解释浏览器、Vue 前端、Gin 后端、PostgreSQL、Redis 和 docreader（文档解析服务）的关系。
- 能从一个页面操作出发，追踪到 API（应用程序接口）、Router（路由）、Middleware（中间件）、Handler（请求处理层）、Service（业务服务层）、Repository（数据访问层）和 Database（数据库）。
- 能找到一个页面的 Route（前端路由）、View（页面）、Component（组件）、Store（状态仓库）、Composable（可复用逻辑）及 API 请求。
- 能看懂一次文档上传如何经历保存、异步任务、解析、分块、向量化和入库。
- 能解释一次 RAG 问答如何经历检索、重排序、上下文组装、大模型调用和流式返回。
- 能解释 Agent 如何经历 Think（思考）、Act（行动/工具调用）、Observe（观察工具结果）和继续推理。
- 能独立完成至少两个小型前后端功能修改，并运行对应检查。
- 遇到报错时，能判断问题更可能出在前端、后端、数据库、Redis、模型服务还是文档解析服务。

---

## 二、先建立项目地图

### 2.1 核心运行结构

```text
浏览器
  ↓ HTTP / SSE（服务器推送事件）
frontend（Vue 前端）
  ↓ /api 代理
app（Gin Go 主后端）
  ├─ PostgreSQL：业务数据、关键词检索、向量数据
  ├─ Redis：异步任务、流状态、发布订阅和限流
  ├─ docreader：Python + gRPC 文档解析服务
  ├─ LLM Provider：大语言模型、Embedding、Rerank
  └─ 可选服务：Neo4j、MinIO、Qdrant、SearXNG 等
```

### 2.2 前端重点目录

| 路径 | 英文（中文名称） | 作用 |
|---|---|---|
| `frontend/src/main.ts` | Entry（应用入口） | 创建 Vue 应用并安装 Router、Pinia 等插件 |
| `frontend/src/App.vue` | Root Component（根组件） | 前端最顶层组件 |
| `frontend/src/router/` | Router（前端路由） | 决定不同网址显示哪个页面 |
| `frontend/src/views/` | View（页面） | 登录、知识库、聊天、设置、Agent 等主要页面 |
| `frontend/src/components/` | Component（组件） | 输入框、弹窗、引用卡片等可复用界面 |
| `frontend/src/api/` | API Client（接口请求层） | 封装向后端发送的请求 |
| `frontend/src/stores/` | Store（状态仓库） | 使用 Pinia 保存跨组件共享状态 |
| `frontend/src/composables/` | Composable（可复用逻辑） | 封装状态、监听和副作用等逻辑 |
| `frontend/src/types/` | Type Definition（类型定义） | 描述 TypeScript 数据结构 |
| `frontend/src/utils/` | Utility（工具函数） | 通用数据处理逻辑 |

### 2.3 后端重点目录

| 路径 | 英文（中文名称） | 作用 |
|---|---|---|
| `cmd/server/` | Entry（服务入口） | 启动后端、监听端口、处理退出信号 |
| `internal/router/` | Router（路由层） | 把 HTTP 地址映射到 Handler |
| `internal/middleware/` | Middleware（中间件） | 认证、日志、权限、异常恢复、限流等公共处理 |
| `internal/handler/` | Handler（请求处理层） | 读取参数、调用 Service、返回响应 |
| `internal/application/service/` | Service（业务服务层） | 实现知识库、文档、会话和 Agent 等业务流程 |
| `internal/application/repository/` | Repository（数据访问层） | 使用 GORM 读写数据库和检索引擎 |
| `internal/types/` | Domain Model（领域模型） | 数据库实体、枚举、接口与上下文类型 |
| `internal/types/interfaces/` | Interface（接口定义） | 约束 Service、Repository 等模块的能力 |
| `internal/container/` | Dependency Injection（依赖注入） | 使用 dig 组装数据库、Service、Handler 和 Router |
| `internal/infrastructure/` | Infrastructure（基础设施适配层） | docreader、网络搜索等外部系统适配 |
| `internal/models/` | Model Adapter（模型适配层） | LLM、Embedding、Rerank 等模型厂商接入 |
| `internal/stream/` | Stream（流管理） | 管理聊天 SSE 流式输出 |
| `internal/agent/` | Agent Engine（智能体引擎） | 工具调用、权限、执行和多步推理 |

### 2.4 一条普通接口链路

```text
前端页面
→ API Client（接口请求代码）
→ Router（后端路由）
→ Middleware（认证和权限检查）
→ Handler（读取参数并返回响应）
→ Service（执行业务规则）
→ Repository（读写数据）
→ PostgreSQL（数据库）
```

不要背这条链。每次只问：当前代码在链路的哪一层，它收到什么，又把什么交给下一层？

---

## 三、每天的时间分配

### 工作日：3～4 小时

- 60 分钟：前端页面、组件、API 或状态管理。
- 90 分钟：后端路由、Handler、Service 或 Repository。
- 30～45 分钟：实际操作、断点、日志、Network（网络请求）面板或数据库验证。
- 15～30 分钟：用中文整理流程图和术语。

如果当天知识点较难，可以减少阅读范围，但必须保留运行验证和笔记。

### 周末：6～8 小时

- 1.5～2 小时：整理本周知识和补相关基础。
- 2～3 小时：完整追踪一条功能链路。
- 2 小时：实际修改、调试和测试。
- 1 小时：画流程图、更新问题清单。

### 每日笔记模板

```text
日期：
今天研究的功能：
用户在页面上的操作：
前端涉及文件：
请求地址和请求方式：
后端涉及文件：
数据保存或读取位置：
今天认识的英文（中文名称）：
我现在能解释的流程：
仍不清楚的问题：
明天从哪里继续：
```

---

# 四、十周学习路线

## 第 1 周：运行观察与整体地图

### 本周目标

不急着研究业务原理，先学会观察正在运行的项目，并建立目录与页面的对应关系。

### 周一：确认运行结构

- 记录前端、后端、PostgreSQL、Redis、docreader 的运行方式和端口。
- 学会查看 Docker Container（容器）状态和 Logs（日志）。
- 访问后端 `/health`，确认主服务可用。
- 输出：一张“当前本机运行服务表”。

### 周二：前端启动入口

- 阅读 `frontend/src/main.ts`。
- 阅读 `frontend/src/App.vue`。
- 只记录应用安装了哪些 Plugin（插件），不深入插件内部。
- 输出：前端从入口到根组件的流程。

### 周三：前端路由

- 阅读 `frontend/src/router/index.ts`。
- 选出登录、知识库、聊天、设置四类页面的 Route（路由）。
- 在浏览器切换页面，对照 URL 和对应 View（页面）文件。

### 周四：后端启动入口

- 阅读 `cmd/server/main.go`、`bootstrap.go`、`listen.go`。
- 了解 BuildContainer（构建依赖容器）、NewRouter（创建路由）和 Serve（启动 HTTP 服务）的大概位置。
- 暂时不深挖 dig（依赖注入库）。

### 周五：后端总路由

- 阅读 `internal/router/router.go`。
- 找到 `/health`、`/api/v1` 和主要 RegisterXxxRoutes（注册某类路由）调用。
- 观察 Middleware（中间件）的注册顺序。

### 周末实践

- 打开浏览器 Network（网络请求）面板。
- 分别执行登录、打开知识库列表、进入聊天页三个操作。
- 每个操作记录一个请求：URL、Method（请求方式）、Status（状态码）、Request（请求数据）、Response（响应数据）。
- 画一张“浏览器 → 前端 → 后端 → 数据库/其他服务”的系统图。

### 本周验收

- 能说出主要进程的职责。
- 能根据浏览器 URL 找到前端页面。
- 能在 `router.go` 中找到后端主要路由注册入口。

---

## 第 2 周：选择第一条简单链路——知识库列表

### 本周目标

完整追踪一个只读功能，理解前端页面怎样向后端获取数据。暂时不要选择聊天或文档上传。

### 周一：找到知识库页面

- 从前端 Router（路由）找到知识库相关 View（页面）。
- 记录页面使用的主要 Component（组件）。
- 判断哪些组件负责布局，哪些负责数据展示。

### 周二：找到前端 API

- 在知识库页面搜索 API 函数调用。
- 跟到 `frontend/src/api/knowledge-base/`。
- 记录请求地址、请求方式、参数和返回类型。

### 周三：了解页面状态

- 查看知识库相关 Store（状态仓库）和 Composable（可复用逻辑）。
- 分清 Source State（原始状态）与 Computed State（计算状态）。
- 观察数据由谁加载、保存和刷新。

### 周四：找到后端路由和 Handler

- 根据 Network 中的接口地址，在 `internal/router/` 搜索。
- 找到对应 Handler（请求处理函数）。
- 只关注参数从哪里来、调用哪个 Service、怎样返回 JSON。

### 周五：找到 Service 和 Repository

- 从 Handler 跳到 Service（业务服务）。
- 从 Service 跳到 Repository（数据访问层）。
- 找到涉及的 Domain Model（领域模型/数据库实体）。

### 周末实践

- 画出“知识库列表”完整调用图。
- 在前端增加一条临时日志，打印返回数据；验证后删除。
- 在后端 Handler 或 Service 增加一条临时日志；验证后删除。
- 找出数据库中对应的数据表和几个主要字段。

### 本周验收

能够用中文解释：页面在哪里、接口在哪里、后端入口在哪里、业务代码在哪里、数据从哪里查询。

---

## 第 3 周：第一条写操作——创建或修改知识库

### 本周目标

理解 Form（表单）、Validation（校验）、POST/PUT/PATCH 请求和数据库写入。

### 工作日任务

1. 找到创建知识库的 Dialog（对话框）或页面。
2. 分析表单字段、默认值、校验和提交函数。
3. 跟踪前端 API 请求和错误提示。
4. 在后端找到对应 Router、Middleware、Handler。
5. 继续跟到 Service、Repository 和数据库实体。

重点理解：

- `props`（组件属性）：父组件传给子组件的数据。
- `emit`（事件通知）：子组件通知父组件发生了操作。
- `v-model`（双向绑定）：表单值与组件状态同步。
- DTO（数据传输对象）：Handler 用来接收和校验请求参数的结构。
- Transaction（数据库事务）：多个数据库写操作需要一起成功或失败。

### 周末实践

完成一个低风险小改动，例如：

- 调整一个表单提示语；或
- 增加一个前端校验；或
- 改进一个后端错误信息。

完成后运行：

```bash
cd frontend
npm run type-check
npm test
```

后端按涉及包运行：

```bash
go test ./internal/handler/...
go test ./internal/application/service/...
```

### 本周验收

能解释一次“用户提交表单 → 后端校验 → 业务处理 → 数据库写入 → 页面刷新”的过程。

---

## 第 4 周：认证、权限与错误处理

### 本周目标

理解为什么同一个接口有时返回 401、403、404 或 500，以及中间件在其中的作用。

### 前端部分

- 阅读 `frontend/src/stores/auth.ts` 及认证相关 API。
- 观察 Token（令牌）、当前用户和当前空间如何保存。
- 找到前端遇到未登录或无权限时如何跳转或提示。

### 后端部分

依次阅读，但不要一次追完所有细节：

- `internal/middleware/logger.go`：Request ID（请求编号）和日志。
- `internal/middleware/recovery.go`：Panic Recovery（异常恢复）。
- `internal/middleware/error_handler.go`：统一错误响应。
- `internal/middleware/auth.go`：认证。
- `internal/middleware/rbac.go`：RBAC（基于角色的权限控制）。

理解差别：

- Authentication（认证）：你是谁？
- Authorization（授权）：你能做什么？
- Middleware（中间件）：进入 Handler 前后的公共处理。
- 401 Unauthorized（未认证）：通常表示未正确登录。
- 403 Forbidden（禁止访问）：已识别身份，但权限不足。

### 周末实践

- 使用正常登录、退出登录、访问无权限资源等方式观察不同响应。
- 用 Network 面板记录请求头与响应错误。
- 根据 Request ID 在后端日志中定位同一请求。

### 本周验收

能判断一条请求是没有到 Handler，还是已经进入业务逻辑后失败。

---

## 第 5 周：文档上传与异步任务

### 本周目标

完整理解文档从浏览器进入系统，到开始后台解析的前半段流程。

### 前端部分

- 从知识库页面找到上传入口。
- 阅读 Attachment/Upload（附件/上传）相关组件。
- 查看 `stores/uploadQueue.ts`、`uploadTasks.ts` 等上传状态代码。
- 观察上传进度、解析状态和错误提示如何更新。

### 后端部分

- 根据上传接口找到 `internal/router/routes_knowledge.go` 等路由。
- 阅读知识相关 Handler。
- 追踪文件保存、Knowledge（知识文档）记录创建和任务入队。
- 认识 Asynq（基于 Redis 的异步任务队列）。

先理解以下词义：

- Synchronous（同步）：请求等待任务完成后再返回。
- Asynchronous（异步）：请求先返回，任务在后台继续处理。
- Queue（队列）：等待后台 Worker 处理的任务列表。
- Worker（工作进程/任务执行器）：从队列取任务并执行。
- Parse Status（解析状态）：pending、processing、completed、failed 等处理阶段。

### 周末实践

- 上传一份短 Markdown/PDF 和一份稍大的 PDF。
- 同时观察 Network、前端状态、后端日志、docreader 日志和数据库状态。
- 画出“上传请求立即返回”和“后台解析继续运行”两条时间线。

### 本周验收

能解释为什么文件上传成功不代表文档已经可以检索。

---

## 第 6 周：docreader、分块与向量化

### 本周目标

理解文档怎样变成能够被搜索的 Chunk（文本块）和 Vector（向量）。Python 代码先读接口和主流程，不要求掌握所有解析器。

### 学习顺序

1. 阅读 `website-docs/02-architecture/03-document-pipeline.md`。
2. 找 Go 后端调用 docreader 的 gRPC Client（客户端）。
3. 查看 `docreader/proto/`，理解 Go 与 Python 之间传递的数据。
4. 阅读 docreader 服务入口和一个简单 Parser（解析器）。
5. 回到 Go 后端，找 Chunking（分块）和 Embedding（向量化）的调用。
6. 找 Chunk（分块）相关数据库实体和 Repository。

重点概念：

- gRPC（远程过程调用协议）：Go 后端调用 Python docreader 的通信方式。
- Parser（解析器）：把 PDF、Word 等文件变成文本和结构信息。
- Chunk（分块）：把长文档拆成适合检索的小段。
- Embedding（向量化）：把文本转换为可以计算语义相似度的数字数组。
- Vector Store（向量存储）：保存和检索这些向量。
- BM25（关键词相关度算法）：根据关键词出现情况检索文档。

### 周末实践

- 选择一份已入库文档，查看其 Chunk 数据。
- 对照原文观察分块边界。
- 修改非生产知识库的一项分块配置，重新解析并比较结果。

### 本周验收

能解释“原始文件 → 解析文本 → 分块 → Embedding → 向量/关键词索引”的完整链路。

---

## 第 7 周：RAG 检索与知识问答

### 本周目标

理解用户问题怎样变成检索请求，以及检索结果怎样成为大模型回答的依据。

### 概念学习顺序

1. Retrieval（检索）：从知识库找候选内容。
2. Keyword Search（关键词检索）：根据词语匹配。
3. Vector Search（向量检索）：根据语义相似度匹配。
4. Hybrid Search（混合检索）：合并关键词和向量结果。
5. Rerank（重排序）：使用模型重新排列候选片段。
6. Context（上下文）：最终发送给大模型的参考资料。
7. Prompt（提示词）：发送给大模型的指令和内容。
8. Citation（引用）：回答对应的原文来源。

### 前端部分

- 找聊天页面、输入框和发送动作。
- 找 `frontend/src/api/chat/`。
- 跟踪 SSE（服务器推送事件）和消息状态更新。
- 找回答组件和引用组件。

### 后端部分

- 找 `routes_chat.go` 和对应 Handler。
- 继续跟到 SessionService（会话服务）和 `chat_pipeline`（聊天流水线）。
- 对照 `website-docs/02-architecture/04-rag-pipeline.md` 找 Search、Rerank、Merge、Prompt 和 Stream 等插件。
- 观察引用怎样进入 Message（消息）并返回前端。

### 周末实践

使用同一份知识库设计五类问题：

- 原文中有明确答案的问题。
- 用不同说法表达的问题。
- 需要跨两个段落组合的问题。
- 文档中没有答案的问题。
- 关键词相近但语义不同的问题。

记录每次检索结果、引用和最终答案，判断错误属于 Retrieval（检索）、Rerank（重排序）、Context（上下文）还是 Generation（模型生成）。

### 本周验收

能解释 RAG 不是让模型“学会文档”，而是在回答前临时检索文档并放进上下文。

---

## 第 8 周：Vue 深入与前端工程质量

### 本周目标

在已经理解真实页面之后，再系统总结 Vue 3 的数据流和项目约定。

### 学习重点

- `ref/reactive`（响应式状态）：页面的原始状态。
- `computed`（计算属性）：从原始状态推导出的数据。
- `watch/watchEffect`（监听器）：状态变化后执行副作用。
- `props down`（属性向下传递）：父组件向子组件传数据。
- `events up`（事件向上传递）：子组件通知父组件。
- Pinia Store（状态仓库）：跨组件共享的业务状态。
- Composable（可复用逻辑）：复用状态、监听和副作用。
- Route Guard（路由守卫）：进入页面前检查登录或条件。

### 代码阅读要求

选择一个中等复杂页面，画 Component Map（组件地图）：

```text
Route View（路由页面）
├─ Feature Container（功能容器）
├─ Form Component（表单组件）
├─ List Component（列表组件）
└─ Dialog / Drawer（对话框 / 抽屉）
```

逐项记录：

- 每个组件唯一职责。
- Props（输入属性）。
- Emits（输出事件）。
- Store（共享状态）。
- Composable（复用逻辑）。
- API（接口调用）。

### 周末实践

完成一个纯前端小改动，例如：

- 为列表增加一个本地筛选；
- 改进空状态或错误状态；
- 将一个过大的页面逻辑拆入 Composable；
- 为一个已有行为补测试。

### 本周验收

能够解释状态应该放在组件、Composable 还是 Pinia Store 中，以及为什么。

---

## 第 9 周：Gin、依赖注入和后端工程结构

### 本周目标

在已经追踪多条接口后，系统总结后端架构，而不是只认识单个函数。

### 学习内容

- Gin Engine（Gin 引擎）和 RouterGroup（路由组）。
- Context（请求上下文）：参数、认证信息、错误和响应。
- Middleware Chain（中间件链）：按顺序处理请求。
- Handler（请求处理层）：只负责 HTTP 边界。
- Service（业务服务层）：业务流程和规则。
- Repository（数据访问层）：GORM 数据读写。
- Interface（接口）：解耦调用方与具体实现。
- Dependency Injection（依赖注入）：由 dig 创建并组装依赖。

### 阅读顺序

1. `cmd/server/main.go`。
2. `internal/container/container.go`。
3. `internal/router/router.go`。
4. 一组 `routes_xxx.go`。
5. 对应 Handler。
6. 对应 Service 接口和实现。
7. 对应 Repository 接口和实现。
8. 对应 Domain Model（领域模型）。

不要尝试一次读懂 `BuildContainer` 中注册的所有依赖。选择一条自己已经熟悉的知识库链路，观察这些对象是怎样被创建并注入的。

### 周末实践

- 为一个简单读取接口增加一个低风险过滤参数，或完善一个已有接口。
- 同步修改前端请求和界面。
- 添加或修改至少一个后端测试。
- 运行相关前端类型检查和后端包测试。

### 本周验收

能解释为什么 Handler 不应该直接写大量数据库查询，Service 和 Repository 分层解决了什么问题。

---

## 第 10 周：Agent 主流程与综合项目

### 本周目标

理解 Agent 与普通 RAG 问答的差别，并通过一个综合小功能检验前后端能力。

### Agent 基础概念

- Agent（智能体）：可以根据任务决定下一步行动的模型应用。
- Tool（工具）：搜索知识、读取文档、访问网页、执行脚本等能力。
- Tool Call（工具调用）：模型请求程序执行某个工具。
- ReAct（推理与行动循环）：Think → Act → Observe → 再思考。
- MCP（模型上下文协议）：以统一协议接入外部工具。
- Sandbox（沙箱）：隔离执行脚本和文件操作的环境。
- Approval（审批）：执行敏感操作前由用户确认。

### 阅读顺序

1. 在界面实际执行一次简单 Agent 任务。
2. 用 Network 面板观察 Agent 请求和流式事件。
3. 找前端 Agent 页面、API 和流式消息展示。
4. 找后端 `routes_agent.go`、相关 Handler 和 Service。
5. 浏览 `internal/agent/`，只先识别运行循环、工具、权限和状态。
6. 找一个内置工具，追踪它从定义、注册到执行结果返回的过程。

### 综合小功能候选

选择一个，不要同时做多个：

- 在知识库列表增加一个后端支持的过滤条件。
- 改进文档解析失败时前后端显示的信息。
- 为聊天引用增加一个简单展示字段。
- 增加一个读取型接口并在前端展示。
- 为已有设置项完善前端校验和后端校验。

综合功能必须完成：

1. 明确需求和影响范围。
2. 画前后端调用图。
3. 完成前端组件和 API 修改。
4. 完成后端 Router、Handler、Service、Repository 中必要的修改。
5. 添加测试。
6. 运行检查。
7. 自己写一段修改说明。

### 本周验收

能够完成一个可运行、可验证、可说明的前后端小功能，而不只是跟着 AI 复制代码。

---

## 五、每周固定复盘清单

每周日完成以下检查：

- [ ] 本周是否完整追踪了一条真实功能，而不是只阅读零散文件？
- [ ] 是否至少使用一次 Network 面板和后端日志验证理解？
- [ ] 是否画了一张流程图或组件图？
- [ ] 是否记录了英文（中文名称）及其在项目中的实际用途？
- [ ] 是否做了一次小修改或实验？
- [ ] 是否运行了相关检查或测试？
- [ ] 是否能不用看代码，用中文讲清本周功能？
- [ ] 是否把暂时不需要的问题放入待学清单，而不是无限展开？

---

## 六、调试问题的定位顺序

### 页面没有正确显示

1. 浏览器 Console（控制台）是否报错？
2. Network 请求是否发出？
3. 请求地址、参数和状态码是否正确？
4. 前端 Store 或组件状态是否更新？
5. Template（模板）的条件渲染是否把内容隐藏？

### API 请求失败

1. 状态码是 401、403、404、422 还是 500？
2. Response（响应）里的错误 code 和 message 是什么？
3. 后端日志中同一个 Request ID 对应什么错误？
4. 请求是否被 Middleware 拒绝，还是进入了 Handler？
5. Service、Repository 或外部服务哪一步失败？

### 文档一直解析中

1. 上传请求是否成功返回 knowledge ID？
2. Redis 和 Asynq Worker 是否正常？
3. 后端任务日志是否报错？
4. docreader 是否健康、gRPC 是否调用成功？
5. 模型配置、Embedding 服务是否可用？
6. 数据库中的 parse_status 和 pending_subtasks_count 是什么？

### 聊天无响应或中断

1. SSE 请求是否保持连接？
2. 前端是否正确处理流式 event？
3. Redis Stream Manager 或内存流管理是否异常？
4. Retrieval、Rerank 或 LLM Provider 哪一步失败？
5. 是否模型超时、Key 错误或并发限制？

---

## 七、建议使用的项目文档

按以下顺序阅读，不要一次全部阅读：

1. `README_CN.md`：产品能力和启动方式。
2. `website-docs/02-architecture/01-overview.md`：总体架构。
3. `website-docs/02-architecture/02-backend-design.md`：Go 后端分层。
4. `website-docs/02-architecture/03-document-pipeline.md`：文档入库。
5. `website-docs/02-architecture/04-rag-pipeline.md`：RAG 问答。
6. `website-docs/02-architecture/05-async-tasks.md`：异步任务。
7. `website-docs/06-development/01-dev-guide.md`：开发命令和测试。
8. `frontend-learning-plan.md`：已有的三周前端专项计划，可作为本计划前端部分的补充。

---

## 八、Git 学习分支建议

不要直接在 `main` 分支进行学习实验。每类实验建立分支：

```bash
git switch -c learning/kb-flow
```

完成一小块后提交：

```bash
git add <本次相关文件>
git commit -m "学习：追踪知识库列表流程"
```

不要习惯性执行 `git add .`。提交前先检查：

```bash
git status
git diff
```

学习日志、临时调试代码和真实功能修改最好分开提交。临时日志验证完成后应删除，不要推到长期分支。

---

## 九、学习过程中使用 AI 的方式

AI 可以帮助：

- 用中文解释当前文件、函数或英文术语。
- 根据一条接口生成调用关系图。
- 帮助定位搜索关键词和可能涉及的文件。
- 解释报错和测试失败。
- 审查你对流程的理解是否有遗漏。

不要只让 AI：

- 一次性总结整个仓库。
- 不解释就直接修改大量文件。
- 在你没有看 Network、日志和调用链时直接猜问题。
- 替你完成全部思考和笔记。

推荐提问方式：

```text
我正在追踪“知识库列表”功能。
目前已找到前端文件 A、API 文件 B 和后端路由 C。
请只解释从 C 到 Handler、Service、Repository 的调用链，
每个英文术语后面加中文名称，不要展开 Agent 或 RAG。
```

---

## 十、最终能力检查

十周结束时，用以下任务自测：

1. 随机选择一个前端页面，10 分钟内找到 Route、View、主要 Component、Store 和 API。
2. 根据一个 API 地址，15 分钟内找到后端 Router、Handler 和主要 Service。
3. 根据 Service 找到 Repository、领域模型和数据库表。
4. 通过 Network 和日志定位一次真实请求。
5. 解释一次文档入库和一次 RAG 问答的完整流程。
6. 解释 Agent 与普通聊天/RAG 的主要区别。
7. 独立完成一个小功能或修复，并运行对应测试。
8. 将修改提交到自己的 Fork 分支，并能写清修改内容和验证方法。

如果前四项熟练、第五和第六项能讲清主流程、第七项能够完成，你就已经从“只能看懂局部代码”进入了“可以参与项目开发”的阶段。
