"use client";
import { useEffect, useRef, useState } from "react";
import { CourseSelect } from "@/features/courses/CourseSelect";

export interface LearningContext { course_id?: number; trusted_tag_ids?: number[] }
interface Tag { id: number; name: string }

export function LearningContextPicker({ value, onChange, disabled, canReport }: {
  value: LearningContext; onChange: (value: LearningContext) => void; disabled: boolean; canReport: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const openPicker = () => setOpen(true);
  const choose = async (courseId: number | undefined) => {
    onChange(courseId ? { course_id: courseId, trusted_tag_ids: [] } : {});
    setTags([]); setError("");
    const key = ++generation.current;
    if (!courseId || !canReport) return;
    try {
      const response = await fetch(`/api/agent/agent/courses/${courseId}/trusted-tags`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.data)) throw new Error(result.message ?? "可信标签暂不可用");
      if (key === generation.current) setTags(result.data);
    } catch { if (key === generation.current) setError("可信标签暂不可用，请稍后重试"); }
  };
  if (!open) return <button type="button" onClick={openPicker} disabled={disabled}
    className="self-start rounded border border-line px-3 py-2 text-sm">选择课程与匿名学习反馈（可选）</button>;
  return <fieldset className="space-y-2 rounded border border-line p-3" disabled={disabled}>
    <legend className="text-sm">课程与匿名学习反馈</legend>
    <CourseSelect
      label="当前学习课程"
      value={value.course_id}
      onChange={(courseId) => void choose(courseId)}
      placeholder="不限定课程"
      disabled={disabled}
    />
    {canReport && <>
      <p className="text-xs text-ink-subtle">只向教师汇总你选定的教材／教师标签与次数，不提交聊天原文或个人记忆；不选标签则不生成学习反馈。</p>
      <div className="flex flex-wrap gap-3">{tags.map(tag => <label key={tag.id} className="text-sm">
        <input type="checkbox" checked={value.trusted_tag_ids?.includes(tag.id) ?? false} onChange={event => {
          const ids = value.trusted_tag_ids ?? [];
          onChange({ ...value, trusted_tag_ids: event.target.checked ? [...ids, tag.id].slice(0, 10) : ids.filter(id => id !== tag.id) });
        }} /> {tag.name}
      </label>)}</div>
    </>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </fieldset>;
}
