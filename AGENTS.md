# AGENTS.md

本文件为 AI 编码代理（Trae / Claude Code / Codex 等）提供项目工作指引。

## 项目概述

CampusOverflow AI：面向高校课程场景的智能问答平台。三个服务物理分离：

| 服务 | 目录 | 技术 | 阶段 |
| ---- | ---- | ---- | ---- |
| 业务后端 | `campus-overflow-ai/backend/` | FastAPI + SQLAlchemy 2.x（同步 + PyMySQL）+ Alembic + MySQL（Python ≥ 3.11） | 一期完成，二期继续扩展 |
| 前端 | `campus-overflow-ai/frontend/` | Next.js 16（App Router）+ React 19 + TypeScript 5 + Tailwind CSS 4 + @ai-sdk/react（Agent 流式 UI） | 二期补完中 |
| Agent 服务 | `campus-overflow-ai/agent/` | TypeScript 5 + Vercel AI SDK 7 + Hono/Nitro + Workflow + Zod v4 + MCP Adapter（Node ≥ 24.0.0，ESM；2026-11-03随agent-browser升级） | 二期实施中，Workflow治理接线仍按WF分期 |

> **当前范围**：以 [specs/status.md](./specs/status.md) 为唯一进度源。当前为二期收尾 + 部署准备：T-01～T-17 已完成（T-16-C/D 于 2026-11-24 补齐，父任务已验收），T-19/T-20 已完成；剩余 F-C6、T-18 部署件与真实环境验收。旧 Q-08“本期只做业务后端”已失效。
> **角色模型**（spec v3）：RBAC 三角色 student / teacher / admin；助教不是独立角色——研究生身份且助教认证通过 → 助教能力位（`require_graduate_assistant`），解锁学生端助教板块（US-20）。

文档与规格：`specs/`（constitution/spec/plan/tasks/status/analyze）、`docs/`（需求、架构、决策、审查记录）、`.trae/rules/`（工程规则与需求流程）。当前状态只看 `specs/status.md`，决策只看 `docs/decisions/`。

**遇事原则**：对需求、架构、接口、流程有任何不清楚的地方，先查 `docs/` 下的相关文档；文档仍无法解答时，直接向用户提问确认，不要自行猜测。

## 工作流程（规格驱动，必须遵守）

需求入口与 DoR/DoD 见 [requirement-process.md](./.trae/rules/requirement-process.md)。规格执行路径：`constitution → specify → clarify → plan → tasks → analyze → implement`，详见 [docs/workflow.md](./docs/workflow.md)。

- **spec.md 只写需求（WHAT）**，禁止写入技术实现细节；实现方案只能进 plan.md。
- **宪法（constitution.md）优先级最高**，与任何文档或代码冲突时以宪法为准。
- **修改 spec / plan / tasks 后，进入 implement 前必须重跑一致性分析**（specs/analyze.md）。
- **tasks.md 严格按 Phase 顺序执行**，每完成一项打勾；失败时回改上游文档，不跳过。当前执行以 `specs/status.md` 与 tasks.md 勾选为准。
- **一个事实只写一处**：进度只写 `status.md`，决策只写 `docs/decisions/`，规则不追加历史状态。
- **新需求先走共创协议**：默认按七问 grill 用户，整理成 `specs/requirements/R-XXX-<slug>.md`，确认后才开工；仅用户明确说“跳过七问”的小修可豁免。
- **快捷命令**：`/spec <任务号>` 等价于 `/speckit.implement <任务号>`，默认上下文为 AGENTS.md、specs/、docs/（按需），收尾动作为勾选 `specs/tasks.md`；细则见 [docs/workflow.md](./docs/workflow.md) "快捷命令 /spec" 一节。

## 增量开发纪律（implement 阶段必须遵守）

> 目的：让设计、验证与决策可解释、可追溯。

1. **写前披露文档**：每次写代码前，先找出并通读本次任务涉及的 `.md`（`specs/`、`docs/`、`.trae/rules/`），在动手前的回复中明确列出"读了哪些文档、实现依据其中哪几条"，读完才开始写。文档无法解答的按"遇事原则"先问用户。
2. **小步快跑**：每完成一个小板块（一个函数、一个接口、一张表迁移）立即验证——只跑冒烟：按改动范围执行相关测试（后端 `uv run pytest tests/test_<改动模块>.py`，前端/Agent `npm test -- <改动相关测试文件>`）+ 所属服务 lint（涉及表结构另跑 `uv run alembic upgrade head`）；全量测试留给 CI（推送远端 / 提 PR / 批次收口前必须 CI 绿）——通过后即按 `<type>: <简短中文描述>` 提交一次；多次小提交，不攒大 diff。
3. **审查节点与记录**：每完成一小块即停下等待用户审查，不得连续推进多个板块；审查通过后将记录写入 `docs/审查记录/<板块名>/` 下相应的 markdown 文档，至少含三节：
   - **设计依据**：读了哪些文档、需求落到哪几条（US/E/Q 编号）；
   - **验证记录**：执行的命令与结果摘要（测试数、lint 结果、迁移结果）；
   - **决策说明**：关键决策为什么这么做、放弃了哪些替代方案、遗留什么限制。

## 硬性约束（违反即返工）

