// T-17 N-06/N-07：外部 MCP 客户端——配置白名单、低风险工具执行、高风险建单不执行。
import { describe, expect, it, vi } from "vitest";

import {
  createUpstreamMcpTools,
  loadUpstreamServers,
  requestUpstreamToolCall,
  type UpstreamCaller,
} from "../src/mcp/upstream";
import type { InternalClient } from "../src/internal-client";

const server = (overrides: Record<string, unknown> = {}) => ({
  name: "campus-portal",
  url: "https://mcp.example.com/mcp",
  tools: [
    { name: "read_notice", risk: "low" },
    { name: "publish_notice", risk: "high", confirmed: true },
  ],
  ...overrides,
});

describe("外部 MCP 配置", () => {
  it("未配置时为空；非法 JSON/重复名/非 http 协议直接失败", () => {
    expect(loadUpstreamServers(undefined)).toEqual([]);
    expect(() => loadUpstreamServers("{oops")).toThrow("不是合法 JSON");
    expect(() => loadUpstreamServers(JSON.stringify([
      server(), server({ name: "campus-portal" }),
    ]))).toThrow("服务名重复");
    expect(() => loadUpstreamServers(JSON.stringify([
      server({ url: "ftp://mcp.example.com" }),
    ]))).toThrow("http/https");
  });

  it("未标注 risk 默认按高风险处理", () => {
    const [parsed] = loadUpstreamServers(JSON.stringify([
      server({ tools: [{ name: "unknown_tool" }] }),
    ]));
    expect(parsed.tools[0]).toMatchObject({ risk: "high", confirmed: false });
  });
});

describe("外部 MCP 工具装配", () => {
  it("低风险注册为可执行工具；高风险只登记元信息，不暴露给模型", async () => {
    const caller: UpstreamCaller = { call: vi.fn().mockResolvedValue({ content: "notice" }) };
    const tools = createUpstreamMcpTools(loadUpstreamServers(JSON.stringify([server()])), caller);
    const low = tools.find(tool => tool.name === "mcp_campus-portal_read_notice")!;
    const high = tools.find(tool => tool.name === "mcp_campus-portal_publish_notice")!;
    expect(low.riskLevel).toBe("low");
    expect(high.riskLevel).toBe("high");
    expect(high.execute).toBeUndefined();
    await expect(low.execute!({ page: 1 }, {} as never)).resolves.toEqual({ content: "notice" });
    expect(caller.call).toHaveBeenCalledWith(
      expect.objectContaining({ name: "campus-portal" }), "read_notice", { page: 1 },
    );
  });

  it("禁用的 Server 不注册任何工具", () => {
    const tools = createUpstreamMcpTools(
      loadUpstreamServers(JSON.stringify([server({ enabled: false })])),
    );
    expect(tools).toEqual([]);
  });
});

describe("高风险外部工具人工确认", () => {
  const approvalClient = () => ({
    createApproval: vi.fn().mockResolvedValue({ id: 31, status: "pending" }),
  }) as unknown as InternalClient;

  it("高风险工具只创建待确认工单，不调用外部", async () => {
    const caller: UpstreamCaller = { call: vi.fn() };
    const client = approvalClient();
    const result = await requestUpstreamToolCall(
      client, loadUpstreamServers(JSON.stringify([server()])),
      { server: "campus-portal", tool: "publish_notice", arguments: { text: "公告" } },
      "mcp-trace-approval", caller,
    );
    expect(result).toEqual({ status: "approval_required", case_id: 31 });
    expect(caller.call).not.toHaveBeenCalled();
    expect(client.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: "call_mcp_tool", risk_level: "high", target_type: "mcp_tool",
      }),
      "mcp-trace-approval",
    );
  });

  it("低风险工具经管理员通道直接执行", async () => {
    const caller: UpstreamCaller = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const result = await requestUpstreamToolCall(
      approvalClient(), loadUpstreamServers(JSON.stringify([server()])),
      { server: "campus-portal", tool: "read_notice" }, "mcp-trace-low", caller,
    );
    expect(result).toEqual({ status: "executed", result: { ok: true } });
  });

  it("未配置的工具直接拒绝", async () => {
    await expect(requestUpstreamToolCall(
      approvalClient(), loadUpstreamServers(JSON.stringify([server()])),
      { server: "campus-portal", tool: "missing" }, "mcp-trace-missing",
    )).rejects.toThrow("未配置的外部 MCP 工具");
  });
});
