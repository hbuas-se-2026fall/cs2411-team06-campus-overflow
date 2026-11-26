// 健康检查 Route Handler：聚合探测业务后端与 Agent 服务（对应 T-01 完成判定"三服务 /health 互通"）
// 任一下游服务不可用时不抛错，降级返回 down（对应 spec X-02：AI 服务不可用不影响基础功能）
export const dynamic = "force-dynamic";

const checkService = async (url: string): Promise<string> => {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok ? "up" : "degraded";
  } catch {
    return "down";
  }
};

export async function GET(): Promise<Response> {
  const backendOrigin = (process.env.BACKEND_ORIGIN ?? "http://localhost:8000").replace(/\/$/, "");
  const agentOrigin = (process.env.AGENT_ORIGIN ?? "http://localhost:8787").replace(/\/$/, "");
  const [backend, agent] = await Promise.all([
    checkService(`${backendOrigin}/api/health`),
    checkService(`${agentOrigin}/agent/health`),
  ]);

  return Response.json({
    code: 200,
    data: { frontend: "up", backend, agent },
    message: "ok",
  });
}
