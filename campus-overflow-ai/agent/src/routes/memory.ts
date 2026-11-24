// 个人记忆建议路由（T-14 M-03，AG-R04）：只返回候选，不写后端、不落审计。
// 前端仅在用户开启“AI 自动更新记忆”时调用；写入仍由浏览器同源敏感过滤后执行。
import {
  MemorySuggestionInputSchema,
  suggestPersonalMemoryUpdates,
} from "../memory/personal-memory.js";
import { resolveModel, toErrorResponse, type AgentApp, type AppDependencies } from "./support.js";

export const registerMemoryRoutes = (app: AgentApp, deps: AppDependencies): void => {
  app.post("/agent/memory/suggestions", async (c) => {
    const parsed = MemorySuggestionInputSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: 400, data: null, message: "请求体需包含 message 与 answer" }, 400);
    }
    try {
      const result = await suggestPersonalMemoryUpdates(parsed.data, resolveModel(deps), {
        signal: c.get("runControl").signal,
      });
      return c.json({ code: 200, data: result, message: "ok" });
    } catch (error) {
      const mapped = toErrorResponse(error);
      return c.json({ code: mapped.status, data: null, message: mapped.message }, mapped.status);
    }
  });
};
