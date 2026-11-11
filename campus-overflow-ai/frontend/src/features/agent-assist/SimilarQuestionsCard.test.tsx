import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SimilarQuestionsCard } from "./SimilarQuestionsCard";

const RESULT = {
  code: 200,
  data: {
    items: [
      {
        questionId: 3,
        title: "作业三第 4 题的动态规划状态转移怎么推导？",
        url: "/questions/3",
        reason: "标题与正文都涉及动态规划状态转移",
      },
    ],
    hasInSiteEvidence: true,
    note: "以下推荐基于站内历史问题检索与模型相似度排序。",
  },
  message: "ok",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SimilarQuestionsCard", () => {
  it("输入标题后防抖检索，渲染站内相似问题与理由", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(RESULT));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SimilarQuestionsCard
        questionTitle="动态规划状态转移"
        questionBody=""
        courseId={1}
      />,
    );

    await waitFor(
      () => {
        expect(screen.getByText(RESULT.data.items[0].title)).toBeTruthy();
      },
      { timeout: 2500 },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/agent/tasks/similar_questions",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toEqual({
      questionTitle: "动态规划状态转移",
      courseId: 1,
    });
    expect(screen.getByText(RESULT.data.items[0].reason)).toBeTruthy();
  });

  it("标题为空：不发请求、不渲染卡片", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SimilarQuestionsCard questionTitle="   " questionBody="" courseId={null} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("相似问题建议")).toBeNull();
  });

  it("标题超过 100 字：前端拦截，不发必然返回 400 的请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SimilarQuestionsCard questionTitle={"字".repeat(101)} questionBody="" courseId={null} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("相似问题建议")).toBeNull();
  });

  it("正文超过 Agent 上限时截取前 20000 字再请求", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ...RESULT, data: { ...RESULT.data, items: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SimilarQuestionsCard
        questionTitle="动态规划状态转移"
        questionBody={"字".repeat(20_001)}
        courseId={1}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2500 });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { questionBody: string };
    expect(body.questionBody).toHaveLength(20_000);
  });

  it("接口失败：静默隐藏，不阻塞提问", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("agent down")));
    render(<SimilarQuestionsCard questionTitle="动态规划" questionBody="" courseId={null} />);

    await waitFor(
      () => {
        expect(screen.queryByLabelText("相似问题建议")).toBeNull();
      },
      { timeout: 2500 },
    );
  });

  it("输入变化后立即隐藏上一标题的旧结果，避免短暂展示错误推荐", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(RESULT));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <SimilarQuestionsCard questionTitle="动态规划状态转移" questionBody="" courseId={1} />,
    );
    await screen.findByText(RESULT.data.items[0].title);

    view.rerender(
      <SimilarQuestionsCard questionTitle="二分查找边界" questionBody="" courseId={1} />,
    );

    expect(screen.queryByText(RESULT.data.items[0].title)).toBeNull();
  });

  it("同一问题重复返回时只渲染一次，避免重复 React key", async () => {
    const item = RESULT.data.items[0];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...RESULT,
          data: { ...RESULT.data, items: [item, item] },
        }),
      ),
    );
    render(
      <SimilarQuestionsCard questionTitle="动态规划状态转移" questionBody="" courseId={1} />,
    );

    await screen.findByText(item.title);
    expect(screen.getAllByRole("link", { name: item.title })).toHaveLength(1);
  });

  it("点击站内相似问题前先保存当前发布草稿", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(RESULT)));
    const onNavigate = vi.fn();
    render(
      <SimilarQuestionsCard
        questionTitle="动态规划状态转移"
        questionBody="正文草稿"
        courseId={1}
        onNavigate={onNavigate}
      />,
    );
    const link = await screen.findByRole("link", { name: RESULT.data.items[0].title });
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(link);

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
