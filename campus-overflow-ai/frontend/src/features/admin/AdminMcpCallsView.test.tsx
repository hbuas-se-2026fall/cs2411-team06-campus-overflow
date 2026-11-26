import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchMcpCalls: vi.fn() }));

vi.mock("@/api/admin-mcp", () => ({
  fetchMcpCalls: mocks.fetchMcpCalls,
}));

import { AdminMcpCallsView } from "./AdminMcpCallsView";

const CALL = {
  id: 1,
  client_name: "partner-a",
  tool_name: "search_questions",
  status: "succeeded",
  args_summary: "关键词：事务",
  result_summary: "命中 3 条",
  error_summary: null,
  duration_ms: 82,
  trace_id: "mcp-trace-1",
  created_at: "2026-11-26T09:00:00+08:00",
};

beforeEach(() => {
  mocks.fetchMcpCalls.mockReset().mockResolvedValue({
    items: [CALL],
    total: 21,
    page: 1,
    page_size: 20,
  });
});

afterEach(cleanup);

describe("AdminMcpCallsView", () => {
  it("展示脱敏调用审计并按筛选和分页请求", async () => {
    render(<AdminMcpCallsView />);

    expect(await screen.findByText("partner-a")).toBeTruthy();
    const row = screen.getByRole("row", { name: /partner-a/ });
    expect(row.textContent).toContain("search_questions");
    expect(row.textContent).toContain("成功");
    expect(row.textContent).toContain("82ms");
    expect(row.textContent).toContain("mcp-trace-1");

    fireEvent.change(screen.getByLabelText("客户端"), { target: { value: "partner" } });
    fireEvent.change(screen.getByLabelText("工具"), { target: { value: "search" } });
    fireEvent.change(screen.getByLabelText("调用结果"), { target: { value: "failed" } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));

    await waitFor(() =>
      expect(mocks.fetchMcpCalls).toHaveBeenLastCalledWith(
        expect.objectContaining({
          client_name: "partner",
          tool_name: "search",
          status: "failed",
          page: 1,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() =>
      expect(mocks.fetchMcpCalls).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      ),
    );
  });
});
