// 子 Agent 槽位池（SA-01）：每实例固定 3 个治理槽 + 5 个问答槽，总共 8 个。
// 这里只做槽位状态机与快照；排队、优先级与让位语义由 scheduler 决定。
export const GOVERNANCE_SLOTS = 3;
export const QA_SLOTS = 5;
export const MAX_AGENT_SLOTS = GOVERNANCE_SLOTS + QA_SLOTS;

export type SlotKind = "governance" | "qa";
/** idle 空闲；leased 已分配未开跑；running 执行中；draining 支援任务已请求归还 */
export type SlotState = "idle" | "leased" | "running" | "draining";

/** 对外快照字段使用蛇形，便于内部接口与管理端直接复用 */
export interface SlotStatus {
  slot_id: string;
  slot_kind: SlotKind;
  state: SlotState;
  job_id: string | null;
  supporting_governance: boolean;
  started_at: string | null;
}

export interface SlotHandle {
  readonly slot_id: string;
  readonly slot_kind: SlotKind;
  readonly supporting_governance: boolean;
}

export interface LeaseOptions {
  /** 治理任务是否允许占用空闲问答槽；问答队列有等待时应传 false */
  allowQaSupport?: boolean;
}

interface SlotRecord {
  slotId: string;
  slotKind: SlotKind;
  state: SlotState;
  jobId: string | null;
  supportingGovernance: boolean;
  startedAt: number | null;
}

const createSlot = (slotId: string, slotKind: SlotKind): SlotRecord => ({
  slotId, slotKind, state: "idle", jobId: null, supportingGovernance: false, startedAt: null,
});

export class SlotPool {
  private readonly now: () => number;
  private readonly slots: SlotRecord[];

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.slots = [
      ...Array.from({ length: GOVERNANCE_SLOTS }, (_, index) => createSlot(`gov-${index + 1}`, "governance")),
      ...Array.from({ length: QA_SLOTS }, (_, index) => createSlot(`qa-${index + 1}`, "qa")),
    ];
  }

  /** 分配槽位：问答只取问答槽；治理先取治理槽，治理槽满后才支援空闲问答槽。 */
  lease(kind: SlotKind, options: LeaseOptions = {}): SlotHandle | undefined {
    const own = this.firstIdle(kind);
    const support = kind === "governance" && options.allowQaSupport !== false
      ? this.firstIdle("qa") : undefined;
    const slot = own ?? support;
    if (!slot) return undefined;
    slot.state = "leased";
    slot.supportingGovernance = kind === "governance" && slot.slotKind === "qa";
    return {
      slot_id: slot.slotId,
      slot_kind: slot.slotKind,
      supporting_governance: slot.supportingGovernance,
    };
  }

  start(handle: SlotHandle, jobId: string): void {
    const slot = this.slotOf(handle.slot_id);
    if (!slot || slot.state !== "leased") throw new Error(`槽位不可启动: ${handle.slot_id}`);
    slot.state = "running";
    slot.jobId = jobId;
    slot.startedAt = this.now();
  }

  /** 释放后完全复位，避免槽位复用残留上一任务的任务号与支援标记。 */
  release(slotId: string): void {
    const slot = this.slotOf(slotId);
    if (!slot) return;
    slot.state = "idle";
    slot.jobId = null;
    slot.supportingGovernance = false;
    slot.startedAt = null;
  }

  /** 让位只适用于正在支援治理的问答槽；治理槽与正在服务问答的槽不可让位。 */
  drain(slotId: string): boolean {
    const slot = this.slotOf(slotId);
    if (!slot || slot.slotKind !== "qa" || !slot.supportingGovernance) return false;
    if (slot.state !== "running" && slot.state !== "leased") return false;
    slot.state = "draining";
    return true;
  }

  isDraining(slotId: string): boolean {
    return this.slotOf(slotId)?.state === "draining";
  }

  /** 是否存在可直接开跑的槽位；调度器据此区分“立即执行”和“需要排队”。 */
  hasIdle(kind: SlotKind): boolean {
    return this.firstIdle(kind) !== undefined;
  }

  snapshot(): SlotStatus[] {
    return this.slots.map(slot => ({
      slot_id: slot.slotId,
      slot_kind: slot.slotKind,
      state: slot.state,
      job_id: slot.jobId,
      supporting_governance: slot.supportingGovernance,
      started_at: slot.startedAt === null ? null : new Date(slot.startedAt).toISOString(),
    }));
  }

  private firstIdle(kind: SlotKind): SlotRecord | undefined {
    return this.slots.find(slot => slot.slotKind === kind && slot.state === "idle");
  }

  private slotOf(slotId: string): SlotRecord | undefined {
    return this.slots.find(slot => slot.slotId === slotId);
  }
}
