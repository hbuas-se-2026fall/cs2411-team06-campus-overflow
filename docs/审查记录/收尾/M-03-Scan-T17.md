# M-03 / 巡检建单 / T-17 N-03～N-07 收口审查记录

日期：2026-11-24
范围：US-13、US-17、US-18、US-19；C-05/C-06/C-07/C-08；T-14 M-03、T-15-B 补齐、T-17 N-03～N-07、T-19/T-20 收尾

## 设计依据

- `specs/spec.md`：US-13（低风险打标、中高险建单，Agent 无处置权）、US-17（个人记忆按账号浏览器保存、可清空）、US-18（运行/工具/审批可追踪）、US-19（MCP 白名单与高风险人工确认）。
- `specs/constitution.md`：C-05（Agent 只走内部白名单）、C-06（工具与 MCP 白名单）、C-07（记忆浏览器保存且敏感信息拦截）、C-08（trace/agent_run_id）、C-09（子 Agent 隔离）。
- `specs/tasks.md`：T-14 M-03、T-15-B、T-17 N-03～N-07、T-19/T-20。
- `docs/decisions/ADR-004-个人记忆隔离.md`、`docs/后端架构说明.md` 双环决策、`docs/接口设计指南.md` 内部/管理员路径约定。
- `.trae/rules/coding-style.md`：router → service → repository/domain，统一响应信封，字段蛇形；测试分层为开发期冒烟 + CI 全量。

## 实现摘要

### M-03 AI 自动更新个人记忆

- Agent 新增 `POST /agent/memory/suggestions`：结构化输出最多 3 条 → 服务端做长度（≤200）、敏感关键词、与已有记忆去重过滤，最多返回 2 条；不写后端、不落审计。
- 前端回答完成后，按账号开关 `co_memory_auto_user_{id}` 请求候选；`applySuggestedMemoryEntries` 复用 browser-memory 的 500 字/50 条/敏感/重复规则，一次性写入且只广播一次变更，避免打断对话。
- 个人中心记忆卡新增“AI 自动更新记忆”开关（默认开启、可关闭）；聊天区提示更新条数。

### 巡检单次评估补齐建单

- `moderation_scan` 任务在 `shouldEscalate` 为真时调用 `POST /internal/agent/patrol/cases` 创建 pending 工单；快照优先使用已核验正文，回退请求方摘录时保留“未核验”标注；不执行任何处置。

### T-17 N-03～N-07

- N-03：核验既有 `admin:query`/`admin:act` scope、`X-External-Agent-Key` 身份映射与“只建申请/工单、不直接处置”实现，补登记未改代码。
- N-04：后端 `mcp_call_logs`（迁移 `n04_mcp_call_logs`）、`POST /internal/agent/mcp/calls`（服务 token）、管理员 `GET /api/governance/mcp/calls`（分页 + 客户端/工具/状态筛选）；Agent `createPersistedMcpCallAudit` 异步持久化，失败只记 `mcp_audit_persist_failed`，不阻塞或改变 MCP 调用结果；`MCP_AUDIT_PERSIST_ENABLED=false` 退回结构化日志。
- N-05：后端 `GET /internal/agent/sync/questions`（`updated_after` + id 游标 + limit≤200，排除软删/隐藏，只返回 id/标题/课程/时间）；MCP 白名单新增只读工具 `sync_questions`，校验时间格式、游标与批大小。
- N-06：`agent/src/mcp/upstream.ts` 从 `MCP_UPSTREAM_SERVERS` 解析 ≤5 个 Server、每 Server ≤20 个工具；低风险工具进入请求级工具注册表，调用时短连接外部 Server；未配置/禁用/未列入白名单的工具不可调用。
- N-07：管理员 `GET /agent/admin/mcp/upstream` 返回脱敏配置（来源域、风险、是否模型可见、是否确认）；`POST /agent/admin/mcp/upstream/call` 对高风险工具要求 `confirmed: true`，并创建 `call_mcp_tool` 待确认工单（`POST /internal/agent/approvals`），确认前不执行。

## 验证记录

- Agent 全量：`npm test -- --run` → 106 文件 835 passed；`npm run typecheck`、`npm run lint` 通过。
- 后端专项：`tests/test_mcp_audit.py` 3 项、`tests/test_mcp_sync.py` 3 项、`tests/test_task_router` 相关 2 项通过；迁移兼容修复后 `test_patrol_notes.py`、`test_patrol_workflow_migration.py`、`test_wf04_case_default_migration.py` 共 8 项通过。
- 后端全量：`uv run pytest -q` → 863 passed / 29 skipped（跳过项为需真实 MySQL/Docker/外部服务的用例）；`uv run ruff check .` 零 error；`uv run lint-imports` 5 契约 KEPT。
- 前端全量：`npm test -- --run` → 82 文件 514 passed；`tsc --noEmit`、`npm run lint` 通过。
- 迁移：新增 `n04_mcp_call_logs`（`down_revision=t14_legacy_memory_cleanup`）；未在真实 MySQL 执行，随上线批次验证。

## 决策说明

- 记忆自动更新采用“服务端只出候选 + 浏览器端确认写入”而非后端持久化：符合 C-07 和 ADR-004，且记忆候选不进入运行审计。
- 外部 MCP 高风险工具采用“配置确认 + 每次调用建待确认工单”双层约束；不在 Agent 进程内直接执行写操作，保持 C-06。
- MCP 调用审计只存脱敏摘要（client/tool/status/摘要/耗时/trace），不存凭证与原始参数，沿用 `sensitive.ts`。
- 增量同步沿用 id 游标而非 offset，避免同步过程中新增/隐藏造成漏项；`updated_after` 由调用方保存水位。
- 迁移改为缺表/缺列时跳过，保证部分基线迁移测试与真实 MySQL 升级都能推进到 head。

## 遗留

- 真实 MySQL 迁移、真实外部 MCP Server 联调、真实模型与多实例容量不在本轮，归部署/真实环境验收。
- 管理端前端尚未展示 MCP 调用审计与外部 Server 配置页（接口已就绪，前端接入下期）。
