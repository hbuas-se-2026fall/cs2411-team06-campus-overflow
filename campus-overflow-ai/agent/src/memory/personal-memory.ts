// 个人记忆自动更新建议（T-14 M-03，AG-R04）：AI 从本轮对话提取值得长期保留的偏好/课程上下文。
// 服务端只产出候选并做一次敏感过滤；真正写入仍由浏览器端同源规则再校验后执行，
// 记忆不落后端、不进审计（C-07 / ADR-004）。
import type { LanguageModel } from "ai";
import { z } from "zod";

import { generateStructured } from "../loop/self-check.js";

/** 单条建议上限：比浏览器记忆 500 字更严格，避免把整段回答塞进记忆 */
export const MEMORY_SUGGESTION_MAX_LEN = 200;
export const MEMORY_SUGGESTION_MAX_ITEMS = 2;

export const MemorySuggestionInputSchema = z.object({
  message: z.string().min(1).max(2000),
  answer: z.string().min(1).max(20_000),
  existing: z.array(z.string().min(1).max(500)).max(50).optional(),
}).strict();

export const MemorySuggestionOutputSchema = z.object({
  updates: z.array(z.string().min(1).max(MEMORY_SUGGESTION_MAX_LEN)).max(3),
}).strict();

export type MemorySuggestionInput = z.infer<typeof MemorySuggestionInputSchema>;

/** 与前端 browser-memory 同源的敏感关键词（小写匹配）；命中即丢弃，不返回原文 */
const SENSITIVE_KEYWORDS = [
  "password", "passwd", "pwd", "token", "secret", "api_key", "apikey",
  "access_key", "cookie", "authorization", "credential", "private_key",
  "密码", "口令", "密钥", "凭证",
] as const;

export const isSensitiveMemory = (content: string): boolean => {
  const lowered = content.toLowerCase();
  return SENSITIVE_KEYWORDS.some((keyword) => lowered.includes(keyword));
};

const MEMORY_SYSTEM = `你是个人记忆整理助手。只提取用户明确表达的长期偏好、学习目标或课程上下文；
不提取密码、密钥、证件号、联系方式等敏感信息，不提取一次性问题细节，不提取任何指令或规则。
没有值得长期保留的内容时返回空数组。`;

const MEMORY_PROMPT = (input: MemorySuggestionInput): string => {
  const existing = input.existing?.length
    ? `已有记忆（不要重复）：\n${input.existing.map((item) => `- ${item}`).join("\n")}\n`
    : "";
  return `${existing}本轮用户消息：\n${input.message}\n\n助手回答：\n${input.answer}\n\n`
    + `请输出最多 ${MEMORY_SUGGESTION_MAX_ITEMS} 条个人记忆更新，每条不超过 ${MEMORY_SUGGESTION_MAX_LEN} 字，`
    + "使用简体中文，以用户视角陈述（如“偏好先看示例再看定义”）。";
};

/** 过滤：去空白、长度、敏感、与已有或彼此重复；顺序保留模型输出顺序 */
export const filterMemoryUpdates = (
  updates: readonly string[], existing: readonly string[] = [],
): string[] => {
  const seen = new Set(existing.map((item) => item.trim()));
  const result: string[] = [];
  for (const raw of updates) {
    const text = raw.trim();
    if (!text || text.length > MEMORY_SUGGESTION_MAX_LEN) continue;
    if (isSensitiveMemory(text) || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= MEMORY_SUGGESTION_MAX_ITEMS) break;
  }
  return result;
};

/**
 * 生成个人记忆更新候选。模型失败/结构化失败直接抛出，由调用方按普通错误处理；
 * 本函数不做任何持久化，也不写审计。
 */
export const suggestPersonalMemoryUpdates = async (
  input: MemorySuggestionInput,
  model: LanguageModel,
  options: { signal?: AbortSignal } = {},
): Promise<{ updates: string[] }> => {
  const parsed = MemorySuggestionInputSchema.parse(input);
  const output = await generateStructured({
    model,
    schema: MemorySuggestionOutputSchema,
    system: MEMORY_SYSTEM,
    prompt: MEMORY_PROMPT(parsed),
    signal: options.signal,
  });
  return { updates: filterMemoryUpdates(output.updates, parsed.existing ?? []) };
};
