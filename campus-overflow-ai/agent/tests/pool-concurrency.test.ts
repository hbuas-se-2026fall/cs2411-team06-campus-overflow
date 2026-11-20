// SA-06 并发与公平性：8 槽不超限、问答优先不被治理饿死、槽位复用不残留支援状态。
import { describe, expect, it } from "vitest";

import type { SchedulerLease } from "../src/orchestrator/scheduler.js";
import { AgentPool } from "../src/runtime/agent-pool.js";

const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const pending = () => new Promise<never>(() => {});

describe("子 Agent 池并发与公平性", () => {
  it("任意并发下运行槽位不超过 8，问答与治理按各自容量排队", async () => {
    const pool = new AgentPool({ maxWaiting: 100 });
    for (let index = 0; index < 20; index += 1) {
      void pool.scheduler.submit({ job_id: `qa-${index}`, kind: "qa", run: pending });
    }
    await nextTick();
    expect(pool.snapshot().slots.filter(slot => slot.state === "running")).toHaveLength(5);

    for (let index = 0; index < 10; index += 1) {
      void pool.scheduler.submit({ job_id: `gov-${index}`, kind: "governance", run: pending });
    }
    await nextTick();

    const snapshot = pool.snapshot();
    const running = snapshot.slots.filter(slot => slot.state === "running");
    expect(running).toHaveLength(8);
    expect(new Set(running.map(slot => slot.slot_id)).size).toBe(8);
    expect(running.filter(slot => slot.slot_kind === "qa")).toHaveLength(5);
    expect(snapshot.queues.qa.waiting).toBe(15);
    expect(snapshot.queues.governance.waiting).toBe(7);
  });

  it("问答到达时支援槽在检查点归还，问答不被治理积压饿死", async () => {
    const pool = new AgentPool({ maxWaiting: 100 });
    for (let index = 0; index < 3; index += 1) {
      void pool.scheduler.submit({ job_id: `gov-block-${index}`, kind: "governance", run: pending });
    }
    await nextTick();

    const gates = Array.from({ length: 5 }, () => deferred());
    const supportLeases: SchedulerLease[] = [];
    gates.forEach((gate, index) => {
      void pool.scheduler.submit({
        job_id: `gov-support-${index}`,
        kind: "governance",
        run: async (lease) => {
          supportLeases.push(lease);
          await gate.promise;
          lease.yieldIfNeeded();
        },
      });
    });
    await nextTick();
    expect(supportLeases).toHaveLength(5);
    expect(supportLeases.every(lease => lease.supporting_governance)).toBe(true);

    const qaGate = deferred();
    let qaLease: SchedulerLease | undefined;
    void pool.scheduler.submit({
      job_id: "qa-arrived",
      kind: "qa",
      run: async (lease) => {
        qaLease = lease;
        await qaGate.promise;
      },
    });
    await nextTick();
    expect(pool.snapshot().slots.filter(slot => slot.state === "draining")).toHaveLength(5);

    gates.forEach(gate => gate.resolve());
    await nextTick();
    await nextTick();

    expect(qaLease).toBeDefined();
    expect(qaLease?.slot_kind).toBe("qa");
    expect(qaLease?.supporting_governance).toBe(false);
    expect(pool.snapshot().slots.some(slot => slot.state === "draining")).toBe(false);
  });

  it("槽位复用后复位支援标记，新任务拿到独立租约", async () => {
    const pool = new AgentPool({ maxWaiting: 10 });
    for (let index = 0; index < 3; index += 1) {
      void pool.scheduler.submit({ job_id: `gov-block-${index}`, kind: "governance", run: pending });
    }
    await nextTick();

    let supportLease: SchedulerLease | undefined;
    await pool.scheduler.submit({
      job_id: "gov-support-once",
      kind: "governance",
      run: async (lease) => { supportLease = lease; },
    });
    const reusedSlotId = supportLease?.slot_id;
    expect(supportLease?.supporting_governance).toBe(true);
    expect(pool.snapshot().slots.find(slot => slot.slot_id === reusedSlotId)).toMatchObject({
      state: "idle", job_id: null, supporting_governance: false,
    });

    let qaLease: SchedulerLease | undefined;
    const qaGate = deferred();
    void pool.scheduler.submit({
      job_id: "qa-after-support",
      kind: "qa",
      run: async (lease) => { qaLease = lease; await qaGate.promise; },
    });
    await nextTick();

    expect(qaLease?.slot_id).toBe(reusedSlotId);
    expect(qaLease?.supporting_governance).toBe(false);
    expect(qaLease).not.toBe(supportLease);
    expect(pool.snapshot().slots.find(slot => slot.slot_id === reusedSlotId)?.job_id).toBe("qa-after-support");
  });
});
