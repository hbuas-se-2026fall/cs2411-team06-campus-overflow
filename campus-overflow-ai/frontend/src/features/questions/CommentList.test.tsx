import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listQuestionComments: vi.fn(),
  listAnswerComments: vi.fn(),
  createQuestionComment: vi.fn(),
  createAnswerComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock("@/api/comments", () => ({
  listQuestionComments: mocks.listQuestionComments,
  listAnswerComments: mocks.listAnswerComments,
  createQuestionComment: mocks.createQuestionComment,
  createAnswerComment: mocks.createAnswerComment,
  deleteComment: mocks.deleteComment,
}));

import { CommentList } from "./CommentList";

const COMMENTS = {
  items: [
    {
      id: 1,
      author: "teacher01",
      body: "可以先看讲义第 3 节。",
      parent_id: null,
      created_at: "2026-10-04T14:30:29",
      replies: [
        {
          id: 2,
          author: "student01",
          body: "好的，我去看。",
          parent_id: 1,
          created_at: "2026-10-04T14:31:00",
        },
      ],
    },
  ],
  total: 1,
  page: 1,
};

beforeEach(() => {
  mocks.listQuestionComments.mockReset().mockResolvedValue(COMMENTS);
  mocks.listAnswerComments.mockReset().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  mocks.createQuestionComment.mockReset().mockResolvedValue({ id: 3, parent_id: null, created_at: "" });
  mocks.createAnswerComment.mockReset().mockResolvedValue({ id: 4, parent_id: null, created_at: "" });
  mocks.deleteComment.mockReset().mockResolvedValue(null);
});

afterEach(cleanup);

describe("CommentList", () => {
  it("渲染顶级评论与二级回复", async () => {
    render(<CommentList targetType="question" targetId={4} currentUsername="student01" />);

    await waitFor(() => expect(screen.getByText("可以先看讲义第 3 节。")).toBeTruthy());
    expect(screen.getByText("好的，我去看。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1 条评论" })).toBeTruthy();
  });

  it("发表评论会调用接口并刷新列表", async () => {
    render(<CommentList targetType="question" targetId={4} currentUsername="student01" />);
    await waitFor(() => expect(screen.getByText("可以先看讲义第 3 节。")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/补充说明/), { target: { value: "补充一句" } });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));

    await waitFor(() =>
      expect(mocks.createQuestionComment).toHaveBeenCalledWith(4, {
        body: "补充一句",
      }),
    );
    // 成功后重新拉取列表
    await waitFor(() => expect(mocks.listQuestionComments.mock.calls.length).toBeGreaterThan(1));
  });

  it("删除他人评论不展示删除按钮；自己的评论删除需二次确认", async () => {
    render(<CommentList targetType="question" targetId={4} currentUsername="student01" />);
    await waitFor(() => expect(screen.getByText("好的，我去看。")).toBeTruthy());

    // 顶级评论属于 teacher01，student01 不应看到它的删除按钮
    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    expect(deleteButtons).toHaveLength(1);

    fireEvent.click(deleteButtons[0]);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mocks.deleteComment).toHaveBeenCalledWith(2));
  });

  it("问题评论超过一页时可按后端真实 total 翻页", async () => {
    mocks.listQuestionComments.mockImplementation(async (_id: number, params: { page: number }) => ({
      ...COMMENTS,
      total: 25,
      page: params.page,
    }));
    render(<CommentList targetType="question" targetId={4} currentUsername="student01" />);

    fireEvent.click(await screen.findByRole("button", { name: "2" }));
    await waitFor(() =>
      expect(mocks.listQuestionComments).toHaveBeenLastCalledWith(4, {
        page: 2,
        page_size: 20,
      }),
    );
  });

  it("回答评论加载和发表走回答接口", async () => {
    render(<CommentList targetType="answer" targetId={9} />);

    await waitFor(() =>
      expect(mocks.listAnswerComments).toHaveBeenCalledWith(9, {
        page: 1,
        page_size: 20,
      }),
    );
    fireEvent.change(screen.getByPlaceholderText(/补充说明/), {
      target: { value: "回答下补充" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));

    await waitFor(() =>
      expect(mocks.createAnswerComment).toHaveBeenCalledWith(9, {
        body: "回答下补充",
      }),
    );
  });

  it("回答评论按当前用户展示删除入口，管理员可删除他人评论", async () => {
    mocks.listAnswerComments.mockResolvedValue({
      items: [{
        ...COMMENTS.items[0],
        author: "student01",
        replies: [],
      }],
      total: 1,
      page: 1,
    });
    render(
      <CommentList targetType="answer" targetId={9} currentUsername="student01" />,
    );

    expect(await screen.findByRole("button", { name: "删除" })).toBeTruthy();

    cleanup();
    render(
      <CommentList targetType="answer" targetId={9} currentUsername="admin01" canModerate />,
    );
    expect(await screen.findByRole("button", { name: "删除" })).toBeTruthy();
  });

  it("删除末页唯一评论后校正到新的末页，并继续展示剩余评论", async () => {
    let total = 21;
    const firstPageComment = {
      ...COMMENTS.items[0],
      id: 20,
      body: "前 20 条中的最后一条",
      author: "student01",
      replies: [],
    };
    const lastPageComment = {
      ...COMMENTS.items[0],
      id: 21,
      body: "第 21 条评论",
      author: "student01",
      replies: [],
    };
    mocks.listQuestionComments.mockImplementation(async (_id: number, params: { page: number }) => {
      if (total === 21 && params.page === 2) {
        return { items: [lastPageComment], total, page: 2 };
      }
      if (total === 20 && params.page === 2) {
        return { items: [], total, page: 2 };
      }
      return { items: [firstPageComment], total, page: 1 };
    });
    mocks.deleteComment.mockImplementation(async () => {
      total = 20;
      return null;
    });

    render(<CommentList targetType="question" targetId={4} currentUsername="student01" />);
    fireEvent.click(await screen.findByRole("button", { name: "2" }));
    expect(await screen.findByText("第 21 条评论")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(mocks.listQuestionComments).toHaveBeenLastCalledWith(4, {
        page: 1,
        page_size: 20,
      }),
    );
    expect(await screen.findByText("前 20 条中的最后一条")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "20 条评论" })).toBeTruthy();
    expect(screen.queryByText("还没有评论")).toBeNull();
  });

  it("发表第 21 条回答评论后定位到新评论所在的末页", async () => {
    let total = 20;
    const firstPageComment = {
      ...COMMENTS.items[0],
      id: 20,
      body: "已有回答评论",
      replies: [],
    };
    const createdComment = {
      ...COMMENTS.items[0],
      id: 21,
      body: "刚发表的回答评论",
      replies: [],
    };
    mocks.listAnswerComments.mockImplementation(async (_id: number, params: { page: number }) => {
      if (total === 21 && params.page === 2) {
        return { items: [createdComment], total, page: 2 };
      }
      return { items: [firstPageComment], total, page: 1 };
    });
    mocks.createAnswerComment.mockImplementation(async () => {
      total = 21;
      return { id: 21, parent_id: null, created_at: "" };
    });

    render(<CommentList targetType="answer" targetId={9} currentUsername="student01" />);
    await screen.findByText("已有回答评论");
    fireEvent.change(screen.getByPlaceholderText(/补充说明/), {
      target: { value: "刚发表的回答评论" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));

    await waitFor(() =>
      expect(mocks.listAnswerComments).toHaveBeenLastCalledWith(9, {
        page: 2,
        page_size: 20,
      }),
    );
    expect(await screen.findByText("刚发表的回答评论")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "21 条评论" })).toBeTruthy();
  });
});
