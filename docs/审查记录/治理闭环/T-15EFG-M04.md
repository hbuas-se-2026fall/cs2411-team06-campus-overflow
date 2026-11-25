# T-15-E/F/G 与 T-14 M-04 审查记录

日期：2026-11-24
范围：US-13 / US-14 / US-16 / C-07；T-15-E/F/G、T-14 M-04；文档一致性修复

## 设计依据

- `specs/spec.md` US-13（低风险仅打标、中高险建单）、US-14（七种处置，含要求修改）、US-16（申诉复核回退）。
- `specs/tasks.md` T-15-E/F/G、T-14 M-04 待办与既有 T-15-A～D 验收口径。
- `docs/后端架构说明.md` §4.C 双环决策、§6 工单状态机；`docs/接口设计指南.md` 管理员/内部接口路径。
- `.trae/rules/coding-style.md`：router → service → repository / domain，响应信封 `{code,data,message}`，字段蛇形；`conventions.md`：一个事实只写一处。

## 验证记录

- `uv run pytest tests/test_governance_internal.py tests/test_moderation_edit.py tests/test_patrol_mark.py tests/test_moderation_center.py -q` → 69 passed。
- `uv run ruff check app/modules/governance app/modules/qa tests` → 通过；`uv run lint-imports` → 5 contracts kept。
- Agent：`npm test -- tests/moderation-patrol.test.ts`、`tests/approvals-preview.test.ts tests/approval-waits.test.ts` 通过；`npm run typecheck` 通过。
- 迁移：新增 `t15_edit_action`、`t15_risk_mark`、`t14_legacy_memory_cleanup`（链在 `sa07c_system_settings` 之后），未在真实 MySQL 执行，随上线迁移批次验证。

## 决策说明

- `edit` 语义定为“置 `needs_revision` 并通知，内容保持可见，作者编辑后自动清除”；评论无作者编辑流程，决策匹配阶段直接 400。放弃“隐藏后重发”方案，避免与 hide 语义重叠。
- 低风险打标使用独立 `moderation_marks` 表（按目标唯一）而不是内容列：避免打标触发内容 `updated_at` 变化，同时保留 agent_run_id / trace_id 审计。
- M-04 直接删除 `/internal/agent/memory` 与 `agent_memory` 表：Agent 已不再调用，个人记忆按 C-07 由浏览器保存；管理员私人上下文继续走独立私有文件接口。
- 文档统一：`/api/governance` 501 旧描述改为真实接口清单；接口指南管理员路径改为 `/api/governance/*`、`/api/appeals`，内部记忆路径移除，打标/运行配置补充；清理 `后端架构说明.md` 中残留的冲突标记。
- 遗留：管理端前端尚未渲染 `edit` 动作按钮（API 已开放）；T-15 父任务仍需与 T-15-A～G 一并按批次收口；真实 MySQL 迁移待上线批次执行。
