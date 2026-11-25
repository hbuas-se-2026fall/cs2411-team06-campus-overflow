/** RAG 检索的公共类型；实现依据 docs/RAG树设计与迭代记录.md D-029/D-030。 */

export interface RagChunk {
  id: string;
  cardId: string;
  courseId: number;
  kind: "summary" | "body";
  title?: string;
  text: string;
  /** 卡片受信标签，用于 1 跳概念关联扩展 */
  tagIds?: readonly number[];
}

export interface RagHitRelation {
  type: "shared_tag";
  direction: "symmetric";
  /** 关系来源，如 tag:12 */
  source: string;
  seedCardId: string;
  tagId: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions?: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface RerankResult {
  index: number;
  score: number;
}

/** 精排接口：复用 OpenAI 兼容 /rerank 服务；分数只用于排序与阈值，不代表概率。 */
export interface RerankProvider {
  readonly model: string;
  rerank(
    query: string,
    documents: readonly string[],
    options?: { topN?: number; signal?: AbortSignal },
  ): Promise<RerankResult[]>;
}

export interface HnswOptions {
  dimensions: number;
  /** 每个节点的邻居上限，默认 16 */
  m?: number;
  /** 构建时候选队列长度，默认 200 */
  efConstruction?: number;
  /** 查询时候选队列长度，默认 64 */
  efSearch?: number;
  /** 固定随机种子，便于测试复现 */
  seed?: number;
}

export interface RagIndexOptions {
  chunks: readonly RagChunk[];
  embedder: EmbeddingProvider;
  hnsw?: Omit<HnswOptions, "dimensions">;
  /** RRF 常数 k，默认 60 */
  rrfK?: number;
  /** 可选精排；未提供时保持 RRF 顺序 */
  reranker?: RerankProvider;
  /** 融合去重后进入精排的候选数，默认 5 */
  candidateLimit?: number;
  /** 精排最低分，默认 0；仅启用重排时生效 */
  minRerankScore?: number;
  /** 同一卡片最多保留的片段数，默认 1 */
  maxChunksPerCard?: number;
  /** 最终证据总字符预算，默认 2400 */
  maxTotalChars?: number;
}

export interface RagSearchOptions {
  /** 每路召回数量，默认 20 */
  topN?: number;
  /** 最终返回数量，默认 5 */
  topK?: number;
  courseId?: number;
  efSearch?: number;
  candidateLimit?: number;
  minRerankScore?: number;
  maxChunksPerCard?: number;
  maxTotalChars?: number;
  signal?: AbortSignal;
}

export interface RagHit {
  chunkId: string;
  cardId: string;
  courseId: number;
  kind: "summary" | "body";
  title?: string;
  text: string;
  /** 最终排序分：启用重排时为精排分，否则为 RRF 融合分 */
  score: number;
  /** RRF 融合分，保留用于诊断 */
  rrfScore: number;
  /** 精排分，仅启用重排时有值 */
  rerankScore?: number;
  /** 命中来自 1 跳关联扩展时的关系来源 */
  relation?: RagHitRelation;
  denseRank?: number;
  keywordRank?: number;
}

/** 单个子问题的检索与合并贡献诊断；不包含子问题原文。 */
export interface RagSubQueryDiagnostics {
  /** 子问题序号，从 1 开始 */
  index: number;
  denseCandidates: number;
  keywordCandidates: number;
  fusedCandidates: number;
  /** 该子问题召回的不同卡片数 */
  cardCandidates: number;
  /** 该子问题进入精排的 1 跳扩展候选数 */
  expandedCandidates: number;
  /** 合并后来自 1 跳扩展的卡片数 */
  expandedHits: number;
  rerankApplied: boolean;
  rerankCandidates: number;
  rerankDropped: number;
  /** 合并后实际进入最终结果的卡片数 */
  selectedCards: number;
  /** 合并后实际进入最终结果的字符数 */
  contextChars: number;
  /** 该子问题的证据是否因总预算被截断或丢弃 */
  truncated: boolean;
  rerankError?: string;
}

export interface RagSearchDiagnostics {
  denseCandidates: number;
  keywordCandidates: number;
  fusedCandidates: number;
  /** 融合结果中不同卡片的数量 */
  cardCandidates: number;
  /** 实际检索的子问题数；单问题为 1 */
  subQueryCount: number;
  /** 逐子问题明细，顺序与拆解顺序一致 */
  subQueries: RagSubQueryDiagnostics[];
  /** 进入精排的 1 跳扩展候选数 */
  expandedCandidates: number;
  /** 最终结果中来自 1 跳扩展的卡片数 */
  expandedHits: number;
  rerankApplied: boolean;
  /** 送入重排的候选数 */
  rerankCandidates: number;
  /** 低于阈值或未被精排返回的候选数 */
  rerankDropped: number;
  /** 最终证据总字符数 */
  contextChars: number;
  /** 是否触发字符预算裁剪 */
  truncated: boolean;
  /** 重排失败的脱敏类型，如 timeout/http_500/invalid_response */
  rerankError?: string;
}

export interface RagSearchResult {
  hits: RagHit[];
  diagnostics: RagSearchDiagnostics;
}
