// SA-07 计划内并行：默认串行、依赖分层、单计划与实例上限、失败传播、审批回退串行
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { InternalApiError } from "../src/internal-client";
import { acquireInflight, inflightSnapshot } from "../src/loop/inflight-limiter";
import { buildPlanLayers, executePlan, PlanExecutionError } from "../src/loop/plan-executor";
import { createRunContext } from "../src/observability/run-context";
import { createToolRegistry, type AgentTool } from "../src/tools/registry";
import type { PlanList } from "../src/types/plan";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const createTracker = () => {
  let active = 0;
  let max = 0;
  return {
    enter: () => { active += 1; if (active > max) max = active; },
    leave: () => { active -= 1; },
    get max() { return max; },
  };
};

type Tracker = ReturnType<typeof createTracker>;

const planWith = (steps: PlanList["steps"]): PlanList => ({ steps });

const stepsOf = (count: number): PlanList["steps"] => Array.from({ length: count }, (_, index) => ({
  stepId: `s${index + 1}`,
  objective: `步骤 ${index + 1}`,
  toolName: "echo",
  args: { keyword: `k${index + 1}` },
}));

const trackedEcho = (tracker: Tracker, delayMs = 20): AgentTool => ({
  name: "echo",
  description: "带并发计数的只读工具",
  riskLevel: "low",
  inputSchema: z.object({ keyword: z.string().optional() }).passthrough(),
  execute: async () => {
    tracker.enter();
    try { await sleep(delayMs); } finally { tracker.leave(); }
    return { ok: true, title: "result" };
  },
});

const run = () => createRunContext({ taskType: "chat" });

afterEach(() => { vi.unstubAllEnvs(); });

