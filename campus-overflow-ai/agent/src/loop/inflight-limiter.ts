// 进程级在途工具调用信号量：所有槽位共享，避免并发计划叠加打爆后端（ADR-010 / SA-07B）。
// 不同上限值各自独立计数，便于测试隔离；生产只使用一个环境变量值。
import { RunStoppedError } from "./abort.js";

export interface InflightSnapshot {
  readonly limit: number;
  readonly active: number;
  readonly waiting: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

const createLimiter = (limit: number) => {
  let active = 0;
  const waiters: Waiter[] = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiters.shift();
      if (next) {
        next.detach();
        grant(next);
      }
    };
  };

  const grant = (waiter: Waiter): void => {
    active += 1;
    waiter.resolve(makeRelease());
  };

  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(new RunStoppedError("cancelled"));
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal?.reason instanceof RunStoppedError ? signal.reason : new RunStoppedError("cancelled"));
      };
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      if (active < limit && waiters.length === 0) {
        grant(waiter);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
    });
  };

  return {
    acquire,
    snapshot: (): InflightSnapshot => ({ limit, active, waiting: waiters.length }),
  };
};

const limiters = new Map<number, ReturnType<typeof createLimiter>>();

const normalizeLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`在途调用上限无效：${limit}`);
  return limit;
};

const getLimiter = (limit: number) => {
  const key = normalizeLimit(limit);
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = createLimiter(key);
    limiters.set(key, limiter);
  }
  return limiter;
};

export const acquireInflight = (limit: number, signal?: AbortSignal): Promise<() => void> =>
  getLimiter(limit).acquire(signal);

export const inflightSnapshot = (limit: number): InflightSnapshot => getLimiter(limit).snapshot();
