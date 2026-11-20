"use client";
import { useState } from "react";
import { apiFetch } from "@/api/client";
import { Button, ErrorState, LoadingSkeleton } from "@/shared/components";
import { toErrorMessage, useAsyncData } from "@/shared/hooks/useAsyncData";
import { TagSelect } from "@/features/tags/TagSelect";

interface Source { tag_id: number; name: string; source: "teacher" | "textbook"; active: boolean; source_ref: string | null }

export function TrustedTagsView({ courseId }: { courseId: number }) {
  const base = `/learning/courses/${courseId}/trusted-tags`;
  const listing = useAsyncData(async () => {
    const managed = await apiFetch<{ items: Source[] }>(base);
    return managed.items;
  }, [courseId]);
  const [tagId, setTagId] = useState<number | undefined>();
  const [source, setSource] = useState<"teacher" | "textbook">("teacher");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (id: number, kind: "teacher" | "textbook", active: boolean, sourceRef: string | null) => {
    setBusy(true); setError("");
    try {
      await apiFetch(`${base}/${id}`, { method: "PUT", body: JSON.stringify({ source: kind, active, source_ref: sourceRef }) });
      listing.reload();
    } catch (caught) { setError(toErrorMessage(caught)); }
    finally { setBusy(false); }
  };
  if (listing.isLoading) return <LoadingSkeleton />;
  if (listing.error) return <ErrorState message={listing.error} onRetry={listing.reload} />;
  return <section className="space-y-4">
    <h1 className="text-xl font-semibold">课程可信标签</h1>
    <p className="text-sm">仅选择已有标签，并明确教师维护或教材来源。普通自定义标签不会自动进入知识目录与匿名学习反馈。</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="flex flex-wrap gap-3">
      <TagSelect label="已有标签" value={tagId} onChange={setTagId} placeholder="选择已有标签" />
      <select aria-label="可信来源" value={source} onChange={event => setSource(event.target.value as "teacher" | "textbook")} className="rounded border border-line p-2">
        <option value="teacher">教师维护</option><option value="textbook">教材来源</option>
      </select>
      <input aria-label="教材或书签依据" value={reference} onChange={event => setReference(event.target.value.slice(0, 500))}
        placeholder="教材名称／书签依据" className="rounded border border-line p-2" />
      <Button disabled={busy || tagId === undefined || (source === "textbook" && !reference.trim())}
        onClick={() => tagId !== undefined && void save(tagId, source, true, reference.trim() || null)}>确认纳入词表</Button>
    </div>
    <ul className="space-y-3">{listing.data?.map(item => <li key={item.tag_id} className="flex flex-wrap items-center gap-3 rounded border border-line p-3">
      <span>{item.name} · {item.source === "teacher" ? "教师维护" : "教材来源"} · {item.active ? "有效" : "已停用"}</span>
      {item.source_ref && <span>{item.source_ref}</span>}
      <Button variant="ghost" disabled={busy} onClick={() => void save(item.tag_id, item.source, !item.active, item.source_ref)}>{item.active ? "停用标签" : "恢复有效"}</Button>
    </li>)}</ul>
  </section>;
}
