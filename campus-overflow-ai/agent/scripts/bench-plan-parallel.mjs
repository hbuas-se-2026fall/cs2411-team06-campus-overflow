/**
 * SA-07D 压测：同一只读计划串行 vs 并行 p95 对比（ADR-010 验收门槛 ≥30%）。
 * 用法：npm run bench:plan-parallel
 *
 * 使用真实 executePlan + 模拟 120ms 工具延迟，不依赖后端或模型；
 * 计划 8 步互不依赖，并行受单计划上限 4 约束（两批完成）。
 */
import { performance } from "node:perf_hooks";

import { z } from "zod";

import { executePlan } from "../src/loop/plan-executor.ts";
import { createRunContext } from "../src/observability/run-context.ts";
import { createToolRegistry } from "../src/tools/registry.ts";

const STEP_COUNT = 8;
const TOOL_LATENCY_MS = 120;
const RUNS = 20;
const P95_THRESHOLD = 0.3;

const registry = createToolRegistry();
registry.registerTool({
  name: "probe",
  description: "压测只读工具",
  riskLevel: "low",
  inputSchema: z.object({ keyword: z.string() }).passthrough(),
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, TOOL_LATENCY_MS));
    return { ok: true, title: "probe-result" };
  },
});

const plan = {
  steps: Array.from({ length: STEP_COUNT }, (_, index) => ({
    stepId: `s${index + 1}`,
    objective: `并发探测 ${index + 1}`,
    toolName: "probe",
    args: { keyword: `k${index + 1}` },
  })),
};

const percentile = (sorted, ratio) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];

const measure = async (parallel) => {
  const samples = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    const result = await executePlan(plan, {
      registry,
      toolContext: createRunContext({ taskType: "chat" }),
      input: {},
      parallel,
    });
    samples.push(performance.now() - started);
    if (result.toolCallCount !== STEP_COUNT || result.stepResults.size !== STEP_COUNT) {
      throw new Error(`执行结果不完整：calls=${result.toolCallCount} results=${result.stepResults.size}`);
    }
  }
  samples.sort((left, right) => left - right);
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    avg: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
};

const format = (value) => `${value.toFixed(1)}ms`;

const serial = await measure(false);
const parallel = await measure(true);
const drop = (serial.p95 - parallel.p95) / serial.p95;

console.log(`计划内并行压测：${STEP_COUNT} 步 × ${RUNS} 次，单步模拟 ${TOOL_LATENCY_MS}ms`);
console.log(`串行  p50=${format(serial.p50)}  p95=${format(serial.p95)}  avg=${format(serial.avg)}`);
console.log(`并行  p50=${format(parallel.p50)}  p95=${format(parallel.p95)}  avg=${format(parallel.avg)}`);
console.log(`p95 降幅：${(drop * 100).toFixed(1)}%（门槛 ${(P95_THRESHOLD * 100).toFixed(0)}%）`);

if (drop < P95_THRESHOLD) {
  console.error("未达到 ADR-010 验收门槛");
  process.exitCode = 1;
}
