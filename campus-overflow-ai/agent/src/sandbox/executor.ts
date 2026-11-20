// P0-2 沙箱执行器：策略通过后才启动子进程；不经过 shell，输出/超时/环境全部收敛。
// 审计只记录命令摘要与计数，不落参数正文、URL、错误消息或凭据。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

import {
  SandboxPolicyError,
  type SandboxActionClass,
  type SandboxAuditEvent,
  type SandboxExecutionRequest,
  type SandboxNetworkMode,
  type SandboxPolicy,
  type SandboxReasonCode,
} from "./contracts.js";
import { evaluateSandboxRequest, isPathWithin } from "./policy.js";

const runFile = promisify(execFile);

export interface SandboxProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface SandboxProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type SandboxProcessRunner = (request: SandboxProcessRequest) => Promise<SandboxProcessResult>;
/** 允许异步落库；执行器不等待审计，审计失败也不改写执行结果。 */
export type SandboxAuditSink = (event: SandboxAuditEvent) => void | Promise<void>;

/** 默认审计只写结构化日志；P0-4 起由装配处注入后端持久化 sink。 */
export const consoleSandboxAudit: SandboxAuditSink = event => {
  console.log(JSON.stringify(event));
};

/** 审计是旁路：同步抛错或异步失败都不能影响沙箱决策与执行结果。 */
const emitAudit = (audit: SandboxAuditSink, event: SandboxAuditEvent): void => {
  try {
    const pending = audit(event);
    if (pending instanceof Promise) pending.catch(() => undefined);
  } catch {
    // 由 sink 自行记录失败；此处只保证不向调用方传播
  }
};

const commandDigest = (request: SandboxExecutionRequest): string => createHash("sha256")
  .update(JSON.stringify([basename(request.executable), ...request.args]))
  .digest("hex")
  .slice(0, 16);

/** 只使用 execFile，shell 永远为 false；maxBuffer 略高于上限以便区分“超限”和正常返回。 */
const defaultRunner: SandboxProcessRunner = async request => {
  const result = await runFile(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    timeout: request.timeoutMs,
    maxBuffer: request.maxOutputBytes + 1,
    signal: request.signal,
    killSignal: "SIGKILL",
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

/**
 * 真实路径复核：工作目录可能在检查后被替换为符号链接。
 * 根目录解析失败时退回字面比较，保证不因根路径不存在而放行。
 */
const assertRealWorkspace = async (cwd: string, roots: readonly string[]): Promise<void> => {
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    throw new SandboxPolicyError("workspace_escape");
  }
  for (const root of roots) {
    let realRoot = root;
    try {
      realRoot = await realpath(root);
    } catch {
      // 根目录不可解析时保留字面路径，下方仍做包含判断
    }
    if (isPathWithin(realRoot, realCwd)) return;
  }
  throw new SandboxPolicyError("workspace_escape");
};

/** 把底层错误映射为固定原因码，绝不把 stderr 或命令行带回上层。 */
const mapFailure = (error: unknown, signal?: AbortSignal): SandboxReasonCode => {
  if (signal?.aborted) return "cancelled";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ABORT_ERR") return "cancelled";
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit_exceeded";
  if (code === "ERR_CHILD_PROCESS_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  if ((error as { killed?: unknown } | null)?.killed === true) return "timeout";
  return "exec_failed";
};

export interface SandboxDependencies {
  run?: SandboxProcessRunner;
  audit?: SandboxAuditSink;
}

/** 唯一的外部执行入口：策略拒绝时不启动进程，也不触发重试或降级。 */
export const runSandboxed = async (
  request: SandboxExecutionRequest,
  policy: SandboxPolicy,
  dependencies: SandboxDependencies = {},
): Promise<string> => {
  const audit = dependencies.audit ?? consoleSandboxAudit;
  const actionClass: SandboxActionClass = request.actionClass ?? "read";
  const networkMode: SandboxNetworkMode = policy.networkMode;
  const base = {
    event: "sandbox_exec" as const,
    tool: request.tool ?? "exec",
    executable: basename(request.executable),
    command_digest: commandDigest(request),
    arg_count: request.args.length,
    action_class: actionClass,
    network_mode: networkMode,
    trace_id: request.traceId ?? null,
  };
  const decision = evaluateSandboxRequest(request, policy);
  if (!decision.allowed) {
    emitAudit(audit, { ...base, outcome: "denied", reason_code: decision.reasonCode ?? "exec_failed",
      duration_ms: 0, output_bytes: 0 });
    throw new SandboxPolicyError(decision.reasonCode ?? "exec_failed");
  }

  const started = Date.now();
  try {
    await assertRealWorkspace(request.cwd, policy.workspaceRoots);
    const result = await (dependencies.run ?? defaultRunner)({
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: decision.env,
      timeoutMs: decision.timeoutMs,
      maxOutputBytes: decision.maxOutputBytes,
      signal: request.signal,
    });
    const outputBytes = Buffer.byteLength(result.stdout, "utf8");
    if (outputBytes > decision.maxOutputBytes) throw new SandboxPolicyError("output_limit_exceeded");
    emitAudit(audit, { ...base, outcome: "completed", duration_ms: Date.now() - started, output_bytes: outputBytes });
    return result.stdout;
  } catch (error) {
    const reasonCode = error instanceof SandboxPolicyError
      ? error.reasonCode
      : mapFailure(error, request.signal);
    emitAudit(audit, { ...base, outcome: "failed", reason_code: reasonCode,
      duration_ms: Date.now() - started, output_bytes: 0 });
    throw error instanceof SandboxPolicyError ? error : new SandboxPolicyError(reasonCode);
  }
};
