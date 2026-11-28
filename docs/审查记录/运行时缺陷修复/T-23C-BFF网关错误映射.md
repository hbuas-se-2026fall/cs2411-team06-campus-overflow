# T-23C BFF 网关错误映射

日期：2026-11-28
范围：R-003 / ADR-012 / BUG-003（P1）

## 设计依据

- `specs/requirements/R-003-runtime-defect-fixes.md` 第 3 节与第 9 节：上游连接失败 502、超时 504；普通接口 60s、导出接口 300s；统一结构、trace、脱敏。
- `docs/decisions/ADR-012-运行时缺陷修复.md` 第 3 条：BFF 保留宽松超时，只有真实挂起返回 504。
- `.trae/rules/conventions.md`：前端交互必须能区分失败与重试；错误文案简体中文。

## 验证记录

- `npm test -- "src/app/api/backend/[...path]/route.test.ts"` → 8 passed（新增 2 项：连接失败 502、挂起超时 504）。
- `npx tsc --noEmit` → 通过。
- `npm run lint` → 通过。
- 手工验证：`BACKEND_ORIGIN=http://127.0.0.1:65530 npm run dev`，请求 `/api/backend/api/health` → `502`，响应体：
  `{"code":502,"data":null,"message":"上游服务暂不可用，请稍后重试"}`；Next 日志输出结构化 `bff_upstream_error`，含 trace id 与 `reason=network`，不含上游地址。
- 单元测试覆盖：502 与 504 均带 `x-trace-id`、`retry-after: 5`，错误消息不包含 `127.0.0.1` 或异常原文。

## 决策说明

- **超时口径**：普通接口 60s、导出接口（路径以 `/export` 结尾）300s，可用 `BACKEND_FETCH_TIMEOUT_MS` / `BACKEND_EXPORT_TIMEOUT_MS` 覆盖；通过多 worker/多线程扩容避免正常请求触达超时。
- **错误分类**：`TimeoutError` / `AbortError` → 504，其余 fetch 异常 → 502；后端正常 4xx/5xx 继续原样透传，不改变业务语义。
- **DOMException 兼容**：测试中发现 Node 的超时错误可能不是 `Error` 实例，若只用 `instanceof Error` 会误判为 502；改为读取 `name` 属性后 504 用例通过。
- **脱敏**：响应只给中文提示，上游地址、异常原文只进服务端结构化日志（`trace_id`、`route`、`reason`）。
- **未验证**：真实 4C4G + Nginx 前置下的 504 时长、浏览器端错误提示与重试交互。
