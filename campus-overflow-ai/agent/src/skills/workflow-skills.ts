// 工作流 skill 注入（T-22C / SK-R03）：按任务类型与课程匹配，最多 3 条、总字符 ≤4000、
// 额外 token ≤1500；仅展开排名第 1 条详情，其余用摘要；30s TTL 缓存，失败降级为空。
// 默认关闭：SKILL_INJECTION_ENABLED=true 时才读取后端，不影响既有计划生成。
import type { WorkflowSkillSummaryItem, WorkflowSkillVersionItem } from "../internal-client.js";
import type { TraceId } from "../types/index.js";

export const SKILL_INJECTION_TTL_MS = 30_000;
export const MAX_INJECTED_SKILLS = 3;
export const MAX_SKILL_CHARS = 4_000;
export const MAX_SKILL_TOKENS = 1_500;

/** 只依赖两个只读方法，便于测试与避免与完整 InternalClient 耦合。 */
export interface SkillSource {
  fetchWorkflowSkills?(
    params: { taskType: string; courseId?: number },
    traceId: TraceId,
  ): Promise<WorkflowSkillSummaryItem[]>;
  fetchWorkflowSkillVersion?(
    params: { skillId: number; version: number },
    traceId: TraceId,
  ): Promise<WorkflowSkillVersionItem>;
}

interface SkillCacheEntry {
  readonly lines: readonly string[];
  readonly expiresAt: number;
}

const cache = new Map<string, SkillCacheEntry>();

export const resetSkillInjectionCacheForTests = (): void => {
  cache.clear();
};

export const isSkillInjectionEnabled = (): boolean =>
  process.env.SKILL_INJECTION_ENABLED === "true";

/** 保守 token 估算：CJK 约 1 token/字，其余约 4 字符/token。 */
export const estimateSkillTokens = (text: string): number => {
  let cjk = 0;
  for (const char of text) {
    if (/[\u3400-\u9fff]/.test(char)) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
};

export const loadSkillInjection = async (
  client: SkillSource,
  taskType: string,
  courseId: number | undefined,
  traceId: TraceId,
  now = Date.now(),
): Promise<string[]> => {
  if (!isSkillInjectionEnabled() || !client.fetchWorkflowSkills) return [];
  const key = `${taskType}:${courseId ?? "all"}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return [...cached.lines];

  let lines: string[] = [];
  try {
    const listed = await client.fetchWorkflowSkills({ taskType, courseId }, traceId);
    lines = await composeSkillLines(client, listed, courseId, traceId);
  } catch {
    // 后端失败或响应不合契约时降级为空，不阻塞规划
    lines = [];
  }
  cache.set(key, { lines, expiresAt: now + SKILL_INJECTION_TTL_MS });
  return [...lines];
};

const composeSkillLines = async (
  client: SkillSource,
  items: readonly WorkflowSkillSummaryItem[],
  courseId: number | undefined,
  traceId: TraceId,
): Promise<string[]> => {
  const ranked = rankSkills(items, courseId);
  if (ranked.length === 0) return [];

  // 只有排名第 1 条拉取详情；详情失败整体降级为空，避免半套提示误导规划
  let detail: WorkflowSkillVersionItem | undefined;
  if (client.fetchWorkflowSkillVersion) {
    try {
      detail = await client.fetchWorkflowSkillVersion(
        { skillId: ranked[0].id, version: ranked[0].version }, traceId,
      );
    } catch {
      return [];
    }
  }

  const lines: string[] = [];
  let chars = 0;
  let tokens = 0;
  for (const [index, item] of ranked.entries()) {
    const remainingChars = MAX_SKILL_CHARS - chars;
    const remainingTokens = MAX_SKILL_TOKENS - tokens;
    if (remainingChars <= 0 || remainingTokens <= 0) break;
    const rendered = renderSkill(item, index === 0 ? detail : undefined);
    const text = truncateToBudget(rendered, remainingChars, remainingTokens);
    if (!text) break;
    lines.push(text);
    chars += text.length;
    tokens += estimateSkillTokens(text);
    if (text !== rendered) break;
  }
  return lines;
};

/** 匹配优先级：任务类型 + 课程精确 > 全局（任务类型由后端过滤）。 */
const rankSkills = (
  items: readonly WorkflowSkillSummaryItem[],
  courseId: number | undefined,
): WorkflowSkillSummaryItem[] => {
  const score = (item: WorkflowSkillSummaryItem): number => {
    if (courseId !== undefined && item.courseId === courseId) return 0;
    return item.courseId === undefined ? 1 : 2;
  };
  return [...items].sort((left, right) => score(left) - score(right))
    .slice(0, MAX_INJECTED_SKILLS);
};

const renderSkill = (
  item: WorkflowSkillSummaryItem,
  detail?: WorkflowSkillVersionItem,
): string => {
  const lines = [`- [${item.name}] ${item.summary}`];
  if (!detail) return lines.join("\n");
  const { conditions, steps, tips, checks } = detail.content;
  if (conditions.length > 0) lines.push(`  适用条件：${conditions.join("；")}`);
  if (steps.length > 0) {
    lines.push(`  步骤：${steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}`);
  }
  if (tips.length > 0) lines.push(`  提示：${tips.join("；")}`);
  if (checks.length > 0) lines.push(`  检查：${checks.join("；")}`);
  return lines.join("\n");
};

const truncateToBudget = (
  text: string,
  maxChars: number,
  maxTokens: number,
): string => {
  if (text.length <= maxChars && estimateSkillTokens(text) <= maxTokens) {
    return text;
  }
  const limit = Math.max(0, Math.min(text.length, maxChars - 1));
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    // 省略号同样占用预算，按「截断后 + …」校验，保证不越界
    if (estimateSkillTokens(`${text.slice(0, mid)}…`) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low)}…` : "";
};
