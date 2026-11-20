// Agent 聊天封装测试（T-14 端到端接线）：发送前注入当前账号的浏览器记忆
// （browser_memory）、SSE 事件解析（meta/delta/done/error）、非 SSE 与中断错误。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  me: { id: 7 } as { id: number } | null,
}));

vi.mock("@/shared/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({ me: mocks.me }),
  },
}));

import { AgentChatError, sendAgentChat } from "./agent-chat";

const sse = (events: Array<[string, unknown]>, ids?: number[]): Response => new Response(
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      events.forEach(([event, data], index) => {
        const id = ids?.[index];
        controller.enqueue(encoder.encode(
          `event: ${event}\ndata: ${JSON.stringify(data)}\n${id === undefined ? "" : `id: ${id}\n`}\n`,
        ));
      });
      controller.close();
    },
  }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const requestBody = (callIndex = -1): { message: string; browser_memory?: string[] } => {
  const call = mocks.fetch.mock.calls.at(callIndex);
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as { message: string; browser_memory?: string[] };
};

beforeEach(() => {
  window.localStorage.clear();
  mocks.me = { id: 7 };
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendAgentChat 记忆注入（T-14 接线点）", () => {
  it("只提交明确选择的课程与可信标签ID，不发送匿名反馈原文摘要", async () => {
    mocks.fetch.mockResolvedValue(sse([["done", { finishReason: "stop" }]]));
    await sendAgentChat("私人提问", {}, { learningContext: { course_id: 2, trusted_tag_ids: [3], learning_event_id: "event" } });
    expect(requestBody()).toMatchObject({ course_id: 2, trusted_tag_ids: [3], learning_event_id: "event" });
    expect(requestBody()).not.toHaveProperty("summary");
  });
  it("按索引、摘要、详情分阶段披露，只将选择详情送入最终聊天", async () => {
    window.localStorage.setItem(
      "co_memory_user_7",
      JSON.stringify([
        { id: "a", content: "偏好简洁回答", created_at: "2026-10-24T01:00:00Z" },
        { id: "b", content: "备考操作系统", created_at: "2026-10-24T02:00:00Z" },
      ]),
    );
    mocks.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/disclose")) {
        const body = JSON.parse(init.body);
        return Response.json({ code: 200, data: { session_id: body.session_id, stage: body.stage,
          selected_ids: body.items.map((item: { id: string }) => item.id) } });
      }
      return sse([
      ["meta", { agentRunId: "run-1", traceId: "t-1", ai: true }],
      ["delta", { text: "你好" }],
      ["done", { agentRunId: "run-1", traceId: "t-1", finishReason: "stop" }],
      ]);
    });

    const result = await sendAgentChat("帮我复习死锁");
    expect(requestBody()).toMatchObject({
      message: "帮我复习死锁",
      browser_memory: ["备考操作系统", "偏好简洁回答"], // 最新在前
      request_id: expect.any(String),
    });
    expect(result.finishReason).toBe("stop");
    expect(mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body).stage)).toEqual(["index", "summary", "detail", undefined]);
  });

  it("中止后不继续披露或发送最终聊天", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sendAgentChat("q", {}, { signal: controller.signal })).rejects.toThrow("会话已切换");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("索引阶段只传短主题，摘要/详情只传已选择的条目", async () => {
    const content = "死锁" + "解释".repeat(100);
    window.localStorage.setItem("co_memory_user_7", JSON.stringify([
      { id: "selected", content, created_at: "2026-10-24T01:00:00Z" },
      { id: "private", content: "与问题无关的个人偏好", created_at: "2026-10-24T02:00:00Z" },
    ]));
    mocks.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/disclose")) {
        const body = JSON.parse(init.body);
        return Response.json({ code: 200, data: { session_id: body.session_id, stage: body.stage, selected_ids: ["selected"] } });
      }
      return sse([["done", { finishReason: "stop" }]]);
    });
    await sendAgentChat("死锁");
    const bodies = mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body));
    expect(bodies[0].items.every((entry: { text: string }) => entry.text.length <= 36)).toBe(true);
    expect(bodies[1].items).toEqual([{ id: "selected", text: content.slice(0, 100) }]);
    expect(bodies[2].items).toEqual([{ id: "selected", text: content }]);
    expect(bodies[3].browser_memory).toEqual([content]);
  });

  it("上游返回未披露ID时停止，不扩大选择范围", async () => {
    window.localStorage.setItem("co_memory_user_7", JSON.stringify([{ id: "a", content: "偏好简洁", created_at: "2026-10-24T01:00:00Z" }]));
    mocks.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ code: 200, data: { session_id: body.session_id, stage: body.stage, selected_ids: ["other-user-id"] } });
    });
    await expect(sendAgentChat("问题")).rejects.toThrow("记忆选择结果不合法");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("当前账号无记忆或未登录时省略 browser_memory 字段", async () => {
    // 每次调用生成新 Response：同一 ReadableStream 只能被读取（锁定）一次
    mocks.fetch.mockImplementation(async () => sse([["done", { finishReason: "stop" }]]));
    await sendAgentChat("问题一");
    expect(requestBody()).toMatchObject({ message: "问题一" });
    expect(requestBody()).not.toHaveProperty("browser_memory");

    mocks.me = null;
    await sendAgentChat("问题二");
    expect(requestBody()).toMatchObject({ message: "问题二" });
    expect(requestBody()).not.toHaveProperty("browser_memory");
  });
});

