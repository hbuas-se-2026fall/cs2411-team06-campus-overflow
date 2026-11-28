# R-004 Phase 0 复验与申诉入口修复

日期：2026-11-28
依据：`specs/requirements/R-004-acceptance-remediation.md`、反馈 `z_测试反馈/acceptance-review/`、spec E-04/US-16

## 设计依据

- 反馈把“接口成功但数据库副作用未闭环”统一判失败，需先区分真实缺陷与测试口径。
- spec E-04：同一内容重复投票保持唯一有效票，允许修改或取消；同值再次提交即取消。
- 申诉后端规则：存在本人已执行处置工单即可申诉，与账号是否 banned 无关；页面原先只允许 banned。

## 验证记录

- `uv run pytest tests/test_answer_certification.py tests/test_interaction_votes.py -q` → **81 passed**。
  - 认证：`test_sources_coexist_and_cancel_independently` 在请求后 `expire_all` 查库，teacher/assistant 标记均正确。
  - 投票：`test_toggle_same_direction_cancels` 断言同值第二次提交后 `question_votes` 为 0、票分为 0；`test_switch_vote_keeps_single_row` 断言改票保留一行。
- 结论：反馈中的 BUG-CERT 与 BUG-VOTE 为**测试口径/事务快照误判**，代码无需修改；验收断言应改为新连接查询与 toggle 语义。
- 申诉：`docker compose config --quiet` 退出码 0；后端 `test_moderation_center.py` 9 项通过，覆盖：
  - 无关用户 `can_appeal=false / no_case`；
  - 本人 `can_appeal=true` 且返回 `case_id`；
  - 提交后 `can_appeal=false / pending`。
- 前端 `AppealFormView` 10 项通过，`tsc --noEmit`、`eslint` 通过；非封禁但有可申诉工单时展示表单与工单号。
- 端口边界：`backend` 改为 `127.0.0.1:${BACKEND_PORT}:8000`，Compose 解析确认 `host_ip=127.0.0.1`，公网入口只剩 Nginx。

## 决策说明

- 认证/投票不改代码，避免把符合 spec 的实现改坏；只修验收断言。
- 申诉采用新增只读接口 `GET /api/appeals/eligibility`，页面先预检再决定展示表单；比“前端放开、提交再报错”体验更稳定。
- 原验收脚本 `tests/acceptance/` 不在当前工作区，160 条全量重跑暂无法执行；本轮只交付可复核的 pytest 证据与重分类结论。
- 遗留：混合旅程 100 VU 正式压测、部署升级/回滚/恢复演练（目标环境）、完整 160 条重跑。
