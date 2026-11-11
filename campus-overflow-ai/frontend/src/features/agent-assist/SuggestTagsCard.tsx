"use client";

import { useEffect, useRef, useState } from "react";

import {
  JUST_CREATED_QUESTION_KEY,
  suggestTags,
  type SuggestedTag,
} from "@/api/agent-assist";
import { ApiError } from "@/api/client";
import { bindQuestionTags } from "@/api/questions";
import { Button } from "@/shared/components";
import { QUESTION_MAX_TAGS } from "@/shared/constants/domain";

interface ExistingTag {
  id: number;
  name: string;
}

const NO_EXISTING_TAGS: readonly ExistingTag[] = [];

// 提问成功后的标签建议（API-58）：仅创建者浏览器带标记时展示；
// 用户勾选确认后才写标签，跳过/失败都不影响主流程（E-09 / X-02）。
export function SuggestTagsCard({
  questionId,
  questionTitle,
  questionBody,
  courseId,
  existingTags = NO_EXISTING_TAGS,
  onApplied,
}: {
  questionId: number;
  questionTitle: string;
  questionBody: string;
  courseId: number;
  existingTags?: readonly ExistingTag[];
  onApplied?: () => void;
}) {
  const [visibleQuestionId, setVisibleQuestionId] = useState<number | null>(null);
  const visible = visibleQuestionId === questionId;
  const [tags, setTags] = useState<SuggestedTag[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [basisNote, setBasisNote] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const submittingRef = useRef(false);
  const existingCount = new Set(existingTags.map((tag) => tag.id)).size;
  const remainingSlots = Math.max(0, QUESTION_MAX_TAGS - existingCount);

  // 挂载后再读浏览器存储：服务端首屏与客户端水合首帧都保持无卡片，避免 hydration mismatch。
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const matches =
          window.sessionStorage.getItem(JUST_CREATED_QUESTION_KEY) === String(questionId);
        setVisibleQuestionId(matches ? questionId : null);
      } catch {
        setVisibleQuestionId(null);
      }
    });
    return () => {
      active = false;
    };
  }, [questionId]);

  useEffect(() => {
    if (!visible || dismissed) return;
    if (remainingSlots === 0) {
      try {
        window.sessionStorage.removeItem(JUST_CREATED_QUESTION_KEY);
      } catch {
        // 存储不可用不影响关闭建议。
      }
      return;
    }
    const controller = new AbortController();
    suggestTags(
      {
        questionTitle,
        questionBody,
        courseId,
        ...(remainingSlots < 3 ? { tagCount: remainingSlots } : {}),
      },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        const existingIds = new Set(existingTags.map((tag) => tag.id));
        const existingNames = new Set(existingTags.map((tag) => tag.name.trim().toLowerCase()));
        const seen = new Set<string>();
        const available = result.tags.flatMap((tag): SuggestedTag[] => {
          const name = tag.name.trim();
          const normalizedName = name.toLowerCase();
          if (
            name.length === 0 ||
            existingNames.has(normalizedName) ||
            (tag.tagId !== undefined && existingIds.has(tag.tagId)) ||
            seen.has(normalizedName)
          ) {
            return [];
          }
          seen.add(normalizedName);
          return [{ ...tag, name }];
        }).slice(0, remainingSlots);
        setTags(available);
        setBasisNote(result.basisNote);
        if (available.length === 0) {
          try {
            window.sessionStorage.removeItem(JUST_CREATED_QUESTION_KEY);
          } catch {
            // 浏览器禁用存储时只需结束当前建议卡，不影响已发布的问题。
          }
        }
      })
      .catch(() => {
        // Agent 不可用/超时：静默隐藏，不影响刚发布的问题
        if (!controller.signal.aborted) setTags([]);
      });
    return () => {
      controller.abort();
    };
  }, [visible, dismissed, questionTitle, questionBody, courseId, existingTags, remainingSlots]);

  function closeSuggestion() {
    try {
      window.sessionStorage.removeItem(JUST_CREATED_QUESTION_KEY);
    } catch {
      // 存储不可用不是写业务失败，关闭建议卡即可。
    }
    setDismissed(true);
  }

  function dismiss() {
    if (submittingRef.current) return;
    closeSuggestion();
  }

  async function apply(): Promise<void> {
    if (submittingRef.current || selected.size === 0) return;
    submittingRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      await bindQuestionTags(questionId, [...selected]);
      try {
        onApplied?.();
      } catch {
        // 写入已经成功；刷新回调异常不能伪装成标签写入失败。
      }
      closeSuggestion();
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.code < 500
          ? error.message
          : "标签添加失败，可在详情页稍后重试",
      );
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (!visible || dismissed || remainingSlots === 0) return null;
  if (tags !== null && tags.length === 0) return null;

  return (
    <section
      aria-label="标签建议"
      aria-busy={busy || undefined}
      className="rounded-lg border border-line bg-panel p-4"
    >
      <h2 className="text-[13px] font-semibold text-ink">为这个问题添加标签</h2>
      <p className="mt-1 text-[12px] text-ink-muted">
        AI 只做建议，勾选并确认后才会写入。
      </p>
      {tags === null ? (
        <p className="mt-2 text-[12px] text-ink-subtle">正在生成标签建议…</p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-2">
            {tags.map((tag) => (
              <li key={tag.name} className="text-[13px]">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(tag.name)}
                    disabled={busy}
                    onChange={() => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(tag.name)) next.delete(tag.name);
                        else next.add(tag.name);
                        return next;
                      });
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium text-ink">{tag.name}</span>
                    <span className="ml-2 text-[11px] text-ink-subtle">
                      置信度 {Math.round(tag.confidence * 100)}%
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink-muted">
                      {tag.reason}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {basisNote ? (
            <p className="mt-3 border-t border-line pt-2 text-[12px] text-ink-subtle">
              建议依据：{basisNote}
            </p>
          ) : null}
        </>
      )}
      {message ? <p role="alert" className="mt-2 text-[12px] text-danger">{message}</p> : null}
      <div className="mt-3 flex gap-2">
        <Button onClick={() => void apply()} disabled={busy || selected.size === 0}>
          {busy ? "添加中…" : `确认添加（${selected.size}）`}
        </Button>
        <Button variant="ghost" onClick={dismiss} disabled={busy}>
          跳过
        </Button>
      </div>
    </section>
  );
}
