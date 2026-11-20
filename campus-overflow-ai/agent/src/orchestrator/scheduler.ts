// 子 Agent 调度器（SA-01）：问答优先，治理积压不阻塞问答；
// 治理槽满时可借用空闲问答槽支援，问答回压时支援任务在安全检查点归还。
import { SlotPool, type SlotHandle, type SlotKind, type SlotStatus } from "./slot-pool.js";

export { GOVERNANCE_SLOTS, MAX_AGENT_SLOTS, QA_SLOTS } from "./slot-pool.js";
export type { SlotHandle, SlotKind, SlotState, SlotStatus } from "./slot-pool.js";

/** 默认等待上限：超过后明确返回繁忙，不静默丢弃任务 */
export const DEFAULT_MAX_WAITING = 64;

export class PoolBusyError extends Error {
  constructor(message = "Agent 运行池繁忙，请稍后重试") {
    super(message);
    this.name = "PoolBusyError";
  }
}

/** 让位信号：只在安全检查点抛出，调度器据此释放槽位并重新排队。 */
export class SlotYieldSignal extends Error {
  constructor(slotId: string) {
    super(`槽位让位: ${slotId}`);
    this.name = "SlotYieldSignal";
  }
}

export interface SchedulerLease {
  slot_id: string;
  slot_kind: SlotKind;
  supporting_governance: boolean;
  /** 管理员终止该槽位时触发；执行入口应与请求信号合并，停止后续模型/工具调用 */
  signal: AbortSignal;
  /**
   * 安全检查点：只在两次模型/工具调用之间调用。
   * 支援槽被要求归还时抛出 SlotYieldSignal；执行入口不得吞掉该信号，
   * 调度器会把同一任务重新排队，已提交的后端动作不会回滚。
   */
  yieldIfNeeded(): void;
}

export interface PoolJob<T = unknown> {
  job_id: string;
  kind: SlotKind;
  run: (lease: SchedulerLease) => Promise<T>;
}

export interface QueueStatus {
  waiting: number;
  oldest_wait_ms: number;
}

/** 供内部池状态接口与管理端复用的快照结构 */
export interface PoolStatusSnapshot {
  slots: SlotStatus[];
  queues: {
    qa: QueueStatus;
    governance: QueueStatus;
  };
}

interface JobOutcome {
  ok: boolean;
  value?: unknown;
  error?: unknown;
}

interface WaitingJob {
  readonly job: PoolJob<unknown>;
  readonly enqueuedAt: number;
  readonly settle: (outcome: JobOutcome) => void;
}

interface RunningRecord {
  readonly handle: SlotHandle;
  readonly abort: AbortController;
}

export interface SlotSchedulerOptions {
  pool?: SlotPool;
  maxWaiting?: number;
  now?: () => number;
}

export class SlotScheduler {
  private readonly pool: SlotPool;
  private readonly now: () => number;
  private readonly maxWaiting: number;
  private readonly qaQueue: WaitingJob[] = [];
  private readonly governanceQueue: WaitingJob[] = [];
  private readonly running = new Map<string, RunningRecord>();
  private readonly known = new Set<string>();

  constructor(options: SlotSchedulerOptions = {}) {
    const now = options.now ?? Date.now;
    this.now = now;
    this.pool = options.pool ?? new SlotPool(now);
    this.maxWaiting = options.maxWaiting !== undefined
      && Number.isInteger(options.maxWaiting) && options.maxWaiting >= 0
      ? options.maxWaiting : DEFAULT_MAX_WAITING;
  }

  submit<T>(job: PoolJob<T>): Promise<T> {
    if (this.known.has(job.job_id)) {
      return Promise.reject(new Error(`重复的任务标识: ${job.job_id}`));
    }
    // 只有确实需要排队时才受等待上限约束；空队列下的立即执行不受 maxWaiting=0 影响
    if (!this.canStartNow(job.kind) && this.waitingCount() >= this.maxWaiting) {
      return Promise.reject(new PoolBusyError());
    }
    this.known.add(job.job_id);
    return new Promise<T>((resolve, reject) => {
      const waiting: WaitingJob = {
        job,
        enqueuedAt: this.now(),
        settle: (outcome) => {
          this.known.delete(job.job_id);
          if (outcome.ok) resolve(outcome.value as T);
          else reject(outcome.error);
        },
      };
      if (job.kind === "qa") this.qaQueue.push(waiting);
      else this.governanceQueue.push(waiting);
      this.dispatch();
    });
  }

