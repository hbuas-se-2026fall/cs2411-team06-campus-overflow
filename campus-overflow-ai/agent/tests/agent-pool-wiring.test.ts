// 生产入口接线：任务映射到对应槽位，池饱和时明确繁忙，快照可供后续管理端使用。
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { UserInternalClient } from "../src/internal-client.js";
import { AgentPool, slotKindForTask } from "../src/runtime/agent-pool.js";
import { auditStub } from "./helpers/audit-stub.js";

const principal = {
  user_id: 1, role: "student", status: "active",
  identity_type: "undergraduate", assistant_cert_status: "none",
} as const;

const clientOf = (): UserInternalClient => ({
  audit: auditStub(1),
  resolvePrincipal: async () => Object.freeze(principal),
} as unknown as UserInternalClient);

const holdSlot = (pool: AgentPool, jobId: string, kind: "qa" | "governance") => {
  void pool.scheduler.submit({ job_id: jobId, kind, run: () => new Promise<never>(() => {}) });
};

describe("生产入口接入子 Agent 池", () => {
  it("治理任务走治理槽，聊天与教学任务走问答槽", () => {
    expect(slotKindForTask("moderation_scan")).toBe("governance");
    expect(slotKindForTask("chat")).toBe("qa");
    expect(slotKindForTask("similar_questions")).toBe("qa");
    expect(slotKindForTask("suggest_tags")).toBe("qa");
    expect(slotKindForTask("doc_draft")).toBe("qa");
    expect(slotKindForTask("knowledge_tree")).toBe("qa");
  });

  it("快照包含实例标识与固定 8 槽", async () => {
    const pool = new AgentPool({ instanceId: "agent-test" });
    await expect(pool.run("qa", "job-1", async () => "ok")).resolves.toBe("ok");

    const snapshot = pool.snapshot();
    expect(snapshot.instance_id).toBe("agent-test");
    expect(snapshot.slots).toHaveLength(8);
    expect(snapshot.slots.every(slot => slot.state === "idle")).toBe(true);
    expect(snapshot.queues).toEqual({
      qa: { waiting: 0, oldest_wait_ms: 0 },
      governance: { waiting: 0, oldest_wait_ms: 0 },
    });
  });

  it("问答槽与队列都满时任务路由明确返回繁忙", async () => {
    const pool = new AgentPool({ maxWaiting: 1 });
    const app = createApp({ pool, createClient: clientOf, getModel: () => ({}) as LanguageModel });
    for (let index = 0; index < 5; index += 1) holdSlot(pool, `qa-busy-${index}`, "qa");
    holdSlot(pool, "qa-waiting", "qa");

    const response = await app.request("/agent/tasks/similar_questions", {
      method: "POST",
      headers: { authorization: "Bearer test-user", "x-trace-id": "trace-busy" },
      body: JSON.stringify({ questionTitle: "如何理解进程调度" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 503, message: expect.stringContaining("繁忙") });
  });

  it("问答饱和时治理槽仍可接纳治理任务", async () => {
    const pool = new AgentPool({ maxWaiting: 0 });
    for (let index = 0; index < 5; index += 1) holdSlot(pool, `qa-busy-${index}`, "qa");
    // maxWaiting=0 时，问答任务入队会被拒绝，但治理槽独立
    await expect(pool.run("qa", "qa-overflow", async () => "never")).rejects.toThrow("繁忙");
    const governance = pool.run("governance", "gov-1", async () => "gov-ok");
    await expect(governance).resolves.toBe("gov-ok");
  });
});
