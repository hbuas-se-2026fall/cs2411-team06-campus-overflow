import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCourses: vi.fn(),
}));

vi.mock("@/api/courses", () => ({
  fetchCourses: mocks.fetchCourses,
  fetchCourseDetail: vi.fn(),
}));

import { LearningContextPicker } from "./LearningContextPicker";

beforeEach(() => {
  mocks.fetchCourses.mockReset().mockResolvedValue({
    items: [
      { id: 2, name: "数据结构", code: "CS201", teacher_name: "teacher01" },
      { id: 3, name: "操作系统", code: "CS301", teacher_name: "teacher02" },
    ],
    total: 2,
    page: 1,
    page_size: 50,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: 9, name: "树" }] }),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LearningContextPicker", () => {
  it("展开后加载课程选项，选择课程后读取可信标签", async () => {
    const onChange = vi.fn();
    render(
      <LearningContextPicker
        value={{}}
        onChange={onChange}
        disabled={false}
        canReport
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择课程与匿名学习反馈（可选）" }));
    await screen.findByRole("option", { name: /数据结构/ });
    expect(mocks.fetchCourses).toHaveBeenCalledWith({
      page: 1,
      page_size: 50,
      keyword: undefined,
    });

    fireEvent.change(screen.getByLabelText("当前学习课程"), { target: { value: "2" } });

    expect(onChange).toHaveBeenCalledWith({ course_id: 2, trusted_tag_ids: [] });
    expect(await screen.findByRole("checkbox", { name: "树" })).toBeTruthy();
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent/agent/courses/2/trusted-tags",
        { cache: "no-store" },
      ),
    );
  });

  it("没有反馈权限时只设置课程，不请求可信标签", async () => {
    const onChange = vi.fn();
    render(
      <LearningContextPicker
        value={{}}
        onChange={onChange}
        disabled={false}
        canReport={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择课程与匿名学习反馈（可选）" }));
    await screen.findByRole("option", { name: /数据结构/ });
    fireEvent.change(screen.getByLabelText("当前学习课程"), { target: { value: "2" } });

    expect(onChange).toHaveBeenCalledWith({ course_id: 2, trusted_tag_ids: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
