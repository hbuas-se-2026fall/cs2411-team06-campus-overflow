import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  fetchCourses: vi.fn(),
  fetchCourseDetail: vi.fn(),
  listTags: vi.fn(),
  fetchTag: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  // 与真实 useSearchParams 一致：导航间引用稳定，仅由 renderView 按用例重建
  searchParams: new URLSearchParams(""),
}));

vi.mock("@/api/search", () => ({
  search: mocks.search,
}));

vi.mock("@/api/courses", () => ({
  fetchCourses: mocks.fetchCourses,
  fetchCourseDetail: mocks.fetchCourseDetail,
}));

vi.mock("@/api/tags", () => ({
  listTags: mocks.listTags,
  fetchTag: mocks.fetchTag,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
}));

import type { QuestionListItem } from "@/shared/types/question";

import { SEARCH_HISTORY_KEY } from "./history";
import { SearchView } from "./SearchView";

const QUESTION: QuestionListItem = {
  id: 9,
  title: "快速排序的最坏情况什么时候出现？",
  course_id: 3,
  author: "alice",
  tags: [{ id: 10, name: "数据结构", type: "system" }],
  status: "published",
  vote_score: 2,
  my_vote: 0,
  answer_count: 1,
  view_count: 20,
  has_accepted: false,
  created_at: "2026-10-01T10:00:00+08:00",
};

const SEARCH_RESULT = {
  items: [QUESTION],
  total: 1,
  page: 1,
  page_size: 10,
};

const COURSES = [
  {
    id: 3,
    name: "数据结构",
    code: "CS201",
    teacher_name: "teacher01",
    member_count: 40,
    question_count: 12,
    created_at: "2026-09-01T08:00:00",
  },
];

const TAGS = [{ id: 10, name: "数据结构", type: "system", question_count: 8 }];

function renderView(initialKeyword = "", extra = "") {
  // 真实不变式：server 壳解析出的 initialKeyword 与 URL ?q= 恒一致，mock 保持同源
  const query = new URLSearchParams();
  if (initialKeyword) query.set("q", initialKeyword);
  for (const [key, value] of new URLSearchParams(extra)) query.set(key, value);
  mocks.searchParams = query;
  return render(<SearchView initialKeyword={initialKeyword} />);
}

