// P0-2 沙箱策略层：纯函数决策，不启动进程。全部按“失败关闭”返回拒绝原因。
import { basename, isAbsolute, resolve, sep } from "node:path";

import type {
  SandboxDecision,
  SandboxExecutionRequest,
  SandboxNetworkMode,
  SandboxPolicy,
  SandboxReasonCode,
} from "./contracts.js";

/** 默认硬禁用命令：shell、通用解释器、下载/远程工具。即使允许列表写 `*` 也不能放行。 */
export const DEFAULT_DENY_EXECUTABLES = [
  "sh", "bash", "zsh", "fish", "ksh", "csh", "dash", "ash",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "wsl", "wsl.exe",
  "node", "node.exe", "deno", "bun", "python", "python.exe", "python3", "perl", "perl.exe",
  "ruby", "ruby.exe", "php", "php.exe", "osascript",
  "curl", "curl.exe", "wget", "wget.exe", "nc", "nc.exe", "ncat", "ncat.exe", "netcat",
  "ssh", "ssh.exe", "scp", "scp.exe", "telnet", "telnet.exe", "ftp", "ftp.exe",
  "reg", "reg.exe", "schtasks", "schtasks.exe", "rundll32", "rundll32.exe",
  "mshta", "mshta.exe", "certutil", "certutil.exe", "bitsadmin", "bitsadmin.exe",
] as const;

/** 子进程默认可见的环境变量：仅系统路径、临时目录与浏览器一次性会话目录，不含任何凭证。 */
export const DEFAULT_ENV_ALLOW_KEYS = [
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
  "AGENT_BROWSER_SOCKET_DIR",
] as const;

const normalize = (value: string): string =>
  (process.platform === "win32" ? value.toLowerCase() : value);

/** 目标路径是否等于根目录或位于其下（先 resolve，避免 `..` 绕过）。 */
export const isPathWithin = (root: string, candidate: string): boolean => {
  const base = normalize(resolve(root));
  const target = normalize(resolve(candidate));
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
};

/** 允许列表支持尾部 `*` 前缀匹配；比较不区分大小写（Windows 文件名不敏感）。 */
export const matchesExecutableAllowlist = (
  executable: string,
  patterns: readonly string[],
): boolean => {
  const name = basename(executable).toLowerCase();
  return patterns.some(pattern => {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) return false;
    return normalized.endsWith("*")
      ? name.startsWith(normalized.slice(0, -1))
      : name === normalized;
  });
};

/** 硬禁用优先于允许列表，防止通过 `*` 放行 shell 或解释器。 */
export const isExecutableDenied = (
  executable: string,
  denyExecutables: readonly string[],
): boolean => {
  const name = basename(executable).toLowerCase();
  return denyExecutables.some(entry => entry.trim().toLowerCase() === name);
};

/** 主机是否在允许范围内；allowlist 按点边界匹配子域，避免 evil-example.com 命中 example.com。 */
export const checkEgressHost = (
  host: string,
  mode: SandboxNetworkMode,
  allowHosts: readonly string[],
): boolean => {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized) return false;
  if (mode === "none") return false;
  if (mode === "loopback") {
    return normalized === "localhost" || normalized === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
  }
  return allowHosts.some(entry => {
    const allowed = entry.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    if (!allowed) return false;
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
};

const deny = (reasonCode: SandboxReasonCode, policy: SandboxPolicy, timeoutMs: number): SandboxDecision => ({
  allowed: false,
  reasonCode,
  timeoutMs,
  maxOutputBytes: policy.maxOutputBytes,
  env: {},
});

const hasControlCharacter = (value: string): boolean => /[\0\r\n]/.test(value);

/** 核心决策：不抛异常，任何不确定都返回拒绝，调用方不得降级放行。 */
export const evaluateSandboxRequest = (
  request: SandboxExecutionRequest,
  policy: SandboxPolicy,
): SandboxDecision => {
  const requestedTimeout = request.timeoutMs ?? policy.maxTimeoutMs;
  const timeoutMs = Math.max(1, Math.min(requestedTimeout, policy.maxTimeoutMs));

  if (request.signal?.aborted) return deny("cancelled", policy, timeoutMs);
  if (!isAbsolute(request.executable)) return deny("executable_not_allowed", policy, timeoutMs);
  if (isExecutableDenied(request.executable, policy.denyExecutables)) {
    return deny("executable_denied", policy, timeoutMs);
  }
  if (!matchesExecutableAllowlist(request.executable, policy.allowExecutables)) {
    return deny("executable_not_allowed", policy, timeoutMs);
  }

  if (request.args.length > policy.maxArgs
    || request.args.some(arg => arg.length > policy.maxArgLength || hasControlCharacter(arg))) {
    return deny("argument_rejected", policy, timeoutMs);
  }

  if (!isAbsolute(request.cwd) || !policy.workspaceRoots.some(root => isPathWithin(root, request.cwd))) {
    return deny("workspace_escape", policy, timeoutMs);
  }

  const declaredHosts = request.networkHosts ?? [];
  if (policy.networkMode === "none" && declaredHosts.length > 0) {
    return deny("network_denied", policy, timeoutMs);
  }
  if (policy.networkMode === "allowlist"
    && declaredHosts.some(host => !checkEgressHost(host, policy.networkMode, policy.allowHosts))) {
    return deny("network_denied", policy, timeoutMs);
  }

  const actionClass = request.actionClass ?? "read";
  if (actionClass !== "read" && !request.approval?.executionId?.trim()) {
    return deny("approval_required", policy, timeoutMs);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.env)) {
    if (value !== undefined && policy.allowEnvKeys.includes(key)) env[key] = value;
  }
  return { allowed: true, timeoutMs, maxOutputBytes: policy.maxOutputBytes, env };
};
