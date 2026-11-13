# C10 Wiki 持久任务与恢复：原子交接与有界重试

> 课程性质：核心；目标掌握：看懂链路、理解机制、设计与表达。
> 课程导航：[导学](../WeKnora/导学.md)；前置：[C06 知识入库与父子索引](C06-知识入库与父子索引.md)、[C09 智能体循环与上下文预算](C09-智能体循环与上下文预算.md)；上一课：[C09](C09-智能体循环与上下文预算.md)；下一课：无（核心源码课程在此收束，回到[导学](../WeKnora/导学.md)梳理全局）。
> 所属可交互专题：[Wiki 并发与持久恢复](topics/C10-Wiki并发与持久恢复.html)（对照 Redis 并发认领、Lite 串行与重启补发）。
> 对应：B4；[面经 Q4](../WeKnora/面经.md#q4-文件传完以后怎样把索引和-wiki-后续任务做成可观察可恢复的流程)。源码基线：`d06733d4157736c0e0e7972d014f0f056d237bb0`。

## 本课重点

Wiki 自动生成是文档解析后的异步后处理，可能经历 LLM 限流、进程重启、同 KB 多批次并发和同一文档“写入后立刻删除”。只向 Redis 投一个任务不足以保证状态和工作同时保存：知识进入 `finalizing` 却丢了 Wiki 任务，会永远等一个不存在的子任务；先投任务再更新计数，又可能被快任务先完成。因此先把知识状态、待完成计数及 Wiki **ingest** 持久操作写在**同一数据库事务**，随后仅用队列任务作唤醒信号。恢复、认领、去重、重试围绕 ingest 持久行构成；后续 KB 全局 Wiki finalize 另行 best-effort 入库，不享有这次原子交接保证。系统也不是 exactly-once 的跨数据库、Redis 和 Wiki 页面事务。

## 主链与职责

`KnowledgePostProcess 识别 willSpawnWiki → 事务提交 processing→finalizing、pending_subtasks_count、task_pending_ops(Wiki ingest) → 投递延时触发器 → WikiIngest 批量 claim/peek → map 文档、按 slug reduce 并发布页面 → 尝试独立写入 Wiki finalize 变更行、入库成功则安排触发器 → 对终结的 ingest 释放该文档 wiki finalizing 槽、结算成功/失败行 → 已写入的 finalize 行由延时任务处理 KB 索引页/链接 → 删除已处理的 finalize 行`。任务载荷只有 KB/租户等路由信息，真正待处理的文档操作以 `task_pending_ops` 为准；知识行的子任务计数负责解析 UI 最终状态，Wiki 页面仓库负责内容。finalize 行插入失败只记日志并继续，ingest 仍可结算：启动恢复只能重新唤醒**已成功入库**的 finalize 行，不能补回从未写成的全局变更。超过内部重试预算时尝试将操作归档到 `task_dead_letters`，即便归档失败也可能删掉 pending 行，不能保证死信证据一定持久保存；启动恢复器重新发触发器。

## 源码阅读

1. [状态交接：`KnowledgePostProcess`](../../internal/application/service/knowledge_post_process.go)：有 Wiki 后处理时调用 `SeedKnowledgeFinalizingWithPendingOp`，并标记 `wikiSlotOwned=promoted`；之后再投 wiki trigger。若触发器投递失败且 Wiki 槽已拥有，返回错误让 post-process 重试触发器，不得删掉仍有持久操作负责的计数；summary/question/graph 若未实际投递则释放它们没有所有者的短缺槽。没有任何子任务时 `CompleteProcessingWithoutSubtasks` 可直接完成。
2. [原子持久行：`SeedKnowledgeFinalizingWithPendingOp`](../../internal/application/repository/task_queue.go)：事务中先检查 KB 属于载荷租户，知识必须仍为该租户/KB 的 `processing`，再原子更新 `finalizing` 与 `pending_subtasks_count` 并 `Create(op)`。任何一步失败事务回滚，`RowsAffected==0` 不伪造新的 wiki 行。普通 [`EnqueueWikiIngest`](../../internal/application/service/wiki_ingest.go) 的独立路径同样先持久化带 `DedupKey=knowledgeID`、`Attempt` 的行再投触发器，但它本身不是上述 finalizing 状态交接事务。
3. [唤醒与批量执行](../../internal/application/service/wiki_ingest.go)、[执行入口](../../internal/application/service/wiki_ingest_batch.go)：ingest trigger 在 Wiki 队列设置 `MaxRetry(10)`、`Timeout(60m)`、`ProcessIn(30s)`；默认最多 5 份文档一批，可由 KB 的 `WikiConfig.IngestBatchSize` 调整。Redis 模式同 KB 可多批并发，每 KB 默认最多 4 个进行中批次，按 slug 的锁串行化同页面修改；Lite 模式无 Redis，按 KB 的进程内锁串行且只 peek。缺失/删除租户或 KB 清除无效队列，Wiki 未启用/自动生成关闭或模型长期不可用时释放相关 ingest，不让 finalizing 永久悬挂。配了 Redis 不会因为断线自动转 Lite。
4. [并发认领：`ClaimBatch`](../../internal/application/repository/task_queue.go)：`limit` 数的是不同 `dedup_key` 文档，不是行数；同键的所有可领取行一起处理，同键存在任何未过期 claim 就整键跳过，包括认领期间后来加入的撤回操作。Postgres 用每键锚点 `FOR UPDATE SKIP LOCKED` 保证并发批次领取不同键；领取按 `fail_count ASC, id ASC`，先新工作再重试；只有 `claimed_at IS NULL` 或 `< staleBefore` 的行合格。Redis 模式按当前时间减 `wikiClaimStaleAfter=90m` 识别超期，必须晚于执行超时 60m，避免抢走尚在运行的任务。Lite 借进程内每 KB 排他，数据库执行 `PeekBatch`；两模式返回操作的排序并不相同。
5. [去重、结算与限次：`decodePendingRows/requeueFailedOps/finalizeWikiSubtask`](../../internal/application/service/wiki_ingest.go)、[批次结算](../../internal/application/service/wiki_ingest_batch.go)：`decodePendingRows` 倒序遍历传入行，对同一知识 ID 保留**输入列表的最后一项**，同时保存所有已读取行 ID 供成功结算删除。Redis 的 [`ClaimBatch`](../../internal/application/repository/task_queue.go) 回传行按 `id ASC`，因此同批读到的“ingest → retract”保留较新撤回；但 Lite 的 `PeekBatch` 按 `fail_count ASC,id ASC`，重试中的旧 ingest 失败次数较高时可能排在新 retract 后面，错误地保留旧 ingest 并清掉撤回行，**不能宣称 Lite 总按最新创建时间胜出**。这仅是可核验的顺序风险，不把具体时序描述成已在生产观察到的事故。失败的 canonical 行不删，增加 `fail_count`，`<=5` 放回可认领池，`>5` 尝试写死信并删除 pending 行；即便写死信失败，删除仍会尝试执行，不能保证留下死信记录。只有 Wiki ingest 到达成功或终结失败时才释放该知识的 Wiki finalizing 槽；旧解析 `attempt` 的操作不可释放新尝试的计数。撤回已删除知识不占该计数。LLM 限流时后续批次采用 60s 而非正常 5s 的回退。
6. [全局收敛：`enqueueFinalizeRow/enqueueFinalize`](../../internal/application/service/wiki_ingest.go)、[批次结算](../../internal/application/service/wiki_ingest_batch.go)：slug/变更/目录修剪 finalize 行是在页面处理后逐行独立尝试写库；插入失败仅记录日志，成功写入至少一行才调度 finalize trigger，失败不阻止 ingest 的结算和 Wiki 槽释放。这与第 2 步 ingest 状态+操作的同事务原子交接不同，没写成的 finalize 行不可由恢复器重建。
7. [启动恢复：`recoverPendingWikiTasks`](../../internal/container/recover_pending_wiki_tasks.go) 与 [容器启动顺序](../../internal/container/container.go)：先注册/启动 Asynq 或 Lite handler，再扫描持久表中各 `(tenant_id, task_type, scope_id)` lane 重建 ingest/finalize 触发器；先清除已删除/不存在租户或 KB 的行，清理查询失败时直接停止而不是对未知租户发任务。Redis 同 KB 的 finalize 用稳定 TaskID 合并，Lite 忽略此合并 ID。运行时若没有可认领行、但仍有新鲜 claim，批次会安排 `90m+5s` 的单 KB 复查；异常退出释放已认领行。恢复是重发唤醒而非依赖 Redis 队列的永久历史。

## 机制与边界

模拟两个并发批次：文档 A 尚在生成页面，用户删除 A 并加入 retract 行；若 claim 只锁已存在的 ingest 行，新 retract 会被另一批执行并先删除页面，随后第一批可能把页面重新建回来。`ClaimBatch` 排除有新鲜 claim 的整个文档键，让 retract 等到 ingest 结算或 claim 过期；Redis 认领返回行按 ID 升序时，`decodePendingRows` 取最后一条等同取较新操作；Lite `PeekBatch` 按失败次数优先，同一键的失败旧 ingest 排到新 retract 后面时可能反而选旧操作并清掉撤回行。这是现有 Lite 排序的具体风险，不能把“按最新创建时间获胜”写成跨模式不变量。不同文档可以跨批并发，但两个文档修改同一个 Wiki slug 仍要按 slug 串行；这是**每文档与每页面**两级并发约束，不能说“同 KB 全程加锁”，因为标准 Redis 模式已允许同 KB 多批同时运行。默认 inflight=4 防热点 KB 占满所有 Wiki worker。

再模拟进程在数据库事务提交后、Redis 触发器入队前崩溃：持久 pending 行与 finalizing 槽都存在，重启扫描重发 trigger；若任务执行中途崩溃留下 `claimed_at`，下一个批次不能马上抢，有新鲜 claim 时会布置超过 90m 的复查，旧 claim 最终可再认领，未正常结算的批次也尝试释放。重发/再次领取意味着页面生成可能重做，故不能保证 exactly-once；用操作去重、状态/尝试保护与页面级锁减少重复副作用。`task_pending_ops` 成功删除、可重试失败留行、超过 5 次先尝试归档死信（失败只记错误）、无论归档成功与否仍尝试删 pending 行，是**本地工作重试预算**；Asynq 自身 `MaxRetry(10)` 是触发器执行预算，两者不要混为一谈。Wiki finalize 的 KB 全局收敛在**写入成功时**才有独立持久 lane；行插入失败仅记日志且 ingest 仍可结算，启动恢复无法凭空重建没写成的 finalize。即使行已存在，索引页重建等某些失败也按 best-effort 记日志并继续清除行，不应声称每一次 LLM 失败都永久重试到成功。

## 需要懂什么

就**post-process → Wiki ingest** 这次交接而言，实现的是“事务性工作记录 + 可丢/可重发唤醒信号”的模式，类似 outbox：真正待做的 ingest 操作与知识状态同事务写库，Redis/进程内 executor 催消费者去读。数据库事务不覆盖任务队列或 Wiki 页面写入；后续 finalize 行独立 best-effort 写库，若没写成功就不属于可恢复的持久工作。重试要有幂等/抑制策略。`finalizing` 子任务计数与持久 Wiki 行一起落库，是为了让等待的槽始终有人负责；终结失败同样要释放槽；系统会尝试写死信，但归档失败可只留日志而无持久死信，不能把它当作必有的失败证据。`90m > 60m` 是 claim 有效期大于 worker 最大执行时间的时序约束；不是“所有任务 90 分钟超时”。多租户恢复时删除失效 scope，执行时还会验证租户/KB，不能把旧持久行当成新的合法访问授权。

## 需要记住什么

复述主线：**入库后处理将 finalizing 计数与 Wiki ingest 操作同事务写库 → 队列只负责唤醒 → Redis 按文档键原子认领、按 ID 顺序同批去重 → map/reduce 后结算、失败限次重试、终结时尝试归档死信 → 重启重新唤醒已落库的持久 lane**。Redis 多批并发与 Lite 单 KB 串行不能混淆；Lite 失败次数排序可破坏“最新操作胜出”，finalize 行若写库失败不会由恢复器补回。90 分钟过期大于 60 分钟 worker 超时；两层重试预算分别是行级 5 次与 Asynq 触发器 10 次；交付保证针对已落库 ingest 是可恢复的至少一次处理思路，而非端到端 exactly-once。前序解析见[C06](C06-知识入库与父子索引.md)，面试回答见[Q4](../WeKnora/面经.md#q4-文件传完以后怎样把索引和-wiki-后续任务做成可观察可恢复的流程)。