// T-17 N-05：MCP 增量同步工具——入参校验、参数映射与只读 scope。
import { describe, expect, it, vi } from "vitest";

import type { InternalClient } from "../src/internal-client";
import { McpToolRegistry } from "../src/mcp/registry";
import { ensureReadOnlyMcpTools } from "../src/mcp/tools";

const client = () => ({
  syncQuestions: vi.fn().mockResolvedValue({
    items: [{ id: 7, title: "问题", course_id: 1, created_at: "2026-01-01T00:00:00",
      updated_at: "2026-01-02T00:00:00" }],
    next_cursor: 7, has_more: false,
  }),
}) as unknown as InternalClient;

describe("MCP sync_questions", () => {
  it("按入参映射后端增量查询并返回游标", async () => {
    const fake = client();
    const registry = new McpToolRegistry();
    ensureReadOnlyMcpTools(registry, fake);
    const tool = registry.getTool("sync_questions")!;
    expect(tool.scope).toBe("read");
    const result = await tool.execute(
      { updated_after: "2026-01-01T00:00:00Z", cursor: 3, limit: 50 },
      { clientName: "campus-portal", traceId: "mcp-trace-sync", signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ next_cursor: 7, has_more: false });
    expect(fake.syncQuestions).toHaveBeenCalledWith(
      { updatedAfter: "2026-01-01T00:00:00Z", cursor: 3, limit: 50 },
      "mcp-trace-sync",
    );
  });

  it("拒绝非法时间与超上限的批大小", () => {
    const registry = new McpToolRegistry();
    ensureReadOnlyMcpTools(registry, client());
    const tool = registry.getTool("sync_questions")!;
    expect(() => tool.validate({ updated_after: "not-a-date" })).toThrow();
    expect(() => tool.validate({ updated_after: "2026-01-01T00:00:00Z", limit: 201 })).toThrow();
  });
});
