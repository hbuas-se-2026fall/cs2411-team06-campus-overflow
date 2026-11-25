// 运行中人工控制门（T-21C / RC-R01～R05）：只在 step/模型调用边界检查后端控制状态。
// 暂停不中断已发出的模型请求；恢复从断点继续；取消进入终态；引导只收集为下一段独立提示。
import type { TraceId } from "../types/index.js";
import { checkSignal, RunStoppedError } from "./abort.js";

export type RunControlAction = "pause" | "resume" | "cancel" | "guidance";
export type RunControlState = "running" | "paused" | "cancelled";

export interface RunControlCommand {
  id: number;
  revision: number;
  action: RunControlAction;
  guidance_text?: string | null;
  guidance_digest?: string | null;
}

export interface RunControlSnapshot {
  enabled: boolean;
  state: RunControlState;
  revision: number;
  pause_deadline?: string | null;
  commands: readonly RunControlCommand[];
}

/** 控制接口客户端：Agent 只做跟随者，权威状态在后端。 */
export interface RunControlClient {
  getRunControl(agentRunId: string, sinceRevision: number, traceId: TraceId): Promise<RunControlSnapshot>;
  ackRunControl(agentRunId: string, commandIds: readonly number[], traceId: TraceId): Promise<number>;
}

export type RunControlEventType =
  | "control_pause"
  | "control_resume"
  | "control_cancel"
  | "control_guidance";

export interface RunControlGateOptions {
  client: RunControlClient;
  agentRunId: string;
  traceId: TraceId;
  signal?: AbortSignal;
  /** 取消时中止运行信号；门自身随后抛 RunStoppedError 保证调用栈立即退出。 */
  onCancel: () => void;
  recordEvent?: (event: RunControlEventType) => Promise<void>;
  /** 暂停期间轮询间隔（ADR-011：2 秒） */
  pollIntervalMs?: number;
  /** 单次状态拉取超时（ADR-011：500ms），超时按网络失败处理，不改状态。 */
  requestTimeoutMs?: number;
  /** 本地暂停兜底上限（ADR-011：30 分钟） */
  pauseTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunControlGate {
  /** 在下一个 step/模型调用前调用：处理暂停与取消，并累积引导词。 */
  checkpoint(): Promise<void>;
  /** 取走已累积的引导词；只影响调用方接下来的 prompt。 */
  takeGuidance(): string[];
}

export const DEFAULT_CONTROL_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 500;
export const DEFAULT_PAUSE_TIMEOUT_MS = 30 * 60_000;

/** 全局开关默认关闭：关闭时保持现状，Agent 完全不轮询。 */
export const isRunControlEnabled = (): boolean => process.env.RUN_CONTROL_ENABLED === "true";

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunStoppedError("cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunStoppedError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** 拉取超时只影响本次判断：底层请求继续，结果被丢弃，状态沿用上一次。 */
const withPollTimeout = <T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunStoppedError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("control poll timeout"));
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

const readPositiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const createRunControlGate = (options: RunControlGateOptions): RunControlGate => {
  const pollIntervalMs = options.pollIntervalMs
    ?? readPositiveInt(process.env.RUN_CONTROL_POLL_INTERVAL_MS, DEFAULT_CONTROL_POLL_INTERVAL_MS);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
  const pauseTimeoutMs = options.pauseTimeoutMs ?? DEFAULT_PAUSE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const seen = new Set<number>();
  const unacked = new Set<number>();
  let pendingGuidance: string[] = [];
  let disabled = false;
  let pausedAt: number | null = null;
  let pauseAnnounced = false;
  let cancelAnnounced = false;
  let chain: Promise<void> = Promise.resolve();

  const emit = async (type: RunControlEventType): Promise<void> => {
    await options.recordEvent?.(type);
  };

  const applyCommands = async (snapshot: RunControlSnapshot): Promise<void> => {
    for (const command of snapshot.commands) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      unacked.add(command.id);
      if (command.action === "guidance") {
        if (command.guidance_text) pendingGuidance.push(command.guidance_text);
        // 正文不入库：仅输出 digest 供日志检索，后端命令表保留同值 digest。
        console.info(JSON.stringify({
          event: "agent_run_control_guidance",
          agent_run_id: options.agentRunId,
          trace_id: options.traceId,
          digest: command.guidance_digest ?? null,
        }));
        await emit("control_guidance");
      }
      // pause/resume/cancel 事件由本实例真正停住、恢复或终止时记录，
      // 避免“命令 + 状态”重复写入；其他实例已消费命令时也能按状态收敛。
    }
    if (unacked.size > 0) {
      try {
        await options.client.ackRunControl(options.agentRunId, [...unacked], options.traceId);
        unacked.clear();
      } catch {
        // ack 失败保持未确认，下次拉取会重复返回 pending；按 id 去重，不重复注入。
      }
    }
  };

