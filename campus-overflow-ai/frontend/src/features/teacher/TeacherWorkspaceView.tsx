"use client";

import { useState } from "react";
import Link from "next/link";

import { listCourses } from "@/api/courses";
import { fetchUserAnswers } from "@/api/users";
import { EmptyState, TabNav } from "@/shared/components";
import { USER_ROLE } from "@/shared/constants/domain";
import { useAsyncData } from "@/shared/hooks/useAsyncData";
import { useSessionStore } from "@/shared/stores/session-store";
import { redirectToLogin } from "@/shared/utils/navigation";

import { AssistantCertReviewBoard } from "./AssistantCertReviewBoard";

const METRIC_CARDS = [
  { label: "我的课程", href: "/teacher/courses" },
  { label: "待处理工单", href: "/teacher/moderation" },
  { label: "待审核问题", href: "/teacher/certify" },
  { label: "我的回答", href: "/users" },
];

// 工单 Tab 为纯组件状态（页面控件级设计说明 §3.1：不写 URL）
const CASE_TABS = [
  { key: "pending", label: "待处理" },
  { key: "history", label: "历史" },
];

const METRIC_CARD_CLASS =
  "co-focusable flex items-center justify-between rounded-lg border border-line bg-canvas p-4 transition-colors duration-150 ease-standard hover:border-brand-line";

function TeacherMetricCards({ userId }: { userId: number }) {
  const courses = useAsyncData(
    () => listCourses({ mine: true, page: 1, page_size: 1 }),
    [userId],
  );
  const answers = useAsyncData(() => fetchUserAnswers(userId, 1), [userId]);
  const values = [
    courses.data === null ? "—" : String(courses.data.total),
    "—",
    "—",
    answers.data === null ? "—" : String(answers.data.total),
  ];

  return (
    <div className="grid grid-cols-2 gap-4">
      {METRIC_CARDS.map((card, index) => (
        <Link
          key={card.label}
          href={card.label === "我的回答" ? `/users/${userId}` : card.href}
          className={METRIC_CARD_CLASS}
        >
          <span className="flex items-baseline gap-3">
            <span className="text-[28px] font-semibold leading-none text-ink">{values[index]}</span>
            <span className="text-[14px] text-ink-muted">{card.label}</span>
          </span>
          <span aria-hidden="true" className="text-[16px] text-ink-subtle">
            →
          </span>
        </Link>
      ))}
    </div>
  );
}

// 教师工作台（页面控件级设计说明 §3.1）：指标卡 2×2 + 左 7 列工单区 + 右 5 列动态调课
// 登录与教师角色守卫由 src/proxy.ts 服务端完成；guest 态兜底登录引导（同 MePanel 写法）
export function TeacherWorkspaceView() {
  const me = useSessionStore((state) => state.me);
  const status = useSessionStore((state) => state.status);
  const [caseTab, setCaseTab] = useState("pending");

  if (status === "guest") {
    return (
      <EmptyState
        title="登录后查看教师工作台"
        description="工作台指标、工单与课程管理仅教师本人可见，请先登录。"
        actionLabel="去登录"
        onAction={() => redirectToLogin("/teacher")}
      />
    );
  }

  if (me === null) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-live="polite">
        <span className="sr-only">正在加载教师工作台</span>
        <div className="grid grid-cols-2 gap-4">
          {METRIC_CARDS.map((card) => (
            <div key={card.href} className="co-skeleton h-[72px] rounded-lg" />
          ))}
          <div className="co-skeleton h-[72px] rounded-lg" />
        </div>
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
          <div className="co-skeleton h-64 rounded-lg lg:col-span-7" />
          <div className="co-skeleton h-64 rounded-lg lg:col-span-5" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-[22px] font-semibold text-ink">教师工作台</h2>

      <TeacherMetricCards key={me.id} userId={me.id} />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
        <section className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4 lg:col-span-7">
          <h3 className="text-[16px] font-semibold text-ink">工单区</h3>
          <TabNav tabs={CASE_TABS} active={caseTab} onChange={setCaseTab} className="border-none" />
          {/* 治理接口已实现但仅管理员可调；教师端无对应接口，两个 Tab 下均渲染同一空态 */}
          <EmptyState
            title="教师端工单接口尚未开放"
            description="治理接口当前仅管理员可调；教师端队列待课程范围接口开放后展示。"
          />
        </section>

        <section className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4 lg:col-span-5">
          <h3 className="text-[16px] font-semibold text-ink">动态调课信息</h3>
          {/* 调课通知后端暂无对应接口，先渲染空态 */}
          <EmptyState title="暂无调课通知" />
        </section>
      </div>

      {/* 管理员继承教师审核能力；助教资格仍由独立能力位控制。 */}
      {me.role === USER_ROLE.teacher || me.role === USER_ROLE.admin ? <AssistantCertReviewBoard /> : null}
    </div>
  );
}
