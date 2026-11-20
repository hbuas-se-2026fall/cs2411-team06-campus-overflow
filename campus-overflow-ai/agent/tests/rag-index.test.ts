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
    const body = result.hits.find(hit => hit.chunkId === "db#deadlock");
    expect(result.hits[0]?.cardId).toBe("db");
    expect(result.hits[0]?.kind).toBe("summary");
    expect(body).toBeDefined();
    expect(body?.keywordRank).toBe(1);
    expect(body?.denseRank).toBeGreaterThan(0);
    expect(result.diagnostics.fusedCandidates).toBeGreaterThan(0);
    expect(result.diagnostics.expandedCandidates).toBe(0);
    expect(body?.score).toBeCloseTo(1 / 61 + 1 / 61, 6);
  });

  it("命中卡片同时返回摘要与定位到的正文（D-022）", async () => {
    const index = await buildIndex();
    const result = await index.search("死锁", { topK: 1 });

    expect(result.hits.map(hit => [hit.chunkId, hit.kind])).toEqual([
      ["db#acid", "summary"],
      ["db#deadlock", "body"],
    ]);
    expect(result.hits[0]?.score).toBe(result.hits[1]?.score);
  });

  it("摘要命中时展开该卡最相关的正文", async () => {
    const custom: RagChunk[] = [
      {
        id: "signal#summary", cardId: "signal", courseId: 1, kind: "summary", title: "信号量",
        text: "信号量用于并发控制。",
      },
      {
        id: "signal#body-0", cardId: "signal", courseId: 1, kind: "body", title: "信号量",
        text: "PV 操作与互斥。",
      },
      {
        id: "signal#body-1", cardId: "signal", courseId: 1, kind: "body", title: "信号量",
        text: "计数器表示可用资源数。",
      },
    ];
    const index = await RagIndex.build({
      chunks: custom,
      embedder: createHashEmbeddingProvider({ dimensions: 64 }),
    });

    const result = await index.search("信号量 PV", { topK: 1 });

    expect(result.hits.map(hit => hit.chunkId)).toEqual(["signal#summary", "signal#body-0"]);
  });

  it("按共享标签补 1 跳关联卡片并标记关系来源", async () => {
    const tagged: RagChunk[] = [
      {
        id: "a#summary", cardId: "a", courseId: 1, kind: "summary", title: "A",
        text: "alpha 摘要", tagIds: [7],
      },
      {
        id: "a#body-0", cardId: "a", courseId: 1, kind: "body", title: "A",
        text: "alpha 正文", tagIds: [7],
      },
      {
        id: "b#summary", cardId: "b", courseId: 1, kind: "summary", title: "B",
        text: "beta 摘要", tagIds: [7],
      },
      {
        id: "b#body-0", cardId: "b", courseId: 1, kind: "body", title: "B",
        text: "beta 正文", tagIds: [7],
      },
      {
        id: "c#summary", cardId: "c", courseId: 1, kind: "summary", title: "C",
        text: "gamma 摘要", tagIds: [8],
      },
    ];
    const index = await RagIndex.build({
      chunks: tagged,
      embedder: createHashEmbeddingProvider({ dimensions: 64 }),
    });

    const result = await index.search("alpha", { topK: 2, candidateLimit: 2 });

    expect(new Set(result.hits.map(hit => hit.cardId))).toEqual(new Set(["a", "b"]));
    expect(result.hits.filter(hit => hit.cardId === "a").every(hit =>
      hit.relation === undefined)).toBe(true);
    const related = result.hits.filter(hit => hit.cardId === "b");
    expect(related).toHaveLength(2);
    expect(related.every(hit => hit.relation?.type === "shared_tag")).toBe(true);
    expect(related[0]?.relation).toMatchObject({
      direction: "symmetric",
      source: "tag:7",
      seedCardId: "a",
      tagId: 7,
    });
    expect(result.diagnostics.expandedCandidates).toBe(1);
    expect(result.diagnostics.expandedHits).toBe(1);
  });

  it("多子问题分别检索后按卡片轮转合并", async () => {
    const index = await buildIndex();
    const result = await index.searchMany(["死锁", "ERR_QUOTA_429"], { topK: 2 });

    expect(result.diagnostics.subQueryCount).toBe(2);
    expect(result.diagnostics.subQueries.map(item => item.index)).toEqual([1, 2]);
    expect(result.diagnostics.subQueries.map(item => item.selectedCards)).toEqual([1, 1]);
    expect(result.diagnostics.subQueries[0]?.contextChars).toBeGreaterThan(0);
    expect(result.diagnostics.subQueries[1]?.contextChars).toBeGreaterThan(0);
    expect(result.diagnostics.subQueries.reduce((sum, item) => sum + item.contextChars, 0))
      .toBe(result.diagnostics.contextChars);
    expect([...new Set(result.hits.map(hit => hit.cardId))]).toEqual(["db", "api"]);
    expect(result.hits.filter(hit => hit.cardId === "db")).toHaveLength(2);
  });

  it("跨子问题重复卡片与片段只保留一次", async () => {
    const index = await buildIndex();
    const result = await index.searchMany(["死锁", "死锁 事务"], { topK: 3 });

    expect(result.hits.filter(hit => hit.cardId === "db")).toHaveLength(2);
    expect(new Set(result.hits.map(hit => hit.chunkId)).size).toBe(result.hits.length);
  });

  it("单问题委托单查询检索", async () => {
    const index = await buildIndex();
    const result = await index.searchMany(["死锁"], { topK: 1 });

    expect(result.diagnostics.subQueryCount).toBe(1);
    expect(result.diagnostics.subQueries).toHaveLength(1);
    expect(result.diagnostics.subQueries[0]).toMatchObject({ index: 1, selectedCards: 1 });
    expect(result.hits[0]?.cardId).toBe("db");
  });

  it("多子问题共享总字符预算", async () => {
    const longChunks: RagChunk[] = [
      {
        id: "a#summary", cardId: "a", courseId: 1, kind: "summary", title: "A",
        text: "A".repeat(100),
      },
      {
        id: "a#body-0", cardId: "a", courseId: 1, kind: "body", title: "A",
        text: "A".repeat(300),
      },
      {
        id: "b#summary", cardId: "b", courseId: 1, kind: "summary", title: "B",
        text: "B".repeat(100),
      },
      {
        id: "b#body-0", cardId: "b", courseId: 1, kind: "body", title: "B",
        text: "B".repeat(300),
      },
    ];
    const index = await RagIndex.build({
      chunks: longChunks,
      embedder: createHashEmbeddingProvider({ dimensions: 64 }),
    });

    const result = await index.searchMany(["A", "B"], { topK: 2, maxTotalChars: 250 });

    expect(result.diagnostics.contextChars).toBeLessThanOrEqual(250);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.subQueries).toHaveLength(2);
    expect(result.diagnostics.subQueries.some(item => item.truncated)).toBe(true);
    expect(result.diagnostics.subQueries.reduce((sum, item) => sum + item.contextChars, 0))
      .toBe(result.diagnostics.contextChars);
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

  it("默认同一卡片只占一个候选名额，但返回摘要与正文", async () => {
    const index = await RagIndex.build({
      chunks,
      embedder: createHashEmbeddingProvider({ dimensions: 128 }),
      reranker: rerankerWith(() => 0.5),
    });

    const result = await index.search("死锁 事务", { topK: 4 });

    const perCard = new Map<string, number>();
    for (const hit of result.hits) {
      perCard.set(hit.cardId, (perCard.get(hit.cardId) ?? 0) + 1);
    }
    expect(perCard.get("db")).toBe(2);
    expect([...perCard.values()].every(count => count <= 2)).toBe(true);
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
    const body = result.hits.find(hit => hit.chunkId === "db#deadlock");

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.kind).toBe("summary");
    expect(body).toBeDefined();
    expect(body?.score).toBe(body?.rrfScore);
    expect(result.hits.every(hit => hit.rerankScore === undefined)).toBe(true);
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
    expect(new Set(result.hits.map(hit => hit.cardId)).size).toBe(2);
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits.length).toBeLessThanOrEqual(4);
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
