// 个人记忆自动更新（T-14 M-03，AG-R04）：候选过滤与建议生成。
// 覆盖敏感丢弃、重复/超长剔除、条数上限与空结果；不写后端、不落审计。
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";

import {
  filterMemoryUpdates,
  suggestPersonalMemoryUpdates,
} from "../src/memory/personal-memory";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const generated = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [],
});

describe("个人记忆候选过滤", () => {
  it("丢弃敏感、重复、超长与空内容，并限制为 2 条", () => {
    const updates = filterMemoryUpdates([
      "偏好先看示例再看定义",
      "偏好先看示例再看定义",
      "我的密码是 abc123",
      "x".repeat(201),
      "希望每周收到一次课程复习提醒",
      "习惯用 Python 写代码",
    ], ["习惯用 Python 写代码"]);
    expect(updates).toEqual(["偏好先看示例再看定义", "希望每周收到一次课程复习提醒"]);
  });

  it("全部命中敏感或重复时返回空数组", () => {
    expect(filterMemoryUpdates(["token=abc", "已有偏好"], ["已有偏好"])).toEqual([]);
  });
});

describe("个人记忆建议生成", () => {
  it("结构化输出经同源过滤后返回候选", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => generated({ updates: ["偏好中文讲解", "password=1", "偏好中文讲解"] }),
    });
    const result = await suggestPersonalMemoryUpdates(
      { message: "以后尽量用中文", answer: "好的，我会用中文回答。" }, model,
    );
    expect(result.updates).toEqual(["偏好中文讲解"]);
  });

  it("模型返回空数组时不产生更新", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => generated({ updates: [] }) });
    await expect(suggestPersonalMemoryUpdates(
      { message: "今天天气怎么样", answer: "这个问题与课程无关。" }, model,
    )).resolves.toEqual({ updates: [] });
  });
});
