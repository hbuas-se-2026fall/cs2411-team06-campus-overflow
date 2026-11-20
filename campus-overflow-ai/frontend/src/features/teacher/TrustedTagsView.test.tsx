import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  listTags: vi.fn(),
  fetchTag: vi.fn(),
}));

vi.mock("@/api/client", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/api/tags", () => ({
  listTags: mocks.listTags,
  fetchTag: mocks.fetchTag,
}));

import { TrustedTagsView } from "./TrustedTagsView";

beforeEach(() => {
  mocks.apiFetch.mockReset()
    .mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "PUT" ? {} : { items: [] });
  mocks.listTags.mockReset().mockResolvedValue({
    items: [{ id: 7, name: "动态规划", type: "course", question_count: 4 }],
  });
  mocks.fetchTag.mockReset();
});

afterEach(cleanup);

describe("TrustedTagsView", () => {
  it("按关键词选择已有标签并保存可信来源", async () => {
    render(<TrustedTagsView courseId={3} />);
    await screen.findByText("课程可信标签");

    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "动态" } });
    await screen.findByRole("option", { name: "动态规划" });
    fireEvent.change(screen.getByLabelText("已有标签"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("教材或书签依据"), {
      target: { value: "教材第 6 章" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认纳入词表" }));

    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenLastCalledWith(
        "/learning/courses/3/trusted-tags/7",
        {
          method: "PUT",
          body: JSON.stringify({
            source: "teacher",
            active: true,
            source_ref: "教材第 6 章",
          }),
        },
      ),
    );
  });
});
