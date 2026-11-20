/** RAG 检索主干：HNSW 稠密召回 + BM25 关键词召回 + RRF 融合 + 可选精排。 */

import { Bm25Index } from "./bm25.js";
import { HnswIndex } from "./hnsw.js";
import { tokenize } from "./tokenize.js";
import type {
  EmbeddingProvider,
  RagChunk,
  RagHit,
  RagIndexOptions,
  RagSearchOptions,
  RagSearchResult,
  RerankProvider,
} from "./types.js";

const assertRange = (value: number, name: string, min: number, max: number): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}～${max} 的整数`);
  }
  return value;
};

const assertFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${name} 必须是有限数值`);
  return value;
};

/** 截断后剩余字符低于该值时不保留残片，避免把半句话当证据。 */
const MIN_TRUNCATED_CHARS = 200;

const classifyRerankError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = /HTTP (\d{3})/.exec(message)?.[1];
  if (httpStatus) return `http_${httpStatus}`;
  if (message.includes("超时")) return "timeout";
  if (message.includes("格式") || message.includes("索引") || message.includes("分数")) {
    return "invalid_response";
  }
  return "unknown";
};

interface FusedChunk {
  chunk: RagChunk;
  score: number;
  denseRank?: number;
  keywordRank?: number;
}

interface RankedChunk extends FusedChunk {
  rerankScore?: number;
}

export class RagIndex {
  private constructor(
    private readonly chunks: readonly RagChunk[],
    private readonly byId: ReadonlyMap<string, RagChunk>,
    private readonly byCard: ReadonlyMap<string, readonly RagChunk[]>,
    private readonly embedder: EmbeddingProvider,
    private readonly hnsw: HnswIndex,
    private readonly bm25: Bm25Index,
    private readonly rrfK: number,
    private readonly reranker: RerankProvider | undefined,
    private readonly candidateLimit: number,
    private readonly minRerankScore: number,
    private readonly maxChunksPerCard: number,
    private readonly maxTotalChars: number,
  ) {}

