// 运行中人工控制面板（T-21E，RC-R01～R05）：状态回显、暂停/继续/取消、引导追加与错误提示。
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRunControl: vi.fn(),
  applyRunControl: vi.fn(),
  addRunGuidance: vi.fn(),
}));

vi.mock("@/api/agent-runs", () => ({
  fetchRunControl: mocks.fetchRunControl,
  applyRunControl: mocks.applyRunControl,
  addRunGuidance: mocks.addRunGuidance,
}));

import { AdminRunControlPanel } from "./AdminRunControlPanel";

const CONTROL = {
  agent_run_id: "run-1",
  state: "running" as const,
  revision: 3,
  pause_deadline: null,
  updated_by: 9,
  updated_at: "2026-11-25T10:00:00Z",
};

function renderPanel(overrides: { taskType?: string; isRunActive?: boolean } = {}) {
  return render(
    <AdminRunControlPanel
      agentRunId="run-1"
      taskType={overrides.taskType ?? "moderation_scan"}
      isRunActive={overrides.isRunActive ?? true}
    />,
  );
}

beforeEach(() => {
  mocks.fetchRunControl.mockReset().mockResolvedValue(CONTROL);
  mocks.applyRunControl.mockReset();
  mocks.addRunGuidance.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminRunControlPanel 运行控制", () => {
  it("加载中显示骨架，成功后回显状态与版本号", async () => {
    renderPanel();
    expect(screen.getByText("控制状态加载中…")).toBeInTheDocument();
    expect(await screen.findByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("版本 v3")).toBeInTheDocument();
    expect(screen.getByText(/所有控制操作都会写入审计日志/)).toBeInTheDocument();
    expect(mocks.fetchRunControl).toHaveBeenCalledWith("run-1");
  });

  it("加载失败展示错误并可重新加载", async () => {
    mocks.fetchRunControl
      .mockRejectedValueOnce(new Error("控制状态不存在"))
      .mockResolvedValueOnce(CONTROL);
    renderPanel();
    expect(await screen.findByText("控制状态不存在")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("运行中")).toBeInTheDocument();
    expect(mocks.fetchRunControl).toHaveBeenCalledTimes(2);
  });

  it("不可控任务只显示提示，不请求控制状态", async () => {
    renderPanel({ taskType: "moderation_patrol" });
    expect(
      screen.getByText(/该任务类型不支持运行中人工控制/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停运行" })).not.toBeInTheDocument();
    expect(mocks.fetchRunControl).not.toHaveBeenCalled();
  });

  it("运行已结束时提示无需控制", async () => {
    renderPanel({ isRunActive: false });
    expect(await screen.findByText("运行已结束，无需控制。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
  });

  it("暂停成功后切换为已暂停并展示引导入口", async () => {
    mocks.applyRunControl.mockResolvedValue({ ...CONTROL, state: "paused", revision: 4 });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "暂停运行" }));
    await waitFor(() => {
      expect(mocks.applyRunControl).toHaveBeenCalledWith("run-1", "pause", 3);
    });
    expect(await screen.findByText("已暂停")).toBeInTheDocument();
    expect(screen.getByText("已提交：暂停运行")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续运行" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停运行" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("暂停期间追加引导并携带当前版本号", async () => {
    mocks.fetchRunControl.mockResolvedValue({ ...CONTROL, state: "paused", revision: 4 });
    mocks.addRunGuidance.mockResolvedValue({ ...CONTROL, state: "paused", revision: 5 });
    renderPanel();
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "优先核对人身攻击" } });
    fireEvent.click(screen.getByRole("button", { name: "追加引导" }));
    await waitFor(() => {
      expect(mocks.addRunGuidance).toHaveBeenCalledWith("run-1", "优先核对人身攻击", 4);
    });
    expect(
      await screen.findByText("引导已追加，将在下一次模型调用前注入"),
    ).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("版本冲突时展示后端错误并刷新状态", async () => {
    mocks.applyRunControl.mockRejectedValue(
      new Error("运行控制状态已被其他操作更新，请刷新后重试"),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "取消运行" }));
    expect(
      await screen.findByText("运行控制状态已被其他操作更新，请刷新后重试"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.fetchRunControl).toHaveBeenCalledTimes(2);
    });
  });

  it("取消成功后不再提供取消按钮", async () => {
    mocks.applyRunControl.mockResolvedValue({ ...CONTROL, state: "cancelled", revision: 4 });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "取消运行" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停运行" })).not.toBeInTheDocument();
  });
});
