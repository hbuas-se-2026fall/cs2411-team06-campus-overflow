# T-21C 审查记录：Agent 执行接线

日期：2026-11-25
范围：R-002 / ADR-011 / spec RC-R01～RC-R05 / plan AX-R11

## 设计依据

- `specs/spec.md` RC-R01～R05：暂停只在 step/工具/模型调用边界生效，不中断已发出请求；resume 从断点继续；cancel 进入终态并释放占位；引导作为独立段落注入下一次 prompt，不扩大权限/工具/审批；仅治理任务与管理员聊天可控制。
- `specs/plan.md` AX-R11：Agent 只在边界拉取，超时 500ms；paused 时 2s 轮询；暂停最长 30 分钟；写 `control_pause/resume/cancel/guidance` 事件，引导正文不入库，仅保留摘要与 digest；开关关闭时行为与现状一致。
- `specs/tasks.md` T-21C：验收为 vitest 假后端覆盖暂停/恢复/取消/引导注入顺序。
- `.trae/rules/coding-style.md`：Agent 工具与外部调用统一走注册表/客户端；不记录原始隐私正文；观测记录 trace id 与摘要。
- `.trae/rules/conventions.md`：子 Agent 任务间不共享可变上下文；证据写本目录，进度只写 `status.md`。
- 已读执行链路：`agent/src/loop/{plan-executor,planned-tools,reviewed-run,abort}.ts`、`agent/src/routes/{chat,tasks}.ts`、`agent/src/tasks/{router,moderation-scan}.ts`、`agent/src/observability/{persistent-audit,audit-client}.ts`、`agent/src/internal-client.ts`、`agent/src/prompts/planning.ts`。

## 验证记录

Agent（`campus-overflow-ai/agent`）：

- `npm test -- tests/run-control-gate.test.ts` → 6 passed。
- `npm test -- tests/run-control-injection.test.ts` → 2 passed。
- `npm test -- tests/plan-executor.test.ts tests/plan-parallel.test.ts tests/planned-entry.test.ts tests/reviewed-run.test.ts tests/web-chat.test.ts tests/chat-resume.test.ts tests/task-router.test.ts tests/persistent-audit.test.ts tests/persistent-audit-serial.test.ts tests/audit-client.test.ts tests/content-tasks.test.ts tests/knowledge-tree-task.test.ts tests/recommend-tasks.test.ts` → 13 files / 150 passed。
- `npm run typecheck` → 通过。
- `npm run lint` → 通过。

后端（`campus-overflow-ai/backend`）：为接收 `control_*` 审计事件扩展了事件类型与 domain 校验。

- `uv run pytest tests/test_agent_run_events.py tests/test_run_control_api.py tests/test_run_control_repository.py -q` → 30 passed。
- `uv run pytest tests/test_governance_internal.py -q` → 52 passed。
- `uv run ruff check app/modules/governance tests/test_agent_run_events.py` → All checks passed。

专项覆盖：

1. 开关关闭（后端 `enabled=false`）后不再轮询，不产生事件、不 ack；
2. 暂停后轮询到 running，`control_pause` / `control_resume` 各只记录一次，命令按 id ack；
3. cancel 状态中止运行（`RunStoppedError`），只记录一次 `control_cancel`；
4. 暂停期间两条引导按命令顺序累积，`takeGuidance()` 一次取走，随后清空；
5. 暂停超过本地 30 分钟兜底自动取消；
6. 拉取失败不误停：保持运行，后续检查继续；
7. 治理任务（moderation_scan）规划前暂停 → 恢复，引导 A 注入规划提示；最终评估前再次暂停 → 恢复，引导 B 只注入评估提示；
8. 控制事件顺序：`control_pause/guidance/resume` 两轮，与命令 revision 一致；
9. 后端允许计划前 `plan_revision=0` 的控制事件，带步骤字段或版本不符仍 400。

## 决策说明

- 新增 `agent/src/loop/run-control-gate.ts` 作为唯一控制门：只读跟随后端状态，边界调用 `checkpoint()`；暂停轮询 `RUN_CONTROL_POLL_INTERVAL_MS`（默认 2000ms，仅测试与运维调优用），拉取超时 500ms。
- 接入点放在最靠近模型调用的公共层：`runPlannedTools` 规划前、`executePlan` 每个 step 前、聊天 `collectAnswer` 前、`moderation_scan` 最终评估前；因此治理任务与管理员聊天共享同一语义，不改变任务路由。
- 暂停/取消事件由“本实例真正停住/终止”时写入，命令只负责恢复状态与引导，避免“命令 + 状态”重复事件；跨实例时即使命令已被消费，仍按状态收敛。
- 引导只在取走时进入 prompt 独立段落，正文不写事件表；digest 已在 T-21A 命令表持久化，Agent 侧仅结构化日志输出 digest。后端 `agent_run_events.event_type` 为字符串列，无需迁移。
- 取消复用既有 `RunStoppedError` 路径，运行时进入 failed 终态并释放槽位；不新增“cancelled”运行状态，避免改动状态机与已有观测。
- 开关双层：`RUN_CONTROL_ENABLED`（Agent）关闭时完全不建门；即使打开，后端 `enabled=false` 也会在首次拉取后停用，保持现状。
- 放弃方案：在 `reviewed-run` 每个模型调用都加检查需扩散参数到审查层，当前边界已覆盖规划、工具与最终生成；审查调用不单独暂停，符合“已发出的请求不中断”。
- 遗留：30 分钟服务端惰性判定与定时清理、双实例并发 ack 属 T-21D；管理端页面属 T-21E；关闭开关的全量回归收口属 T-21F。
