// MCP 调用审计（T-17 N-01，US-18 / AG-R03）：记录客户端、工具、参数与结果
// 摘要、状态、耗时、trace——只存受控脱敏摘要，不存完整原文与凭证（C-07/C-08）。
// N-04：持久化实现把同结构摘要写入后端 mcp_call_logs；写入失败只记日志，不影响调用结果。
import { buildSummary } from "../observability/sensitive.js";
import type { McpCallAuditBody } from "../internal-client.js";
import { asTraceId } from "../types/index.js";

export interface McpCallAuditRecord {
  event: "mcp_tool_call";
  client: string;
  tool: string;
  status: "succeeded" | "failed" | "denied" | "unregistered";
  args_summary: string;
  result_summary: string | null;
  error_summary: string | null;
  duration_ms: number;
  trace_id: string;
}

export interface McpRequestRejectedRecord {
  event: "mcp_request_rejected";
  client: string;
  reason: "rate_limited";
  limit_per_minute: number;
  trace_id: string;
}

export interface McpCallAudit {
  record: (record: McpCallAuditRecord) => void;
  /** 请求层拒绝（如限流）审计；旧实现可不提供 */
  recordRejected?: (record: McpRequestRejectedRecord) => void;
}

/** 默认实现：结构化日志（stderr），供运维采集；测试注入内存实现 */
export const consoleMcpCallAudit = (): McpCallAudit => ({
  record: (record) => {
    console.error(JSON.stringify(record));
  },
  recordRejected: (record) => {
    console.error(JSON.stringify(record));
  },
});

export interface McpCallPersister {
  recordMcpCall(body: McpCallAuditBody, traceId: ReturnType<typeof asTraceId>): Promise<unknown>;
}

/**
 * 持久化审计（T-17 N-04）：异步写入后端，失败只记录事件名，绝不阻塞或改变 MCP 调用结果。
 * 传入客户端必须是服务级 InternalClient（只带服务 token，不携带用户身份）。
 */
export const createPersistedMcpCallAudit = (client: McpCallPersister): McpCallAudit => {
  const write = (body: McpCallAuditBody): void => {
    void client.recordMcpCall(body, asTraceId(body.trace_id)).catch(() => {
      console.error(JSON.stringify({ event: "mcp_audit_persist_failed", tool: body.tool_name }));
    });
  };
  return {
    record: (record) => {
      write({
        client_name: record.client, tool_name: record.tool, status: record.status,
        args_summary: record.args_summary, result_summary: record.result_summary,
        error_summary: record.error_summary, duration_ms: record.duration_ms,
        trace_id: record.trace_id,
      });
    },
    recordRejected: (record) => {
      write({
        client_name: record.client, tool_name: "*", status: "rejected",
        args_summary: "", error_summary: record.reason, duration_ms: 0,
        trace_id: record.trace_id,
      });
    },
  };
};

export const summarizeArgs = (args: unknown): string =>
  buildSummary(JSON.stringify(args ?? {}), 200);

export const summarizeResult = (result: unknown): string =>
  buildSummary(JSON.stringify(result ?? null), 200);

export const summarizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  // 底层异常可能带后端响应片段：统一脱敏截断，不透传原始内容
  return buildSummary(message, 200);
};
