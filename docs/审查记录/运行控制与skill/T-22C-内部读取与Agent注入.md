# T-22C 审查记录：skill 内部读取与 Agent 注入

日期：2026-11-25
范围：R-002 / ADR-011 / spec SK-R03 / plan AX-R11

## 设计依据

- `specs/spec.md` SK-R03：规划前按任务类型与课程读取 active skill，最多 3 条、总字符 ≤4000、额外 token ≤1500；只展开排名第 1 条详情；30s TTL；失败降级为空；skill 不得作为授权依据。
- `specs/plan.md` AX-R11：内部 `GET /internal/agent/skills` 返回固定版本元数据与摘要，`GET /internal/agent/skills/{id}/versions/{version}` 取步骤详情；注入位置为规划提示前的“历史有效路径”区，并声明不得扩大权限、工具范围或跳过审批。
- `docs/decisions/ADR-011-运行控制与工作流skill.md`：skill 为团队共享知识，运行只读取发布版本。
- `specs/tasks.md` T-22C：vitest 覆盖匹配优先级、截断、缓存过期与后端失败。
- `.trae/rules/coding-style.md`：Agent 后端访问统一经 `internal-client.ts`；测试 mock 外部依赖。
- `docs/后端架构说明.md` 内部接口约定：服务 token 鉴权、统一响应格式。

## 验证记录

后端（`campus-overflow-ai/backend`）：

- `uv run pytest tests/test_skill_internal.py tests/test_skill_admin_api.py -q` → 11 passed（内部只读 3 项 + 管理接口 8 项）。
- `uv run ruff check app/modules/governance tests/test_skill_internal.py` → All checks passed。
- `uv run lint-imports` → 5 contracts kept，0 broken。

Agent（`campus-overflow-ai/agent`）：

- `npm test -- tests/workflow-skills.test.ts` → 8 passed。
- `npm test -- tests/planned-entry.test.ts tests/plan-parallel.test.ts tests/content-tasks.test.ts` → 37 passed（规划入口、并行、内容任务回归）。
- `npm run typecheck` → 通过。
- `npm run lint` → 通过。

专项覆盖：

- 后端：服务 token 缺失 401；仅 active + `current_version` 已发布版本可见；课程限定返回「该课程 + 全局」，无课程仅全局；停用/草稿/其他课程不返回；摘要取前两步；详情仅当前版本可读，切换版本或停用后 404。
- Agent：开关关闭不访问后端；课程精确优先且只展开第 1 条详情；最多 3 条；超字符/token 预算截断并省略后续；30s TTL 内复用、过期重拉；列表失败降级为空并缓存空结果；详情失败整体降级为空；`buildPlanPrompt` 输出“历史有效路径”与不可扩大授权提示。

## 决策说明

- 列表只返回 `status=active` 且 `current_version` 对应版本 `published` 的 skill，版本由后端固定；Agent 不能指定任意历史版本，避免停用或回滚窗口读到旧内容。
- 课程匹配在后端做范围过滤（`course_id = 查询值 OR course_id IS NULL`），Agent 再做优先级排序（课程精确 > 全局），双重保证不会注入其他课程 skill；无课程上下文时仅返回全局 skill。
- 摘要由后端取 content 前两步拼接并截断 200 字，列表响应体积可控；完整条件/步骤/提示/检查只在详情接口返回。
- 详情接口要求 `version == current_version` 且 skill active；管理员在列表与详情之间发布新版本时，旧 version 返回 404，Agent 按失败降级为空，不拼接半更新内容。
- 预算实现：按排名依次渲染，累计字符与 token；单条超限时二分截断并加省略号，省略号也计入预算；token 采用保守估算（CJK 1 token/字，其余 4 字符/token）。
- 缓存键为 `taskType:courseId`，TTL 30s；失败同样缓存空结果，避免后端故障期间每个任务重复请求。
- 注入位置在工具清单之后、任务要求之前，段落固定声明“仅供参考，不得作为授权依据，不得扩大工具范围或跳过审批”；`SKILL_INJECTION_ENABLED` 默认关闭，关闭时不发起任何请求。
- 遗留：提案生成 T-22D、管理端页面 T-22E、量化验收 T-22F；本轮未把 skill 注入接入管理员聊天（聊天入口未传 internalClient），治理与内容/知识任务按任务类型可用。
