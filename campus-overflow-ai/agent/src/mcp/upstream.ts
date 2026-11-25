// Agent 作为 MCP 客户端消费外部 MCP Server（T-17 N-06 / N-07，US-18）。
// 只有配置白名单中的工具可注册；高风险工具不暴露给模型，必须由管理员调用通道
// 生成待确认工单（C-06），确认前不执行。外部结果视为不可信内容，只原样回传。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { buildSummary } from "../observability/sensitive.js";
import type { AgentTool } from "../tools/registry.js";
import type { TraceId } from "../types/index.js";

/** 高风险调用只需创建待确认工单，不依赖完整客户端能力 */
export interface ApprovalCreator {
  createApproval(body: {
    action_type: string;
    risk_level: "low" | "medium" | "high";
    payload_snapshot: string;
    target_type?: string;
    target_id?: number;
    reason?: string;
    agent_run_id?: string;
  }, traceId: TraceId): Promise<{ id: number; status: string }>;
}

export const UpstreamToolConfigSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, "工具名只允许字母/数字/下划线/短横线"),
  /** 未标注时按高风险处理：必须显式确认后才允许管理员通道调用 */
  risk: z.enum(["low", "high"]).default("high"),
  confirmed: z.boolean().default(false),
}).strict();

export const UpstreamServerConfigSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "服务名只允许字母/数字/下划线/短横线"),
  url: z.string().url(),
  token: z.string().min(1).max(500).optional(),
  enabled: z.boolean().default(true),
  tools: z.array(UpstreamToolConfigSchema).min(1).max(20),
}).strict();

export type UpstreamToolConfig = z.infer<typeof UpstreamToolConfigSchema>;
export type UpstreamServerConfig = z.infer<typeof UpstreamServerConfigSchema>;

const MAX_SERVERS = 5;

/** 解析 MCP_UPSTREAM_SERVERS；空值表示未配置外部 Server（默认关闭） */
export const loadUpstreamServers = (raw: string | undefined): UpstreamServerConfig[] => {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MCP_UPSTREAM_SERVERS 不是合法 JSON");
  }
  const servers = z.array(UpstreamServerConfigSchema).max(MAX_SERVERS).parse(parsed);
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) throw new Error(`MCP upstream 服务名重复: ${server.name}`);
    names.add(server.name);
    if (!/^https?:\/\//.test(server.url)) throw new Error(`MCP upstream URL 必须是 http/https: ${server.name}`);
  }
  return servers;
};

/** 进程内缓存：配置错误在启动/首次读取时暴露，不在每次请求重复解析 */
let cachedRaw: string | undefined;
let cachedServers: UpstreamServerConfig[] = [];
export const upstreamServersFromEnv = (): UpstreamServerConfig[] => {
  const raw = process.env.MCP_UPSTREAM_SERVERS;
  if (raw !== cachedRaw) {
    cachedServers = loadUpstreamServers(raw);
    cachedRaw = raw;
  }
  return cachedServers;
};

export interface UpstreamCaller {
  call(server: UpstreamServerConfig, toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

/** 生产实现：每次调用建立短连接，避免进程内长期持有外部会话与凭证 */
export const sdkUpstreamCaller: UpstreamCaller = {
  call: async (server, toolName, args) => {
    const client = new Client({ name: "campus-overflow-ai", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.token ? { headers: { authorization: `Bearer ${server.token}` } } : undefined,
    });
    await client.connect(transport);
    try {
      return await client.callTool({ name: toolName, arguments: args });
    } finally {
      await client.close();
    }
  },
};

const toolName = (server: UpstreamServerConfig, tool: UpstreamToolConfig): string =>
  `mcp_${server.name}_${tool.name}`;

/** 低风险工具注册为模型可用；高风险工具只登记元信息，模型通道不会展示/执行 */
export const createUpstreamMcpTools = (
  servers: readonly UpstreamServerConfig[],
  caller: UpstreamCaller = sdkUpstreamCaller,
): AgentTool[] => {
  const tools: AgentTool[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    for (const item of server.tools) {
      const name = toolName(server, item);
      if (item.risk !== "low") {
        tools.push({ name, description: `外部 MCP 高风险工具（需人工确认）：${server.name}/${item.name}`,
          riskLevel: "high" });
        continue;
      }
      tools.push({
        name,
        description: `外部 MCP 只读工具：${server.name}/${item.name}`,
        riskLevel: "low",
        inputSchema: z.record(z.string(), z.unknown()),
        execute: async (input) => caller.call(server, item.name, (input ?? {}) as Record<string, unknown>),
      });
    }
  }
  return tools;
};

/** 查找配置中的外部工具；未配置返回 undefined */
export const findUpstreamTool = (
  servers: readonly UpstreamServerConfig[], serverName: string, name: string,
): { server: UpstreamServerConfig; tool: UpstreamToolConfig } | undefined => {
  const server = servers.find(item => item.name === serverName && item.enabled);
  const tool = server?.tools.find(item => item.name === name);
  return server && tool ? { server, tool } : undefined;
};

/**
 * N-07：管理员调用通道。高风险工具生产待确认工单并返回工单号，确认前不执行；
 * 低风险工具直接调用。参数只以脱敏摘要进入工单，不落凭证。
 */
export const requestUpstreamToolCall = async (
  client: ApprovalCreator,
  servers: readonly UpstreamServerConfig[],
  body: { server: string; tool: string; arguments?: Record<string, unknown> },
  traceId: TraceId,
  caller: UpstreamCaller = sdkUpstreamCaller,
): Promise<{ status: "executed"; result: unknown } | { status: "approval_required"; case_id: number }> => {
  const found = findUpstreamTool(servers, body.server, body.tool);
  if (!found) throw new Error("未配置的外部 MCP 工具");
  const args = body.arguments ?? {};
  const summary = buildSummary(JSON.stringify({ server: body.server, tool: body.tool, args }), 400);
  if (found.tool.risk === "low") {
    return { status: "executed", result: await caller.call(found.server, found.tool.name, args) };
  }
  const approval = await client.createApproval({
    action_type: "call_mcp_tool",
    risk_level: "high",
    payload_snapshot: summary,
    target_type: "mcp_tool",
    reason: `外部 MCP 高风险工具调用：${body.server}/${body.tool}`,
  }, traceId);
  return { status: "approval_required", case_id: approval.id };
};
