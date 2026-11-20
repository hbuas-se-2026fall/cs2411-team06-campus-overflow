// SA-02 子 Agent 执行入口：上下文重建、检查点续接、预算/轮次累计、已提交动作不重放。
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { ChildAgentRunner, type ChildStepContext } from "../src/agents/runner.js";
import type { UserInternalClient } from "../src/internal-client.js";
import type { ChildRunSpec } from "../src/orchestrator/run-context.js";
import { SlotYieldSignal, type SchedulerLease } from "../src/orchestrator/scheduler.js";

const principal = {
  user_id: 7, role: "student", status: "active",
  identity_type: "undergraduate", assistant_cert_status: "none",
} as const;

const leaseOf = (state: { draining: boolean }): SchedulerLease => ({
  slot_id: "qa-1",
  slot_kind: "qa",
  supporting_governance: true,
  signal: new AbortController().signal,
  yieldIfNeeded: () => {
    if (state.draining) throw new SlotYieldSignal("qa-1");
  },
});

const specOf = (createClient: () => UserInternalClient): ChildRunSpec => ({
  jobId: "job-1",
  actorKind: "governance",
  taskType: "moderation_scan",
  principal,
  createClient,
  model: {} as LanguageModel,
});

describe("子 Agent 执行入口", () => {
  it("每次尝试重建客户端与运行上下文，trace 跨让位保持一致", async () => {
    const runner = new ChildAgentRunner();
    const clients: UserInternalClient[] = [];
    const spec = specOf(() => {
      const client = {} as UserInternalClient;
      clients.push(client);
      return client;
    });
    const state = { draining: false };
    const runIds: string[] = [];
    const traceIds: string[] = [];
    let attempts = 0;
    const execute = async ({ context, safePoint }: ChildStepContext) => {
      attempts += 1;
      runIds.push(context.run.agentRunId);
      traceIds.push(context.run.traceId);
      if (attempts === 1) {
        state.draining = true;
        safePoint();
      }
      return "done";
    };

    await expect(runner.run(spec, leaseOf(state), execute)).rejects.toBeInstanceOf(SlotYieldSignal);
    state.draining = false;
    await expect(runner.run(spec, leaseOf(state), execute)).resolves.toBe("done");

    expect(attempts).toBe(2);
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
    expect(runIds[0]).not.toBe(runIds[1]);
    expect(traceIds[1]).toBe(traceIds[0]);
  });

  it("让位后预算、步骤与治理轮次继续累计，不重置", async () => {
    const runner = new ChildAgentRunner();
    const spec = specOf(() => ({}) as UserInternalClient);
    const state = { draining: false };
    let attempts = 0;
    let usedAtResume = -1;
    let roundAtResume = -1;
    let stepDoneAtResume = false;

    const execute = async ({
      context, isStepDone, markStepDone, setGovernanceRound, governanceRound, safePoint,
    }: ChildStepContext) => {
      attempts += 1;
      if (attempts === 1) {
        context.run.toolBudget.consume();
        markStepDone("round-1");
        setGovernanceRound(1);
        state.draining = true;
        safePoint();
      }
      usedAtResume = context.run.toolBudget.used;
      roundAtResume = governanceRound();
      stepDoneAtResume = isStepDone("round-1");
      context.run.toolBudget.consume();
      return "ok";
    };

    await expect(runner.run(spec, leaseOf(state), execute)).rejects.toBeInstanceOf(SlotYieldSignal);
    state.draining = false;
    await expect(runner.run(spec, leaseOf(state), execute)).resolves.toBe("ok");

    expect(usedAtResume).toBe(1);
    expect(roundAtResume).toBe(1);
    expect(stepDoneAtResume).toBe(true);
  });

  it("已提交动作在恢复后不重复执行", async () => {
    const runner = new ChildAgentRunner();
    const spec = specOf(() => ({}) as UserInternalClient);
    const state = { draining: false };
    let attempts = 0;
    let actionCalls = 0;
    let executedOnResume: boolean | undefined;

    const execute = async ({ commit, safePoint }: ChildStepContext) => {
      attempts += 1;
      const executed = await commit("approval:question:1", async () => { actionCalls += 1; });
      if (attempts === 1) {
        state.draining = true;
        safePoint();
      }
      executedOnResume = executed;
      return "ok";
    };

    await expect(runner.run(spec, leaseOf(state), execute)).rejects.toBeInstanceOf(SlotYieldSignal);
    state.draining = false;
    await expect(runner.run(spec, leaseOf(state), execute)).resolves.toBe("ok");

    expect(actionCalls).toBe(1);
    expect(executedOnResume).toBe(false);
  });

  it("活动时间跨尝试累计", async () => {
    let now = 1_000;
    const runner = new ChildAgentRunner({ now: () => now });
    const spec = specOf(() => ({}) as UserInternalClient);
    const state = { draining: false };
    let attempts = 0;
    const observed: number[] = [];

    const execute = async ({ activityMs, safePoint }: ChildStepContext) => {
      attempts += 1;
      observed.push(activityMs());
      if (attempts === 1) {
        now = 1_150;
        state.draining = true;
        safePoint();
      }
      return "ok";
    };

    await expect(runner.run(spec, leaseOf(state), execute)).rejects.toBeInstanceOf(SlotYieldSignal);
    state.draining = false;
    now = 1_200;
    await expect(runner.run(spec, leaseOf(state), execute)).resolves.toBe("ok");

    expect(observed).toEqual([0, 150]);
  });

  it("成功后清空检查点，失败不保留检查点", async () => {
    const runner = new ChildAgentRunner();
    const spec = specOf(() => ({}) as UserInternalClient);
    const state = { draining: false };

    await expect(runner.run(spec, leaseOf(state), async () => "ok")).resolves.toBe("ok");
    expect(runner.checkpoints.size()).toBe(0);

    await expect(runner.run(spec, leaseOf(state), async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(runner.checkpoints.size()).toBe(0);
  });

  it("工具表只含低风险工具，且不注册记忆写入", async () => {
    const runner = new ChildAgentRunner();
    const spec = specOf(() => ({}) as UserInternalClient);
    const state = { draining: false };
    let toolNames: string[] = [];
    let highRisk = 0;

    await runner.run(spec, leaseOf(state), async ({ context }: ChildStepContext) => {
      const tools = context.tools.listTools();
      toolNames = tools.map(tool => tool.name);
      highRisk = tools.filter(tool => tool.riskLevel !== "low").length;
      return "ok";
    });

    expect(toolNames.length).toBeGreaterThan(0);
    expect(highRisk).toBe(0);
    // 只读记忆可以继承，写入记忆的动作工具不得出现在子 Agent 工具表
    const memoryWrites = ["writeMemory", "saveMemory", "updateMemory", "deleteMemory", "createMemory"];
    expect(toolNames.filter(name => memoryWrites.includes(name))).toEqual([]);
  });
});
