// 子 Agent 执行入口（SA-02）：每次尝试重建隔离上下文，提供检查点与安全检查点让位钩子。
// 让位只抛 SlotYieldSignal，由调度器按同一 job_id 重新排队；检查点保留进度与累计消耗。
import { SlotYieldSignal, type SchedulerLease } from "../orchestrator/scheduler.js";
import {
  CheckpointStore,
  createCheckpoint,
  createChildRunContext,
  type ChildRunContext,
  type ChildRunSpec,
} from "../orchestrator/run-context.js";

export interface ChildStepContext {
  readonly context: ChildRunContext;
  /** 本次尝试是否从已有检查点恢复 */
  readonly resumed: boolean;
  isStepDone(stepId: string): boolean;
  markStepDone(stepId: string): void;
  hasCommitted(actionId: string): boolean;
  /** 已提交动作恢复后跳过，返回 true 表示本次真正执行 */
  commit(actionId: string, action: () => Promise<void>): Promise<boolean>;
  /** 治理轮次跨让位保留，只允许单调增加 */
  setGovernanceRound(round: number): void;
  governanceRound(): number;
  activityMs(): number;
  /**
   * 安全检查点：先持久化进度，再检查是否让位。
   * 只能在一次模型/工具调用结束、下一次尚未发起时调用，避免中断在途动作。
   */
  safePoint(): void;
}

export interface ChildRunnerOptions {
  store?: CheckpointStore;
  now?: () => number;
}

export class ChildAgentRunner {
  private readonly store: CheckpointStore;
  private readonly now: () => number;

  constructor(options: ChildRunnerOptions = {}) {
    this.store = options.store ?? new CheckpointStore();
    this.now = options.now ?? Date.now;
  }

  get checkpoints(): CheckpointStore {
    return this.store;
  }

  async run<T>(
    spec: ChildRunSpec,
    lease: SchedulerLease,
    execute: (steps: ChildStepContext) => Promise<T>,
  ): Promise<T> {
    const existing = this.store.load(spec.jobId);
    const checkpoint = existing ?? createCheckpoint(spec.jobId, spec.traceId, this.now);
    let context: ChildRunContext;
    try {
      context = createChildRunContext(spec, checkpoint);
    } catch (error) {
      this.store.clear(spec.jobId);
      throw error;
    }

    let lastSync = this.now();
    const sync = (): void => {
      const at = this.now();
      // 预算只取实际消耗的更大值，恢复时不会被调用方写小
      checkpoint.consumed_tool_calls = Math.max(checkpoint.consumed_tool_calls, context.run.toolBudget.used);
      checkpoint.consumed_repairs = Math.max(checkpoint.consumed_repairs, context.run.repairBudget.used);
      checkpoint.activity_ms += Math.max(0, at - lastSync);
      checkpoint.updated_at = new Date(at).toISOString();
      lastSync = at;
      this.store.save(checkpoint);
    };

    const steps: ChildStepContext = {
      context,
      resumed: existing !== undefined,
      isStepDone: (stepId) => checkpoint.completed_steps.includes(stepId),
      markStepDone: (stepId) => {
        if (!checkpoint.completed_steps.includes(stepId)) checkpoint.completed_steps.push(stepId);
        sync();
      },
      hasCommitted: (actionId) => checkpoint.committed_actions.includes(actionId),
      commit: async (actionId, action) => {
        if (checkpoint.committed_actions.includes(actionId)) return false;
        await action();
        checkpoint.committed_actions.push(actionId);
        sync();
        return true;
      },
      setGovernanceRound: (round) => {
        if (!Number.isInteger(round) || round < 0) throw new Error("治理轮次必须为非负整数");
        checkpoint.governance_round = Math.max(checkpoint.governance_round, round);
        sync();
      },
      governanceRound: () => checkpoint.governance_round,
      activityMs: () => checkpoint.activity_ms,
      safePoint: () => {
        sync();
        lease.yieldIfNeeded();
      },
    };

    try {
      const result = await execute(steps);
      this.store.clear(spec.jobId);
      return result;
    } catch (error) {
      sync();
      if (error instanceof SlotYieldSignal) throw error;
      this.store.clear(spec.jobId);
      throw error;
    }
  }
}
