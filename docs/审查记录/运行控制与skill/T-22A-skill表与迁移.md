# T-22A 审查记录：工作流 skill 表与迁移

日期：2026-11-25
范围：R-002 / ADR-011 / spec SK-R01～SK-R05 / plan AX-R11

## 设计依据

- `specs/spec.md` SK-R02：skill 含适用条件、步骤序列、提示要点、检查清单与阈值，可限定任务类型与课程；每次发布生成新版本，运行读取固定版本。
- `specs/spec.md` SK-R04：管理员可列表、新增、编辑、启停、删除、发布与回看版本；删除采用归档，不影响历史运行记录。
- `specs/plan.md` AX-R11：`workflow_skills`（name/task_type/course_id/status/current_version）与 `workflow_skill_versions`（skill_id+version、content JSON、source_run_id、status、发布者与时间）。
- `docs/decisions/ADR-011-运行控制与工作流skill.md`：skill 存后端并版本化，AI 只提案、管理员发布，归档不删除版本。
- `specs/tasks.md` T-22A：迁移可执行、版本唯一、归档不破坏历史引用。
- `.trae/rules/coding-style.md`：表结构变更走 Alembic；SQLAlchemy 2.x 声明式模型。
- `.trae/rules/conventions.md`：证据写本目录，进度只写 `status.md`。

## 验证记录

后端（`campus-overflow-ai/backend`）：

- `uv run pytest tests/test_workflow_skills.py -q` → 4 passed。
- `uv run alembic upgrade head` → `rc02_system_commands -> sk01_workflow_skills` 升级成功。
- `uv run ruff check app/modules/governance/models.py tests/test_workflow_skills.py alembic/versions/sk01_workflow_skills.py` → All checks passed。
- `uv run lint-imports` → 5 contracts kept，0 broken。

专项覆盖（`tests/test_workflow_skills.py`）：

1. 同一 skill 下重复 `version` 触发主键唯一约束（`IntegrityError`），原版本内容保留；
2. 不同 skill 可使用相同 `version` 编号，互不冲突；
3. skill 归档后 `status=archived`，`current_version` 与全部版本行仍在，历史内容与 `source_run_id` 可读；
4. 隔离 SQLite 上执行 `sk01_workflow_skills` 升级/降级，确认两表与 `(skill_id, version)` 复合主键，降级可完整回退。

## 决策说明

- 版本唯一用复合主键 `(skill_id, version)` 承担，不额外加唯一索引；发布新版本时由 T-22B 递增版本并更新 `current_version`。
- `workflow_skills.current_version` 可空：草稿尚未发布时没有可注入版本；发布后指向 `workflow_skill_versions.version`，运行读取固定版本，避免半更新。
- `workflow_skill_versions.content` 用 JSON 保存条件/步骤/提示/检查/阈值，字段结构与 plan AX-R11 一致；不把 skill 文本拆列，便于整版本回看。
- `source_run_id` 只存 Agent 运行 id 并加索引，不设外键：运行记录归档或清理后，历史 skill 版本仍可读，符合 SK-R04“归档不影响历史引用”。
- 删除为归档：只改 `workflow_skills.status`，不级联删除版本行；`status` 索引与 `(task_type, status)`、`course_id` 索引服务后续内部匹配查询（T-22C）。
- 遗留：管理 CRUD/发布/启停属 T-22B；内部读取与 Agent 注入属 T-22C；提案生成 T-22D；管理端页面 T-22E；量化验收 T-22F。本轮不新增开关，`SKILL_INJECTION_ENABLED` 仍默认关闭。
