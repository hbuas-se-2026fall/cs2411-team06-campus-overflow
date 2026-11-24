// 运行配置读取（SA-07C / ADR-010）：后端全局开关，30s TTL 缓存。
// 读取失败不阻塞任务：沿用最后一次有效值，无缓存时按默认关闭处理。
import { z } from "zod";

import { resolveInternalConfig } from "./internal-client.js";
import { withUpstreamDeadline } from "./loop/abort.js";

const EnvelopeSchema = z.object({
  code: z.literal(200),
  data: z.unknown(),
  message: z.string(),
});
const RuntimeConfigSchema = z.object({ plan_parallel_enabled: z.boolean() });

/** 配置刷新周期：开关变更最迟在下一次刷新后生效（ADR-010）。 */
export const RUNTIME_CONFIG_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

let cache: CacheEntry | undefined;
let inflight: Promise<boolean> | undefined;
/** 测试可注入与业务相同的请求实现；未注入时动态使用全局 fetch（兼容 vi.stubGlobal） */
let configFetch: typeof fetch | undefined;

/** 仅供测试注入 fetch 并清空缓存，避免真实网络或假定时器干扰。 */
export const setRuntimeConfigFetchForTests = (impl: typeof fetch | undefined): void => {
  configFetch = impl;
  resetRuntimeConfigCache();
};

/** 仅供测试重置模块级缓存。 */
export const resetRuntimeConfigCache = (): void => {
  cache = undefined;
  inflight = undefined;
};

const requestPlanParallel = async (traceId: string): Promise<boolean> => {
  const { baseUrl, token } = resolveInternalConfig();
  return withUpstreamDeadline(undefined, async (signal) => {
    const response = await (configFetch ?? fetch)(
      `${baseUrl.replace(/\/+$/, "")}/internal/agent/runtime-config`,
      {
        headers: { "X-Service-Token": token, "x-trace-id": traceId },
        signal,
        redirect: "error",
      },
    );
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`runtime config HTTP ${response.status}`);
    const envelope = EnvelopeSchema.safeParse(raw);
    const parsed = envelope.success
      ? RuntimeConfigSchema.safeParse(envelope.data.data)
      : undefined;
    if (!parsed?.success) throw new Error("runtime config response invalid");
    return parsed.data.plan_parallel_enabled;
  }, FETCH_TIMEOUT_MS);
};

/** 读取计划内并行开关；失败时返回缓存值或默认关闭，不向调用方抛错。 */
export const readPlanParallelEnabled = async (traceId: string): Promise<boolean> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  inflight ??= (async () => {
    let value = cache?.value ?? false;
    try {
      value = await requestPlanParallel(traceId);
    } catch {
      // 后端不可用或响应异常：保持默认/上次值，避免开关抖动影响任务执行
    }
    cache = { value, expiresAt: Date.now() + RUNTIME_CONFIG_TTL_MS };
    return value;
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
};
