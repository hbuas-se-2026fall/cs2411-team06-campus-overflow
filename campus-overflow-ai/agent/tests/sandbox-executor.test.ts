import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runSandboxed, type SandboxProcessRequest } from "../src/sandbox/executor.js";
import type { SandboxAuditEvent, SandboxExecutionRequest, SandboxPolicy } from "../src/sandbox/contracts.js";

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  workspaceRoots: [tmpdir()],
  allowExecutables: ["agent-browser-*"],
  denyExecutables: ["bash", "sh", "cmd"],
  allowEnvKeys: ["PATH"],
  networkMode: "loopback",
  allowHosts: [],
  maxTimeoutMs: 30_000,
  maxOutputBytes: 1024,
  maxArgs: 8,
  maxArgLength: 256,
  maxMemoryMb: 256,
  ...overrides,
});

const request = (overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest => ({
  tool: "probe",
  executable: join(tmpdir(), "agent-browser-probe"),
  args: ["--token", "secret-value"],
  cwd: tmpdir(),
  env: { PATH: "/bin", SECRET: "leak" },
  traceId: "trace-1",
  ...overrides,
});

describe("沙箱执行器", () => {
  it("策略拒绝时不启动进程，只记录原因码", async () => {
    const run = vi.fn();
    const events: SandboxAuditEvent[] = [];
    await expect(runSandboxed(request({ executable: join(tmpdir(), "bash") }), policy(),
      { run, audit: event => events.push(event) })).rejects.toThrow("executable_denied");
    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({
      event: "sandbox_exec", outcome: "denied", reason_code: "executable_denied", trace_id: "trace-1",
      executable: "bash", arg_count: 2,
    })]);
  });

  it("执行时只传白名单环境，审计不含参数原文", async () => {
    let captured: SandboxProcessRequest | undefined;
    const events: SandboxAuditEvent[] = [];
    const output = await runSandboxed(request(), policy(), {
      run: async input => { captured = input; return { stdout: "ok", stderr: "" }; },
      audit: event => events.push(event),
    });
    expect(output).toBe("ok");
    expect(captured?.env).toEqual({ PATH: "/bin" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("SECRET");
    expect(events[0]).toMatchObject({ outcome: "completed", output_bytes: 2, network_mode: "loopback" });
    expect(events[0].command_digest).toMatch(/^[a-f0-9]{16}$/);
  });

  it("底层错误只映射为固定原因码，不泄露 stderr", async () => {
    const events: SandboxAuditEvent[] = [];
    const failure = Object.assign(new Error("secret stderr detail"), { killed: true });
    await expect(runSandboxed(request(), policy(), {
      run: async () => { throw failure; },
      audit: event => events.push(event),
    })).rejects.toThrow("沙箱策略拒绝：timeout");
    expect(JSON.stringify(events)).not.toContain("secret stderr detail");
  });

  it("输出超过上限时失败关闭", async () => {
    await expect(runSandboxed(request(), policy(), {
      run: async () => ({ stdout: "x".repeat(1025), stderr: "" }),
    })).rejects.toThrow("output_limit_exceeded");
  });

  it("取消信号在启动前生效", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    await expect(runSandboxed(request({ signal: controller.signal }), policy(), { run }))
      .rejects.toThrow("cancelled");
    expect(run).not.toHaveBeenCalled();
  });

  it("审计异步失败不影响执行结果", async () => {
    const output = await runSandboxed(request(), policy(), {
      run: async () => ({ stdout: "ok", stderr: "" }),
      audit: async () => { throw new Error("backend down"); },
    });
    expect(output).toBe("ok");
  });

  it("审计同步抛错也不改写策略拒绝", async () => {
    await expect(runSandboxed(request({ executable: join(tmpdir(), "bash") }), policy(), {
      audit: () => { throw new Error("audit broken"); },
    })).rejects.toThrow("executable_denied");
  });

  it("真实子进程经 execFile 执行，shell 关闭", async () => {
    const executable = process.execPath;
    const output = await runSandboxed(request({
      executable, args: ["-e", "process.stdout.write('ok')"],
    }), policy({ allowExecutables: [basename(executable)], denyExecutables: [] }), {
      audit: () => undefined,
    });
    expect(output).toBe("ok");
  });
});
