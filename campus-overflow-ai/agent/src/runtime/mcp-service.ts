import { createInternalClient, resolveInternalConfig } from "../internal-client.js";
import { consoleMcpCallAudit, createPersistedMcpCallAudit, type McpCallAudit } from "../mcp/audit.js";
import { startMcpHttpServer } from "../mcp/http.js";
import { loadMcpClients } from "../mcp/policy.js";
import { createTokenBucketRateLimiter, resolveRateLimitPerMinute } from "../mcp/rate-limit.js";
import { McpToolRegistry } from "../mcp/registry.js";
import { createMcpSessionFactory } from "../mcp/session.js";
import { ensureReadOnlyMcpTools } from "../mcp/tools.js";
import { ensureAdminMcpTools } from "../mcp/admin-tools.js";
import { ensurePrivateContextMcpTools } from "../mcp/private-contexts.js";
import { asTraceId } from "../types/index.js";

export const startMcpService = async (): Promise<() => void | Promise<void>> => {
  if (process.env.MCP_SERVER_ENABLED !== "true") return () => {};
  const clients = loadMcpClients(process.env.MCP_EXTERNAL_CLIENTS);
  const rateLimiter = createTokenBucketRateLimiter(
    resolveRateLimitPerMinute(process.env.MCP_RATE_LIMIT_PER_MINUTE),
  );
  const registry = new McpToolRegistry();
  const readonlyClient = createInternalClient({ ...resolveInternalConfig(), fetchImpl: fetch });
  ensureReadOnlyMcpTools(registry, readonlyClient);
  const externalClient = (name: string) => {
    const client = clients.find(item => item.name === name);
    if (!client) throw new Error("外部客户端已撤销");
    // 外部密钥与 MCP 凭证分离：轮换主/备 token 不需要改后端管理员密钥映射
    return createInternalClient({ ...resolveInternalConfig(), externalKey: client.externalKey, fetchImpl: fetch });
  };
  ensureAdminMcpTools(registry, externalClient);
  ensurePrivateContextMcpTools(registry, externalClient);
  // N-04：默认持久化调用审计；可用 MCP_AUDIT_PERSIST_ENABLED=false 退回结构化日志
  const audit: McpCallAudit = process.env.MCP_AUDIT_PERSIST_ENABLED === "false"
    ? consoleMcpCallAudit()
    : createPersistedMcpCallAudit(readonlyClient);
  try {
    const handle = await startMcpHttpServer({
      clients,
      sessionFactory: createMcpSessionFactory({ registry, audit, authorize: async principal => {
        if (!principal.scopes.some(scope => scope.startsWith("admin:"))) return;
        const client = clients.find(item => item.name === principal.name);
        if (!client) throw new Error("外部客户端已撤销");
        await externalClient(client.name).resolvePrincipal(asTraceId(`mcp-auth-${crypto.randomUUID()}`));
      } }),
      audit,
      rateLimiter,
    }, Number(process.env.MCP_PORT ?? 8790));
    console.log(`mcp server listening on http://localhost:${handle.port}/mcp`);
    return handle.close;
  } catch (error) {
    console.error(JSON.stringify({ event: "mcp_server_start_failed", reason: error instanceof Error ? error.name : "unknown" }));
    return () => {};
  }
};
