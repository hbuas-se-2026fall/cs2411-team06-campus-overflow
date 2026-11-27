# T-23A 多 worker 与连接池

日期：2026-11-27
范围：R-003 / ADR-012 / BUG-001（P1）

## 设计依据

- `specs/requirements/R-003-runtime-defect-fixes.md` 第 9 节：`workers = min(4, CPU//2, 内存GB)`，`WEB_CONCURRENCY` 可覆盖；每 worker 池 10+10；100 并发 60s 成功率 ≥99%、P95 ≤1.5s。
- `docs/decisions/ADR-012-运行时缺陷修复.md` 第 1 条：连接池等待超时映射 503，不再表现为客户端超时。
- `.trae/rules/coding-style.md`：冒烟测试 + 所属服务 lint。

## 验证记录

单测与静态检查：

- `uv run pytest tests/test_db_pool.py tests/test_db_pool_timeout.py tests/test_config_prod_guard.py -q` → 7 passed。
- `uv run ruff check app/db/session.py app/core/errors.py app/core/config.py tests/test_db_pool.py tests/test_db_pool_timeout.py` → All checks passed。
- `uv run lint-imports` → 5 contracts kept。

压测（本地 MySQL，`GET /api/courses`，100 并发、60s、单请求超时 30s）：

| 指标 | 修复前（单 worker，池 5+10） | 修复后（4 worker，池 10+10） |
| --- | --- | --- |
| 总请求 | 304 | 19994 |
| 成功 | 104（34.21%） | 19956（99.81%） |
| 超时 | 200 | 0 |
| 503 快速失败 | 0 | 38（0.19%） |
| RPS | 5.0 | 332.6 |
| P50 | 30012ms | 270.9ms |
| P95 | 30030ms | 378.9ms |
| P99 | 30032ms | 545.7ms |
| `QueuePool limit` 日志 | 158 条 | 0 条 |
| 连接池超时日志 | — | 38 条（与 503 数一致） |

复测命令：

```powershell
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 4
uv run --project backend python scripts/load_test.py `
  --url http://127.0.0.1:8000/api/courses --token-file "$env:TEMP\bench_token.txt" `
  --concurrency 100 --duration 60 --timeout 30 --min-success-rate 99 --max-p95-ms 1500
```

## 决策说明

- **容量口径**：每 worker `pool_size=10`、`overflow=10`；本地 16 核按公式封顶 4 worker，总连接 80；生产 4C4G 按公式为 2 worker、总连接 40，低于 MySQL 默认 151。
- **worker 计算**：放在 `backend/docker-entrypoint.sh`，读取 `nproc`（affinity）、cgroup v2 `memory.max` / v1 `memory.limit_in_bytes`；`WEB_CONCURRENCY` 显式设置时优先。
- **快速失败**：`sqlalchemy.exc.TimeoutError` 统一映射 503，返回 `reason_code=db_pool_timeout` 并记录 trace id；复测中 38 次瞬时饱和全部快速返回，无客户端超时。
- **最大延迟 6566.6ms**：单次池等待叠加慢请求的离群值，P95 仍为 378.9ms；未针对 `/api/courses` 做查询优化，不在本 Bug 范围。
- **未验证**：真实 Docker 镜像构建与 4C4G 容器运行、多 worker 下的 MySQL 总连接数实测、生产 Nginx 前置场景。
