"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/api/client";
import {
  createAnswerComment,
  createQuestionComment,
  deleteComment,
  listAnswerComments,
  listQuestionComments,
} from "@/api/comments";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Pagination,
} from "@/shared/components";
import { COMMENT_MAX_LEN } from "@/shared/constants/domain";
import type { CommentListItem } from "@/shared/types/question";
import { formatRelativeTime } from "@/shared/utils/format";
import { isAuthorOf } from "@/shared/utils/ownership";

type LoadStatus = "loading" | "ready" | "error";
const PAGE_SIZE = 20;

export function CommentList({
  targetType,
  targetId,
  currentUsername,
  canModerate = false,
}: {
  targetType: "question" | "answer";
  targetId: number;
  currentUsername?: string | null;
  canModerate?: boolean;
}) {
  const [items, setItems] = useState<CommentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setStatus("loading");
      try {
        const params = { page, page_size: PAGE_SIZE };
        const result = targetType === "question"
          ? await listQuestionComments(targetId, params)
          : await listAnswerComments(targetId, params);
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.total);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetType, targetId, page, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  async function submitComment(text: string, parentId?: number) {
    if (!text.trim()) {
      setError("评论内容不能为空");
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (targetType === "question") {
        await createQuestionComment(targetId, {
          body: text.trim(),
          ...(parentId ? { parent_id: parentId } : {}),
        });
      } else {
        await createAnswerComment(targetId, {
          body: text.trim(),
          ...(parentId ? { parent_id: parentId } : {}),
        });
      }
      if (parentId) {
        setReplyBody("");
        setReplyTo(null);
        reload();
      } else {
        setBody("");
        if (page === 1) reload();
        else setPage(1);
      }
    } catch (caught) {
      // 400 空内容 / 400 父评论不合法（回复的回复）/ 403 封禁
      setError(caught instanceof ApiError ? caught.message : "提交失败，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    if (deleteTarget === null) return;
    setPending(true);
    setError(null);
    try {
      await deleteComment(deleteTarget);
      setDeleteTarget(null);
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "删除失败，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label={targetType === "question" ? "问题评论" : "回答评论"}
      className="flex flex-col gap-3"
    >
      <h2 className="text-[18px] font-semibold text-ink">{total} 条评论</h2>

      {status === "loading" ? <LoadingSkeleton variant="list" count={2} /> : null}
      {status === "error" ? (
        <ErrorState message="评论加载失败，请稍后重试。" onRetry={reload} />
      ) : null}

      {status === "ready" && items.length === 0 ? (
        <EmptyState title="还没有评论" description="补充你的疑问或补充说明，帮后来的人看懂。" />
      ) : null}

      {status === "ready" && items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {items.map((comment) => (
            <li key={comment.id} className="rounded-lg border border-line bg-canvas p-4">
              <CommentBody
                author={comment.author}
                body={comment.body}
                createdAt={comment.created_at}
                canDelete={canModerate || isAuthorOf(currentUsername, comment.author)}
                onDelete={() => setDeleteTarget(comment.id)}
                onReply={() => {
                  setReplyTo(replyTo === comment.id ? null : comment.id);
                  setReplyBody("");
                }}
              />

              {comment.replies.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-2 border-l border-line pl-4">
                  {comment.replies.map((reply) => (
                    <li key={reply.id}>
                      <CommentBody
                        author={reply.author}
                        body={reply.body}
                        createdAt={reply.created_at}
                        canDelete={canModerate || isAuthorOf(currentUsername, reply.author)}
                        onDelete={() => setDeleteTarget(reply.id)}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}

              {replyTo === comment.id ? (
                <form
                  className="mt-3 flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitComment(replyBody, comment.id);
                  }}
                >
                  <textarea
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    rows={2}
                    maxLength={COMMENT_MAX_LEN}
                    placeholder={`回复 ${comment.author}`}
                    aria-label={`回复 ${comment.author}`}
                    className="co-focusable w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[13px] text-ink transition-colors duration-150 ease-standard placeholder:text-ink-subtle focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="co-focusable cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-ink-muted hover:bg-panel"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={pending}
                      className="co-focusable cursor-pointer rounded-md bg-brand px-3 py-1.5 text-[13px] font-medium text-white transition-colors duration-150 ease-standard hover:bg-brand-strong disabled:bg-line disabled:text-ink-subtle"
                    >
                      发布回复
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {status === "ready" && total > PAGE_SIZE ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitComment(body);
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-semibold text-ink">写评论</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            maxLength={COMMENT_MAX_LEN}
            placeholder="补充说明，或询问细节（最多 1000 字）"
            className="co-focusable w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink transition-colors duration-150 ease-standard placeholder:text-ink-subtle hover:border-ink-subtle focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </label>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="co-focusable cursor-pointer rounded-md bg-brand px-4 py-2 text-[14px] font-medium text-white transition-colors duration-150 ease-standard hover:bg-brand-strong disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-subtle"
          >
            {pending ? "提交中…" : "发表评论"}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={deleteTarget !== null}
        busy={pending}
        title="确认删除这条评论？"
        description="删除后普通用户不可见；若删除的是顶级评论，其下的回复会一并隐藏。"
        confirmLabel="确认删除"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

function CommentBody({
  author,
  body,
  createdAt,
  canDelete,
  onDelete,
  onReply,
}: {
  author: string;
  body: string;
  createdAt: string;
  canDelete: boolean;
  onDelete: () => void;
  onReply?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-subtle">
        <span className="text-ink-muted">{author}</span>
        <span aria-hidden="true">·</span>
        <span>{formatRelativeTime(createdAt)}</span>
        {onReply ? (
          <button
            type="button"
            onClick={onReply}
            className="co-focusable cursor-pointer text-[12px] text-ink-muted hover:text-brand"
          >
            回复
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="co-focusable cursor-pointer text-[12px] text-ink-muted hover:text-danger"
          >
            删除
          </button>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{body}</p>
    </div>
  );
}