function storedHistory(): string[] {
  const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

// 仓库测试不引 jest-dom matchers，输入值用原生属性断言
function inputValue(element: HTMLElement): string {
  return (element as HTMLInputElement).value;
}

describe("SearchView", () => {
  beforeEach(() => {
    mocks.search.mockResolvedValue(SEARCH_RESULT);
    mocks.fetchCourses.mockResolvedValue({ items: COURSES, total: 1, page: 1, page_size: 50 });
    mocks.fetchCourseDetail.mockResolvedValue({
      id: 3,
      name: "数据结构",
      code: "CS201",
      teacher_name: "teacher01",
    });
    mocks.listTags.mockResolvedValue({ items: TAGS });
    mocks.fetchTag.mockResolvedValue(TAGS[0]);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("输入关键词提交：写入历史并调用搜索接口，URL 写回关键词", async () => {
    renderView();

    fireEvent.change(await screen.findByLabelText("全站搜索"), {
      target: { value: "快速排序" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() => {
      expect(mocks.search).toHaveBeenCalledWith(
        expect.objectContaining({ q: "快速排序", page: 1, page_size: 10 }),
      );
    });
    expect(await screen.findByText(QUESTION.title)).toBeTruthy();
    expect(storedHistory()).toEqual(["快速排序"]);
    expect(mocks.replace).toHaveBeenCalledWith("/search?q=%E5%BF%AB%E9%80%9F%E6%8E%92%E5%BA%8F");
  });

  it("URL 关键词回填：深链进入自动搜索且输入框保留关键词", async () => {
    renderView("哈希表冲突");

    const input = (await screen.findByLabelText("全站搜索")) as HTMLInputElement;
    await waitFor(() => {
      expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ q: "哈希表冲突" }));
    });
    expect(inputValue(input)).toBe("哈希表冲突");
  });

  it("同一关键词返回相关问题、课程和标签", async () => {
    renderView("数据结构");

    const courseRegion = await screen.findByRole("region", { name: "相关课程" });
    expect(within(courseRegion).getByRole("link", { name: "数据结构" }).getAttribute("href")).toBe(
      "/courses/3",
    );
    expect(within(courseRegion).getByRole("link", { name: "查看全部课程" }).getAttribute("href")).toBe(
      "/courses?keyword=%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84",
    );
    const tagRegion = screen.getByRole("region", { name: "相关标签" });
    expect(within(tagRegion).getByRole("link", { name: "标签 数据结构" }).getAttribute("href")).toBe(
      "/tags/10",
    );
    expect(screen.getByText(QUESTION.title)).toBeTruthy();
  });

  it("课程或标签搜索失败不影响问题结果", async () => {
    mocks.fetchCourses.mockRejectedValue(new Error("课程搜索失败"));
    mocks.listTags.mockRejectedValue(new Error("标签搜索失败"));
    renderView("数据结构");

    expect(await screen.findByText(QUESTION.title)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "相关课程" })).toBeNull();
    expect(screen.queryByRole("region", { name: "相关标签" })).toBeNull();
  });

  it("切换关键词加载新结果时不展示上一关键词的课程", async () => {
    renderView("旧关键词");
    expect(await screen.findByRole("region", { name: "相关课程" })).toBeTruthy();

    mocks.fetchCourses.mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByLabelText("全站搜索"), { target: { value: "新关键词" } });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() =>
      expect(mocks.fetchCourses).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyword: "新关键词" }),
      ),
    );
    expect(screen.queryByRole("region", { name: "相关课程" })).toBeNull();
  });

  it("深链组合筛选：课程、标签、排序、状态和时间范围一并传给搜索接口", async () => {
    renderView("线程", "course_id=3&tag_id=10&sort=hot&unresolved=1&within=week");

    await waitFor(() => {
      expect(mocks.search).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "线程",
          course_id: 3,
          tag_id: 10,
          sort: "hot",
          unresolved: true,
          created_from: expect.any(String),
        }),
      );
    });
    expect((screen.getByLabelText("按课程筛选") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByLabelText("按标签筛选") as HTMLSelectElement).value).toBe("10");
    expect(screen.getByRole("tab", { name: "热门" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "未解决" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("发布时间") as HTMLSelectElement).value).toBe("week");
  });

  it("切换筛选保留关键词并重置到第一页", async () => {
    renderView("线程", "page=2&course_id=3");

    fireEvent.click(await screen.findByRole("tab", { name: "热门" }));

    expect(mocks.replace).toHaveBeenCalledWith(
      "/search?q=%E7%BA%BF%E7%A8%8B&course_id=3&sort=hot",
    );
    await waitFor(() => {
      expect(mocks.search).toHaveBeenLastCalledWith(
        expect.objectContaining({
          q: "线程",
          course_id: 3,
          sort: "hot",
          page: 1,
        }),
      );
    });
  });

  it("无关键词：不发请求，空态引导提问", async () => {
    renderView();

    await waitFor(() => {
      expect(screen.getByText("输入关键词，搜索问题、课程和标签")).toBeTruthy();
    });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "直接提问" })).toBeTruthy();
  });

  it("无结果：空态引导换个关键词或直接提问", async () => {
    mocks.search.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10 });
    mocks.fetchCourses.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 50 });
    mocks.listTags.mockResolvedValue({ items: [] });
    renderView("不存在的关键词");

    expect(await screen.findByText("未找到相关内容，换个关键词试试")).toBeTruthy();
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ q: "不存在的关键词" }));
    expect(screen.getByRole("button", { name: "直接提问" })).toBeTruthy();
  });

  it("搜索失败：错误态可重试并恢复结果", async () => {
    mocks.search.mockRejectedValueOnce(new Error("服务异常"));
    renderView("动态规划");

    expect(await screen.findByText("加载失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(await screen.findByText(QUESTION.title)).toBeTruthy();
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });

  it("点击历史词：置顶去重并触发搜索", async () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["链表", "动态规划"]));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "动态规划" }));

    await waitFor(() => {
      expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ q: "动态规划" }));
    });
    expect(storedHistory()).toEqual(["动态规划", "链表"]);
    expect(screen.getAllByText("动态规划").length).toBe(1);
    expect(mocks.replace).toHaveBeenCalledWith("/search?q=%E5%8A%A8%E6%80%81%E8%A7%84%E5%88%92");
  });

  it("历史 chips：逐条删除", async () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["链表", "红黑树"]));
    renderView();

    expect(await screen.findByText("链表")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除搜索历史 红黑树" }));

    expect(screen.queryByText("红黑树")).toBeNull();
    expect(storedHistory()).toEqual(["链表"]);
  });

  it("历史 chips：一键清空后整块隐藏", async () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["链表", "红黑树"]));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "清空历史" }));

    expect(screen.queryByText("链表")).toBeNull();
    expect(screen.queryByLabelText("搜索历史")).toBeNull();
    expect(window.localStorage.getItem(SEARCH_HISTORY_KEY)).toBeNull();
  });
});
