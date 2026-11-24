// 外部 MCP Server 配置与高风险调用通道（T-17 N-06/N-07，US-18）。
// 只返回脱敏配置；高风险工具创建待确认工单，确认前不执行任何外部动作。
import type { Context } from "hono";
import { z } from "zod";

import type { AgentEnvironment } from "../auth/request-context.js";
import {
  requestUpstreamToolCall,
  upstreamServersFromEnv,
  type UpstreamServerConfig,
} from "../mcp/upstream.js";
import { toErrorResponse, type AgentApp } from "./support.js";

const UpstreamCallRequestSchema = z.object({
  server: z.string().min(1).max(40),
  tool: z.string().min(1).max(60),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

const rejectNonAdmin = (c: Context<AgentEnvironment>): Response | null => {
  const principal = c.get("principal");
  if (principal.role === "admin" && principal.status === "active") return null;
  return c.json({ code: 403, data: null, message: "仅管理员可管理外部 MCP" }, 403);
};

/** 隐藏 token，只暴露来源域名与工具风险状态 */
const publicServerView = (server: UpstreamServerConfig) => ({
  name: server.name,
  origin: (() => {
    try {
      return new URL(server.url).origin;
    } catch {
      return "";
    }
  })(),
  enabled: server.enabled,
  tools: server.tools.map(item => ({
    name: item.name,
    risk: item.risk,
    confirmed: item.confirmed,
    model_visible: item.risk === "low",
  })),
});

export const registerUpstreamMcpRoutes = (app: AgentApp): void => {
  app.get("/agent/admin/mcp/upstream", (c) => {
    const rejected = rejectNonAdmin(c);
    if (rejected) return rejected;
    try {
      return c.json({
        code: 200,
        data: { servers: upstreamServersFromEnv().map(publicServerView) },
        message: "ok",
      });
    } catch (error) {
      const mapped = toErrorResponse(error);
      return c.json({ code: mapped.status, data: null, message: mapped.message }, mapped.status);
    }
  });

  app.post("/agent/admin/mcp/upstream/call", async (c) => {
    const rejected = rejectNonAdmin(c);
    if (rejected) return rejected;
    const parsed = UpstreamCallRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ code: 400, data: null, message: "请求体需包含 server 与 tool" }, 400);
    }
    try {
      const servers = upstreamServersFromEnv();
      const found = servers
        .find(item => item.name === parsed.data.server && item.enabled)
        ?.tools.find(item => item.name === parsed.data.tool);
      if (!found) {
        return c.json({ code: 404, data: null, message: "未配置的外部 MCP 工具" }, 404);
      }
      // 高风险工具必须先在配置中人工确认启用，再按次生成待确认工单。
      if (found.risk !== "low" && !found.confirmed) {
        return c.json({
          code: 409, data: null,
          message: "该外部工具属高风险，需先由管理员在配置中确认启用",
        }, 409);
      }
      const result = await requestUpstreamToolCall(
        c.get("internalClient"), servers, parsed.data, c.get("traceId"),
      );
      return result.status === "approval_required"
        ? c.json({ code: 202, data: result, message: "已生成待确认工单" }, 202)
        : c.json({ code: 200, data: result, message: "ok" });
    } catch (error) {
      const mapped = toErrorResponse(error);
      return c.json({ code: mapped.status, data: null, message: mapped.message }, mapped.status);
    }
  });
};