  static async build(options: RagIndexOptions): Promise<RagIndex> {
    if (options.chunks.length === 0) throw new Error("RAG 索引至少需要一个片段");
    const known = new Set<string>();
    for (const chunk of options.chunks) {
      if (!chunk.id.trim()) throw new Error("RAG 片段 id 不能为空");
      if (known.has(chunk.id)) throw new Error(`RAG 片段 id 重复：${chunk.id}`);
      known.add(chunk.id);
    }
    const vectors = await options.embedder.embed(
      options.chunks.map(chunk => `${chunk.title ?? ""}\n${chunk.text}`),
    );
    if (vectors.length !== options.chunks.length) {
      throw new Error("embedding 返回条数与片段数不一致");
    }
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions === 0) throw new Error("embedding 返回空向量");
    if (vectors.some(vector => vector.length !== dimensions)) {
      throw new Error("embedding 返回向量维度不一致");
    }
    const hnsw = new HnswIndex({ dimensions, ...options.hnsw });
    for (const vector of vectors) hnsw.add(vector);
    const bm25 = new Bm25Index(options.chunks.map(chunk => ({
      id: chunk.id,
      tokens: tokenize(`${chunk.title ?? ""} ${chunk.text}`),
    })));
    const rrfK = assertRange(options.rrfK ?? 60, "RRF k", 1, 1000);
    const candidateLimit = assertRange(options.candidateLimit ?? 5, "candidateLimit", 1, 50);
    const maxChunksPerCard = assertRange(options.maxChunksPerCard ?? 1, "maxChunksPerCard", 1, 10);
    const maxTotalChars = assertRange(options.maxTotalChars ?? 2400, "maxTotalChars", 1, 1_000_000);
    const minRerankScore = assertFinite(options.minRerankScore ?? 0, "minRerankScore");
    const byCard = new Map<string, RagChunk[]>();
    for (const chunk of options.chunks) {
      const cardChunks = byCard.get(chunk.cardId) ?? [];
      cardChunks.push(chunk);
      byCard.set(chunk.cardId, cardChunks);
    }
    return new RagIndex(
      options.chunks,
      new Map(options.chunks.map(chunk => [chunk.id, chunk])),
      byCard,
      options.embedder,
      hnsw,
      bm25,
      rrfK,
      options.reranker,
      candidateLimit,
      minRerankScore,
      maxChunksPerCard,
      maxTotalChars,
    );
  }

  get size(): number {
    return this.chunks.length;
  }

  async search(query: string, options: RagSearchOptions = {}): Promise<RagSearchResult> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("RAG 查询不能为空");
    const topN = options.topN ?? 20;
    const topK = options.topK ?? 5;
    assertRange(topN, "topN", 1, 1000);
    assertRange(topK, "topK", 1, topN);
    const candidateLimit = assertRange(
      options.candidateLimit ?? this.candidateLimit, "candidateLimit", 1, 50,
    );
    const maxChunksPerCard = assertRange(
      options.maxChunksPerCard ?? this.maxChunksPerCard, "maxChunksPerCard", 1, 10,
    );
    const maxTotalChars = assertRange(
      options.maxTotalChars ?? this.maxTotalChars, "maxTotalChars", 1, 1_000_000,
    );
    const minRerankScore = assertFinite(
      options.minRerankScore ?? this.minRerankScore, "minRerankScore",
    );

    // 课程过滤在召回后执行，先多取一些候选，避免过滤后不足 topN。
    const fetchSize = options.courseId
      ? Math.max(topN * 4, topN + 20)
      : Math.max(topN * 2, topN + 10);
    // 候选数可能超过默认 efSearch；至少按候选数探索，避免 HNSW 参数校验失败。
    const efSearch = Math.max(options.efSearch ?? 64, fetchSize);
    const [queryVector] = await this.embedder.embed([trimmed]);
    if (!queryVector) throw new Error("embedding 返回空查询向量");

    const denseChunks = this.hnsw.search(queryVector, fetchSize, efSearch)
      .map(hit => this.chunks[hit.id])
      .filter(chunk => !options.courseId || chunk.courseId === options.courseId)
      .slice(0, topN);

    const keywordChunks = this.bm25.search(tokenize(trimmed), fetchSize)
      .map(hit => this.byId.get(hit.id))
      .filter((chunk): chunk is RagChunk => {
        if (!chunk) return false;
        return !options.courseId || chunk.courseId === options.courseId;
      })
      .slice(0, topN);

    const fused = new Map<string, FusedChunk>();
    const addRank = (chunk: RagChunk, rank: number, channel: "dense" | "keyword"): void => {
      const current = fused.get(chunk.id) ?? { chunk, score: 0 };
      current.score += 1 / (this.rrfK + rank);
      if (channel === "dense") current.denseRank = rank;
      else current.keywordRank = rank;
      fused.set(chunk.id, current);
    };
    denseChunks.forEach((chunk, index) => addRank(chunk, index + 1, "dense"));
    keywordChunks.forEach((chunk, index) => addRank(chunk, index + 1, "keyword"));

    const ordered = [...fused.values()].sort((left, right) =>
      right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    const cardCandidates = new Set(ordered.map(item => item.chunk.cardId)).size;
    const candidates = this.pickCandidates(ordered, candidateLimit, maxChunksPerCard);

    let ranked: RankedChunk[] = candidates;
    let rerankApplied = false;
    let rerankDropped = 0;
    let rerankError: string | undefined;
    if (this.reranker && candidates.length > 0) {
      if (options.signal?.aborted) throw new Error("检索已取消");
      try {
        const documents = candidates.map(item =>
          `${item.chunk.title ?? ""}\n${item.chunk.text}`.trim());
        const results = await this.reranker.rerank(trimmed, documents, {
          topN: candidates.length,
          signal: options.signal,
        });
        const scores = new Map(results.map(result => [result.index, result.score]));
        const scored = candidates.flatMap((item, index): RankedChunk[] => {
          const score = scores.get(index);
          return score === undefined ? [] : [{ ...item, rerankScore: score }];
        });
        ranked = scored
          .filter(item => (item.rerankScore ?? 0) >= minRerankScore)
          .sort((left, right) => (right.rerankScore ?? 0) - (left.rerankScore ?? 0)
            || left.chunk.id.localeCompare(right.chunk.id));
        rerankDropped = candidates.length - ranked.length;
        rerankApplied = true;
      } catch (error) {
        // 调用方取消是控制流，不降级为 RRF；其余失败回退，不阻断问答。
        if (options.signal?.aborted) throw new Error("检索已取消");
        rerankError = classifyRerankError(error);
        ranked = candidates;
      }
    }

    const hits: RagHit[] = [];
    const selectedCards = new Set<string>();
    let contextChars = 0;
    let truncated = false;
    for (const item of ranked) {
      if (selectedCards.size >= topK) break;
      if (selectedCards.has(item.chunk.cardId)) continue;
      const evidence = this.cardEvidence(item, fused);
      for (const chunk of evidence) {
        const remaining = maxTotalChars - contextChars;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        let text = chunk.text;
        if (text.length > remaining) {
          if (remaining < MIN_TRUNCATED_CHARS) {
            truncated = true;
            break;
          }
          text = text.slice(0, remaining);
          truncated = true;
        }
        const fusedItem = fused.get(chunk.id);
        hits.push({
          chunkId: chunk.id,
          cardId: chunk.cardId,
          courseId: chunk.courseId,
          kind: chunk.kind,
          title: chunk.title,
          text,
          // 摘要与正文同属一个命中卡片，共享卡片最终分；rrfScore 保留各自融合分。
          score: item.rerankScore ?? item.score,
          rrfScore: fusedItem?.score ?? 0,
          ...(chunk.id === item.chunk.id && item.rerankScore !== undefined
            ? { rerankScore: item.rerankScore } : {}),
          denseRank: fusedItem?.denseRank,
          keywordRank: fusedItem?.keywordRank,
        });
        contextChars += text.length;
        if (truncated) break;
      }
      selectedCards.add(item.chunk.cardId);
      if (truncated) break;
    }

    return {
      hits,
      diagnostics: {
        denseCandidates: denseChunks.length,
        keywordCandidates: keywordChunks.length,
        fusedCandidates: fused.size,
        cardCandidates,
        rerankApplied,
        rerankCandidates: candidates.length,
        rerankDropped,
        contextChars,
        truncated,
        ...(rerankError === undefined ? {} : { rerankError }),
      },
    };
  }

  /** D-022：命中卡片返回摘要 + 定位到的正文片段，摘要排在正文之前。 */
  private cardEvidence(
    selected: RankedChunk,
    fused: ReadonlyMap<string, FusedChunk>,
  ): RagChunk[] {
    const cardChunks = this.byCard.get(selected.chunk.cardId) ?? [selected.chunk];
    const summary = cardChunks.find(chunk => chunk.kind === "summary");
    const body = selected.chunk.kind === "body"
      ? selected.chunk
      : this.bestBody(cardChunks, fused);
    const evidence: RagChunk[] = [];
    if (summary) evidence.push(summary);
    if (body && body.id !== summary?.id) evidence.push(body);
    return evidence.length > 0 ? evidence : [selected.chunk];
  }

  private bestBody(
    cardChunks: readonly RagChunk[],
    fused: ReadonlyMap<string, FusedChunk>,
  ): RagChunk | undefined {
    let best: RagChunk | undefined;
    let bestScore = -1;
    for (const chunk of cardChunks) {
      if (chunk.kind !== "body") continue;
      const score = fused.get(chunk.id)?.score ?? -1;
      if (score > bestScore) {
        best = chunk;
        bestScore = score;
      }
    }
    return best;
  }

  private pickCandidates(
    ordered: readonly FusedChunk[],
    limit: number,
    maxChunksPerCard: number,
  ): FusedChunk[] {
    const picked: FusedChunk[] = [];
    const perCard = new Map<string, number>();
    for (const item of ordered) {
      if (picked.length >= limit) break;
      const used = perCard.get(item.chunk.cardId) ?? 0;
      if (used >= maxChunksPerCard) continue;
      picked.push(item);
      perCard.set(item.chunk.cardId, used + 1);
    }
    return picked;
  }
}
