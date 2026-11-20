// P0-1 跨实例槽位租约 + P0-5 全局问答排队：只调用 FastAPI /internal/agent/slot-leases。
import { z } from "zod";

import { resolveInternalConfig } from "./internal-client.js";
import type { GovernanceAdmission, QaAdmission } from "./runtime/agent-pool.js";

const LeaseSchema = z.object({
  kind: z.string(),
  slot_no: z.number().int().positive(),
  job_id: z.string(),
  fencing_token: z.string(),
  lease_expires_at: z.string(),
});
const WaitTicketSchema = z.object({
  ticket_id: z.number().int().positive(),
  job_id: z.string(),
  status: z.enum(["waiting", "granted", "expired"]),
  position: z.number().int().positive().nullable().optional(),
  lease: LeaseSchema.nullable().optional(),
});
const EnvelopeSchema = z.object({ code: z.number(), data: z.unknown(), message: z.string() });

export interface SlotLease {
  readonly kind: "qa" | "governance" | "maintenance";
  readonly slotNo: number;
  readonly fencingToken: string;
}

export interface SlotLeaseClient {
  claim(input: {
    kind: SlotLease["kind"];
    capacity: number;
    jobId: string;
    instanceId: string;
    ttlSeconds: number;
    signal?: AbortSignal;
  }): Promise<SlotLease | null>;
  renew(lease: SlotLease, ttlSeconds: number, signal?: AbortSignal): Promise<boolean>;
  release(lease: SlotLease): Promise<void>;
}

export interface SlotWaitResult {
  readonly ticketId: number;
  readonly status: "waiting" | "granted" | "expired";
  readonly position: number | null;
  readonly lease: SlotLease | null;
}

export interface SlotQueueClient {
  enqueue(input: {
    kind: SlotLease["kind"];
    capacity: number;
    jobId: string;
    instanceId: string;
    ttlSeconds: number;
    waitSeconds: number;
    signal?: AbortSignal;
  }): Promise<SlotWaitResult>;
  poll(ticketId: number, signal?: AbortSignal): Promise<SlotWaitResult>;
  cancel(ticketId: number): Promise<void>;
}

interface EnvelopeResult {
  readonly status: number;
  readonly ok: boolean;
  readonly data: unknown;
  readonly message: string;
}

const postEnvelope = async (
  config: { baseUrl: string; token: string }, fetchImpl: typeof fetch,
  path: string, body: Record<string, unknown>, signal?: AbortSignal,
): Promise<EnvelopeResult> => {
  const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-token": config.token },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
  const raw: unknown = await response.json().catch(() => undefined);
  const envelope = EnvelopeSchema.safeParse(raw);
  const ok = response.ok && envelope.success && envelope.data.code === 200;
  return {
    status: response.status,
    ok,
    data: envelope.success ? envelope.data.data : undefined,
    message: envelope.success ? envelope.data.message : `租约接口失败 HTTP ${response.status}`,
  };
};

const toLease = (raw: z.infer<typeof LeaseSchema>): SlotLease => ({
  kind: raw.kind as SlotLease["kind"],
  slotNo: raw.slot_no,
  fencingToken: raw.fencing_token,
});

const toWaitResult = (raw: z.infer<typeof WaitTicketSchema>): SlotWaitResult => ({
  ticketId: raw.ticket_id,
  status: raw.status,
  position: raw.position ?? null,
  lease: raw.lease ? toLease(raw.lease) : null,
});

export const createSlotLeaseClient = (
  config = resolveInternalConfig(), fetchImpl: typeof fetch = fetch,
): SlotLeaseClient => {
  const call = async (
    path: string, body: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<unknown | undefined> => {
    const result = await postEnvelope(config, fetchImpl, path, body, signal);
    // 409 表示容量已满或 token 失效，由调用方决定繁忙/停止，不当作网络故障重试
    if (result.status === 409) return null;
    if (!result.ok) throw new Error(result.message);
    return result.data;
  };

  return {
    async claim(input) {
      const data = await call("/internal/agent/slot-leases/claim", {
        kind: input.kind,
        capacity: input.capacity,
        job_id: input.jobId,
        instance_id: input.instanceId,
        ttl_seconds: input.ttlSeconds,
      }, input.signal);
      if (data === null) return null;
      const lease = LeaseSchema.parse(data);
      if (lease.kind !== input.kind) throw new Error("租约类型不一致");
      return toLease(lease);
    },
    async renew(lease, ttlSeconds, signal) {
      const data = await call(
        `/internal/agent/slot-leases/${lease.kind}/${lease.slotNo}/renew`,
        { fencing_token: lease.fencingToken, ttl_seconds: ttlSeconds }, signal,
      );
      return data !== null;
    },
    async release(lease) {
      await call(
        `/internal/agent/slot-leases/${lease.kind}/${lease.slotNo}/release`,
        { fencing_token: lease.fencingToken },
      );
    },
  };
};

export const createSlotQueueClient = (
  config = resolveInternalConfig(), fetchImpl: typeof fetch = fetch,
): SlotQueueClient => ({
  async enqueue(input) {
    const result = await postEnvelope(config, fetchImpl, "/internal/agent/slot-leases/wait", {
      kind: input.kind,
      capacity: input.capacity,
      job_id: input.jobId,
      instance_id: input.instanceId,
      ttl_seconds: input.ttlSeconds,
      wait_seconds: input.waitSeconds,
    }, input.signal);
    if (!result.ok) throw new Error(result.message);
    return toWaitResult(WaitTicketSchema.parse(result.data));
  },
  async poll(ticketId, signal) {
    const result = await postEnvelope(
      config, fetchImpl, `/internal/agent/slot-leases/wait/${ticketId}/poll`, {}, signal,
    );
    // 票据已被取走或取消：按过期处理，避免无限轮询已不存在的票据
    if (result.status === 404) {
      return { ticketId, status: "expired", position: null, lease: null };
    }
    if (!result.ok) throw new Error(result.message);
    return toWaitResult(WaitTicketSchema.parse(result.data));
  },
  async cancel(ticketId) {
    const result = await postEnvelope(
      config, fetchImpl, `/internal/agent/slot-leases/wait/${ticketId}/cancel`, {},
    );
    if (result.status === 404) return;
    if (!result.ok) throw new Error(result.message);
  },
});

/** 治理任务的全局准入：capacity 为跨实例总并发，0 表示不启用。 */
export const createGovernanceAdmission = (
  client: SlotLeaseClient, capacity: number, instanceId: string, ttlSeconds = 900,
): GovernanceAdmission => ({
  async acquire(jobId: string) {
    const lease = await client.claim({
      kind: "governance", capacity, jobId, instanceId, ttlSeconds,
    });
    if (!lease) return null;
    return {
      release: async () => {
        // 释放失败由租约 TTL 兜底，不能反向把已完成的治理任务标记失败
        await client.release(lease).catch(() => undefined);
      },
    };
  },
});

/** 排队超时或取消：消息直接面向用户，由聊天路由透出中文提示。 */
export class QaQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaQueueError";
  }
}