describe("sendAgentChat SSE 流解析", () => {
  it("meta 与 delta 事件按序回调", async () => {
    mocks.fetch.mockResolvedValue(sse([
      ["meta", { agentRunId: "run-2", traceId: "t-2", ai: true }],
      ["delta", { text: "死锁的" }],
      ["delta", { text: "四个必要条件" }],
      ["done", { finishReason: "stop" }],
    ]));
    const received: string[] = [];
    let meta: { agentRunId: string } | undefined;
    const result = await sendAgentChat("q", {
      onMeta: (value) => { meta = value; },
      onDelta: (text) => { received.push(text); },
    });
    expect(meta).toEqual({ agentRunId: "run-2", traceId: "t-2", ai: true });
    expect(received).toEqual(["死锁的", "四个必要条件"]);
    expect(result.finishReason).toBe("stop");
  });

  it("error 事件抛 AgentChatError（后端中文文案）", async () => {
    // 每次调用生成新 Response：同一 ReadableStream 只能被读取（锁定）一次
    mocks.fetch.mockImplementation(async () => sse([
      ["meta", { agentRunId: "r", traceId: "t", ai: true }],
      ["error", { message: "任务运行超时", traceId: "t" }],
    ]));
    await expect(sendAgentChat("q")).rejects.toThrow(AgentChatError);
    await expect(sendAgentChat("q")).rejects.toThrow("任务运行超时");
  });

  it("非 SSE 响应（如 BFF 503 信封）抛错并透传 message", async () => {
    mocks.fetch.mockResolvedValue(new Response(
      JSON.stringify({ code: 503, data: null, message: "AI 服务暂不可用，请稍后重试" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    await expect(sendAgentChat("q")).rejects.toThrow("AI 服务暂不可用，请稍后重试");
  });

  it("连接中断且未收到 done 时按事件游标自动续接", async () => {
    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).includes("/runs/")) {
        return sse([["delta", { text: "续接内容" }], ["done", { finishReason: "stop" }]], [2, 3]);
      }
      return sse([["meta", { agentRunId: "r", traceId: "t", ai: true }], ["delta", { text: "半截" }]], [1, 2]);
    });
    const received: string[] = [];
    const result = await sendAgentChat("q", { onDelta: (text) => received.push(text) });
    expect(received).toEqual(["半截", "续接内容"]);
    expect(result.finishReason).toBe("stop");
    expect(String(mocks.fetch.mock.calls[1]?.[0])).toContain("after=2");
    expect(String(mocks.fetch.mock.calls[1]?.[0])).toContain("/runs/");
  });

  it("无法续接（回复已过期）时抛中文错误且不重复展示已收内容", async () => {
    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).includes("/runs/")) {
        return new Response(JSON.stringify({ code: 404, data: null, message: "该回复已过期或不存在，请重新提问" }),
          { status: 404, headers: { "content-type": "application/json" } });
      }
      return sse([["delta", { text: "半截" }]], [1]);
    });
    await expect(sendAgentChat("q")).rejects.toThrow("该回复已过期或不存在");
  });

  it("用户中止不续接，并异步通知服务端取消运行", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith("/cancel")) return Response.json({ code: 200, data: null, message: "ok" });
      return new Response(new ReadableStream({ start() { /* 保持连接直到用户中止 */ } }),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const pending = sendAgentChat("q", {}, { signal: controller.signal });
    await vi.waitFor(() => { expect(mocks.fetch).toHaveBeenCalled(); });
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => {
      expect(mocks.fetch.mock.calls.some((call) => String(call[0]).endsWith("/cancel"))).toBe(true);
    });
    expect(mocks.fetch.mock.calls.some((call) => String(call[0]).includes("/stream"))).toBe(false);
  });
});
