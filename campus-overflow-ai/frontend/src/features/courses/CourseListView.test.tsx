import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCourses: vi.fn(),
}));

vi.mock("@/api/courses", () => ({
  listCourses: mocks.listCourses,
}));

import { CourseListView } from "./CourseListView";

const COURSES = {
  items: [{
    id: 1,
    name: "数据结构",
    code: "CS101",
    teacher_name: "teacher01",
    member_count: 20,
    question_count: 4,
    created_at: "2026-09-01T08:00:00+08:00",
  }],
  total: 1,
  page: 1,
  page_size: 20,
};

beforeEach(() => {
  mocks.listCourses.mockReset().mockResolvedValue(COURSES);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CourseListView", () => {
  it("学期下拉提供可用预设，并向后端传递 semester 筛选", async () => {
    render(<CourseListView />);
    await screen.findByText("数据结构");

    const select = screen.getByLabelText("按学期筛选") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "2026 秋" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "2027 春" })).toBeTruthy();

    fireEvent.change(select, { target: { value: "2026秋" } });

    await waitFor(() => {
      expect(mocks.listCourses).toHaveBeenLastCalledWith(
        expect.objectContaining({ semester: "2026秋", page: 1 }),
      );
    });
  });

  it("从 URL 深链回填关键词与学期并直接用于首屏查询", async () => {
    render(<CourseListView initialKeyword="数据结构" initialSemester="2026秋" />);

    await waitFor(() => {
      expect(mocks.listCourses).toHaveBeenCalledWith(
        expect.objectContaining({
          keyword: "数据结构",
          semester: "2026秋",
          page: 1,
        }),
      );
    });
    expect((screen.getByLabelText("搜索课程") as HTMLInputElement).value).toBe("数据结构");
    expect((screen.getByLabelText("按学期筛选") as HTMLSelectElement).value).toBe("2026秋");
  });
});
