/**
 * OpenAI 兼容 rerank provider：默认关闭；错误信息不含 query、正文与 API Key。
 * 依据 D-033：复用现有 OpenAI 兼容 /rerank 服务，不在本地新增模型运行时。
 */

import type { RerankProvider, RerankResult } from "./types.js";

export interface OpenAICompatibleRerankOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时，默认 15 秒 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RerankEnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 融合去重后进入精排的候选数 */
  candidateLimit: number;
  /** 精排最低分 */
  minScore: number;
  /** 最终证据总字符预算 */
  maxTotalChars: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const assertPositiveInteger = (value: number, name: string, max: number): number => {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} 必须是 1～${max} 的整数`);
  }
  return value;
};

const parseRerankResponse = (
  payload: unknown,
  documentCount: number,
  topN: number,
): RerankResult[] => {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error("rerank 服务响应格式不正确");
  }
  const seen = new Set<number>();
  const results = payload.results.map((item) => {
    if (!isRecord(item)) throw new Error("rerank 服务响应格式不正确");
    const index = item.index;
    if (typeof index !== "number" || !Number.isInteger(index)
      || index < 0 || index >= documentCount) {
      throw new Error("rerank 服务返回越界索引");
    }
    if (seen.has(index)) throw new Error("rerank 服务返回重复索引");
    seen.add(index);
    const score = item.relevance_score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error("rerank 服务返回非数值分数");
    }
    return { index, score };
  });
  return results
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, topN);
};

export const createOpenAICompatibleRerankProvider = (
  options: OpenAICompatibleRerankOptions,
): RerankProvider => {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("rerank 配置不完整：baseUrl、apiKey、model 均不能为空");
  }
  const timeoutMs = assertPositiveInteger(options.timeoutMs ?? 15_000, "rerank 超时", 120_000);
  const fetchImpl = options.fetchImpl ?? fetch;

  const rerank = async (
    query: string,
    documents: readonly string[],
    runtimeOptions: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<RerankResult[]> => {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("rerank 查询不能为空");
    if (documents.length === 0) return [];
    const topN = Math.min(runtimeOptions.topN ?? documents.length, documents.length);
    if (!Number.isInteger(topN) || topN < 1) {
      throw new Error("rerank topN 必须是正整数");
    }
    if (runtimeOptions.signal?.aborted) throw new Error("rerank 请求已取消");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    runtimeOptions.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(`${baseUrl}/rerank`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          query: trimmed,
          documents: [...documents],
          top_n: topN,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`rerank 服务返回 HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("rerank 服务响应格式不正确");
      }
      return parseRerankResponse(payload, documents.length, topN);
    } catch (error) {
      if (runtimeOptions.signal?.aborted) throw new Error("rerank 请求已取消");
      if (controller.signal.aborted) throw new Error("rerank 请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
      runtimeOptions.signal?.removeEventListener("abort", onAbort);
    }
  };

  return { model, rerank };
};

const firstNonEmpty = (
  primary: string | undefined,
  fallback: string | undefined,
): string | undefined => {
  const preferred = primary?.trim();
  return preferred ? preferred : fallback?.trim();
};

const parseEnvInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}～${max} 的整数`);
  }
  return parsed;
};

const parseEnvNumber = (
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}～${max} 的数值`);
  }
  return parsed;
};

/**
 * 默认关闭：RAG_ENABLED 与 RAG_RERANK_ENABLED 同时为 "true" 才返回配置。
 * 地址与密钥可回退到 embedding 配置，模型必须显式指定。
 */
export const resolveRerankConfig = (
  env: NodeJS.ProcessEnv = process.env,
): RerankEnvConfig | null => {
  if (env.RAG_ENABLED !== "true" || env.RAG_RERANK_ENABLED !== "true") return null;
  const baseUrl = firstNonEmpty(env.RAG_RERANK_BASE_URL, env.RAG_EMBEDDING_BASE_URL);
  const apiKey = firstNonEmpty(env.RAG_RERANK_API_KEY, env.RAG_EMBEDDING_API_KEY);
  const model = env.RAG_RERANK_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "RAG rerank 配置不完整：需要 RAG_RERANK_MODEL，以及 RAG_RERANK_BASE_URL/API_KEY 或对应 embedding 配置",
    );
  }
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: parseEnvInteger(
      env.RAG_RERANK_TIMEOUT_MS, 15_000, "RAG_RERANK_TIMEOUT_MS", 1_000, 60_000,
    ),
    candidateLimit: parseEnvInteger(
      env.RAG_RERANK_CANDIDATES, 5, "RAG_RERANK_CANDIDATES", 1, 20,
    ),
    minScore: parseEnvNumber(
      env.RAG_RERANK_MIN_SCORE, 0, "RAG_RERANK_MIN_SCORE", -1_000_000, 1_000_000,
    ),
    maxTotalChars: parseEnvInteger(
      env.RAG_CONTEXT_MAX_CHARS, 2400, "RAG_CONTEXT_MAX_CHARS", 200, 20_000,
    ),
  };
};
