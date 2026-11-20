/** 查询拆解：确定性切分复合问题，不引入额外模型调用（D-008 / D-009）。 */

/** 子问题上限：避免一次检索放大成过多外部请求。 */
export const MAX_SUB_QUERIES = 4;

const SENTENCE_SPLIT = /[？?；;。！!\n]+/;
// 只切显式连接词；“和/与/及”可能是同一信息需求，不能贸然拆开。
const CONNECTOR_SPLIT = /\s*(?:以及|还有|另外|并且|同时)\s*/;

/**
 * 将复合问题拆成子问题；保留原顺序并去重。
 * 未识别到分隔符时返回原查询；不生成同义改写，避免无依据地扩大召回。
 */
export const decomposeQuery = (query: string): string[] => {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const clauses = normalized
    .split(SENTENCE_SPLIT)
    .flatMap(part => part.split(CONNECTOR_SPLIT))
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  const unique = [...new Set(clauses.length > 0 ? clauses : [normalized])];
  return unique.slice(0, MAX_SUB_QUERIES);
};
