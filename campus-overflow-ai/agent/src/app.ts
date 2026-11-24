// 应用只装配路由和必经的用户认证；用户客户端与工具均按请求创建。
import { Hono } from "hono";

import { userRequestContext, type AgentEnvironment } from "./auth/request-context.js";
import { defaultInternalClient } from "./internal-client.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerUpstreamMcpRoutes } from "./routes/mcp-upstream.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerPatrolConsolidationRoute } from "./routes/patrol-consolidation.js";
import { registerPatrolFullScanRoutes } from "./routes/patrol-full-scan.js";
import { registerPatrolInjectionRoute } from "./routes/patrol-injection.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerPoolRoutes } from "./routes/pool-admin.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSharedContextRoutes } from "./routes/shared-context.js";
import { registerSnapshotAdminRoutes } from "./routes/snapshot-admin.js";
import { createGovernanceAdmission, createQaAdmission, createSlotLeaseClient, createSlotQueueClient } from "./backend-lease.js";
import { AgentPool } from "./runtime/agent-pool.js";
import type { AgentApp, AppDependencies } from "./routes/support.js";

export type { AppDependencies } from "./routes/support.js";

export const healthPayload = () => ({
  code: 200, data: { status: "up", service: "agent" }, message: "ok",
});

export const createApp = (deps: AppDependencies = {}): AgentApp => {
  const app = new Hono<AgentEnvironment>();
  // 每应用一个池；SSE 与结构化任务共享同一组槽位
  const pool = deps.pool ?? new AgentPool();
  // P0-1：配置了全局治理容量时，先向后端申请跨实例租约，再进入本地槽位队列
  const governanceLimit = Number(process.env.AGENT_GLOBAL_GOVERNANCE_LIMIT ?? "0");
  if (!deps.pool && Number.isInteger(governanceLimit) && governanceLimit > 0) {
    pool.setAdmission(createGovernanceAdmission(
      createSlotLeaseClient(), governanceLimit, pool.instanceId,
    ));
  }
  // P0-5：配置了全局问答容量时，超限任务进入后端队列等待，而不是立即繁忙
  const qaLimit = Number(process.env.AGENT_GLOBAL_QA_LIMIT ?? "0");
  if (!deps.pool && Number.isInteger(qaLimit) && qaLimit > 0) {
    const waitMs = Number(process.env.AGENT_QA_QUEUE_WAIT_MS ?? "120000");
    pool.setQaAdmission(createQaAdmission(
      createSlotQueueClient(), createSlotLeaseClient(), qaLimit, pool.instanceId,
      { maxWaitMs: Number.isInteger(waitMs) && waitMs > 0 ? waitMs : undefined },
    ));
  }
  // 探针在认证中间件前注册，不依赖数据库、登录态或模型服务。
  app.get("/health", (c) => c.json(healthPayload()));
  app.get("/agent/health", (c) => c.json(healthPayload()));
  app.use("/agent/*", userRequestContext(deps.createClient ?? defaultInternalClient));
  registerApprovalRoutes(app);
  registerPatrolConsolidationRoute(app);
  registerPatrolFullScanRoutes(app);
  registerPatrolInjectionRoute(app);
  registerSessionRoutes(app);
  registerSharedContextRoutes(app);
  registerSnapshotAdminRoutes(app);
  registerChatRoute(app, { ...deps, pool });
  registerMemoryRoutes(app, deps);
  registerUpstreamMcpRoutes(app);
  registerTaskRoutes(app, { ...deps, pool });
  registerPoolRoutes(app, pool);
  return app;
};
