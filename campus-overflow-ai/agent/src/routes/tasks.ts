import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";

import { dispatchTask } from "../tasks/index.js";
import { runReviewed } from "../loop/reviewed-run.js";
import { PersistentRunAudit } from "../observability/persistent-audit.js";
import type { RunContext } from "../observability/run-context.js";
import { PoolBusyError } from "../orchestrator/scheduler.js";
import { slotKindForTask } from "../runtime/agent-pool.js";
import { TaskTypeSchema } from "../types/index.js";
import { resolveModel, toErrorResponse, type AgentApp, type AppDependencies } from "./support.js";

const BUSY_MESSAGE = "Agent 服务繁忙，请稍后重试";

type TaskOutcome =
  | { data: unknown }
  | { failure: ReturnType<typeof toErrorResponse>; run: RunContext };

export const registerTaskRoutes = (app: AgentApp, deps: AppDependencies): void => {
  app.post("/agent/tasks/:type", async (c) => {
    const typeParse = TaskTypeSchema.safeParse(c.req.param("type"));
    if (!typeParse.success) return c.json({ code: 400, data: null, message: "不支持的任务类型" }, 400);
    let model: LanguageModel;
    try {
      model = resolveModel(deps);
    } catch (error) {
      const mapped = toErrorResponse(error);
      return c.json({ code: mapped.status, data: null, message: mapped.message }, mapped.status);
    }
    const pool = deps.pool;
    if (!pool) return c.json({ code: 503, data: null, message: BUSY_MESSAGE }, 503);
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    const kind = slotKindForTask(typeParse.data);
    // trace id 可由调用方复用；追加随机后缀保证并发请求不撞 job_id
    const jobId = `task:${typeParse.data}:${c.get("traceId")}:${randomUUID()}`;

    try {
      return await pool.run(kind, jobId, async (lease) => {
        const control = c.get("runControl");
        control.start();
        try {
          const outcome = await pool.runner.run({
            jobId,
            actorKind: kind,
            taskType: typeParse.data,
            principal: c.get("principal"),
            // 同一请求的任务只属于一个客户端；跨任务不共享
            createClient: () => c.get("internalClient"),
            model,
            traceId: c.get("traceId"),
            signal: AbortSignal.any([control.signal, lease.signal]),
          }, lease, async ({ context, safePoint }): Promise<TaskOutcome> => {
            const audit = new PersistentRunAudit(context.client.audit, context.run, {
              actor_kind: context.actorKind,
              slot_kind: kind,
              slot_id: lease.slot_id,
            });
            try {
              // 让位只允许发生在审计创建之前：重排后重新建运行记录，不会重复写入已完成动作。
              safePoint();
              await audit.create();
              const data = await runReviewed({ kind: typeParse.data, input: rawBody, model, run: context.run,
                produce: (feedback) => dispatchTask(typeParse.data, rawBody, {
                  runContext: context.run, model, internalClient: context.client,
                  toolRegistry: context.tools, audit, feedback,
                }) });
              await audit.finish("succeeded");
              return { data };
            } catch (error) {
              return { failure: toErrorResponse(await audit.onFailure(error)), run: context.run };
            }
          });

          if ("failure" in outcome) {
            return c.json({ code: outcome.failure.status, data: null, message: outcome.failure.message,
              agent_run_id: outcome.run.agentRunId, trace_id: outcome.run.traceId }, outcome.failure.status);
          }
          return c.json({ code: 200, data: outcome.data, message: "ok" });
        } finally {
          control.dispose();
        }
      });
    } catch (error) {
      if (error instanceof PoolBusyError) {
        return c.json({ code: 503, data: null, message: BUSY_MESSAGE }, 503);
      }
      throw error;
    }
  });
};
