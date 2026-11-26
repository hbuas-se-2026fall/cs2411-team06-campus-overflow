"use client";

// Agent 运行列表（T-16-B，US-18）：状态/任务类型筛选 + 运行表 + 详情入口。
// 数据源 GET /api/governance/agent-runs（仅管理员）；失败运行以醒目样式呈现。
import { useState } from "react";
import Link from "next/link";

import {
  drainPoolSlot, fetchAgentPool, fetchAgentRuns, terminatePoolSlot,
  type AgentPoolSlot, type AgentPoolStatus,
} from "@/api/agent-runs";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Pagination,
  Select,
  TabNav,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";

import { AGENT_STATUS_LABELS, AGENT_TASK_TYPE_LABELS } from "./agentLabels";

const PAGE_SIZE = 20;

const STATUS_TABS = [
  { key: "all", label: "全部" },
  { key: "running", label: "运行中" },
  { key: "succeeded", label: "已成功" },
  { key: "failed", label: "已失败" },
];

const ACTOR_LABELS: Record<string, string> = {
  main: "主 Agent", governance: "治理子 Agent", qa: "问答子 Agent",
};

const SLOT_STATE_LABELS: Record<string, string> = {
  idle: "空闲", leased: "已分配", running: "运行中", draining: "让位中",
};