  const pollOnce = async (): Promise<RunControlSnapshot | null> => {
    if (disabled) return null;
    checkSignal(options.signal);
    let snapshot: RunControlSnapshot;
    try {
      snapshot = await withPollTimeout(
        options.client.getRunControl(options.agentRunId, 0, options.traceId),
        requestTimeoutMs,
        options.signal,
      );
    } catch (error) {
      if (error instanceof RunStoppedError) throw error;
      // 网络抖动或超时保持原状态，不因拉取失败误停。
      return null;
    }
    if (!snapshot.enabled) {
      disabled = true;
      return snapshot;
    }
    await applyCommands(snapshot);
    return snapshot;
  };

  const cancelRun = async (): Promise<never> => {
    if (!cancelAnnounced) {
      cancelAnnounced = true;
      await emit("control_cancel");
    }
    options.onCancel();
    throw new RunStoppedError("cancelled");
  };

  const waitWhilePaused = async (initial: RunControlSnapshot): Promise<void> => {
    const startedAt = pausedAt ?? now();
    pausedAt = startedAt;
    if (!pauseAnnounced) {
      pauseAnnounced = true;
      await emit("control_pause");
    }
    const parsedDeadline = initial.pause_deadline ? Date.parse(initial.pause_deadline) : Number.NaN;
    const backendDeadline = Number.isFinite(parsedDeadline) ? parsedDeadline : Number.POSITIVE_INFINITY;
    const deadline = Math.min(startedAt + pauseTimeoutMs, backendDeadline);
    while (true) {
      checkSignal(options.signal);
      if (now() >= deadline) await cancelRun();
      await sleep(pollIntervalMs, options.signal);
      const snapshot = await pollOnce();
      if (snapshot?.state === "cancelled") await cancelRun();
      if (!snapshot || snapshot.enabled === false || snapshot.state === "running") {
        pausedAt = null;
        if (pauseAnnounced) {
          pauseAnnounced = false;
          await emit("control_resume");
        }
        return;
      }
    }
  };

  const checkpointInner = async (): Promise<void> => {
    const snapshot = await pollOnce();
    if (!snapshot || disabled) return;
    if (snapshot.state === "cancelled") await cancelRun();
    if (snapshot.state === "paused") await waitWhilePaused(snapshot);
  };

  return {
    checkpoint: () => {
      const next = chain.then(checkpointInner, checkpointInner);
      chain = next.then(() => undefined, () => undefined);
      return next;
    },
    takeGuidance: () => {
      const guidance = pendingGuidance;
      pendingGuidance = [];
      return guidance;
    },
  };
};

/** 客户端未实现控制接口时返回 undefined，调用方保持现状不轮询。 */
export const createRunControlGateIfSupported = (
  options: Omit<RunControlGateOptions, "client"> & { client: Partial<RunControlClient> },
): RunControlGate | undefined => {
  if (typeof options.client.getRunControl !== "function"
    || typeof options.client.ackRunControl !== "function") return undefined;
  return createRunControlGate({ ...options, client: options.client as RunControlClient });
};
