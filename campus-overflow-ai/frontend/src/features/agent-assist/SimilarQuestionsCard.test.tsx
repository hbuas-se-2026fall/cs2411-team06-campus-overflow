import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
