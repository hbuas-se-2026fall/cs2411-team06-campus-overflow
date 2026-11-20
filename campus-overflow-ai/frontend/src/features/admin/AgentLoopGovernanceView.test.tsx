import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAgentRuns: vi.fn(),
  fetchAgentRunTrace: vi.fn(),
}));

vi.mock("@/api/agent-runs", () => ({
  fetchAgentRuns: mocks.fetchAgentRuns,
  fetchAgentRunTrace: mocks.fetchAgentRunTrace,
}));

import { AgentLoopGovernanceView } from "./AgentLoopGovernanceView";

const RUN = {
  id: 1,
  user_id: null,
  task_type: "moderation_patrol",
  trace_id: "trace-001",
  agent_run_id: "run-001",
  input_summary: "巡检最近内容",
  output_summary: "已生成一条待审批建议",
  error_summary: null,
  status: "succeeded",
  created_at: "2026-11-19T10:00:00+08:00",
  updated_at: "2026-11-19T10:01:00+08:00",
};

beforeEach(() => {
  mocks.fetchAgentRuns.mockReset().mockResolvedValue({
    items: [RUN],
    total: 1,
    page: 1,
    page_size: 5,
  });
  mocks.fetchAgentRunTrace.mockReset().mockResolvedValue({
    run: RUN,
    events: [{
      id: 1,
      agent_run_id: "run-001",
      sequence_no: 1,
      event_type: "plan",
      plan_revision: 1,
      steps: [{ step_id: "step-1", tool_name: "search_questions" }],
      step_id: null,
      tool_name: null,
      duration_ms: 80,
      trace_id: "trace-001",
      created_at: "2026-11-19T10:00:00+08:00",
    }],
    tool_calls: [{
      id: 1,
      agent_run_id: "run-001",
      tool_name: "search_questions",
      args_summary: "关键词：死锁",
      result_summary: "命中 3 条",
      status: "succeeded",
      duration_ms: 80,
      trace_id: "trace-001",
      created_at: "2026-11-19T10:00:00+08:00",
    }],
    related_cases: [],
  });
});

afterEach(cleanup);

describe("AgentLoopGovernanceView", () => {
  it("展示治理闭环、两个隔离沙箱和真实边界说明", async () => {
    render(<AgentLoopGovernanceView />);

    expect(screen.getByRole("heading", { name: "Agent Loop 治理" })).toBeTruthy();
    for (const stage of [
      "观察与发现",
      "规划动作",
      "人工审批",
      "受控执行",
      "重新观察",
      "效果评估",
      "终结或转人工",
    ]) {
      expect(screen.getByText(stage)).toBeTruthy();
    }

    expect(screen.getByText("测试数据库沙箱")).toBeTruthy();
    expect(screen.getByText("MCP 隔离沙箱")).toBeTruthy();
    expect(screen.getAllByText("本地手动启动").length).toBe(2);
    expect(screen.getByText(/未接入在线状态探测/)).toBeTruthy();
    expect(screen.getByText("治理预演 dry-run")).toBeTruthy();
    expect(screen.getByText(/不会创建工单、写审计或修改目标状态/)).toBeTruthy();
    expect(screen.queryByText("运行中")).toBeNull();
  });

  it("展示最近运行并提供调用链入口", async () => {
    render(<AgentLoopGovernanceView />);

    expect(await screen.findByText("静默巡检")).toBeTruthy();
    expect(screen.getByText("巡检最近内容")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看调用链" }).getAttribute("href")).toBe(
      "/admin/agent/runs/run-001",
    );
    expect(mocks.fetchAgentRuns).toHaveBeenCalledWith({ page: 1, page_size: 5 });
    expect(await screen.findByText("生成计划")).toBeTruthy();
    expect(screen.getByText(/search_questions/)).toBeTruthy();
    expect(screen.getByText(/命中 3 条/)).toBeTruthy();
  });

  it("运行列表无数据时显示空态，不隐藏页面主体", async () => {
    mocks.fetchAgentRuns.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 5,
    });
    render(<AgentLoopGovernanceView />);

    expect(await screen.findByText("暂无 Agent 运行")).toBeTruthy();
    expect(screen.getByText("测试数据库沙箱")).toBeTruthy();
    expect(screen.getByText("MCP 隔离沙箱")).toBeTruthy();
    expect(mocks.fetchAgentRunTrace).not.toHaveBeenCalled();
  });

  it("运行接口失败时只显示局部错误，闭环与沙箱继续可见", async () => {
    mocks.fetchAgentRuns.mockRejectedValue(new Error("运行记录加载失败"));
    render(<AgentLoopGovernanceView />);

    expect(await screen.findByText(/运行记录加载失败/)).toBeTruthy();
    expect(screen.getByText("观察与发现")).toBeTruthy();
    expect(screen.getByText("测试数据库沙箱")).toBeTruthy();
  });
});
