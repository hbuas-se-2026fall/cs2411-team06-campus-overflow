// 生产入口共享的子 Agent 池（SA-02 接线）：每实例固定 3 治理 + 5 问答槽。
// createApp 为每个应用创建一个池；测试可注入独立实例，避免用例间共享队列。
import { randomUUID } from "node:crypto";

import { ChildAgentRunner } from "../agents/runner.js";
import type { RunTaskKind } from "../observability/run-context.js";
import {
  PoolBusyError,
  SlotScheduler,
  type PoolStatusSnapshot,
  type SchedulerLease,
} from "../orchestrator/scheduler.js";
import type { SlotKind } from "../orchestrator/slot-pool.js";

/** 跨实例治理准入：返回 null 表示全局容量已满，必须明确拒绝而非排队等待。 */
export interface GovernanceAdmission {
  acquire(jobId: string): Promise<{ release: () => Promise<void> } | null>;
}

/** 全局问答准入：内部排队等待，超时/取消抛错；返回 null 仅作兼容保护。 */
export interface QaWaitOptions {
  signal?: AbortSignal;
  /** 排队位置变化时通知（1 表示队首），用于向用户展示排队进度。 */
  onWaiting?: (position: number) => void;
}

export interface QaAdmission {
  acquire(
    jobId: string, options?: QaWaitOptions,
  ): Promise<{ release: () => Promise<void> } | null>;
}

export type RunOptions = QaWaitOptions;

export interface AgentPoolOptions {
  instanceId?: string;
  maxWaiting?: number;
  scheduler?: SlotScheduler;
  runner?: ChildAgentRunner;
  admission?: GovernanceAdmission;
  qaAdmission?: QaAdmission;
}

export class AgentPool {
  readonly instanceId: string;
  readonly scheduler: SlotScheduler;
  readonly runner: ChildAgentRunner;
  private admission?: GovernanceAdmission;
  private qaAdmission?: QaAdmission;

  constructor(options: AgentPoolOptions = {}) {
    const configured = process.env.AGENT_INSTANCE_ID?.trim();
    this.instanceId = options.instanceId
      ?? (configured && configured.length > 0 ? configured : `agent-${randomUUID().slice(0, 8)}`);
    this.scheduler = options.scheduler ?? new SlotScheduler({ maxWaiting: options.maxWaiting });
    this.runner = options.runner ?? new ChildAgentRunner();
    this.admission = options.admission;
    this.qaAdmission = options.qaAdmission;
  }

  /** 由 createApp 在实例标识确定后注入，避免构造期循环依赖 */
  setAdmission(admission: GovernanceAdmission | undefined): void {
    this.admission = admission;
  }

  /** 全局问答准入（P0-5）：未注入时保持每实例本地调度语义 */
  setQaAdmission(admission: QaAdmission | undefined): void {
    this.qaAdmission = admission;
  }

  /** 排队超过上限时以 PoolBusyError 拒绝，调用方负责返回明确繁忙 */
  async run<T>(
    kind: SlotKind, jobId: string, run: (lease: SchedulerLease) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const held = await this.acquire(kind, jobId, options);
    try {
      return await this.scheduler.submit({ job_id: jobId, kind, run });
    } finally {
      if (held) await held.release();
    }
  }

  private async acquire(
    kind: SlotKind, jobId: string, options: RunOptions,
  ): Promise<{ release: () => Promise<void> } | null> {
    if (kind === "governance" && this.admission) {
      const held = await this.admission.acquire(jobId);
      if (!held) throw new PoolBusyError("全局治理并发已满");
      return held;
    }
    if (kind === "qa" && this.qaAdmission) {
      const held = await this.qaAdmission.acquire(jobId, options);
      if (!held) throw new PoolBusyError();
      return held;
    }
    return null;
  }

  snapshot(): PoolStatusSnapshot & { instance_id: string } {
    return { instance_id: this.instanceId, ...this.scheduler.snapshot() };
  }
}

/** 管理端治理任务走治理槽；聊天与其余教学任务走问答槽。 */
export const slotKindForTask = (taskType: RunTaskKind): SlotKind =>
  taskType === "moderation_scan" ? "governance" : "qa";
