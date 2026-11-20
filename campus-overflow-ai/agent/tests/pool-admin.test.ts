// SA-04 运行池只读状态：内部服务鉴权与管理员权限分离，快照含固定 8 槽。
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { UserInternalClient } from "../src/internal-client.js";

const admin = {
  user_id: 1, role: "admin", status: "active",
  identity_type: "postgraduate", assistant_cert_status: "approved",
} as const;
const student = {
  user_id: 2, role: "student", status: "active",
  identity_type: "undergraduate", assistant_cert_status: "none",
} as const;

const appOf = (principal: typeof admin | typeof student) => createApp({
  createClient: () => ({ resolvePrincipal: async () => principal } as unknown as UserInternalClient),
  getModel: () => ({}) as never,
});

beforeEach(() => {
  process.env.AGENT_SERVICE_TOKEN = "svc-test";
});

afterEach(() => {
  delete process.env.AGENT_SERVICE_TOKEN;
});

describe("运行池状态接口", () => {
  it("内部接口必须携带匹配的服务凭证", async () => {
    const app = appOf(admin);

    const missing = await app.request("/internal/agent/agent-pool/status");
    expect(missing.status).toBe(401);

    const wrong = await app.request("/internal/agent/agent-pool/status", {
      headers: { "x-service-token": "wrong" },
    });
    expect(wrong.status).toBe(401);

    const ok = await app.request("/internal/agent/agent-pool/status", {
      headers: { "x-service-token": "svc-test" },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.slots).toHaveLength(8);
    expect(body.data.slots.filter((slot: { slot_kind: string }) => slot.slot_kind === "governance")).toHaveLength(3);
    expect(body.data.slots.filter((slot: { slot_kind: string }) => slot.slot_kind === "qa")).toHaveLength(5);
    expect(body.data.queues.qa.waiting).toBe(0);
  });

  it("管理端视图仅允许 active 管理员", async () => {
    const studentResponse = await appOf(student).request("/agent/admin/pool", {
      headers: { authorization: "Bearer student-token" },
    });
    expect(studentResponse.status).toBe(403);

    const adminResponse = await appOf(admin).request("/agent/admin/pool", {
      headers: { authorization: "Bearer admin-token" },
    });
    expect(adminResponse.status).toBe(200);
    expect((await adminResponse.json()).data.slots).toHaveLength(8);
  });
});
