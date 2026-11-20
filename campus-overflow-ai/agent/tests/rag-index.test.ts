// RAG 检索主干：稠密 + BM25 + RRF，课程过滤与参数校验。
import { describe, expect, it } from "vitest";

import { createHashEmbeddingProvider } from "../src/knowledge/rag/embedding.js";
import { RagIndex } from "../src/knowledge/rag/index.js";
import type { RagChunk, RerankProvider } from "../src/knowledge/rag/types.js";

const chunks: RagChunk[] = [
  {
    id: "db#deadlock", cardId: "db", courseId: 1, kind: "body", title: "数据库",
    text: "死锁检测与预防：按固定顺序加锁，必要时回滚事务。",
  },
  {
    id: "db#acid", cardId: "db", courseId: 1, kind: "summary", title: "数据库",
    text: "事务的 ACID 特性包括原子性、一致性、隔离性与持久性。",
  },
  {
    id: "os#schedule", cardId: "os", courseId: 2, kind: "body", title: "操作系统",
    text: "进程调度算法包括先来先服务、短作业优先与时间片轮转。",
  },
  {
    id: "api#quota", cardId: "api", courseId: 1, kind: "body", title: "接口规范",
    text: "错误码 ERR_QUOTA_429 表示配额超限，请稍后重试。",
  },
];

const buildIndex = async (): Promise<RagIndex> => RagIndex.build({
  chunks,
  embedder: createHashEmbeddingProvider({ dimensions: 128 }),
  hnsw: { efSearch: 64, seed: 3 },
});

describe("RAG 检索", () => {
  it("关键词与稠密召回经 RRF 返回相关片段", async () => {
    const index = await buildIndex();
    const result = await index.search("死锁", { topK: 2 });
    expect(result.hits[0].chunkId).toBe("db#deadlock");
    expect(result.hits[0].keywordRank).toBe(1);
    expect(result.hits[0].denseRank).toBeGreaterThan(0);
    expect(result.diagnostics.fusedCandidates).toBeGreaterThan(0);
    expect(result.hits[0].score).toBeCloseTo(1 / 61 + 1 / 61, 6);
  });

  it("精确错误码优先命中", async () => {
    const index = await buildIndex();
    const result = await index.search("ERR_QUOTA_429", { topK: 1 });
    expect(result.hits[0]?.chunkId).toBe("api#quota");
  });

  it("课程过滤后只返回该课程片段", async () => {
    const index = await buildIndex();
    const result = await index.search("死锁", { courseId: 2, topK: 5, topN: 10 });
    expect(result.hits.every(hit => hit.courseId === 2)).toBe(true);
  });

  it("默认 topN 加课程过滤时自动放大 efSearch", async () => {
    const index = await buildIndex();
    const result = await index.search("死锁", { courseId: 1, topN: 20, topK: 3 });
    expect(result.hits.every(hit => hit.courseId === 1)).toBe(true);
  });

  it("拒绝空查询、重复 id 与非法返回条数", async () => {
    await expect(RagIndex.build({
      chunks: [chunks[0], chunks[0]],
      embedder: createHashEmbeddingProvider(),
    })).rejects.toThrow("id 重复");
    const index = await buildIndex();
    await expect(index.search("  ")).rejects.toThrow("不能为空");
    await expect(index.search("死锁", { topN: 2, topK: 3 })).rejects.toThrow("topK");
  });
});

const rerankerWith = (
  score: (text: string, index: number) => number,
): RerankProvider => ({
  model: "fake-reranker",
  rerank: async (_query, documents) => documents.map((text, index) => ({
    index, score: score(text, index),
  })),
});

