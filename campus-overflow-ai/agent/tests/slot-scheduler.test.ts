// SA-01 调度器：问答优先、空闲问答槽支援治理、问答回压时安全检查点让位、超限明确繁忙。
import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_SLOTS, PoolBusyError, QA_SLOTS, SlotScheduler, type SchedulerLease,
} from "../src/orchestrator/scheduler.js";
import type { SlotKind } from "../src/orchestrator/slot-pool.js";

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

const gate = (): Gate => {
  let resolve!: () => void;
  const promise = new Promise<void>(resolved => { resolve = resolved; });
  return { promise, resolve };
};

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

const schedulerOf = (): {
  scheduler: SlotScheduler;
  started: string[];
  gates: Map<string, Gate>;
  job: (jobId: string, kind: SlotKind) => {
    job_id: string;
    kind: SlotKind;
    run: () => Promise<string>;
  };
} => {
  const scheduler = new SlotScheduler();
  const started: string[] = [];
  const gates = new Map<string, Gate>();
  const job = (jobId: string, kind: SlotKind) => {
    const current = gate();
    gates.set(jobId, current);
    return {
      job_id: jobId,
      kind,
      run: async () => {
        started.push(jobId);
        await current.promise;
        return jobId;
      },
    };
  };
  return { scheduler, started, gates, job };
};

const fillAllSlots = async (scheduler: SlotScheduler, job: ReturnType<typeof schedulerOf>["job"]) => {
  for (let index = 0; index < QA_SLOTS; index += 1) void scheduler.submit(job(`qa-busy-${index}`, "qa"));
  for (let index = 0; index < GOVERNANCE_SLOTS; index += 1) {
    void scheduler.submit(job(`gov-busy-${index}`, "governance"));
  }
  await tick();
};

describe("子 Agent 槽位调度", () => {
  it("问答优先：问答槽释放后先跑排队问答，再跑排队治理", async () => {
    const { scheduler, started, gates, job } = schedulerOf();
    await fillAllSlots(scheduler, job);
    expect(started).toHaveLength(8);

    void scheduler.submit(job("gov-queued", "governance"));
    void scheduler.submit(job("qa-queued", "qa"));
    await tick();
    expect(started).not.toContain("qa-queued");
    expect(scheduler.snapshot().queues).toMatchObject({
      qa: { waiting: 1 }, governance: { waiting: 1 },
    });

    gates.get("qa-busy-0")?.resolve();
    await tick();
    expect(started).toContain("qa-queued");
    expect(started).not.toContain("gov-queued");

    for (const current of gates.values()) current.resolve();
    await tick();
  });

  it("问答槽空闲时支援治理，单实例不超过 8 个并发任务", async () => {
    const { scheduler, started, gates, job } = schedulerOf();
    for (let index = 0; index < 8; index += 1) {
      void scheduler.submit(job(`gov-${index}`, "governance"));
    }
    await tick();

    expect(started).toHaveLength(8);
    const snapshot = scheduler.snapshot();
    expect(snapshot.slots.filter(slot => slot.state === "running")).toHaveLength(8);
    expect(snapshot.slots.filter(slot => slot.supporting_governance)).toHaveLength(QA_SLOTS);
    expect(snapshot.queues.governance.waiting).toBe(0);

    for (const current of gates.values()) current.resolve();
    await tick();
  });

  it("问答回压时支援槽在安全检查点让位并重新排队，不丢失治理任务", async () => {
    const scheduler = new SlotScheduler();
    const started: string[] = [];
    const gates = new Map<string, Gate>();
    const tracked = (jobId: string, kind: SlotKind) => {
      const current = gate();
      gates.set(jobId, current);
      return { job_id: jobId, kind, run: async () => { started.push(jobId); await current.promise; return jobId; } };
    };

    for (let index = 0; index < QA_SLOTS - 1; index += 1) {
      void scheduler.submit(tracked(`qa-busy-${index}`, "qa"));
    }
    for (let index = 0; index < GOVERNANCE_SLOTS; index += 1) {
      void scheduler.submit(tracked(`gov-busy-${index}`, "governance"));
    }
    await tick();

    // 治理任务落到最后一个问答槽，先完成一个已提交步骤再到达安全检查点
    const committedStep = gate();
    let governanceAttempts = 0;
    const governance = scheduler.submit({
      job_id: "gov-support",
      kind: "governance",
      run: async (lease: SchedulerLease) => {
        governanceAttempts += 1;
        if (governanceAttempts > 1) return "gov-done";
        await committedStep.promise;
        lease.yieldIfNeeded();
        return "gov-unreachable";
      },
    });
    await tick();
    expect(governanceAttempts).toBe(1);

    void scheduler.submit(tracked("qa-queued", "qa"));
    await tick();
    const draining = scheduler.snapshot().slots.filter(slot => slot.state === "draining");
    expect(draining).toHaveLength(1);
    expect(draining[0]?.supporting_governance).toBe(true);
    expect(scheduler.snapshot().queues.qa.waiting).toBe(1);

    committedStep.resolve();
    await tick();
    expect(started).toContain("qa-queued");
    expect(governanceAttempts).toBe(1);

    // 任意槽释放后，让位重排的治理任务重新执行
    gates.get("qa-busy-0")?.resolve();
    await tick();
    await expect(governance).resolves.toBe("gov-done");
    expect(governanceAttempts).toBe(2);

    for (const current of gates.values()) current.resolve();
    await tick();
  });

  it("等待超过上限时明确返回繁忙", async () => {
    const scheduler = new SlotScheduler({ maxWaiting: 1 });
    const gates: Gate[] = [];
    const job = (jobId: string, kind: SlotKind) => {
      const current = gate();
      gates.push(current);
      return { job_id: jobId, kind, run: async () => { await current.promise; return jobId; } };
    };
    for (let index = 0; index < QA_SLOTS; index += 1) {
      void scheduler.submit(job(`strict-qa-${index}`, "qa"));
    }
    for (let index = 0; index < GOVERNANCE_SLOTS; index += 1) {
      void scheduler.submit(job(`strict-gov-${index}`, "governance"));
    }
    await tick();

    void scheduler.submit(job("strict-waiting", "qa"));
    await expect(scheduler.submit(job("strict-overflow", "qa"))).rejects.toBeInstanceOf(PoolBusyError);

    for (const current of gates) current.resolve();
    await tick();
  });

  it("快照包含 8 槽、队列长度与最长等待时长", async () => {
    let now = 1_000;
    const scheduler = new SlotScheduler({ now: () => now });
    const gates: Gate[] = [];
    const job = (jobId: string, kind: SlotKind) => {
      const current = gate();
      gates.push(current);
      return { job_id: jobId, kind, run: async () => { await current.promise; return jobId; } };
    };
    for (let index = 0; index < 8; index += 1) {
      void scheduler.submit(job(`busy-${index}`, "governance"));
    }
    await tick();

    void scheduler.submit(job("qa-waiting", "qa"));
    now += 250;
    const snapshot = scheduler.snapshot();
    expect(snapshot.slots).toHaveLength(8);
    expect(snapshot.queues).toEqual({
      qa: { waiting: 1, oldest_wait_ms: 250 },
      governance: { waiting: 0, oldest_wait_ms: 0 },
    });

    for (const current of gates) current.resolve();
    await tick();
  });
});
