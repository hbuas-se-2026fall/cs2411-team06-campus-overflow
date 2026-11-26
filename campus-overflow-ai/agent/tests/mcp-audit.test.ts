// T-17 N-04：MCP 调用审计持久化——摘要字段映射、限流拒绝记录、失败不阻塞调用。
import { describe, expect, it, vi } from "vitest";

import { createPersistedMcpCallAudit } from "../src/mcp/audit";

describe("MCP 持久化审计", () => {
  it("成功调用按脱敏摘要异步写入后端", async () => {
    const recordMcpCall = vi.fn().mockResolvedValue({ id: 1, status: "succeeded" });
    const audit = createPersistedMcpCallAudit({ recordMcpCall });
    audit.record({
      event: "mcp_tool_call", client: "campus-portal", tool: "search_questions",
      status: "succeeded", args_summary: '{"keyword":"死锁"}', result_summary: "2 条",
      error_summary: null, duration_ms: 8, trace_id: "mcp-trace-1",
    });
    await vi.waitFor(() => expect(recordMcpCall).toHaveBeenCalledOnce());
    expect(recordMcpCall.mock.calls[0][0]).toEqual({
      client_name: "campus-portal", tool_name: "search_questions", status: "succeeded",
      args_summary: '{"keyword":"死锁"}', result_summary: "2 条", error_summary: null,
      duration_ms: 8, trace_id: "mcp-trace-1",
    });
    expect(recordMcpCall.mock.calls[0][1]).toBe("mcp-trace-1");
  });

  it("限流拒绝记录为 rejected，工具名使用通配", async () => {
    const recordMcpCall = vi.fn().mockResolvedValue({ id: 2, status: "rejected" });
    const audit = createPersistedMcpCallAudit({ recordMcpCall });
    audit.recordRejected?.({
      event: "mcp_request_rejected", client: "campus-portal", reason: "rate_limited",
      limit_per_minute: 60, trace_id: "mcp-trace-2",
    });
    await vi.waitFor(() => expect(recordMcpCall).toHaveBeenCalledOnce());
    expect(recordMcpCall.mock.calls[0][0]).toMatchObject({
      client_name: "campus-portal", tool_name: "*", status: "rejected",
      error_summary: "rate_limited", trace_id: "mcp-trace-2",
    });
  });

  it("后端不可用时只记录事件，不向调用方抛错", async () => {
    const recordMcpCall = vi.fn().mockRejectedValue(new Error("backend down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const audit = createPersistedMcpCallAudit({ recordMcpCall });
    expect(() => audit.record({
      event: "mcp_tool_call", client: "campus-portal", tool: "list_tags", status: "failed",
      args_summary: "", result_summary: null, error_summary: "tool failed",
      duration_ms: 1, trace_id: "mcp-trace-3",
    })).not.toThrow();
    await vi.waitFor(() => expect(recordMcpCall).toHaveBeenCalledOnce());
    error.mockRestore();
  });
});