describe("RAG 重排与重排后选择", () => {
  it("按精排分重排，并保留 RRF 分用于诊断", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      hnsw: { efSearch: 64, seed: 3 },
      reranker: rerankerWith((text) => {
        if (text.includes("错误码")) return 0.95;
        if (text.includes("调度")) return 0.6;
        if (text.includes("死锁")) return 0.3;
        return 0.1;
      }),
    });

    const result = await index.search("死锁 错误码 调度 事务", { topN: 20, topK: 2 });

    expect(result.hits.map(hit => hit.chunkId)).toEqual(["api#quota", "os#schedule"]);
    expect(result.hits[0]?.score).toBe(0.95);
    expect(result.hits[0]?.rerankScore).toBe(0.95);
    expect(result.hits[0]?.rrfScore).toBeGreaterThan(0);
    expect(result.diagnostics).toMatchObject({
      rerankApplied: true,
      rerankCandidates: 3,
      rerankDropped: 0,
    });
  });

  it("低于阈值的候选被丢弃，不足条数不强凑", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: rerankerWith(text => text.includes("错误码") ? 0.9 : -0.2),
    });

    const result = await index.search("死锁 错误码 调度 事务", { topK: 3, minRerankScore: 0 });

    expect(result.hits.map(hit => hit.chunkId)).toEqual(["api#quota"]);
    expect(result.diagnostics.rerankDropped).toBe(2);
  });

  it("全部低于阈值时返回空结果", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: rerankerWith(() => -1),
    });

    const result = await index.search("死锁 错误码 调度 事务", { topK: 3, minRerankScore: 0 });

    expect(result.hits).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      rerankApplied: true,
      rerankDropped: 3,
      contextChars: 0,
    });
  });

  it("默认同一卡片只占一个候选名额", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: rerankerWith(() => 0.5),
    });

    const result = await index.search("死锁 事务", { topK: 4 });

    expect(new Set(result.hits.map(hit => hit.cardId)).size).toBe(result.hits.length);
    expect(result.diagnostics.cardCandidates).toBe(3);
    expect(result.diagnostics.cardCandidates).toBeLessThan(result.diagnostics.fusedCandidates);
  });

  it("重排失败时回退 RRF 顺序并记录脱敏错误", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: {
        model: "broken",
        rerank: async () => {
          throw new Error("rerank 服务返回 HTTP 500");
        },
      },
    });

    const result = await index.search("死锁", { topK: 2 });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.chunkId).toBe("db#deadlock");
    expect(result.hits.every(hit => hit.rerankScore === undefined)).toBe(true);
    expect(result.hits[0]?.score).toBe(result.hits[0]?.rrfScore);
    expect(result.diagnostics).toMatchObject({
      rerankApplied: false,
      rerankError: "http_500",
    });
  });

  it("调用方取消时抛出取消错误，不降级", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: rerankerWith(() => 1),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(index.search("死锁", { signal: controller.signal }))
      .rejects.toThrow("检索已取消");
  });

  it("candidateLimit 限制进入重排的候选数", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: rerankerWith(() => 1),
      candidateLimit: 2,
    });

    const result = await index.search("死锁 错误码 调度 事务", { topK: 2 });

    expect(result.diagnostics.rerankCandidates).toBe(2);
    expect(result.hits).toHaveLength(2);
  });

  it("超出总字符预算时截断最后一条", async () => {
    const longChunks: RagChunk[] = [{
      id: "long#1", cardId: "long", courseId: 1, kind: "body", text: "长".repeat(500),
    }];
    const index = await RagIndex.build({
      chunks: longChunks,
      embedder: createHashEmbeddingProvider({ dimensions: 64 }),
    });

    const result = await index.search("长", { topK: 1, maxTotalChars: 300 });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.text).toHaveLength(300);
    expect(result.diagnostics.contextChars).toBe(300);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it("剩余预算不足 200 字时丢弃该条", async () => {
    const longChunks: RagChunk[] = [{
      id: "long#1", cardId: "long", courseId: 1, kind: "body", text: "长".repeat(500),
    }];
    const index = await RagIndex.build({
      chunks: longChunks,
      embedder: createHashEmbeddingProvider({ dimensions: 64 }),
    });

    const result = await index.search("长", { topK: 1, maxTotalChars: 100 });

    expect(result.hits).toEqual([]);
    expect(result.diagnostics.truncated).toBe(true);
  });
});
