// SA-07B：并行步骤的审计事件必须串行写入，sequence_no 严格递增（ADR-010）
import { describe, expect, it } from "vitest";

import type { AuditClient, AuditEventInput } from "../src/observability/audit-client";
import { PersistentRunAudit } from "../src/observability/persistent-audit";
import { createRunContext } from "../src/observability/run-context";
import type { PlanStep } from "../src/types/plan";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("并发步骤的审计写入", () => {
  it("四个步骤同时开始，审计事件仍逐个写入且 sequence 连续", async () => {
    const run = createRunContext({ taskType: "chat" });
    let sequence = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const client = {
      createRun: async () => ({ id: 1, user_id: undefined as unknown as null,
        agent_run_id: run.agentRunId, trace_id: run.traceId, status: "running" }),
      recordEvent: async (_id: string, body: AuditEventInput) => {
        concurrent += 1;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        await sleep(3);
        concurrent -= 1;
        sequence += 1;
        return { id: sequence, sequence_no: sequence, agent_run_id: run.agentRunId, trace_id: run.traceId,
          event_type: body.event_type, plan_revision: body.plan_revision,
          steps: body.steps ?? null, step_id: body.step_id ?? null, tool_name: body.tool_name ?? null,
          duration_ms: body.duration_ms ?? null };
      },
      finishRun: async () => ({ id: 1, user_id: undefined as unknown as null,
        agent_run_id: run.agentRunId, trace_id: run.traceId, status: "succeeded" }),
    } as unknown as AuditClient;

    const audit = new PersistentRunAudit(client, run);
    await audit.create();
    const steps: PlanStep[] = Array.from({ length: 4 }, (_, index) => ({
      stepId: `s${index + 1}`, objective: "读取", toolName: "echo", args: {},
    }));
    await audit.recordPlan({ steps });
    await Promise.all(steps.map((step) => audit.beforeStep(step)));

    expect(maxConcurrent).toBe(1);
    expect(sequence).toBe(5);
  });
});
