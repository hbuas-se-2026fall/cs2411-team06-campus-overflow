"use client";

import { CourseSelect } from "@/features/courses/CourseSelect";
import { TagSelect } from "@/features/tags/TagSelect";
import { Button, FilterBar, Select, TabNav } from "@/shared/components";
import type { QuestionSort } from "@/shared/types/question";

// 筛选状态（与 URL 参数一一对应：course_id/tag_id/sort/unresolved/within）
export interface QuestionFilters {
  courseId?: number;
  tagId?: number;
  sort: QuestionSort;
  unresolved: boolean;
  within: QuestionTimeRange;
}

export type QuestionTimeRange = "any" | "day" | "week" | "month";

export interface QuestionFilterBarProps {
  filters: QuestionFilters;
  // 变更回调：父级统一写入 URL（URL 为唯一筛选状态源）
  onChange: (patch: Partial<QuestionFilters>) => void;
  // ＋提问：登录 → /questions/new；游客 → /auth/login?returnTo=/questions/new（由父级分流）
  onAsk: () => void;
}

const SORT_TABS = [
  { key: "latest", label: "最新" },
  { key: "hot", label: "热门" },
];

const STATUS_TABS = [
  { key: "all", label: "全部" },
  { key: "unresolved", label: "未解决" },
];

const TIME_RANGE_OPTIONS = [
  { value: "any", label: "全部时间" },
  { value: "day", label: "24 小时内" },
  { value: "week", label: "7 天内" },
  { value: "month", label: "30 天内" },
];

/** 时间范围转为后端 created_from；只设起点，保持“至今”的语义。 */
export function createdFromForRange(within: QuestionTimeRange): string | undefined {
  const days = within === "day" ? 1 : within === "week" ? 7 : within === "month" ? 30 : 0;
  if (days === 0) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// 问题广场筛选条（§2.3）：[＋提问] | 课程/标签 Select | 排序与状态 TabNav
export function QuestionFilterBar({
  filters,
  onChange,
  onAsk,
}: QuestionFilterBarProps) {
  // TODO(接口差异)：后端 /api/questions 无 resolved 筛选参数，"已解决"Tab 随接口回填流程补
  return (
    <FilterBar
      actions={
        <Button onClick={onAsk}>
          <span aria-hidden="true">＋</span> 提问
        </Button>
      }
      filters={
        <>
          <div className="w-[220px]">
            <CourseSelect
              label="按课程筛选"
              value={filters.courseId}
              onChange={(courseId) => onChange({ courseId })}
              placeholder="全部课程"
            />
          </div>
          <div className="w-[220px]">
            <TagSelect
              label="按标签筛选"
              value={filters.tagId}
              onChange={(tagId) => onChange({ tagId })}
              placeholder="全部标签"
            />
          </div>
          <TabNav
            tabs={SORT_TABS}
            active={filters.sort}
            onChange={(key) => onChange({ sort: key as QuestionSort })}
          />
          <TabNav
            tabs={STATUS_TABS}
            active={filters.unresolved ? "unresolved" : "all"}
            onChange={(key) => onChange({ unresolved: key === "unresolved" })}
          />
          <div className="w-[130px]">
            <Select
              aria-label="发布时间"
              value={filters.within}
              options={TIME_RANGE_OPTIONS}
              onChange={(event) => onChange({ within: event.target.value as QuestionTimeRange })}
              className="h-10"
            />
          </div>
        </>
      }
    />
  );
}
