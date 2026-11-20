// P0-2 沙箱配置：默认失败关闭（无网络、只允许 agent-browser、工作区限临时目录）。
import { tmpdir } from "node:os";

import type { SandboxNetworkMode, SandboxPolicy } from "./contracts.js";
import { DEFAULT_DENY_EXECUTABLES, DEFAULT_ENV_ALLOW_KEYS } from "./policy.js";

const list = (raw: string | undefined): string[] =>
  raw?.split(",").map(item => item.trim()).filter(Boolean) ?? [];

const integer = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const networkMode = (raw: string | undefined): SandboxNetworkMode =>
  raw === "none" || raw === "loopback" || raw === "allowlist" ? raw : "none";

/** `SANDBOX_DENY_EXECUTABLES` 只能在硬禁用列表上追加，不能移除。 */
export const readSandboxPolicy = (env: NodeJS.ProcessEnv = process.env): SandboxPolicy => {
  const workspaceRoots = list(env.SANDBOX_WORKSPACE_ROOTS);
  const allowExecutables = list(env.SANDBOX_ALLOW_EXECUTABLES);
  return {
    workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots : [tmpdir()],
    allowExecutables: allowExecutables.length > 0 ? allowExecutables : ["agent-browser-*"],
    denyExecutables: [...DEFAULT_DENY_EXECUTABLES, ...list(env.SANDBOX_DENY_EXECUTABLES)],
    allowEnvKeys: [...DEFAULT_ENV_ALLOW_KEYS, ...list(env.SANDBOX_ENV_ALLOW)],
    networkMode: networkMode(env.SANDBOX_NETWORK_MODE),
    allowHosts: list(env.SANDBOX_ALLOW_HOSTS),
    maxTimeoutMs: integer(env.SANDBOX_TIMEOUT_MS, 30_000, 100, 600_000),
    maxOutputBytes: integer(env.SANDBOX_MAX_OUTPUT_BYTES, 1_000_000, 1024, 10_000_000),
    maxArgs: 64,
    maxArgLength: 8192,
    maxMemoryMb: integer(env.SANDBOX_MAX_MEMORY_MB, 512, 64, 4096),
  };
};