function formatWait(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)} 秒`;
}

function AgentPoolPanel({
  status, onAction,
}: {
  status: AgentPoolStatus | null | undefined;
  onAction: (slotId: string, action: "drain" | "terminate") => void;
}) {
  if (!status) return null;
  const canOperate = (slot: AgentPoolSlot) => slot.state === "running" || slot.state === "leased";
  return (
    <div className="mt-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {status.slots.map((slot) => (
          <div
            key={slot.slot_id}
            className={`rounded border p-2 text-[12px] ${
              slot.state === "idle"
                ? "border-line-subtle text-ink-subtle"
                : "border-brand/40 bg-brand/5 text-ink"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">{slot.slot_id}</span>
              <span>{SLOT_STATE_LABELS[slot.state] ?? slot.state}</span>
            </div>
            {slot.job_id ? (
              <div className="mt-1 truncate" title={slot.job_id}>{slot.job_id}</div>
            ) : null}
            {slot.supporting_governance ? (
              <div className="mt-1 text-[11px] text-ink-subtle">支援治理</div>
            ) : null}
            {canOperate(slot) ? (
              <div className="mt-2 flex gap-3">
                {slot.slot_kind === "qa" && slot.supporting_governance ? (
                  <button
                    type="button"
                    className="co-focusable text-[11px] text-brand hover:underline"
                    onClick={() => onAction(slot.slot_id, "drain")}
                  >
                    让位
                  </button>
                ) : null}
                <button
                  type="button"
                  className="co-focusable text-[11px] text-red-600 hover:underline"
                  onClick={() => onAction(slot.slot_id, "terminate")}
                >
                  终止
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-ink-subtle">
        问答排队 {status.queues.qa.waiting}（最长 {formatWait(status.queues.qa.oldest_wait_ms)}）
        {" · "}
        治理排队 {status.queues.governance.waiting}（最长 {formatWait(status.queues.governance.oldest_wait_ms)}）
      </p>
    </div>
  );
}

export function AdminAgentRunsView() {
  const [status, setStatus] = useState("all");
  const [taskType, setTaskType] = useState("all");
  const [page, setPage] = useState(1);

  const state = useAsyncData(
    () => fetchAgentRuns({
      status: status === "all" ? undefined : status,
      task_type: taskType === "all" ? undefined : taskType,
      page,
      page_size: PAGE_SIZE,
    }),
    [status, taskType, page],
  );
  const poolState = useAsyncData(() => fetchAgentPool(), []);
  const [poolActionError, setPoolActionError] = useState<string | null>(null);
  const runs = state.data?.items ?? [];

  const runPoolAction = (slotId: string, action: "drain" | "terminate") => {
    const label = action === "drain" ? "让位" : "终止";
    const extra = action === "terminate"
      ? "终止后已执行的后端动作不会回滚。"
      : "任务会在最近的安全检查点归还。";
    if (!window.confirm(`确认对槽位 ${slotId} 执行${label}？${extra}`)) return;
    setPoolActionError(null);
    void (action === "drain" ? drainPoolSlot(slotId) : terminatePoolSlot(slotId))
      .then(() => poolState.reload())
      .catch((error: unknown) => {
        setPoolActionError(error instanceof Error ? error.message : "运行池操作失败");
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[22px] font-semibold text-ink">Agent 运行记录</h2>

      <section className="rounded-lg border border-line bg-canvas p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-ink">运行池</h3>
          <span className="text-[12px] text-ink-subtle">
            {poolState.data ? `实例 ${poolState.data.instance_id}` : "3 治理 + 5 问答"}
          </span>
        </div>
        {poolState.isLoading ? (
          <p className="mt-2 text-[12px] text-ink-subtle">运行池状态加载中…</p>
        ) : null}
        {poolState.error ? (
          <p className="mt-2 text-[12px] text-red-600">运行池状态加载失败：{poolState.error}</p>
        ) : null}
        {poolActionError ? (
          <p className="mt-2 text-[12px] text-red-600">运行池操作失败：{poolActionError}</p>
        ) : null}
        <AgentPoolPanel status={poolState.data} onAction={runPoolAction} />
      </section>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[160px]">
          <Select
            label="任务类型"
            value={taskType}
            onChange={(event) => {
              setTaskType(event.target.value);
              setPage(1);
            }}
            options={[
              { value: "all", label: "全部类型" },
              ...Object.entries(AGENT_TASK_TYPE_LABELS).map(([value, label]) => ({
                value, label,
              })),
            ]}
          />
        </div>
      </div>

      <TabNav
        tabs={STATUS_TABS}
        active={status}
        onChange={(next) => {
          setStatus(next);
          setPage(1);
        }}
      />

      {state.isLoading ? <LoadingSkeleton variant="detail" count={3} /> : null}
      {state.error !== null ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : null}

      {!state.isLoading && state.error === null ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-line bg-canvas">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line text-[12px] text-ink-subtle">
                  <th scope="col" className="py-3 pl-5 pr-4 font-medium">运行 ID</th>
                  <th scope="col" className="py-3 pr-4 font-medium">任务类型</th>
                  <th scope="col" className="py-3 pr-4 font-medium">归属用户</th>
                  <th scope="col" className="py-3 pr-4 font-medium">来源</th>
                  <th scope="col" className="py-3 pr-4 font-medium">状态</th>
                  <th scope="col" className="py-3 pr-4 font-medium">摘要</th>
                  <th scope="col" className="py-3 pr-4 font-medium">时间</th>
                  <th scope="col" className="py-3 pr-4 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.agent_run_id}
                    className={`border-b border-line-subtle text-[13px] ${
                      run.status === "failed" ? "bg-red-50/50" : ""
                    }`}
                  >
                    <td className="py-3 pl-5 pr-4 font-mono text-[12px]">
                      {run.agent_run_id.slice(0, 8)}…
                    </td>
                    <td className="py-3 pr-4">
                      {AGENT_TASK_TYPE_LABELS[run.task_type] ?? run.task_type}
                    </td>
                    <td className="py-3 pr-4">
                      {run.user_id ? `用户 #${run.user_id}` : "系统"}
                    </td>
                    <td className="py-3 pr-4 text-[12px]">
                      {run.actor_kind
                        ? `${ACTOR_LABELS[run.actor_kind] ?? run.actor_kind}${run.slot_id ? ` · ${run.slot_id}` : ""}`
                        : "—"}
                    </td>
                    <td className="py-3 pr-4">
                      <span className={run.status === "failed" ? "text-red-600" : ""}>
                        {AGENT_STATUS_LABELS[run.status] ?? run.status}
                      </span>
                      {run.error_summary ? (
                        <span className="ml-2 text-[12px] text-ink-subtle" title={run.error_summary}>
                          {run.error_summary.slice(0, 20)}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-[240px] truncate py-3 pr-4" title={run.input_summary}>
                      {run.input_summary}
                    </td>
                    <td className="py-3 pr-4 text-[12px]">
                      {new Date(run.created_at).toLocaleString("zh-CN")}
                    </td>
                    <td className="py-3 pr-4">
                      <Link
                        href={`/admin/agent/runs/${run.agent_run_id}`}
                        className="co-focusable text-brand hover:underline"
                      >
                        调用链
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.length === 0 ? (
            <EmptyState
              title="暂无运行记录"
              description="当前筛选条件下没有 Agent 运行。用户使用智能功能或系统调度触发后此处展示。"
            />
          ) : (
            <>
              <p className="text-[12px] text-ink-subtle">共 {state.data?.total ?? 0} 条</p>
              {(state.data?.total ?? 0) > PAGE_SIZE ? (
                <Pagination
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={state.data?.total ?? 0}
                  onChange={setPage}
                />
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
