import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchUpstreamMcpConfig: vi.fn(),
  callUpstreamMcpTool: vi.fn(),
}));

vi.mock("@/api/admin-mcp", () => ({
  fetchUpstreamMcpConfig: mocks.fetchUpstreamMcpConfig,
  callUpstreamMcpTool: mocks.callUpstreamMcpTool,
}));

import { AdminMcpUpstreamView } from "./AdminMcpUpstreamView";

const CONFIG = {
  servers: [
    {
      name: "knowledge",
      origin: "https://mcp.example.edu",
      enabled: true,
      tools: [
        { name: "lookup", risk: "low", confirmed: true, model_visible: true },
        { name: "publish", risk: "high", confirmed: true, model_visible: false },
      ],
    },
    {
      name: "disabled-server",
      origin: "https://disabled.example.edu",
      enabled: false,
      tools: [],
    },
  ],
};

beforeEach(() => {
  mocks.fetchUpstreamMcpConfig.mockReset().mockResolvedValue(CONFIG);
  mocks.callUpstreamMcpTool.mockReset().mockResolvedValue({
    status: "executed",
    result: { items: ["算法"] },
  });
});

afterEach(cleanup);

describe("AdminMcpUpstreamView", () => {
  it("展示脱敏外部配置，低风险工具直接调用", async () => {
    render(<AdminMcpUpstreamView />);

    expect(await screen.findByRole("heading", { name: "knowledge" })).toBeTruthy();
    expect(screen.getByText("https://mcp.example.edu")).toBeTruthy();
    expect(screen.getByText("disabled-server")).toBeTruthy();
    expect(screen.getByText("模型可见")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("调用参数（JSON）"), {
      target: { value: "{\"query\":\"事务\"}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "调用工具" }));

    await waitFor(() =>
      expect(mocks.callUpstreamMcpTool).toHaveBeenCalledWith({
        server: "knowledge",
        tool: "lookup",
        arguments: { query: "事务" },
      }),
    );
    expect(await screen.findByText(/调用完成/)).toBeTruthy();
    expect(screen.getByText(/算法/)).toBeTruthy();
  });

  it("高风险工具调用前二次确认，并展示待审批工单", async () => {
    mocks.callUpstreamMcpTool.mockResolvedValue({
      status: "approval_required",
      case_id: 42,
    });
    render(<AdminMcpUpstreamView />);
    await screen.findByRole("heading", { name: "knowledge" });

    fireEvent.change(screen.getByLabelText("工具"), { target: { value: "publish" } });
    fireEvent.click(screen.getByRole("button", { name: "调用工具" }));
    expect(screen.getByRole("dialog", { name: "确认调用高风险管理工具" })).toBeTruthy();
    expect(mocks.callUpstreamMcpTool).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(mocks.callUpstreamMcpTool).toHaveBeenCalled());
    expect(await screen.findByText(/待确认工单 #42/)).toBeTruthy();
  });

  it("非法 JSON 本地拦截，不发送请求", async () => {
    render(<AdminMcpUpstreamView />);
    await screen.findByRole("heading", { name: "knowledge" });

    fireEvent.change(screen.getByLabelText("调用参数（JSON）"), {
      target: { value: "[1,2]" },
    });
    fireEvent.click(screen.getByRole("button", { name: "调用工具" }));

    expect(screen.getByRole("alert").textContent).toContain("参数必须是 JSON 对象");
    expect(mocks.callUpstreamMcpTool).not.toHaveBeenCalled();
  });
});
