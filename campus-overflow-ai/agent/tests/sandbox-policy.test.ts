import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkEgressHost,
  evaluateSandboxRequest,
  isPathWithin,
  matchesExecutableAllowlist,
} from "../src/sandbox/policy.js";
import type { SandboxExecutionRequest, SandboxPolicy } from "../src/sandbox/contracts.js";

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  workspaceRoots: [tmpdir()],
  allowExecutables: ["agent-browser-*"],
  denyExecutables: ["bash", "sh", "powershell", "cmd", "curl"],
  allowEnvKeys: ["PATH", "TEMP"],
  networkMode: "none",
  allowHosts: [],
  maxTimeoutMs: 30_000,
  maxOutputBytes: 1024,
  maxArgs: 4,
  maxArgLength: 32,
  maxMemoryMb: 256,
  ...overrides,
});

const request = (overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest => ({
  executable: join(tmpdir(), "agent-browser-probe"),
  args: ["read"],
  cwd: tmpdir(),
  env: { PATH: "/bin", SECRET: "should-not-pass" },
  ...overrides,
});

describe("沙箱策略层", () => {
  it("允许工作区内的只读执行，并只保留白名单环境变量", () => {
    const decision = evaluateSandboxRequest(request(), policy());
    expect(decision.allowed).toBe(true);
    expect(decision.env).toEqual({ PATH: "/bin" });
    expect(decision.timeoutMs).toBe(30_000);
  });

  it("拒绝工作目录逃逸与根目录前缀伪装", () => {
    expect(evaluateSandboxRequest(request({ cwd: resolve(tmpdir(), "..") }), policy()))
      .toMatchObject({ allowed: false, reasonCode: "workspace_escape" });
    expect(isPathWithin("/tmp/work", "/tmp/work/child")).toBe(true);
    expect(isPathWithin("/tmp/work", "/tmp/worker")).toBe(false);
  });

  it("要求可执行文件为绝对路径且命中允许列表", () => {
    expect(evaluateSandboxRequest(request({ executable: "agent-browser-probe" }), policy()))
      .toMatchObject({ reasonCode: "executable_not_allowed" });
    expect(evaluateSandboxRequest(request({ executable: join(tmpdir(), "other-tool") }), policy()))
      .toMatchObject({ reasonCode: "executable_not_allowed" });
  });

  it("硬禁用命令优先于允许列表，写 * 也不能放行 shell", () => {
    const wildcard = policy({ allowExecutables: ["*"], denyExecutables: ["bash", "cmd"] });
    expect(evaluateSandboxRequest(request({ executable: join(tmpdir(), "bash") }), wildcard))
      .toMatchObject({ reasonCode: "executable_denied" });
    expect(evaluateSandboxRequest(request({ executable: join(tmpdir(), "cmd") }), wildcard))
      .toMatchObject({ reasonCode: "executable_denied" });
    expect(matchesExecutableAllowlist("/opt/agent-browser-linux-x64", ["agent-browser-*"])).toBe(true);
  });

  it.each([
    ["换行", ["read\nclose"]],
    ["回车", ["read\rclose"]],
    ["空字符", ["read\0close"]],
    ["参数过多", ["a", "b", "c", "d", "e"]],
    ["参数过长", ["x".repeat(33)]],
  ])("拒绝非法参数：%s", (_label, args) => {
    expect(evaluateSandboxRequest(request({ args }), policy()))
      .toMatchObject({ reasonCode: "argument_rejected" });
  });

  it("出站主机按模式与点边界核对", () => {
    expect(checkEgressHost("127.0.0.1", "loopback", [])).toBe(true);
    expect(checkEgressHost("localhost", "loopback", [])).toBe(true);
    expect(checkEgressHost("example.com", "loopback", [])).toBe(false);
    expect(checkEgressHost("docs.example.com", "allowlist", ["example.com"])).toBe(true);
    expect(checkEgressHost("evil-example.com", "allowlist", ["example.com"])).toBe(false);
    expect(checkEgressHost("example.com", "none", ["example.com"])).toBe(false);
    expect(evaluateSandboxRequest(request({ networkHosts: ["example.com"] }), policy()))
      .toMatchObject({ reasonCode: "network_denied" });
  });

  it("写操作与网络动作必须携带审批编号", () => {
    expect(evaluateSandboxRequest(request({ actionClass: "write" }), policy()))
      .toMatchObject({ reasonCode: "approval_required" });
    expect(evaluateSandboxRequest(request({ actionClass: "write", approval: { executionId: "exec-1" } }), policy()).allowed)
      .toBe(true);
    expect(evaluateSandboxRequest(request({ actionClass: "network", approval: { executionId: "  " } }), policy()))
      .toMatchObject({ reasonCode: "approval_required" });
  });

  it("超时按策略上限收敛，取消信号直接拒绝", () => {
    expect(evaluateSandboxRequest(request({ timeoutMs: 999_999 }), policy()).timeoutMs).toBe(30_000);
    expect(evaluateSandboxRequest(request({ timeoutMs: 50 }), policy()).timeoutMs).toBe(50);
    const controller = new AbortController();
    controller.abort();
    expect(evaluateSandboxRequest(request({ signal: controller.signal }), policy()))
      .toMatchObject({ reasonCode: "cancelled" });
  });
});