1. **Agent 服务不直接连接业务 MySQL**，业务数据只能调用 FastAPI 的 `/internal/agent/*` 白名单接口。2026-11-01用户同意独立PostgreSQL仅作Workflow运行状态、队列及必要恢复数据存储（C-05例外），不授予业务权限或替代MySQL真值；Markdown/Wiki仅作知识参考。（T-11/T-12 已生效，WF生产存储尚未启用）
2. **高风险操作**（删帖、封号、内容隐藏）：第一期由管理员直接执行并写入审计日志（封禁已在 T-02 实现）；第二阶段起 AI 相关高风险动作只能由 Agent 创建"待确认工单"，由人工确认后执行（C-06）。
3. **MCP 工具必须白名单注册**，不得绕过 FastAPI 直接修改核心业务数据。（第二阶段生效）
4. **个人记忆按账号和来源隔离并可清空**，不得把密码、密钥、隐私原文写入 memory。2026-10-29 用户修订 C-07：管理员自己的记忆和会话改为服务器私有文件保存，与大系统中台接入会话分目录并做来源/客户端授权隔离；学生/教师仍浏览器保存。新增服务端私人上下文GL-07已本地实现，真实环境验收归GL-06；旧后端memory表不自动代表新方案。公共Wiki与运行审计仍由后端持久化。
5. **Agent run / tool call / approval request 必须可追踪**，至少保留 trace id、agent_run_id 和调用摘要。（T-12 已有基础表与写入接口；管理端检索与完整观测归 T-16）
6. 界面文案使用简体中文。（一期指后端错误消息与接口描述文案）
7. 规则必须是可检查的：代码需通过 `ruff check`（后端）、`eslint`（前端/Agent）零 error。
8. 核心流程必须有测试：后端 pytest、前端与 Agent vitest。（编写要求不变；执行分层为开发期冒烟、CI 全量，见 [.trae/rules/coding-style.md](./.trae/rules/coding-style.md) "测试执行分层"）
9. **子 Agent 上下文隔离**：Agent 采用主 Agent 编排 + 子 Agent 池，每实例最多 8 个（3 治理 + 5 问答）；任务间不得共享可变上下文、凭证、会话或工具授权，槽位复用必须整体重建；子 Agent 不写共享记忆，外部执行走沙箱。（C-09；设计见 plan AX-R09；SA-01/02B/06 已落地，SA-03/04/05 待生产验收，状态以 `specs/tasks.md` 为准）

## 常用命令

> 各依赖包的用途与版本约束见 [docs/依赖说明.md](./docs/依赖说明.md)。三个服务命令均为现行命令。

```bash
# 后端（campus-overflow-ai/backend/，uv 环境）
uv venv                          # 首次：创建 .venv
uv pip install -e ".[dev]"       # 安装依赖
uv run pytest                    # 测试
uv run ruff check .              # Lint
uv run lint-imports              # 架构依赖契约检查（分层基线 D-6，违规即返工）
uv run uvicorn app.main:app --reload    # 启动开发服务器

# 前端（campus-overflow-ai/frontend/）
npm install && npm run dev       # 启动开发服务器
npm test                         # 测试
npm run lint                     # Lint

# Agent 服务（campus-overflow-ai/agent/）
npm install && npm run dev       # 启动开发服务器
npm test                         # 测试
npm run lint                     # Lint
```

## 目录约定

- 后端采用轻量模块化单体，6 个业务模块：identity / courses / qa / interaction / discovery / governance，每模块统一结构 `router.py / service.py / domain.py / repository.py / models.py / schemas.py`（4.5 层：router → service → domain/repository → models；**domain/service 是基座**——domain 零框架依赖、规则集中、设计后冻结；**models 只被本模块 repository import**；discovery 为纯读模块无 domain/repository/models；governance 一期仅建表 + 501 占位；分层规则详见 [docs/后端架构/分层架构设计基线.md](./docs/后端架构/分层架构设计基线.md)，由 `uv run lint-imports` 强制）。
- **后端目录与结构以 [docs/后端架构说明.md](./docs/后端架构说明.md) 第 7 节为权威**。6 个业务模块均已落地；governance 当前同时承载一期 501 治理占位和 T-12 Agent 内部白名单接口/持久化基础表，T-15 再启用治理业务逻辑。
- 前端采用三端路由（学生端根路由 / `teacher/**` / `admin/**`）+ BFF 转发（`src/app/api/backend/[...path]`、`src/app/api/agent/[...path]`），页面已进入代码基线并按专项清单补完。Agent 工具注册在 `agent/src/tools/registry.ts`，后端访问统一经 `agent/src/internal-client.ts`；`agent/src/orchestrator/` 放槽位调度与运行上下文装配，`agent/src/agents/` 放子 Agent 执行入口；MCP、记忆、审批与观测目录分别作为 T-17/T-14/T-15/T-16 的扩展点（详见 docs/项目骨架分析.md）。

## 代码风格

遵循 [.trae/rules/coding-style.md](./.trae/rules/coding-style.md) 与 [.trae/rules/conventions.md](./.trae/rules/conventions.md)：Python 蛇形、TS 小驼峰（各语言惯例）、函数不超过 80 行、禁止空 catch、注释用简体中文、只对非自明逻辑注释；**接口字段一律蛇形**（2026-09-20 定案，见 docs/接口设计指南.md）。
