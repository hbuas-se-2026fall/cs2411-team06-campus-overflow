// P0-5：全局问答排队客户端与准入的等待、超时、取消语义。
import { describe, expect, it, vi } from "vitest";

import {
  createQaAdmission,
  createSlotQueueClient,
  QaQueueError,
  QA_QUEUE_CANCELLED_MESSAGE,
  QA_QUEUE_TIMEOUT_MESSAGE,
  type SlotQueueClient,
  type SlotWaitResult,
} from "../src/backend-lease.js";

const envelope = (data: unknown, code = 200, message = "ok") =>
  new Response(JSON.stringify({ code, data, message }), { status: code === 200 ? 200 : code });

const leaseBody = {
  kind: "qa", slot_no: 2, job_id: "job-a",
  fencing_token: "fence-1", lease_expires_at: "2026-11-20T00:00:00",
};

const waiting = (position: number): SlotWaitResult => ({
  ticketId: 7, status: "waiting", position, lease: null,
});

describe("全局问答排队客户端", () => {
  it("入队解析等待位置与授予租约", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope({
        ticket_id: 7, job_id: "job-a", status: "waiting", position: 3,
      }))
      .mockResolvedValueOnce(envelope({
        ticket_id: 7, job_id: "job-a", status: "granted", lease: leaseBody,
      }));
    const client = createSlotQueueClient({ baseUrl: "http://backend", token: "svc" }, fetchImpl);

    const queued = await client.enqueue({
      kind: "qa", capacity: 5, jobId: "job-a", instanceId: "agent-a",
      ttlSeconds: 60, waitSeconds: 120,
    });
    expect(queued).toMatchObject({ ticketId: 7, status: "waiting", position: 3, lease: null });

    const granted = await client.poll(7);
    expect(granted.status).toBe("granted");
    expect(granted.lease).toEqual({ kind: "qa", slotNo: 2, fencingToken: "fence-1" });
  });

  it("轮询 404 视为排队过期，取消 404 幂等", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope(null, 404, "排队票据不存在或已过期"))
      .mockResolvedValueOnce(envelope(null, 404, "排队票据不存在或已过期"));
    const client = createSlotQueueClient({ baseUrl: "http://backend", token: "svc" }, fetchImpl);

    await expect(client.poll(7)).resolves.toMatchObject({ ticketId: 7, status: "expired" });
    await expect(client.cancel(7)).resolves.toBeUndefined();
  });
});

describe("全局问答准入", () => {
  const leases = { release: vi.fn().mockResolvedValue(undefined) } as never;

  it("排队后轮询到授予，任务结束时释放租约", async () => {
    const queue: SlotQueueClient = {
      enqueue: vi.fn().mockResolvedValue(waiting(2)),
      poll: vi.fn()
        .mockResolvedValueOnce(waiting(1))
        .mockResolvedValueOnce({
          ticketId: 7, status: "granted", position: null,
          lease: { kind: "qa", slotNo: 2, fencingToken: "fence-1" },
        }),
      cancel: vi.fn(),
    };
    const admission = createQaAdmission(queue, leases, 5, "agent-a", { pollMs: 1 });
    const positions: number[] = [];
    const held = await admission.acquire("job-a", { onWaiting: position => positions.push(position) });

    expect(positions).toEqual([2, 1]);
    expect(held).not.toBeNull();
    await held?.release();
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it("等待超时放弃票据并抛出中文错误", async () => {
    const queue: SlotQueueClient = {
      enqueue: vi.fn().mockResolvedValue(waiting(1)),
      poll: vi.fn().mockImplementation(async () => waiting(1)),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const admission = createQaAdmission(queue, leases, 5, "agent-a", {
      pollMs: 5, maxWaitMs: 20,
    });

    await expect(admission.acquire("job-a")).rejects.toSatisfy(
      error => error instanceof QaQueueError && error.message === QA_QUEUE_TIMEOUT_MESSAGE,
    );
    expect(queue.cancel).toHaveBeenCalledWith(7);
  });

  it("运行信号取消时放弃票据并抛出取消提示", async () => {
    const queue: SlotQueueClient = {
      enqueue: vi.fn().mockResolvedValue(waiting(1)),
      poll: vi.fn().mockResolvedValue(waiting(1)),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const admission = createQaAdmission(queue, leases, 5, "agent-a", { pollMs: 20 });
    const controller = new AbortController();
    const pending = admission.acquire("job-a", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      error => error instanceof QaQueueError && error.message === QA_QUEUE_CANCELLED_MESSAGE,
    );
    expect(queue.cancel).toHaveBeenCalledWith(7);
  });
});
