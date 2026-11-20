// SA-05 让位与终止：仅管理员可操作，让位只作用于支援槽，终止取消后续调用并写审计摘要。
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { UserInternalClient } from "../src/internal-client.js";
import type { SchedulerLease } from "../src/orchestrator/scheduler.js";
import { AgentPool } from "../src/runtime/agent-pool.js";

const admin = {
  user_id: 1, role: "admin", status: "active",
  identity_type: "postgraduate", assistant_cert_status: "approved",
} as const;
const student = {
  user_id: 2, role: "student", status: "active",
  identity_type: "undergraduate", assistant_cert_status: "none",
} as const;

const appOf = (pool: AgentPool, principal: typeof admin | typeof student) => createApp({
  pool,
  createClient: () => ({ resolvePrincipal: async () => principal } as unknown as UserInternalClient),
  getModel: () => ({}) as never,
});

const holdSlot = (pool: AgentPool, jobId: string) => {
  void pool.scheduler.submit({ job_id: jobId, kind: "governance", run: () => new Promise<never>(() => {}) });
};

const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

async function startSupportJob(pool: AgentPool): Promise<SchedulerLease> {
  let lease: SchedulerLease | undefined;
  void pool.scheduler.submit({
    job_id: "governance-support",
    kind: "governance",
    run: (current) => {
      lease = current;
      return new Promise<never>(() => {});
    },
  });
  await nextTick();
  if (!lease) throw new Error("支援任务未启动");
  return lease;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("运行池让位与终止", () => {
  it("仅管理员可操作", async () => {
    const response = await appOf(new AgentPool(), student)
      .request("/agent/admin/pool/qa-1/drain", { method: "POST", headers: { authorization: "Bearer student" } });
    expect(response.status).toBe(403);
  });

  it("让位只作用于支援中的问答槽，并写审计摘要", async () => {
    const pool = new AgentPool({ maxWaiting: 10 });
    for (let index = 0; index < 3; index += 1) holdSlot(pool, `gov-busy-${index}`);
    const lease = await startSupportJob(pool);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(lease.slot_kind).toBe("qa");
    expect(lease.supporting_governance).toBe(true);

    const response = await appOf(pool, admin)
      .request(`/agent/admin/pool/${lease.slot_id}/drain`, {
        method: "POST", headers: { authorization: "Bearer admin", "x-trace-id": "trace-drain" },
      });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ action: "drain", accepted: true });
    expect(body.data.audit_summary).toContain("让位");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("\"event\":\"agent_pool_admin_action\""));
    expect(pool.snapshot().slots.find(slot => slot.slot_id === lease.slot_id)?.state).toBe("draining");

    const invalid = await appOf(new AgentPool(), admin)
      .request("/agent/admin/pool/gov-1/drain", { method: "POST", headers: { authorization: "Bearer admin" } });
    expect(invalid.status).toBe(409);
  });

  it("终止取消后续调用并写审计摘要，不重复终止", async () => {
    const pool = new AgentPool({ maxWaiting: 10 });
    const lease = await startSupportJob(pool);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = appOf(pool, admin);

    const response = await app.request(`/agent/admin/pool/${lease.slot_id}/terminate`, {
      method: "POST", headers: { authorization: "Bearer admin", "x-trace-id": "trace-terminate" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ action: "terminate", accepted: true });
    expect(lease.signal.aborted).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("\"action\":\"terminate\""));

    await nextTick();
    const again = await app.request(`/agent/admin/pool/${lease.slot_id}/terminate`, {
      method: "POST", headers: { authorization: "Bearer admin" },
    });
    expect(again.status).toBe(409);
  });
});
