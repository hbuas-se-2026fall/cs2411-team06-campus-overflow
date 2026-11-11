"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { similarQuestions, type SimilarQuestionItem } from "@/api/agent-assist";

const DEBOUNCE_MS = 800;

// 提问前相似问题建议（API-57）：输入标题后防抖检索；无命中/失败一律不渲染，绝不阻塞提问（X-02）。
export function SimilarQuestionsCard({
  questionTitle,
  questionBody,
  courseId,
}: {
  questionTitle: string;
  questionBody: string;
  courseId: number | null;
}) {
  const [items, setItems] = useState<SimilarQuestionItem[] | null>(null);
  const [pending, setPending] = useState(false);
  const active = questionTitle.trim().length > 0;

  useEffect(() => {
    const title = questionTitle.trim();
    // 标题为空不请求；渲染层用 active 直接隐藏，避免在 effect 内同步 setState
    if (title.length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      // 防抖结束后才进入加载态（不在 effect 体内同步 setState）
      setPending(true);
      similarQuestions(
        {
          questionTitle: title,
          questionBody: questionBody.trim() || undefined,
          courseId: courseId ?? undefined,
        },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setItems(result.items);
        })
        .catch(() => {
          // Agent 不可用/超时：卡片隐藏，不提示错误、不影响发布
          if (!controller.signal.aborted) setItems([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [questionTitle, questionBody, courseId]);

  if (!active) return null;
  if (items === null && !pending) return null;
  if (items !== null && items.length === 0) return null;

  return (
    <section
      aria-label="相似问题建议"
      className="rounded-lg border border-line bg-panel p-4"
    >
      <h2 className="text-[13px] font-semibold text-ink">可能已有答案</h2>
      {pending && items === null ? (
        <p className="mt-2 text-[12px] text-ink-subtle">正在检索站内相似问题…</p>
      ) : null}
      {items && items.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.questionId} className="text-[13px]">
              <Link
                href={item.url}
                className="co-focusable text-brand hover:underline"
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
