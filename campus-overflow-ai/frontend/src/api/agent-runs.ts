// Agent 观测（T-16-B，US-18）：admin 运行列表与调用链详情数据源。
// 走同源 BFF（/api/backend/api/**），蛇形字段与后端 governance 契约一致。
import { apiFetch } from "./client";
import type {
  ModerationCaseItem,
} from "@/shared/types/governance";

export interface AgentRunItem {
  id: number;
  user_id: number | null;
  actor_kind: string | null;
  parent_run_id: string | null;
  slot_kind: string | null;
  slot_id: string | null;
  task_type: string;
  trace_id: string;
  agent_run_id: string;
  input_summary: string;
  output_summary: string | null;
  error_summary: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentRunList {
  items: AgentRunItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface AgentRunEventItem {
  id: number;
  agent_run_id: string;
  sequence_no: number;
  event_type: string;
  plan_revision: number;
  steps: Array<{ step_id: string; tool_name: string }> | null;
  step_id: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  trace_id: string;
  created_at: string;
}

export interface ToolCallItem {
  id: number;
  agent_run_id: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  status: string;
  duration_ms: number | null;
  trace_id: string;
  created_at: string;
}

/** 单运行完整调用链（US-18 完成判定：trace 可检索、失败可定位） */
export interface AgentRunTrace {
  run: AgentRunItem;
  events: AgentRunEventItem[];
  tool_calls: ToolCallItem[];
  related_cases: ModerationCaseItem[];
}

export function fetchAgentRuns(
  params: { page?: number; page_size?: number; status?: string; task_type?: string; user_id?: number } = {},
) {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.page_size !== undefined) query.set("page_size", String(params.page_size));
  if (params.status) query.set("status", params.status);
  if (params.task_type) query.set("task_type", params.task_type);
  if (params.user_id !== undefined) query.set("user_id", String(params.user_id));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiFetch<AgentRunList>(`/governance/agent-runs${suffix}`);
}

export function fetchAgentRunTrace(agentRunId: string) {
  return apiFetch<AgentRunTrace>(
    `/governance/agent-runs/${encodeURIComponent(agentRunId)}`,
  );
}

/** 运行池（SA-04）：同源 BFF 转发到 Agent 管理路由。 */
export type AgentPoolSlotKind = "qa" | "governance";
export type AgentPoolSlotState = "idle" | "leased" | "running" | "draining";

export interface AgentPoolSlot {
  slot_id: string;
  slot_kind: AgentPoolSlotKind;
  state: AgentPoolSlotState;
  job_id: string | null;
  supporting_governance: boolean;
  started_at: string | null;
}

export interface AgentPoolQueueStatus {
  waiting: number;
  oldest_wait_ms: number;
}

export interface AgentPoolStatus {
  instance_id: string;
  slots: AgentPoolSlot[];
  queues: Record<AgentPoolSlotKind, AgentPoolQueueStatus>;
}

export async function fetchAgentPool(): Promise<AgentPoolStatus> {
  const response = await fetch("/api/agent/agent/admin/pool", { cache: "no-store" });
  const body = await response.json().catch(() => null) as
    | { code?: number; data?: unknown; message?: string }
    | null;
  if (!response.ok || body?.code !== 200) {
    throw new Error(body?.message ?? "运行池状态加载失败");
  }
  return body.data as AgentPoolStatus;
}

export interface AgentPoolAction {
  slot_id: string;
  action: "drain" | "terminate";
  accepted: boolean;
  audit_summary: string;
}

async function postPoolAction(slotId: string, action: "drain" | "terminate"): Promise<AgentPoolAction> {
  const response = await fetch(
    `/api/agent/agent/admin/pool/${encodeURIComponent(slotId)}/${action}`,
    { method: "POST", cache: "no-store" },
  );
  const body = await response.json().catch(() => null) as
    | { code?: number; data?: unknown; message?: string }
    | null;
  if (!response.ok || body?.code !== 200) {
    throw new Error(body?.message ?? "运行池操作失败");
  }
  return body.data as AgentPoolAction;
}

export const drainPoolSlot = (slotId: string) => postPoolAction(slotId, "drain");
export const terminatePoolSlot = (slotId: string) => postPoolAction(slotId, "terminate");
