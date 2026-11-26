// T-21C 治理任务接线：暂停/恢复顺序、引导注入规划与最终评估提示、控制事件落审计
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createApp } from "../src/app";
import type { UserInternalClient } from "../src/internal-client";
import { auditStub } from "./helpers/audit-stub";
import { chatStreamStub } from "./helpers/chat-stream-stub";
import { approvedReview } from "./helpers/review-response";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const plan = {
  steps: [{ stepId: "s1", objective: "读取待评估正文", toolName: "fetchModerationTarget",
    args: { targetType: "$input.targetType", targetId: "$input.targetId" } }],
};
const riskOutput = { riskLevel: "low", shouldEscalate: false, reason: "正常" };

const snap = (overrides: Record<string, unknown>) => ({
  enabled: true, state: "running", revision: 0, pause_deadline: null, commands: [], ...overrides,
});
const guidance = (id: number, revision: number, text: string) => ({
  id, revision, action: "guidance", guidance_text: text, guidance_digest: `d${id}`,
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("治理任务运行控制接线（T-21C）", () => {
  it("暂停/恢复按边界生效，引导分别注入规划与最终评估提示", async () => {
    vi.stubEnv("RUN_CONTROL_ENABLED", "true");
    vi.stubEnv("RUN_CONTROL_POLL_INTERVAL_MS", "5");
    const controls = [
      // 规划前：暂停 → 收到第一条引导 → 恢复
      snap({ state: "paused", revision: 1, commands: [{ id: 1, revision: 1, action: "pause" }] }),
      snap({ state: "paused", revision: 2, commands: [guidance(2, 2, "先核对内容来源")] }),
      snap({ state: "running", revision: 3, commands: [{ id: 3, revision: 3, action: "resume" }] }),
      // 工具步骤前：直接运行
      snap({ revision: 3 }),
      // 最终评估前：暂停 → 第二条引导 → 恢复
      snap({ state: "paused", revision: 4, commands: [{ id: 4, revision: 4, action: "pause" }] }),
      snap({ state: "paused", revision: 5, commands: [guidance(5, 5, "重点核对课程范围")] }),
      snap({ state: "running", revision: 6, commands: [{ id: 6, revision: 6, action: "resume" }] }),
    ];
    const getRunControl = vi.fn(async () => controls.shift() ?? snap({ revision: 6 }));
    const ackRunControl = vi.fn(async (_runId: string, ids: readonly number[]) => ids.length);

    const outputs: unknown[] = [plan, riskOutput];
    const generate = vi.fn(async (options: Parameters<MockLanguageModelV4["doGenerate"]>[0]) =>
      approvedReview(options) ?? {
        content: [{ type: "text" as const, text: JSON.stringify(outputs.shift()) }],
        finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [],
      });
    const model = new MockLanguageModelV4({ doGenerate: generate, doStream: vi.fn(async () => ({
      stream: simulateReadableStream({ chunks: [] }),
    })) });
    const audit = auditStub();
    const client: UserInternalClient = chatStreamStub().apply({
      audit,
      resolvePrincipal: vi.fn().mockResolvedValue(Object.freeze({
        user_id: 3, role: "student", status: "active", identity_type: "undergraduate", assistant_cert_status: "none",
      })),
      fetchModerationTarget: vi.fn().mockResolvedValue({
        targetType: "answer", targetId: 12, authorId: 1, courseId: 2, body: "后端原文",
      }),
      getRunControl,
      ackRunControl,
    });
    const app = createApp({ getModel: () => model, createClient: () => client });

    const response = await app.request("/agent/tasks/moderation_scan", {
      method: "POST", headers: { authorization: "Bearer user" },
      body: JSON.stringify({ targetType: "answer", targetId: 12, contentExcerpt: "请求方摘录" }),
    });

    expect(response.status).toBe(200);
    const planPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(planPrompt).toContain("管理员运行中引导");
    expect(planPrompt).toContain("先核对内容来源");
    expect(planPrompt).not.toContain("重点核对课程范围");
    const evaluationPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(evaluationPrompt).toContain("管理员运行中引导");
    expect(evaluationPrompt).toContain("重点核对课程范围");

    const controlEvents = audit.recordEvent.mock.calls
      .map(([, input]) => input.event_type)
      .filter((type) => type.startsWith("control_"));
    expect(controlEvents).toEqual([
      "control_pause", "control_guidance", "control_resume",
      "control_pause", "control_guidance", "control_resume",
    ]);
    expect(ackRunControl.mock.calls.map(([, ids]) => [...ids]))
      .toEqual([[1], [2], [3], [4], [5], [6]]);
  });

  it("开关关闭时完全不轮询，行为与现状一致", async () => {
    vi.stubEnv("RUN_CONTROL_ENABLED", "false");
    const getRunControl = vi.fn();
    const outputs: unknown[] = [plan, riskOutput];
    const generate = vi.fn(async (options: Parameters<MockLanguageModelV4["doGenerate"]>[0]) =>
      approvedReview(options) ?? {
        content: [{ type: "text" as const, text: JSON.stringify(outputs.shift()) }],
        finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [],
      });
    const model = new MockLanguageModelV4({ doGenerate: generate, doStream: vi.fn(async () => ({
      stream: simulateReadableStream({ chunks: [] }),
    })) });
    const client: UserInternalClient = chatStreamStub().apply({
      audit: auditStub(),
      resolvePrincipal: vi.fn().mockResolvedValue(Object.freeze({
        user_id: 3, role: "student", status: "active", identity_type: "undergraduate", assistant_cert_status: "none",
      })),
      fetchModerationTarget: vi.fn().mockResolvedValue({
        targetType: "answer", targetId: 12, authorId: 1, courseId: 2, body: "后端原文",
      }),
      getRunControl,
      ackRunControl: vi.fn(),
    });
    const app = createApp({ getModel: () => model, createClient: () => client });
    const response = await app.request("/agent/tasks/moderation_scan", {
      method: "POST", headers: { authorization: "Bearer user" },
      body: JSON.stringify({ targetType: "answer", targetId: 12, contentExcerpt: "请求方摘录" }),
    });
    expect(response.status).toBe(200);
    expect(getRunControl).not.toHaveBeenCalled();
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).not.toContain("管理员运行中引导");
  });
});
