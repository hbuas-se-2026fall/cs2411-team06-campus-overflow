import { afterEach, describe, expect, it, vi } from "vitest";

import { suggestTags } from "./agent-assist";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent-assist API", () => {
  it("suggestTags 使用真实任务路由与 camelCase Schema 字段", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        code: 200,
        data: {
          tags: [{ name: "算法", reason: "文本匹配", confidence: 0.8 }],
          basisNote: "依据为文本语义匹配。",
        },
        message: "ok",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await suggestTags(
      {
        questionTitle: "动态规划怎么学",
        questionBody: "状态转移不会写",
        courseId: 1,
        tagCount: 3,
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/agent/tasks/suggest_tags",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      questionTitle: "动态规划怎么学",
      questionBody: "状态转移不会写",
      courseId: 1,
      tagCount: 3,
    });
  });
});
