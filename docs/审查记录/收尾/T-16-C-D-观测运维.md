# T-16-C/D 观测运维收口（2026-11-24）

## 设计依据

- 已读：`specs/tasks.md`（T-16 父任务与 C/D 登记）、`specs/status.md`、`specs/constitution.md`（C-05/C-08）、`docs/接口设计指南.md`（内部接口与响应口径）、`.trae/rules/coding-style.md`（分层与测试分层）。
- 需求落点：US-18（Agent 治理观测）、C-08（run / tool call / approval 可追踪）。
- 边界：仍由业务后端承担持久化与运维；Agent 不直连数据库；导出与清理都不改变业务写入路径。

## 实现摘要

### T-16-C OTLP/HTTP 追踪导出

- 新增 `backend/app/core/otel.py`：未配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 时完全禁用、零开销；启用后由后台队列 + 单导出线程发送 `/v1/traces`，失败只记 `otel_export_failed`，不影响响应。
- 新增 `OtelTraceMiddleware` 并在 `main.py` 注册：每请求导出单 span，属性含 `http.method`、`http.route`、`http.status_code`、`trace.id`、可选 `agent_run.id`；`/health`、`/api/health` 默认跳过；非 32 位十六进制 trace id 以 sha256 稳定映射。
- 取舍：不新增 OpenTelemetry SDK 依赖，直接实现 OTLP/HTTP JSON；采样率与采集器地址留给部署环境配置。

### T-16-D 运行记录归档与清理

- 新增 `backend/app/modules/governance/repository_retention.py`：只返回普通字典的归档读取与按外键顺序删除（事件 → 工具调用 → 运行）。
- 新增 `backend/app/ops/agent_runs_retention.py`：默认保留 90 天（`agent_run_retention_days`），只处理 `succeeded` / `failed`，`running` 一律保留；默认先写 JSONL 并 `fsync` 再删除，未配置归档目录必须显式 `--purge-without-archive`；支持 `--dry-run`、分批与幂等。
- 配置项：`agent_run_retention_days`、`agent_run_archive_dir`。
- 归档内容只含运行/事件/工具调用的元数据，不含模型原文与凭据。

## 验证记录

```text
uv run pytest tests/test_otel_export.py tests/test_agent_runs_retention.py -q
→ 10 passed（OTel 6 项：默认关闭/标准 trace 保留/payload 结构/入队导出/发送失败吞掉/中间件导出且跳过 health；
  retention 4 项：归档后删除且保留 recent 与 running、dry-run 不写不删、无归档目录拒绝、二次执行为空操作）

uv run ruff check .
→ All checks passed!

uv run lint-imports
→ 5 contracts kept, 0 broken
```

未验证：真实 OTLP 采集器连通性、生产采样策略、真实 MySQL 上的定时调度与归档存储容量；本轮未重跑后端全量（改动仅新增文件 + main 中间件注册，专项与静态检查覆盖）。

## 决策说明

- 用后台队列而非同步发送：避免采集器抖动拖慢业务请求；队列满时丢弃并记事件，符合“观测不阻塞业务”。
- 用 JSONL 归档而非入库：运维脚本不引入新表，归档文件可直接转冷存储；删除前强制归档，避免证据不可恢复。
- 拒绝“未归档直接删”的默认行为：运行审计是 C-08 证据，只能由运维显式承担删除风险。
- 遗留：采集器地址、采样率、定时任务（Cron/系统计划任务）与归档保留周期归 T-18 部署验收。
