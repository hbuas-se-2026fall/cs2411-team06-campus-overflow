import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTags: vi.fn(),
  fetchTag: vi.fn(),
}));

vi.mock("@/api/tags", () => ({
  listTags: mocks.listTags,
  fetchTag: mocks.fetchTag,
}));

import { TagSelect } from "./TagSelect";

const TAG = { id: 5, name: "红黑树", type: "tech", question_count: 3 };

beforeEach(() => {
  mocks.listTags.mockReset().mockResolvedValue({ items: [TAG] });
  mocks.fetchTag.mockReset().mockResolvedValue(TAG);
});

afterEach(cleanup);

describe("TagSelect", () => {
  it("输入关键词后按后端结果选择标签", async () => {
    const onChange = vi.fn();
    render(<TagSelect label="按标签筛选" onChange={onChange} placeholder="全部标签" />);

    expect(mocks.listTags).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "红黑" } });

    await waitFor(() =>
      expect(mocks.listTags).toHaveBeenCalledWith({ keyword: "红黑" }),
    );
    fireEvent.change(await screen.findByLabelText("按标签筛选"), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it("深链接选中的标签不在当前搜索结果时补取标签详情", async () => {
    mocks.listTags.mockResolvedValue({ items: [] });
    render(<TagSelect label="按标签筛选" value={5} onChange={vi.fn()} placeholder="全部标签" />);

    await waitFor(() => expect(mocks.fetchTag).toHaveBeenCalledWith(5));
    expect((screen.getByLabelText("按标签筛选") as HTMLSelectElement).value).toBe("5");
    expect(screen.getByRole("option", { name: "红黑树" })).toBeTruthy();
  });

  it("关键词无匹配时保留搜索框和清除选择能力", async () => {
    mocks.listTags.mockResolvedValue({ items: [] });
    const onChange = vi.fn();
    render(<TagSelect label="按标签筛选" onChange={onChange} placeholder="全部标签" />);

    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "不存在" } });
    expect(await screen.findByText("没有匹配的标签")).toBeTruthy();
    expect(screen.getByLabelText("搜索标签")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("按标签筛选"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("切换关键词时立即移除上一轮标签选项", async () => {
    render(<TagSelect label="按标签筛选" onChange={vi.fn()} placeholder="全部标签" />);

    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "红黑" } });
    expect(await screen.findByRole("option", { name: "红黑树" })).toBeTruthy();

    mocks.listTags.mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "线程" } });

    expect(screen.queryByRole("option", { name: "红黑树" })).toBeNull();
    expect(screen.getByText("正在搜索标签…")).toBeTruthy();
  });
});