export interface QaAdmissionOptions {
  ttlSeconds?: number;
  waitSeconds?: number;
  maxWaitMs?: number;
  pollMs?: number;
}

export const QA_QUEUE_TIMEOUT_MESSAGE = "问答排队等待超时，请稍后重试";
export const QA_QUEUE_CANCELLED_MESSAGE = "问答请求已取消";

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  timer.unref();
  signal?.addEventListener("abort", finish, { once: true });
});

/**
 * 全局问答准入（P0-5）：容量已满时进入跨实例队列等待，而不是立即繁忙。
 * 排队时间计入运行预算；超时/取消必须放弃票据，避免占住队首。
 */
export const createQaAdmission = (
  queue: SlotQueueClient, leases: SlotLeaseClient, capacity: number, instanceId: string,
  options: QaAdmissionOptions = {},
): QaAdmission => {
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const ttlSeconds = options.ttlSeconds ?? 900;
  const waitSeconds = options.waitSeconds ?? Math.ceil(maxWaitMs / 1000);
  const hold = (lease: SlotLease) => ({
    release: async () => { await leases.release(lease).catch(() => undefined); },
  });

  return {
    async acquire(jobId, waitOptions = {}) {
      const { signal, onWaiting } = waitOptions;
      // 运行已取消/超时：不再申请票据，避免占用队首
      if (signal?.aborted) throw new QaQueueError(QA_QUEUE_CANCELLED_MESSAGE);
      let ticket = await queue.enqueue({
        kind: "qa", capacity, jobId, instanceId, ttlSeconds, waitSeconds, signal,
      });
      const abandon = async () => { await queue.cancel(ticket.ticketId).catch(() => undefined); };
      if (ticket.status === "granted" && ticket.lease) {
        if (ticket.lease.kind !== "qa") throw new QaQueueError("排队租约类型异常，请稍后重试");
        return hold(ticket.lease);
      }
      if (ticket.status === "expired") throw new QaQueueError(QA_QUEUE_TIMEOUT_MESSAGE);

      const deadline = Date.now() + maxWaitMs;
      let lastPosition = ticket.position;
      onWaiting?.(lastPosition ?? 1);
      while (true) {
        if (signal?.aborted) {
          await abandon();
          throw new QaQueueError(QA_QUEUE_CANCELLED_MESSAGE);
        }
        if (Date.now() >= deadline) {
          await abandon();
          throw new QaQueueError(QA_QUEUE_TIMEOUT_MESSAGE);
        }
        await abortableSleep(pollMs, signal);
        if (signal?.aborted) {
          await abandon();
          throw new QaQueueError(QA_QUEUE_CANCELLED_MESSAGE);
        }
        try {
          ticket = await queue.poll(ticket.ticketId, signal);
        } catch (error) {
          // 轮询偶发失败不放弃票据；由截止时间兜底，避免一次抖动导致任务失败
          if (signal?.aborted) throw error;
          continue;
        }
        if (ticket.status === "granted" && ticket.lease) {
          if (ticket.lease.kind !== "qa") {
            await abandon();
            throw new QaQueueError("排队租约类型异常，请稍后重试");
          }
          return hold(ticket.lease);
        }
        if (ticket.status === "expired") throw new QaQueueError(QA_QUEUE_TIMEOUT_MESSAGE);
        if (ticket.position !== null && ticket.position !== lastPosition) {
          lastPosition = ticket.position;
          onWaiting?.(ticket.position);
        }
      }
    },
  };
};
