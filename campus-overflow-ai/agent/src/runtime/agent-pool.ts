// 生产入口共享的子 Agent 池（SA-02 接线）：每实例固定 3 治理 + 5 问答槽。
// createApp 为每个应用创建一个池；测试可注入独立实例，避免用例间共享队列。
import { randomUUID } from "node:crypto";

import { ChildAgentRunner } from "../agents/runner.js";
import type { RunTaskKind } from "../observability/run-context.js";
import {
  SlotScheduler,
  type PoolStatusSnapshot,
  type SchedulerLease,
} from "../orchestrator/scheduler.js";
import type { SlotKind } from "../orchestrator/slot-pool.js";

export interface AgentPoolOptions {
  instanceId?: string;
  maxWaiting?: number;
  scheduler?: SlotScheduler;
  runner?: ChildAgentRunner;
}

export class AgentPool {
  readonly instanceId: string;
  readonly scheduler: SlotScheduler;
  readonly runner: ChildAgentRunner;

  constructor(options: AgentPoolOptions = {}) {
    const configured = process.env.AGENT_INSTANCE_ID?.trim();
    this.instanceId = options.instanceId
      ?? (configured && configured.length > 0 ? configured : `agent-${randomUUID().slice(0, 8)}`);
    this.scheduler = options.scheduler ?? new SlotScheduler({ maxWaiting: options.maxWaiting });
    this.runner = options.runner ?? new ChildAgentRunner();
  }

  /** 排队超过上限时以 PoolBusyError 拒绝，调用方负责返回明确繁忙 */
  run<T>(kind: SlotKind, jobId: string, run: (lease: SchedulerLease) => Promise<T>): Promise<T> {
    return this.scheduler.submit({ job_id: jobId, kind, run });
  }

  snapshot(): PoolStatusSnapshot & { instance_id: string } {
    return { instance_id: this.instanceId, ...this.scheduler.snapshot() };
  }
}

/** 管理端治理任务走治理槽；聊天与其余教学任务走问答槽。 */
export const slotKindForTask = (taskType: RunTaskKind): SlotKind =>
  taskType === "moderation_scan" ? "governance" : "qa";
