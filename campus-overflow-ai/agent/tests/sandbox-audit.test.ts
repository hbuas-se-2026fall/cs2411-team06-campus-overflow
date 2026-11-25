import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendSandboxAudit } from "../src/sandbox/audit.js";
import type { SandboxAuditEvent } from "../src/sandbox/contracts.js";
import { createInternalClient } from "../src/internal-client.js";

const event = (overrides: Partial<SandboxAuditEvent> = {}): SandboxAuditEvent => ({
  event: "sandbox_exec",
  outcome: "completed",
  tool: "agent-browser",
  executable: "agent-browser-win32-x64.exe",
  command_digest: "0123456789abcdef",
  arg_count: 5,
  action_class: "read",
  network_mode: "loopback",
  trace_id: "trace-1",
  duration_ms: 20,
  output_bytes: 128,
  ...overrides,
});

const okResponse = () => new Response(
  JSON.stringify({ code: 200, data: { id: 7 }, message: "沙箱审计已记录" }),
  { status: 200, headers: { "content-type": "application/json" } },
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("沙箱审计后端 sink", () => {
  it("只携带服务凭证，按蛇形契约发送契约字段", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse();
    });
    const client = createInternalClient({
      baseUrl: "http://backend.test", token: "svc-token", fetchImpl: fetchImpl as typeof fetch,
    });
    const sink = createBackendSandboxAudit({ createRecorder: () => client });

    await sink(event());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://backend.test/internal/agent/sandbox/events");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("X-Service-Token")).toBe("svc-token");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-trace-id")).toBe("trace-1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(event());
  });

  it("trace 缺失时生成可检索的本地 trace", async () => {
    let trace: string | undefined;
    const sink = createBackendSandboxAudit({
      createRecorder: () => ({
        recordSandboxEvent: async (_event, traceId) => {
          trace = traceId;
          return { id: 1 };
        },
      }),
    });
    await sink(event({ trace_id: null }));
    expect(trace).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("后端失败只记结构化日志，不抛错也不落参数", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ code: 500, data: null, message: "内部错误" }),
      { status: 500, headers: { "content-type": "application/json" } },
    ));
    const client = createInternalClient({
      baseUrl: "http://backend.test", token: "svc-token", fetchImpl: fetchImpl as typeof fetch,
    });
    const sink = createBackendSandboxAudit({ createRecorder: () => client });

    await expect(sink(event())).resolves.toBeUndefined();

    expect(logged).toHaveLength(1);
    const report = JSON.parse(logged[0]) as Record<string, unknown>;
    expect(report).toMatchObject({
      event: "sandbox_audit_delivery_failed", outcome: "completed", tool: "agent-browser",
    });
    expect(logged[0]).not.toContain("secret-value");
    expect(logged[0]).not.toContain("内部错误");
  });
});
