"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { getRank } from "@/api/reputation";
import { fetchPublicReputation } from "@/api/users";
import { CourseSelect } from "@/features/courses/CourseSelect";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  TabNav,
  UserLine,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";
import type { RankPeriod } from "@/shared/types/reputation";

export type RankingTab = "week" | "month" | "course";

const RANK_TABS = [
  { key: "week", label: "周榜" },
  { key: "month", label: "月榜" },
  { key: "course", label: "课程榜" },
];

// 课程榜维度 = period=all + course_id（后端 period 仅接受 week|month|all，无 course 枚举）
const TAB_PERIOD: Record<RankingTab, RankPeriod> = {
  week: "week",
  month: "month",
  course: "all",
};

// 前三名红底徽标 + 其余名次纯文本（设计系统语义色）
const TOP_BADGE =
  "inline-flex h-6 w-6 items-center justify-center rounded-full bg-danger-soft text-[13px] font-semibold text-danger-ink";
const PLAIN_BADGE =
  "inline-flex h-6 w-6 items-center justify-center text-[13px] font-medium text-ink-muted";

function isRankingTab(key: string): key is RankingTab {
  return RANK_TABS.some((tab) => tab.key === key);
}

// 排行榜（页面控件级设计说明 §2.10）：周榜/月榜/课程榜 Tab + 课程 Select + 榜单表
// Tab/课程切换写 URL（默认周榜不写参数），刷新后由服务端解析回填 initialTab
export function RankingsView({
  initialTab,
  initialCourseId,
}: {
  initialTab: RankingTab;
  initialCourseId: number | null;
}) {
  const router = useRouter();

  const [tab, setTab] = useState<RankingTab>(initialTab);
  const [courseId, setCourseId] = useState<number | null>(initialCourseId);

  // 课程榜单首次进入自动选中第一门已加载课程；之后可按关键词搜索或继续加载。
  const effectiveCourseId = tab === "course" ? courseId : null;

  // Tab/课程切换写 URL：period/course_id 直接映射后端查询参数
  useEffect(() => {
    const params = new URLSearchParams();
    if (tab === "month") params.set("period", "month");
    if (tab === "course" && effectiveCourseId !== null) {
      params.set("period", "all");
      params.set("course_id", String(effectiveCourseId));
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/rankings?${query}` : "/rankings");
  }, [tab, effectiveCourseId]);

  const rankState = useAsyncData(
    async () => {
      if (tab === "course" && effectiveCourseId === null) return [];
      const result = await getRank({
        period: TAB_PERIOD[tab],
        course_id:
          tab === "course" && effectiveCourseId !== null ? effectiveCourseId : undefined,
      });
      return Promise.all(
        result.items.map(async (entry) => {
          try {
            const reputation = await fetchPublicReputation(entry.user_id);
            return {
              ...entry,
              question_count: reputation.question_count,
              answer_count: reputation.answer_count,
            };
          } catch {
            return { ...entry, question_count: null, answer_count: null };
          }
        }),
      );
    },
    [tab, effectiveCourseId],
  );
  const entries = rankState.data ?? [];
  const isReady = !rankState.isLoading && rankState.error === null;
  const waitingForCourse = tab === "course" && effectiveCourseId === null;

  function handleTabChange(key: string) {
    if (!isRankingTab(key)) return;
    setTab(key);
    // 离开课程榜时清空课程选择，回到周/月维度
    if (key !== "course") setCourseId(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[22px] font-semibold text-ink">排行榜</h1>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabNav tabs={RANK_TABS} active={tab} onChange={handleTabChange} className="border-none" />
        {tab === "course" ? (
          <div className="w-full sm:w-64">
            <CourseSelect
              label="选择课程"
              value={effectiveCourseId ?? undefined}
              onChange={(next) => setCourseId(next ?? null)}
              placeholder="请选择课程"
              autoSelectFirst
            />
          </div>
        ) : null}
      </div>

      {rankState.isLoading ? <LoadingSkeleton variant="list" count={6} /> : null}

      {rankState.error !== null ? (
        <ErrorState message={rankState.error} onRetry={rankState.reload} />
      ) : null}

      {isReady && !waitingForCourse && entries.length === 0 ? (
        <EmptyState
          title="暂无榜单数据"
          description={
            tab === "course"
              ? "该课程在当前统计窗口内还没有声望变动。"
              : "当前统计窗口内还没有声望变动。"
          }
        />
      ) : null}

      {isReady && entries.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-canvas">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-[12px] text-ink-subtle">
                <th scope="col" className="py-3 pl-5 pr-4 font-medium">名次</th>
                <th scope="col" className="py-3 pr-4 font-medium">用户</th>
                <th scope="col" className="py-3 pr-4 font-medium">声望值</th>
                {/* TODO(接口差异)：后端 rank 接口仅返回 user_id/username/score，提问数/回答数/采纳率待后端补充后渲染 */}
                <th scope="col" className="py-3 pr-4 font-medium">提问数</th>
                <th scope="col" className="py-3 pr-4 font-medium">回答数</th>
                <th scope="col" className="py-3 pr-4 font-medium">采纳率</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => {
                const rank = index + 1;
                return (
                  <tr
                    key={entry.user_id}
                    onClick={() => router.push(`/users/${entry.user_id}`)}
                    className="cursor-pointer border-b border-line transition-colors duration-150 ease-standard last:border-b-0 hover:bg-panel"
                  >
                    <td className="py-3 pl-5 pr-4">
                      {rank <= 3 ? (
                        <span className={TOP_BADGE}>{rank}</span>
                      ) : (
                        <span className={PLAIN_BADGE}>{rank}</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {/* 榜单条目无角色字段，暂按学生徽标展示（同课程活跃用户做法） */}
                      <UserLine
                        userId={entry.user_id}
                        nickname={entry.username}
                        role="student"
                        size="sm"
                      />
                    </td>
                    <td className="py-3 pr-4 text-[14px] font-medium text-ink">{entry.score}</td>
                    <td className="py-3 pr-4 text-[13px] text-ink-muted">
                      {entry.question_count ?? "—"}
                    </td>
                    <td className="py-3 pr-4 text-[13px] text-ink-muted">
                      {entry.answer_count ?? "—"}
                    </td>
                    <td className="py-3 pr-4 text-[13px] text-ink-muted">—</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
