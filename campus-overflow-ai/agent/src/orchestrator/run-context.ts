// 子 Agent 运行上下文（SA-02）：每次尝试整体重建身份、客户端、工具表与预算；
// 检查点只保留跨尝试需要的进度与累计消耗，不保存对话正文、工具原始输出或凭证。
import { randomUUID } from "node:crypto";

import type { LanguageModel } from "ai";

import { AgentPrincipalSchema, type AgentPrincipal } from "../auth/principal.js";
import type { UserInternalClient } from "../internal-client.js";
import { createRepairBudget } from "../loop/repair-budget.js";
import { createToolCallBudget } from "../loop/run-budget.js";
import { createRunContext, type RunContext, type RunTaskKind } from "../observability/run-context.js";
import { createRequestTools } from "../tools/request-tools.js";
import type { ToolRegistry } from "../tools/registry.js";

export type ChildActorKind = "qa" | "governance";

/** 跨尝试保留的最小状态；不存对话正文、工具原始输出或凭证。 */
export interface ChildRunCheckpoint {
  version: 1;
  job_id: string;
  trace_id: string;
  /** 已完成的步骤标识：恢复时跳过，不重复规划同一阶段 */
  completed_steps: string[];
  /** 已提交的后端动作标识：恢复后绝不重复执行 */
  committed_actions: string[];
  consumed_tool_calls: number;
  consumed_repairs: number;
  activity_ms: number;
  governance_round: number;
  updated_at: string;
}

export interface ChildRunSpec {
  jobId: string;
  actorKind: ChildActorKind;
  taskType: RunTaskKind;
  /** 来自后端已验证的不可变身份；每次尝试重新解析一份副本 */
  principal: AgentPrincipal;
  /** 每次尝试重新创建；禁止把上一次的客户端或凭证带入下一次 */
  createClient: () => UserInternalClient;
  model: LanguageModel;
  courseId?: number;
  traceId?: string;
  signal?: AbortSignal;
  webOptions?: Parameters<typeof import("../web/tools.js").createWebTools>[1];
}

export interface ChildRunContext {
  readonly jobId: string;
  readonly actorKind: ChildActorKind;
  readonly principal: AgentPrincipal;
  readonly client: UserInternalClient;
  readonly model: LanguageModel;
  readonly tools: ToolRegistry;
  readonly run: RunContext;
}

const cloneCheckpoint = (checkpoint: ChildRunCheckpoint): ChildRunCheckpoint => ({
  ...checkpoint,
  completed_steps: [...checkpoint.completed_steps],
  committed_actions: [...checkpoint.committed_actions],
});

export const createCheckpoint = (
  jobId: string, traceId: string | undefined, now: () => number,
): ChildRunCheckpoint => ({
  version: 1,
  job_id: jobId,
  trace_id: traceId?.trim() || randomUUID(),
  completed_steps: [],
  committed_actions: [],
  consumed_tool_calls: 0,
  consumed_repairs: 0,
  activity_ms: 0,
  governance_round: 0,
  updated_at: new Date(now()).toISOString(),
});

/** 进程内检查点仓库：按 job_id 隔离；超出容量按最早写入淘汰，避免无限增长。 */
export class CheckpointStore {
  private readonly entries = new Map<string, ChildRunCheckpoint>();
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, Math.trunc(maxEntries));
  }

  load(jobId: string): ChildRunCheckpoint | undefined {
    const entry = this.entries.get(jobId);
    return entry ? cloneCheckpoint(entry) : undefined;
  }

  save(checkpoint: ChildRunCheckpoint): void {
    const snapshot = cloneCheckpoint(checkpoint);
    // 重新写入时移到队尾，近似 LRU，避免活跃任务被先淘汰
    this.entries.delete(snapshot.job_id);
    this.entries.set(snapshot.job_id, snapshot);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(jobId: string): void {
    this.entries.delete(jobId);
  }

  size(): number {
    return this.entries.size;
  }
}

/** 每次调用都新建客户端、工具表与预算；检查点只提供初始累计值。 */
export const createChildRunContext = (
  spec: ChildRunSpec, checkpoint: ChildRunCheckpoint,
): ChildRunContext => {
  if (checkpoint.job_id !== spec.jobId) throw new Error("检查点与任务不匹配");
  const principal = AgentPrincipalSchema.parse({ ...spec.principal });
  const client = spec.createClient();
  // 工具表复用 agents/controller 收窄：白名单 ∩ 角色能力 ∩ 主规则，且只保留 low 风险工具。
  const tools = createRequestTools(client, principal, spec.courseId, spec.webOptions);
  const run = createRunContext({
    taskType: spec.taskType,
    principal,
    traceId: checkpoint.trace_id,
    signal: spec.signal,
    toolBudget: createToolCallBudget(checkpoint.consumed_tool_calls),
    repairBudget: createRepairBudget(checkpoint.consumed_repairs),
  });
  return Object.freeze({
    jobId: spec.jobId,
    actorKind: spec.actorKind,
    principal,
    client,
    model: spec.model,
    tools,
    run,
  });
};
