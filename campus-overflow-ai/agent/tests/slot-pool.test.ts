// SA-01 槽位池：固定 3 治理 + 5 问答，问答任务不占治理槽，治理仅在治理槽满后占用空闲问答槽。
import { describe, expect, it } from "vitest";

import { GOVERNANCE_SLOTS, MAX_AGENT_SLOTS, QA_SLOTS, SlotPool } from "../src/orchestrator/slot-pool.js";

describe("子 Agent 槽位池", () => {
  it("固定 3 治理 + 5 问答，共 8 槽且初始空闲", () => {
    const slots = new SlotPool().snapshot();

    expect(MAX_AGENT_SLOTS).toBe(8);
    expect(slots).toHaveLength(8);
    expect(slots.filter(slot => slot.slot_kind === "governance")).toHaveLength(GOVERNANCE_SLOTS);
    expect(slots.filter(slot => slot.slot_kind === "qa")).toHaveLength(QA_SLOTS);
    expect(slots.every(slot => slot.state === "idle")).toBe(true);
  });

  it("问答任务只占用问答槽", () => {
    const pool = new SlotPool();
    const handles = Array.from({ length: QA_SLOTS }, () => pool.lease("qa"));

    expect(handles.every(handle => handle?.slot_kind === "qa")).toBe(true);
    expect(pool.lease("qa")).toBeUndefined();
    // 问答槽占满不影响治理槽
    expect(pool.lease("governance")?.slot_kind).toBe("governance");
  });

  it("治理优先用治理槽，治理槽满后才用空闲问答槽支援", () => {
    const pool = new SlotPool();
    const own = Array.from({ length: GOVERNANCE_SLOTS }, () => pool.lease("governance"));

    expect(own.every(handle => handle?.slot_kind === "governance")).toBe(true);
    expect(own.every(handle => handle?.supporting_governance === false)).toBe(true);
    const support = pool.lease("governance");
    expect(support?.slot_kind).toBe("qa");
    expect(support?.supporting_governance).toBe(true);
  });

  it("问答回压时治理不占用空闲问答槽", () => {
    const pool = new SlotPool();
    for (let index = 0; index < GOVERNANCE_SLOTS; index += 1) pool.lease("governance");

    expect(pool.lease("governance", { allowQaSupport: false })).toBeUndefined();
  });

  it("启动与释放复位槽位，不保留上一个任务", () => {
    const pool = new SlotPool();
    const handle = pool.lease("governance");
    expect(handle).toBeDefined();
    if (!handle) return;

    pool.start(handle, "job-1");
    expect(pool.snapshot().find(slot => slot.slot_id === handle.slot_id)).toMatchObject({
      state: "running", job_id: "job-1",
    });
    expect(pool.snapshot().find(slot => slot.slot_id === handle.slot_id)?.started_at).not.toBeNull();

    pool.release(handle.slot_id);
    expect(pool.snapshot().find(slot => slot.slot_id === handle.slot_id)).toEqual({
      slot_id: handle.slot_id,
      slot_kind: "governance",
      state: "idle",
      job_id: null,
      supporting_governance: false,
      started_at: null,
    });
  });

  it("只允许支援中的问答槽让位", () => {
    const pool = new SlotPool();
    const governance = pool.lease("governance");
    const qa = pool.lease("qa");
    expect(governance && pool.drain(governance.slot_id)).toBe(false);
    expect(qa && pool.drain(qa.slot_id)).toBe(false);

    for (let index = 1; index < GOVERNANCE_SLOTS; index += 1) pool.lease("governance");
    const support = pool.lease("governance");
    expect(support?.supporting_governance).toBe(true);
    if (!support) return;

    pool.start(support, "job-support");
    expect(pool.drain(support.slot_id)).toBe(true);
    expect(pool.isDraining(support.slot_id)).toBe(true);
    expect(pool.snapshot().find(slot => slot.slot_id === support.slot_id)?.state).toBe("draining");
  });
});
