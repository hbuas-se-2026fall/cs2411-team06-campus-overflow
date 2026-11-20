"use client";

import { useEffect, useState } from "react";

import { fetchTag, listTags } from "@/api/tags";
import { Select } from "@/shared/components";
import type { TagListItem } from "@/shared/types/tag";

type LoadStatus = "idle" | "loading" | "ready" | "error";

export function TagSelect({
  label,
  value,
  onChange,
  placeholder = "请选择标签",
}: {
  label: string;
  value?: number;
  onChange: (id: number | undefined) => void;
  placeholder?: string;
}) {
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<TagListItem[]>([]);
  const [pinned, setPinned] = useState<TagListItem | null>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");

  useEffect(() => {
    const normalized = keyword.trim();
    if (!normalized) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setStatus("loading");
      void listTags({ keyword: normalized })
        .then((result) => {
          if (cancelled) return;
          setItems(result.items);
          setStatus("ready");
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [keyword]);

  useEffect(() => {
    if (!value || items.some((tag) => tag.id === value)) return;
    let cancelled = false;
    void fetchTag(value)
      .then((tag) => {
        if (!cancelled) setPinned(tag);
      })
      .catch(() => {
        if (!cancelled) setPinned(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, items]);

  const pinnedOption = value && !items.some((tag) => tag.id === value) && pinned?.id === value
    ? pinned
    : null;

  return (
    <div className="flex flex-col gap-2">
      <input
        value={keyword}
        onChange={(event) => {
          const next = event.target.value;
          setKeyword(next);
          if (!next.trim()) {
            setItems([]);
            setStatus("idle");
          } else {
            setItems([]);
            setStatus("loading");
          }
        }}
        placeholder="输入关键词搜索标签"
        aria-label="搜索标签"
        className="co-focusable h-10 w-full rounded-md border border-line bg-canvas px-3 text-[13px] text-ink placeholder:text-ink-subtle focus:border-brand focus:ring-2 focus:ring-brand/20"
      />
      <Select
        aria-label={label}
        value={value ? String(value) : ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}
        options={[
          { value: "", label: placeholder },
          ...(pinnedOption ? [{ value: String(pinnedOption.id), label: pinnedOption.name }] : []),
          ...items.map((tag) => ({ value: String(tag.id), label: tag.name })),
        ]}
        className="h-10"
      />
      {status === "loading" ? <p className="text-[12px] text-ink-subtle">正在搜索标签…</p> : null}
      {status === "error" ? <p className="text-[12px] text-danger-ink">标签搜索失败，请重试</p> : null}
      {status === "ready" && items.length === 0 ? (
        <p className="text-[12px] text-ink-subtle">没有匹配的标签</p>
      ) : null}
    </div>
  );
}