describe("计划内并行执行（SA-07）", () => {
  it("默认关闭：独立步骤仍串行执行", async () => {
    const tracker = createTracker();
    const registry = createToolRegistry();
    registry.registerTool(trackedEcho(tracker));
    const result = await executePlan(planWith(stepsOf(4)), { registry, toolContext: run(), input: {} });
    expect(result.toolCallCount).toBe(4);
    expect(tracker.max).toBe(1);
  });

  it("开启后独立步骤并发，且不超过单计划默认上限 4", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    const tracker = createTracker();
    const registry = createToolRegistry();
    registry.registerTool(trackedEcho(tracker));
    const result = await executePlan(planWith(stepsOf(4)), { registry, toolContext: run(), input: {} });
    expect(result.toolCallCount).toBe(4);
    expect(tracker.max).toBeGreaterThan(1);
    expect(tracker.max).toBeLessThanOrEqual(4);
  });

  it("单计划在途上限可由环境变量收紧", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    vi.stubEnv("PLAN_MAX_PARALLEL_STEPS", "2");
    const tracker = createTracker();
    const registry = createToolRegistry();
    registry.registerTool(trackedEcho(tracker));
    await executePlan(planWith(stepsOf(6)), { registry, toolContext: run(), input: {} });
    expect(tracker.max).toBeGreaterThan(1);
    expect(tracker.max).toBeLessThanOrEqual(2);
  });

  it("引用前序结果的步骤等待依赖完成后才执行", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    const events: string[] = [];
    const registry = createToolRegistry();
    registry.registerTool({ name: "first", description: "前序", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async () => { await sleep(30); events.push("first"); return { title: "done" }; } });
    registry.registerTool({ name: "second", description: "依赖前序", riskLevel: "low",
      inputSchema: z.object({ keyword: z.string() }),
      execute: async () => { events.push("second"); return { ok: true }; } });
    const plan = planWith([
      { stepId: "s1", objective: "先执行", toolName: "first", args: {} },
      { stepId: "s2", objective: "引用 s1", toolName: "second", args: { keyword: "$s1.title" } },
    ]);
    await executePlan(plan, { registry, toolContext: run(), input: {} });
    expect(events).toEqual(["first", "second"]);
  });

  it("实例级在途上限跨计划共享", async () => {
    const limit = 3;
    const releases = await Promise.all(Array.from({ length: limit }, () => acquireInflight(limit)));
    expect(inflightSnapshot(limit).active).toBe(limit);
    const pending = acquireInflight(limit);
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await sleep(0);
    expect(resolved).toBe(false);
    releases[0]!();
    const release = await pending;
    expect(inflightSnapshot(limit).active).toBe(limit);
    release();
    releases[1]!();
    releases[2]!();
    expect(inflightSnapshot(limit).active).toBe(0);
  });

  it("并行中 403 终止并取消其余在途调用", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    let aborted = false;
    const revoked = new InternalApiError(403, 403, "身份失效");
    const registry = createToolRegistry();
    registry.registerTool({ name: "slow", description: "慢调用", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async (_input, context) => {
        context.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        await sleep(50);
        return { ok: true };
      } });
    registry.registerTool({ name: "denied", description: "越权", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async () => { await sleep(5); throw revoked; } });
    const plan = planWith([
      { stepId: "s1", objective: "慢调用", toolName: "slow", args: {} },
      { stepId: "s2", objective: "越权", toolName: "denied", args: {} },
    ]);
    await expect(executePlan(plan, { registry, toolContext: run(), input: {} })).rejects.toBe(revoked);
    expect(aborted).toBe(true);
  });

  it("同层无依赖步骤并发，下游步骤等待全部依赖完成", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    const events: string[] = [];
    let active = 0;
    let max = 0;
    const parallelTool = (name: string, title: string) => ({
      name, description: `${name} 只读工具`, riskLevel: "low" as const,
      inputSchema: z.object({ keyword: z.string().optional() }).passthrough(),
      execute: async () => {
        active += 1;
        if (active > max) max = active;
        try { await sleep(30); events.push(name); return { title }; } finally { active -= 1; }
      },
    });
    const registry = createToolRegistry();
    registry.registerTool(parallelTool("left", "L"));
    registry.registerTool(parallelTool("right", "R"));
    registry.registerTool({ name: "join", description: "依赖合并", riskLevel: "low",
      inputSchema: z.object({ keyword: z.string(), note: z.string() }),
      execute: async () => { events.push("join"); return { ok: true }; } });
    const plan = planWith([
      { stepId: "s1", objective: "左侧", toolName: "left", args: {} },
      { stepId: "s2", objective: "右侧", toolName: "right", args: {} },
      { stepId: "s3", objective: "合并", toolName: "join", args: { keyword: "$s1.title", note: "$s2.title" } },
    ]);
    await executePlan(plan, { registry, toolContext: run(), input: {} });
    expect(max).toBe(2);
    expect(events.slice(0, 2).sort()).toEqual(["left", "right"]);
    expect(events[2]).toBe("join");
  });

  it("审批建单计划回退串行且每步只执行一次", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    const calls: string[] = [];
    const registry = createToolRegistry();
    registry.registerTool({ name: "probe", description: "只读探测", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async () => { calls.push("probe"); await sleep(10); return { ok: true }; } });
    registry.registerTool({ name: "proposeGovernance", description: "建单", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async () => { calls.push("propose"); return { approval_required: true }; } });
    const plan = planWith([
      { stepId: "s1", objective: "探测一", toolName: "probe", args: {} },
      { stepId: "s2", objective: "探测二", toolName: "probe", args: {} },
      { stepId: "s3", objective: "建单", toolName: "proposeGovernance", args: {} },
    ]);
    const result = await executePlan(plan, { registry, toolContext: run(), input: {} });
    expect(result.state).toBe("waiting");
    expect(calls).toEqual(["probe", "probe", "propose"]);
  });

  it("含审批动作的计划整份回退串行", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    const tracker = createTracker();
    const registry = createToolRegistry();
    registry.registerTool(trackedEcho(tracker));
    registry.registerTool({ name: "proposeGovernance", description: "建单", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async () => {
        tracker.enter();
        try { await sleep(10); } finally { tracker.leave(); }
        return { ok: true };
      } });
    const plan = planWith([
      ...stepsOf(2),
      { stepId: "s3", objective: "审批", toolName: "proposeGovernance", args: {} },
    ]);
    const result = await executePlan(plan, { registry, toolContext: run(), input: {} });
    expect(result.state).toBe("completed");
    expect(tracker.max).toBe(1);
  });

  it("普通失败按步骤收集，预算按实际调用累计", async () => {
    vi.stubEnv("PLAN_PARALLEL_ENABLED", "true");
    const registry = createToolRegistry();
    registry.registerTool({ name: "flaky", description: "失败工具", riskLevel: "low",
      inputSchema: z.object({}).passthrough(),
      execute: async () => { throw new Error("backend down"); } });
    registry.registerTool(trackedEcho(createTracker(), 5));
    const plan = planWith([
      { stepId: "s1", objective: "失败", toolName: "flaky", args: {} },
      { stepId: "s2", objective: "成功", toolName: "echo", args: { keyword: "a" } },
      { stepId: "s3", objective: "成功", toolName: "echo", args: { keyword: "b" } },
    ]);
    const result = await executePlan(plan, { registry, toolContext: run(), input: {} });
    expect(result.failures.size).toBe(1);
    expect(result.stepResults.size).toBe(2);
    expect(result.toolCallCount).toBe(3);
  });

  it("循环引用在依赖分析阶段拒绝", () => {
    const plan = planWith([
      { stepId: "s1", objective: "a", toolName: "echo", args: { keyword: "$s2.title" } },
      { stepId: "s2", objective: "b", toolName: "echo", args: { keyword: "$s1.title" } },
    ]);
    expect(() => buildPlanLayers(plan)).toThrow(PlanExecutionError);
  });
});
