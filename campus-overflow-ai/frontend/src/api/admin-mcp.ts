import { apiFetch, buildQuery } from "./client";

export type McpCallStatus = "succeeded" | "failed" | "denied" | "unregistered" | "rejected";

export interface McpCallItem {
  id: number;
  client_name: string;
  tool_name: string;
  status: McpCallStatus;
  args_summary: string;
  result_summary: string | null;
  error_summary: string | null;
  duration_ms: number;
  trace_id: string;
  created_at: string;
}

export interface McpCallList {
  items: McpCallItem[];
  total: number;
  page: number;
  page_size: number;
}

export function fetchMcpCalls(
  params: {
    page?: number;
    page_size?: number;
    client_name?: string;
    tool_name?: string;
    status?: McpCallStatus;
  } = {},
) {
  return apiFetch<McpCallList>(`/governance/mcp/calls${buildQuery(params)}`);
}

export interface UpstreamMcpTool {
  name: string;
  risk: "low" | "high";
  confirmed: boolean;
  model_visible: boolean;
}

export interface UpstreamMcpServer {
  name: string;
  origin: string;
  enabled: boolean;
  tools: UpstreamMcpTool[];
}

export interface UpstreamMcpConfig {
  servers: UpstreamMcpServer[];
}

export type UpstreamMcpCallResult =
  | { status: "executed"; result: unknown }
  | { status: "approval_required"; case_id: number };

async function fetchAgentData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/agent${path}`, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as
    | { code?: number; data?: unknown; message?: string }
    | null;
  const acceptedCode = body?.code === 200 || body?.code === 202;
  if (!response.ok || !acceptedCode) {
    throw new Error(body?.message ?? "Agent 管理请求失败");
  }
  return body.data as T;
}

export function fetchUpstreamMcpConfig() {
  return fetchAgentData<UpstreamMcpConfig>("/agent/admin/mcp/upstream");
}

export function callUpstreamMcpTool(input: {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
}) {
  return fetchAgentData<UpstreamMcpCallResult>("/agent/admin/mcp/upstream/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
