// P0-3 可恢复流：请求幂等、断线续接、取消与持久化失败边界。
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createApp } from "../src/app";
import { InternalApiError, type UserInternalClient } from "../src/internal-client";
import { auditStub } from "./helpers/audit-stub";
import { chatStreamStub } from "./helpers/chat-stream-stub";
import { approvedReview } from "./helpers/review-response";

const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 } };
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const headers = { authorization: "Bearer user", "x-trace-id": "trace-resume" };
const flush = async (rounds = 800) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); };

function fixture(overrides: { complete?: boolean; appendError?: boolean } = {}) {
  const complete = overrides.complete ?? true;
  const stream = vi.fn(async () => ({ stream: complete
    ? simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "可恢复回答" }, { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ] })
    : new ReadableStream({ start(output) {
      output.enqueue({ type: "stream-start", warnings: [] });
      output.enqueue({ type: "text-start", id: "t1" });
      output.enqueue({ type: "text-delta", id: "t1", delta: "未完成" });
    } }) }));
  const generate = vi.fn(async (options: Parameters<MockLanguageModelV4["doGenerate"]>[0]) =>
    approvedReview(options) ?? { content: [{ type: "text" as const, text: JSON.stringify({ steps: [] }) }],
      finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
  const model = new MockLanguageModelV4({ doGenerate: generate, doStream: stream });
  const base = chatStreamStub().apply({
    audit: auditStub(5), resolvePrincipal: vi.fn().mockResolvedValue({ user_id: 5, role: "student",
      status: "active", identity_type: "undergraduate", assistant_cert_status: "none" }),
  }) as unknown as UserInternalClient;
  const client = overrides.appendError
    ? Object.assign({}, base, { appendChatStreamEvent: async () => { throw new InternalApiError(503, 503, "写入失败"); } })
    : base;
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = createApp({ getModel: () => model, createClient: () => client });
  const chat = (requestId = REQUEST_ID) => app.request("/agent/chat", { method: "POST", headers,
    body: JSON.stringify({ message: "解释线程", request_id: requestId }) });
  const resume = (requestId = REQUEST_ID, after = 0) => app.request(
    `/agent/chat/runs/${requestId}/stream?after=${after}`, { method: "GET", headers },
  );
  const cancel = (requestId = REQUEST_ID) => app.request(
    `/agent/chat/runs/${requestId}/cancel`, { method: "POST", headers },
  );
  return { app, chat, resume, cancel, stream, generate, errorLog };
}

describe("P0-3 聊天可恢复流", () => {
  it("重复 POST 使用同一运行，不重复调用模型并回放已有事件", async () => {
    const f = fixture({ complete: false });
    const first = await f.chat();
    for (let i = 0; f.stream.mock.calls.length === 0 && i < 1000; i++) await flush(50);
    expect(f.stream).toHaveBeenCalledOnce();

    const second = await f.chat();
    const reader = second.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: meta");
    expect(chunk).toContain(REQUEST_ID);
    await reader.cancel();
    await flush();
    expect(f.stream).toHaveBeenCalledOnce();

    expect((await f.cancel()).status).toBe(200);
    await flush();
    await first.text().catch(() => undefined);
  });

  it("断线后可凭 request_id 与事件游标续接，且 meta 只在游标之前", async () => {
    const f = fixture();
    const response = await f.chat();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    const resumed = await f.resume(REQUEST_ID, 1);
    expect(resumed.status).toBe(200);
    const body = await resumed.text();
    expect(body).toContain("event: delta");
    expect(body).toContain("可恢复回答");
    expect(body).toContain("event: done");
    expect(body).not.toContain("event: meta");
    expect(body).toContain("id: 2");
  });

  it("未知或过期请求返回 404 中文提示，不建立 SSE", async () => {
    const f = fixture();
    const missing = await f.resume(OTHER_ID);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("已过期或不存在");
    const cancelMissing = await f.cancel(OTHER_ID);
    expect(cancelMissing.status).toBe(404);
  });

  it("持久化失败时结束订阅，不广播未落库内容也不进入模型", async () => {
    const f = fixture({ appendError: true });
    const response = await f.chat();
    const body = await response.text();
    expect(body).not.toContain("event: delta");
    expect(body).not.toContain("event: done");
    expect(f.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(f.errorLog.mock.calls)).toContain("chat_stream_append_failed");
  });
});
