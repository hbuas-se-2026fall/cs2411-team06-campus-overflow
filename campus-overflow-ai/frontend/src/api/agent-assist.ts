// AI 辅助（相似问题 / 标签建议）：BFF /api/agent/** 转发到 Agent 服务。
// 字段与 agent/src/types/index.ts 的真实 Schema 对齐（camelCase，非蛇形）。

export interface SimilarQuestionItem {
  questionId: number;
  title: string;
  url: string;
  reason: string;
}

export interface SimilarQuestionsResult {
  items: SimilarQuestionItem[];
  hasInSiteEvidence: boolean;
  note: string;
}

interface AgentEnvelope<T> {
  code: number;
  data: T | null;
  message: string;
}

async function postTask<T>(
  task: "similar_questions" | "suggest_tags",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/agent/agent/tasks/${task}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = (await response.json()) as AgentEnvelope<T>;
  if (!response.ok || payload.code !== 200 || payload.data === null) {
    throw new Error(payload.message || "AI 建议暂不可用");
  }
  return payload.data;
}

export function similarQuestions(
  input: { questionTitle: string; questionBody?: string; courseId?: number; limit?: number },
  signal?: AbortSignal,
) {
  return postTask<SimilarQuestionsResult>("similar_questions", input, signal);
}

export interface SuggestedTag {
  name: string;
  reason: string;
  confidence: number;
  tagId?: number;
}

export interface SuggestTagsResult {
  tags: SuggestedTag[];
  basisNote: string;
}

export function suggestTags(
  input: {
    questionTitle: string;
    questionBody: string;
    courseId?: number;
    tagCount?: number;
  },
  signal?: AbortSignal,
) {
  return postTask<SuggestTagsResult>("suggest_tags", input, signal);
}
