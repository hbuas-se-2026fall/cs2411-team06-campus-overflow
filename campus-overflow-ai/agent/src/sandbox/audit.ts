// P0-4：把沙箱审计事件经 FastAPI 内部白名单接口持久化（C-05）。
// 旁路语义：不等审计、不改写执行结果；失败只写结构化日志，不落参数与响应正文。
import { randomUUID } from "node:crypto";

import {
  createInternalClient,
  resolveInternalConfig,
  type SandboxAuditRecorder,
} from "../internal-client.js";
import { asTraceId } from "../types/index.js";
import type { SandboxAuditSink } from "./executor.js";

export const SANDBOX_AUDIT_TIMEOUT_MS = 5_000;

interface Options {
  /** 测试注入点；默认每次按当前环境变量创建服务凭证客户端。 */
  createRecorder?: () => SandboxAuditRecorder;
}

const defaultRecorder = (): SandboxAuditRecorder => createInternalClient({
  ...resolveInternalConfig(),
  fetchImpl: fetch,
  // 单次上报独立截止，避免长期复用的 signal 在 5 秒后失效
  signal: AbortSignal.timeout(SANDBOX_AUDIT_TIMEOUT_MS),
});

/**
 * 后端审计 sink：只发送交叉接口契约字段（不含参数、URL、stderr、凭据）。
 * trace 缺失时生成本地 trace，保证后端记录可检索；返回 Promise 供测试等待，
 * 执行器不会等待它。
 */
export const createBackendSandboxAudit = (options: Options = {}): SandboxAuditSink => event => {
  const recorder = (options.createRecorder ?? defaultRecorder)();
  const traceId = asTraceId(event.trace_id ?? randomUUID());
  return recorder.recordSandboxEvent(event, traceId).then(
    () => undefined,
    () => {
      console.error(JSON.stringify({
        event: "sandbox_audit_delivery_failed",
        outcome: event.outcome,
        tool: event.tool,
        reason_code: event.reason_code ?? null,
        trace_id: event.trace_id,
      }));
    },
  );
};
