"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { similarQuestions, type SimilarQuestionItem } from "@/api/agent-assist";
import { BODY_MAX_LEN, TITLE_MAX_LEN } from "@/shared/constants/domain";

const DEBOUNCE_MS = 800;

interface SuggestionState {
  key: string;
  status: "pending" | "ready" | "error";
  items: SimilarQuestionItem[];
}

// 提问前相似问题建议（API-57）：输入标题后防抖检索；无命中/失败一律不渲染，绝不阻塞提问（X-02）。
export function SimilarQuestionsCard({
  questionTitle,
  questionBody,
  courseId,
  onNavigate,
}: {
  questionTitle: string;
  questionBody: string;
  courseId: number | null;
  onNavigate?: () => void;
}) {
  const [state, setState] = useState<SuggestionState | null>(null);
  const title = questionTitle.trim();
  const body = questionBody.trim().slice(0, BODY_MAX_LEN);
  const active = title.length > 0 && title.length <= TITLE_MAX_LEN;
  const queryKey = JSON.stringify([title, body, courseId]);

  useEffect(() => {
    const currentTitle = questionTitle.trim();
    const currentBody = questionBody.trim().slice(0, BODY_MAX_LEN);
    const currentKey = JSON.stringify([currentTitle, currentBody, courseId]);
    // 标题为空不请求；渲染层用 active 直接隐藏，避免在 effect 内同步 setState
    if (currentTitle.length === 0 || currentTitle.length > TITLE_MAX_LEN) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      // 防抖结束后才进入加载态（不在 effect 体内同步 setState）
      setState({ key: currentKey, status: "pending", items: [] });
      similarQuestions(
        {
          questionTitle: currentTitle,
          questionBody: currentBody || undefined,
          courseId: courseId ?? undefined,
        },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            const items = Array.from(
              new Map(result.items.map((item) => [item.questionId, item])).values(),
            );
            setState({ key: currentKey, status: "ready", items });
          }
        })
        .catch(() => {
          // Agent 不可用/超时：卡片隐藏，不提示错误、不影响发布
          if (!controller.signal.aborted) {
            setState({ key: currentKey, status: "error", items: [] });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [questionTitle, questionBody, courseId]);

  if (!active) return null;
  if (state === null || state.key !== queryKey) return null;
  if (state.status === "error") return null;
  if (state.status === "ready" && state.items.length === 0) return null;

  return (
    <section
      aria-label="相似问题建议"
      className="rounded-lg border border-line bg-panel p-4"
    >
      <h2 className="text-[13px] font-semibold text-ink">可能已有答案</h2>
      {state.status === "pending" ? (
        <p className="mt-2 text-[12px] text-ink-subtle">正在检索站内相似问题…</p>
      ) : null}
      {state.status === "ready" ? (
        <ul className="mt-2 flex flex-col gap-2">
          {state.items.map((item) => (
            <li key={item.questionId} className="text-[13px]">
              <Link
                href={item.url}
                className="co-focusable text-brand hover:underline"
                onClick={() => onNavigate?.()}
              >
                {item.title}
              </Link>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{item.reason}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
