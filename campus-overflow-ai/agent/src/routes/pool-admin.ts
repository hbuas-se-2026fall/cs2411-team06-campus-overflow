// 运行池只读状态与管理员操作（SA-04/SA-05）：不返回对话正文与凭证。
import type { Context } from "hono";

import type { AgentEnvironment } from "../auth/request-context.js";
import type { AgentPool } from "../runtime/agent-pool.js";
import type { AgentApp } from "./support.js";

/** 让位与终止写入脱敏审计摘要；当前落结构化日志，后端持久化待后续接口。 */
const auditPoolAction = (
  action: "drain" | "terminate", slotId: string, userId: number,
  traceId: string, instanceId: string,
): string => {
  const summary = `管理员 #${userId} 对槽位 ${slotId} 执行${action === "drain" ? "让位" : "终止"}`;
  console.info(JSON.stringify({
    event: "agent_pool_admin_action", action, slot_id: slotId,
    actor_user_id: userId, trace_id: traceId, instance_id: instanceId,
    summary, at: new Date().toISOString(),
  }));
  return summary;
};

const rejectNonAdmin = (c: Context<AgentEnvironment>): Response | null => {
  const principal = c.get("principal");
  if (principal.role === "admin" && principal.status === "active") return null;
  return c.json({ code: 403, data: null, message: "仅管理员可管理运行池" }, 403);
};

export const registerPoolRoutes = (app: AgentApp, pool: AgentPool): void => {
  app.get("/internal/agent/agent-pool/status", (c) => {
    const configured = process.env.AGENT_SERVICE_TOKEN?.trim();
    const provided = c.req.header("x-service-token")?.trim();
    if (!configured || !provided || provided !== configured) {
      return c.json({ code: 401, data: null, message: "服务鉴权失败" }, 401);
    }
    return c.json({ code: 200, data: pool.snapshot(), message: "ok" });
  });

  app.get("/agent/admin/pool", (c) => {
    const principal = c.get("principal");
    if (principal.role !== "admin" || principal.status !== "active") {
      return c.json({ code: 403, data: null, message: "仅管理员可查看运行池" }, 403);
    }
    return c.json({ code: 200, data: pool.snapshot(), message: "ok" });
  });

  app.post("/agent/admin/pool/:slot_id/drain", (c) => {
    const rejected = rejectNonAdmin(c);
    if (rejected) return rejected;
    const slotId = c.req.param("slot_id");
    if (!pool.scheduler.drain(slotId)) {
      return c.json({ code: 409, data: null, message: "槽位不可让位：仅运行中的支援问答槽" }, 409);
    }
    const summary = auditPoolAction("drain", slotId, c.get("principal").user_id,
      c.get("traceId"), pool.instanceId);
    return c.json({ code: 200, data: { slot_id: slotId, action: "drain", accepted: true, audit_summary: summary }, message: "已请求让位" });
  });

  app.post("/agent/admin/pool/:slot_id/terminate", (c) => {
    const rejected = rejectNonAdmin(c);
    if (rejected) return rejected;
    const slotId = c.req.param("slot_id");
    if (!pool.scheduler.terminate(slotId)) {
      return c.json({ code: 409, data: null, message: "槽位不可终止：当前没有运行中的任务" }, 409);
    }
    const summary = auditPoolAction("terminate", slotId, c.get("principal").user_id,
      c.get("traceId"), pool.instanceId);
    return c.json({ code: 200, data: { slot_id: slotId, action: "terminate", accepted: true, audit_summary: summary }, message: "已终止后续调用" });
  });
};
