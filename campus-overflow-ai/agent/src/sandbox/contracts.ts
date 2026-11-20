// P0-2 沙箱执行边界：策略层契约。只含类型与错误，不依赖进程、框架或网络。
// 外部命令、浏览器、文件执行都必须先经过本层决策，再进入执行器。

export type SandboxNetworkMode = "none" | "loopback" | "allowlist";

/** read 不需要审批；write/network 必须携带审批执行编号（C-06）。 */
export type SandboxActionClass = "read" | "write" | "network";

export type SandboxReasonCode =
  | "executable_denied"
  | "executable_not_allowed"
  | "argument_rejected"
  | "workspace_escape"
  | "network_denied"
  | "approval_required"
  | "output_limit_exceeded"
  | "timeout"
  | "cancelled"
  | "exec_failed";

export interface SandboxPolicy {
  /** 允许执行的绝对根目录；工作目录必须落在其中 */
  readonly workspaceRoots: readonly string[];
  /** 可执行文件名允许列表，支持尾部 `*` 前缀匹配，如 agent-browser-* */
  readonly allowExecutables: readonly string[];
  /** 无论允许列表如何配置都拒绝的命令（shell、解释器、下载器） */
  readonly denyExecutables: readonly string[];
  /** 子进程可见的环境变量键；其余一律剥离 */
  readonly allowEnvKeys: readonly string[];
  readonly networkMode: SandboxNetworkMode;
  /** allowlist 模式下允许的出站主机（含子域） */
  readonly allowHosts: readonly string[];
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxArgs: number;
  readonly maxArgLength: number;
  /** 声明给容器运行时的内存上限；本地进程由容器侧真正限制 */
  readonly maxMemoryMb: number;
}

export interface SandboxExecutionRequest {
  /** 审计用工具名，默认 exec */
  readonly tool?: string;
  /** 必须是绝对路径，且文件名命中允许列表 */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 缺省为 read；write/network 需要审批 */
  readonly actionClass?: SandboxActionClass;
  /** 声明本次执行需要的出站主机，由策略核对 */
  readonly networkHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** write/network 动作的审批执行编号，缺失即拒绝 */
  readonly approval?: { readonly executionId: string };
  readonly traceId?: string;
}

export interface SandboxDecision {
  readonly allowed: boolean;
  readonly reasonCode?: SandboxReasonCode;
  /** 已按策略上限收敛 */
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** 仅保留允许键的环境变量 */
  readonly env: Record<string, string>;
}

export interface SandboxAuditEvent {
  readonly event: "sandbox_exec";
  readonly outcome: "denied" | "completed" | "failed";
  readonly tool: string;
  readonly executable: string;
  readonly command_digest: string;
  readonly arg_count: number;
  readonly action_class: SandboxActionClass;
  readonly network_mode: SandboxNetworkMode;
  readonly trace_id: string | null;
  readonly duration_ms: number;
  readonly output_bytes: number;
  readonly reason_code?: SandboxReasonCode;
}

export class SandboxPolicyError extends Error {
  constructor(readonly reasonCode: SandboxReasonCode) {
    super(`沙箱策略拒绝：${reasonCode}`);
    this.name = "SandboxPolicyError";
  }
}
