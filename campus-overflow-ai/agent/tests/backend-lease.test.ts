// P0-1：租约客户端与治理准入的失败语义（409=繁忙，不重试；释放失败不反噬任务）。
import { describe, expect, it, vi } from "vitest";

import { createGovernanceAdmission, createSlotLeaseClient } from "../src/backend-lease.js";

const envelope = (data: unknown, code = 200, message = "ok") =>
  new Response(JSON.stringify({ code, data, message }), { status: code === 200 ? 200 : 409 });

const leaseBody = {
  kind: "governance", slot_no: 2, job_id: "job-a",
  fencing_token: "fence-1", lease_expires_at: "2026-11-20T00:00:00",
};

describe("跨实例槽位租约客户端", () => {
  it("解析租约并在 409 时返回 null", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope(leaseBody))
      .mockResolvedValueOnce(envelope(null, 409, "全局槽位已满"));
    const client = createSlotLeaseClient({ baseUrl: "http://backend", token: "svc" }, fetchImpl);

    const lease = await client.claim({
      kind: "governance", capacity: 3, jobId: "job-a",
      instanceId: "agent-a", ttlSeconds: 60,
    });
    expect(lease).toEqual({ kind: "governance", slotNo: 2, fencingToken: "fence-1" });

    const busy = await client.claim({
      kind: "governance", capacity: 3, jobId: "job-b",
      instanceId: "agent-b", ttlSeconds: 60,
    });
    expect(busy).toBeNull();
  });

  it("续租 409 返回 false，释放失败不抛出", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope(null, 409, "租约已失效"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(envelope(null, 409, "全局槽位已满"));
    const client = createSlotLeaseClient({ baseUrl: "http://backend", token: "svc" }, fetchImpl);
    const lease = { kind: "qa" as const, slotNo: 1, fencingToken: "fence-1" };

    await expect(client.renew(lease, 60)).resolves.toBe(false);
    await expect(client.release(lease)).rejects.toThrow("network down");
    const admission = createGovernanceAdmission(client, 2, "agent-a");
    const held = await admission.acquire("job-a");
    expect(held).toBeNull();
  });

  it("治理准入在容量满时返回 null，成功时释放", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(envelope(leaseBody))
      .mockResolvedValueOnce(envelope({ released: true }));
    const admission = createGovernanceAdmission(
      createSlotLeaseClient({ baseUrl: "http://backend", token: "svc" }, fetchImpl), 3, "agent-a",
    );

    const held = await admission.acquire("job-a");
    expect(held).not.toBeNull();
    await held?.release();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/slot-leases/governance/2/release");
  });
});
