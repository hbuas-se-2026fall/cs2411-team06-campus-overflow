import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRank: vi.fn(),
  listCourses: vi.fn(),
  fetchPublicReputation: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/api/reputation", () => ({
  getRank: mocks.getRank,
}));

// 课程榜 Select 的课程选项
vi.mock("@/api/courses", () => ({
  listCourses: mocks.listCourses,
}));
vi.mock("@/api/users", () => ({
  fetchPublicReputation: mocks.fetchPublicReputation,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
}));

import { RankingsView } from "./RankingsView";

const RANK_ITEMS = [
  { user_id: 1, username: "alice", score: 320 },
  { user_id: 2, username: "bob", score: 280 },
  { user_id: 3, username: "carol", score: 210 },
  { user_id: 4, username: "dave", score: 150 },
];

const COURSES = {
  items: [
    { id: 3, name: "数据结构", code: "CS201", teacher_name: "李老师", member_count: 40, question_count: 12, created_at: "2026-09-01T08:00:00+08:00" },
    { id: 4, name: "操作系统", code: "CS301", teacher_name: "王老师", member_count: 35, question_count: 9, created_at: "2026-09-01T08:00:00+08:00" },
  ],
  total: 2,
  page: 1,
  page_size: 100,
};

describe("RankingsView", () => {
  beforeEach(() => {
    mocks.getRank.mockResolvedValue({ items: RANK_ITEMS });
    mocks.listCourses.mockResolvedValue(COURSES);
    mocks.fetchPublicReputation.mockImplementation(async (userId: number) => ({
      user_id: userId,
      username: RANK_ITEMS.find((item) => item.user_id === userId)?.username ?? "",
      reputation_score: RANK_ITEMS.find((item) => item.user_id === userId)?.score ?? 0,
      question_count: userId,
      answer_count: userId + 10,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("默认周榜：渲染榜单表与前三名徽标", async () => {
    render(<RankingsView initialTab="week" initialCourseId={null} />);

    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("320")).toBeTruthy();
    // 周榜请求参数；名次 1~3 徽标 + 第 4 名纯文本
    expect(mocks.getRank).toHaveBeenCalledWith(expect.objectContaining({ period: "week" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].querySelectorAll("td")[0].textContent).toBe("1");
    expect(rows[2].querySelectorAll("td")[0].textContent).toBe("3");
    expect(rows[3].querySelectorAll("td")[0].textContent).toBe("4");
    // 周榜不显示课程选择
    expect(screen.queryByLabelText("选择课程")).toBeNull();
  });

  it("用公开声誉接口补齐每行提问数/回答数，采纳率继续明确占位", async () => {
    render(<RankingsView initialTab="week" initialCourseId={null} />);
    const alice = await screen.findByText("alice");
    const row = alice.closest("tr");
    expect(row).not.toBeNull();
    expect(await within(row!).findByText("11")).toBeTruthy();
    const cells = row!.querySelectorAll("td");
    expect(cells[3].textContent).toBe("1");
    expect(cells[4].textContent).toBe("11");
    expect(cells[5].textContent).toBe("—");
    expect(mocks.fetchPublicReputation).toHaveBeenCalledTimes(RANK_ITEMS.length);
  });

  it("单个用户声誉读取失败只让该行计数占位，不拖垮排行榜", async () => {
    mocks.fetchPublicReputation.mockImplementation(async (userId: number) => {
      if (userId === 1) throw new Error("声誉接口失败");
      return {
        user_id: userId,
        username: RANK_ITEMS.find((item) => item.user_id === userId)?.username ?? "",
        reputation_score: RANK_ITEMS.find((item) => item.user_id === userId)?.score ?? 0,
        question_count: userId,
        answer_count: userId + 10,
      };
    });
    render(<RankingsView initialTab="week" initialCourseId={null} />);

    const aliceRow = (await screen.findByText("alice")).closest("tr");
    const bobRow = screen.getByText("bob").closest("tr");
    expect(aliceRow).not.toBeNull();
    expect(bobRow).not.toBeNull();
    expect(aliceRow!.querySelectorAll("td")[3].textContent).toBe("—");
    expect(aliceRow!.querySelectorAll("td")[4].textContent).toBe("—");
    expect(bobRow!.querySelectorAll("td")[3].textContent).toBe("2");
    expect(bobRow!.querySelectorAll("td")[4].textContent).toBe("12");
    expect(screen.queryByText("加载失败")).toBeNull();
  });

  it("切换月榜：以 period=month 重新请求并写回 URL", async () => {
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<RankingsView initialTab="week" initialCourseId={null} />);
    fireEvent.click(await screen.findByRole("tab", { name: "月榜" }));

    await waitFor(() => {
      expect(mocks.getRank).toHaveBeenCalledWith(
        expect.objectContaining({ period: "month" }),
      );
    });
    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/rankings?period=month");
    });
  });

  it("切换课程榜：出现课程 Select，默认选第一门课并携带 course_id 请求", async () => {
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<RankingsView initialTab="week" initialCourseId={null} />);
    fireEvent.click(await screen.findByRole("tab", { name: "课程榜" }));

    // 课程选项加载后自动选第一门，课程榜 = period=all + course_id
    await waitFor(() => {
      expect(mocks.getRank).toHaveBeenCalledWith(
        expect.objectContaining({ period: "all", course_id: 3 }),
      );
    });
    const select = (await screen.findByLabelText("选择课程")) as HTMLSelectElement;
    expect(select.value).toBe("3");

    // 手动切换课程 → 重新请求并写回 URL
    fireEvent.change(select, { target: { value: "4" } });
    await waitFor(() => {
      expect(mocks.getRank).toHaveBeenCalledWith(
        expect.objectContaining({ period: "all", course_id: 4 }),
      );
    });
    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/rankings?period=all&course_id=4");
    });
  });

  it("榜单行点击跳转对应用户主页", async () => {
    render(<RankingsView initialTab="week" initialCourseId={null} />);

    // 点行内非链接单元格（声望值），避免落在 UserLine 链接上触发 jsdom 导航噪音
    fireEvent.click(await screen.findByText("320"));
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith("/users/1");
    });
  });

  it("榜单加载失败：展示错误态并可重试", async () => {
    mocks.getRank.mockRejectedValue(new Error("网络异常"));

    render(<RankingsView initialTab="week" initialCourseId={null} />);

    expect(await screen.findByText("加载失败")).toBeTruthy();
    expect(screen.getByText("网络异常")).toBeTruthy();

    mocks.getRank.mockResolvedValue({ items: RANK_ITEMS });
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("alice")).toBeTruthy();
  });
});
