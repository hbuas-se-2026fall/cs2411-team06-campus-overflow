import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlanParallelSetting: vi.fn(),
  updatePlanParallelSetting: vi.fn(),
}));

vi.mock("@/api/runtime-settings", () => ({
  getPlanParallelSetting: mocks.getPlanParallelSetting,
  updatePlanParallelSetting: mocks.updatePlanParallelSetting,
}));

import { AdminRuntimeSettingsView } from "./AdminRuntimeSettingsView";

beforeEach(() => {
  mocks.getPlanParallelSetting.mockReset().mockResolvedValue({
    plan_parallel_enabled: false,
    updated_at: null,
  });
  mocks.updatePlanParallelSetting.mockReset().mockResolvedValue({
    plan_parallel_enabled: true,
    updated_at: "2026-11-26T10:00:00+08:00",
  });
});

afterEach(cleanup);

describe("AdminRuntimeSettingsView", () => {
  it("加载开关并提交计划内并行设置", async () => {
    render(<AdminRuntimeSettingsView />);

    const toggle = (await screen.findByRole("checkbox", {
      name: "启用计划内并行",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Agent 下一次配置刷新后生效，最长约 30 秒/)).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mocks.updatePlanParallelSetting).toHaveBeenCalledWith(true),
    );
    expect(screen.getByText(/当前已开启/)).toBeTruthy();
  });

  it("更新失败保持原值并显示后端错误", async () => {
    mocks.updatePlanParallelSetting.mockRejectedValue(new Error("设置写入失败"));
    render(<AdminRuntimeSettingsView />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "启用计划内并行" }));
    expect((await screen.findByRole("alert")).textContent).toContain("设置写入失败");
    expect((screen.getByRole("checkbox", { name: "启用计划内并行" }) as HTMLInputElement).checked).toBe(false);
  });
});
