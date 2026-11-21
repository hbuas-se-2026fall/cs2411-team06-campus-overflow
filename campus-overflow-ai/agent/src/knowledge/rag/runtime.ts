/**
 * 课程级 RAG 运行时：按知识目录版本与 embedding 配置缓存索引。
 * 默认关闭；构建失败只记录脱敏摘要，不阻断在线问答。
 */

import type { KnowledgeCatalog } from "../catalog.js";
import { getKnowledgeCatalog } from "../runtime.js";
import { collectCatalogChunks } from "./catalog-source.js";
import {
  createOpenAICompatibleEmbeddingProvider,
  resolveEmbeddingConfig,
  type EmbeddingEnvConfig,
} from "./embedding.js";
import { RagIndex } from "./index.js";
import {
  createOpenAICompatibleRerankProvider,
  resolveRerankConfig,
  type RerankEnvConfig,
} from "./rerank.js";
import type { EmbeddingProvider, RerankProvider } from "./types.js";

export interface RagRuntimeDependencies {
  getCatalog: () => KnowledgeCatalog | undefined;
  resolveConfig?: () => EmbeddingEnvConfig | null;
  createEmbedder?: (config: EmbeddingEnvConfig) => EmbeddingProvider;
  resolveRerank?: () => RerankEnvConfig | null;
  createReranker?: (config: RerankEnvConfig) => RerankProvider;
  enabled?: () => boolean;
}

export interface RagRuntime {
  getIndex: (courseId: number) => Promise<RagIndex | undefined>;
  reset: () => void;
}

interface CacheEntry {
  key: string;
  index: RagIndex;
}

const sanitizeReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 200);
};

export const createRagRuntime = (dependencies: RagRuntimeDependencies): RagRuntime => {
  const cache = new Map<number, CacheEntry>();
  const building = new Map<number, Promise<RagIndex | undefined>>();
  const enabled = dependencies.enabled ?? (() => process.env.RAG_ENABLED === "true");
  const resolveConfig = dependencies.resolveConfig ?? resolveEmbeddingConfig;
  const createEmbedder = dependencies.createEmbedder
    ?? ((config: EmbeddingEnvConfig) => createOpenAICompatibleEmbeddingProvider(config));
  const resolveRerank = dependencies.resolveRerank ?? resolveRerankConfig;
  const createReranker = dependencies.createReranker
    ?? ((config: RerankEnvConfig) => createOpenAICompatibleRerankProvider(config));
  let rerankResolved = false;
  let rerankConfig: RerankEnvConfig | null = null;

  // 重排配置无效只降级为“无重排”，不能让整个索引构建失败。
  const resolveRerankOnce = (): RerankEnvConfig | null => {
    if (rerankResolved) return rerankConfig;
    rerankResolved = true;
    try {
      rerankConfig = resolveRerank();
    } catch (error) {
      console.error(JSON.stringify({
        event: "rag_rerank_config_invalid",
        reason: sanitizeReason(error),
      }));
      rerankConfig = null;
    }
    return rerankConfig;
  };

  const buildReranker = (config: RerankEnvConfig | null): RerankProvider | undefined => {
    if (!config) return undefined;
    try {
      return createReranker(config);
    } catch (error) {
      console.error(JSON.stringify({
        event: "rag_rerank_config_invalid",
        reason: sanitizeReason(error),
      }));
      return undefined;
    }
  };

  const getIndex = async (courseId: number): Promise<RagIndex | undefined> => {
    if (!enabled()) return undefined;
    const prepared = await (async () => {
      try {
        const catalog = dependencies.getCatalog();
        if (!catalog) return undefined;
        await catalog.refresh();
        const summary = catalog.list([courseId]);
        const config = resolveConfig();
        if (!config) return undefined;
        return { catalog, summary, config, rerank: resolveRerankOnce() };
      } catch (error) {
        console.error(JSON.stringify({
          event: "rag_index_prepare_failed",
          course_id: courseId,
          reason: sanitizeReason(error),
        }));
        return undefined;
      }
    })();
    if (!prepared) return undefined;
    const { catalog, summary, config, rerank } = prepared;
    const rerankKey = rerank
      ? `${rerank.model}|${rerank.candidateLimit}|${rerank.minScore}|${rerank.maxTotalChars}`
      : "off";
    const cacheKey = `${summary.version}|${config.model}|${config.baseUrl}|rerank:${rerankKey}`;
    const cached = cache.get(courseId);
    if (cached?.key === cacheKey) return cached.index;

    const pending = building.get(courseId);
    if (pending) return pending;

    const task = (async (): Promise<RagIndex | undefined> => {
      try {
        const chunks = await collectCatalogChunks(catalog, [courseId]);
        if (chunks.length === 0) return undefined;
        const reranker = buildReranker(rerank);
        const index = await RagIndex.build({
          chunks,
          embedder: createEmbedder(config),
          ...(reranker && rerank ? {
            reranker,
            candidateLimit: rerank.candidateLimit,
            minRerankScore: rerank.minScore,
            maxTotalChars: rerank.maxTotalChars,
          } : {}),
        });
        cache.set(courseId, { key: cacheKey, index });
        return index;
      } catch (error) {
        console.error(JSON.stringify({
          event: "rag_index_build_failed",
          course_id: courseId,
          reason: sanitizeReason(error),
        }));
        return undefined;
      } finally {
        building.delete(courseId);
      }
    })();
    building.set(courseId, task);
    return task;
  };

  return {
    getIndex,
    reset: () => {
      cache.clear();
      building.clear();
      rerankResolved = false;
      rerankConfig = null;
    },
  };
};

export const ragRuntime = createRagRuntime({ getCatalog: getKnowledgeCatalog });
