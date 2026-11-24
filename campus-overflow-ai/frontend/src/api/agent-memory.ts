// 个人记忆建议（T-14 M-03，AG-R04）：回答完成后按开关请求 AI 候选；
// 只返回候选文本，写入由 browser-memory 同源过滤后执行（C-07）。
import { listMemoryEntries } from "@/shared/lib/browser-memory";

const SUGGEST_PATH = "/api/agent/agent/memory/suggestions";
/** 与 Agent 侧契约一致：单条 200 字、最多 3 条返回 */
const MAX_ITEM_LEN = 200;
const MAX_ITEMS = 3;

/** 请求 AI 记忆候选；失败返回空数组，不影响已完成的回答 */
export async function requestMemorySuggestions(
  userId: number,
  message: string,
  answer: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!message.trim() || !answer.trim()) return [];
  const existing = listMemoryEntries(userId).slice(0, 50).map((entry) => entry.content);
  try {
    const response = await fetch(SUGGEST_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message.slice(0, 2000), answer: answer.slice(0, 20_000), existing }),
      cache: "no-store",
      signal,
    });
    if (!response.ok) return [];
    const envelope = await response.json() as { data?: { updates?: unknown } } | null;
    const updates = envelope?.data?.updates;
    if (!Array.isArray(updates)) return [];
    return updates
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0
        && item.trim().length <= MAX_ITEM_LEN)
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}