  /** 管理员让位：仅支援中的问答槽可标记，任务在下一个安全检查点归还 */
  drain(slotId: string): boolean {
    return this.pool.drain(slotId);
  }

  /**
   * 管理员终止：只取消该槽位后续模型/工具调用，不释放槽位、不回滚已执行动作。
   * 执行入口必须把 lease.signal 与请求信号合并；任务停止后由正常收尾释放槽位。
   */
  terminate(slotId: string): boolean {
    const record = this.running.get(slotId);
    if (!record || record.abort.signal.aborted) return false;
    record.abort.abort();
    return true;
  }

  snapshot(): PoolStatusSnapshot {
    const now = this.now();
    return {
      slots: this.pool.snapshot(),
      queues: {
        qa: this.queueStatus(this.qaQueue, now),
        governance: this.queueStatus(this.governanceQueue, now),
      },
    };
  }

  private dispatch(): void {
    // 问答优先；问答槽全忙时，要求支援槽在安全检查点归还
    while (this.qaQueue.length > 0) {
      const handle = this.pool.lease("qa");
      if (!handle) {
        this.requestSupportYield();
        break;
      }
      const next = this.qaQueue.shift();
      if (!next) break;
      this.startJob(next, handle);
    }
    // 治理：问答队列有等待时只允许治理槽，不得再占用问答槽
    while (this.governanceQueue.length > 0) {
      const handle = this.pool.lease("governance", { allowQaSupport: this.qaQueue.length === 0 });
      if (!handle) break;
      const next = this.governanceQueue.shift();
      if (!next) break;
      this.startJob(next, handle);
    }
  }

  private requestSupportYield(): void {
    for (const record of this.running.values()) {
      if (record.handle.supporting_governance) this.pool.drain(record.handle.slot_id);
    }
  }

  private startJob(waiting: WaitingJob, handle: SlotHandle): void {
    this.pool.start(handle, waiting.job.job_id);
    const abort = new AbortController();
    this.running.set(handle.slot_id, { handle, abort });
    const lease: SchedulerLease = Object.freeze({
      slot_id: handle.slot_id,
      slot_kind: handle.slot_kind,
      supporting_governance: handle.supporting_governance,
      signal: abort.signal,
      yieldIfNeeded: (): void => {
        if (this.pool.isDraining(handle.slot_id)) throw new SlotYieldSignal(handle.slot_id);
      },
    });
    void Promise.resolve()
      .then(() => waiting.job.run(lease))
      .then(
        value => { this.finish(handle.slot_id, waiting, { ok: true, value }); },
        (error: unknown) => {
          if (error instanceof SlotYieldSignal && waiting.job.kind === "governance") {
            this.finishYielded(handle.slot_id, waiting);
            return;
          }
          this.finish(handle.slot_id, waiting, { ok: false, error });
        },
      );
  }

  private finish(slotId: string, waiting: WaitingJob, outcome: JobOutcome): void {
    this.running.delete(slotId);
    this.pool.release(slotId);
    waiting.settle(outcome);
    this.dispatch();
  }

  private finishYielded(slotId: string, waiting: WaitingJob): void {
    this.running.delete(slotId);
    this.pool.release(slotId);
    // 让位不是失败：保留原 job_id 与入队时间，重新排到治理队列最前
    this.governanceQueue.unshift(waiting);
    this.dispatch();
  }

  private waitingCount(): number {
    return this.qaQueue.length + this.governanceQueue.length;
  }

  private canStartNow(kind: SlotKind): boolean {
    if (kind === "qa") return this.pool.hasIdle("qa");
    return this.pool.hasIdle("governance") || (this.qaQueue.length === 0 && this.pool.hasIdle("qa"));
  }

  private queueStatus(queue: readonly WaitingJob[], now: number): QueueStatus {
    const oldest = queue[0];
    return {
      waiting: queue.length,
      oldest_wait_ms: oldest ? Math.max(0, now - oldest.enqueuedAt) : 0,
    };
  }
}
