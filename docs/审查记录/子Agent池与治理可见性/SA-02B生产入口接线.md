# SA-02B 生产入口接线审查记录

日期：2026-11-19
范围：`agent/src/runtime/agent-pool.ts`、`app.ts`、`routes/chat.ts`、`routes/tasks.ts`，以及调度器 `maxWaiting` 语义修正。

## 设计依据

- `specs/plan.md` AX-R09：每实例 8 槽，chat/教学任务走问答槽，管理端治理走治理槽；池满明确繁忙；管理端后续通过池状态接口观测（SA-04）。
- `specs/tasks.md` SA-01/SA-02：槽位调度、上下文隔离、检查点续接。
- 2026-11-19 用户要求：先把子 Agent 池接入生产入口，再继续后端可观测扩展。
- `.trae/rules/coding-style.md`：统一错误封装、接口蛇形、禁止空 catch。

## 实现要点

- 新增 `AgentPool`：每个 `createApp()` 创建一个实例，内部持有 `SlotScheduler` 与 `ChildAgentRunner`；测试可注入独立池，避免用例共享队列。
- `slotKindForTask`：`moderation_scan` → `governance`，`chat`、`similar_questions`、`suggest_tags`、`doc_draft`、`knowledge_tree` → `qa`。
- `POST /agent/tasks/:type`：先解析类型与模型，再提交到池；在槽位内启动 RunControl、创建运行记录并执行 `runReviewed`；池饱和返回 503「Agent 服务繁忙，请稍后重试」。
- 结构化任务经 `ChildAgentRunner` 执行，使用隔离上下文；让位检查点只放在审计创建之前，确保重排后重新建运行记录，不重复已提交动作。
- `POST /agent/chat`：SSE 执行整体占用一个问答槽；池饱和时写入 `error` 事件「当前问答并发已满，请稍后重试」，不建立运行记录。
- 调度器繁忙判定改为“只有确实需要排队时才受上限约束”：`maxWaiting=0` 时仍有空闲槽位的任务可以立即执行，避免把池禁用。

## 验证记录

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 池接线专项 | `npm test -- tests/agent-pool-wiring.test.ts` | 4 项通过 |
| SA-01/SA-02 联合 | 同命令附带 slot-pool / slot-scheduler / child-runner | 21 项通过 |
| 路由回归 | `npm test -- tests/app.test.ts tests/integration-run.test.ts tests/content-tasks.test.ts tests/web-chat.test.ts tests/browser-memory.test.ts` | 33 项通过 |
| 类型检查 | `npm run typecheck` | 通过 |
| Lint | `npm run lint` | 通过 |

覆盖场景：任务槽位映射、快照实例标识与 8 槽、问答饱和时任务 503、问答饱和时治理槽仍可接纳治理任务。

## 决策说明

1. 每个应用一个池而不是模块级单例：生产只创建一次，测试按用例隔离；`AGENT_INSTANCE_ID` 可显式配置实例标识。
2. chat 不参与检查点续接：SSE 会话中断后无法续接，问答槽本身不可被让位，只在池满时排队或明确繁忙。
3. 结构化任务复用 runner 的隔离上下文；同一请求只创建一个客户端，跨任务不共享。治理任务只允许在审计创建前让位，避免重复运行记录。
4. 繁忙响应采用 503：与现有 `toErrorResponse` 的服务不可用语义一致，不新增错误码。

## 遗留与限制

- 池状态只在内存中，尚无内部状态接口与管理端页面（SA-04）。
- 让位/终止路由未实现（SA-05）；当前只有问答回压自动让位。
- chat 与任务排队不计入 180 秒运行预算，等待过久由调用方超时控制。
- 未做真实模型、多实例容量与公平性压测（SA-06）。
