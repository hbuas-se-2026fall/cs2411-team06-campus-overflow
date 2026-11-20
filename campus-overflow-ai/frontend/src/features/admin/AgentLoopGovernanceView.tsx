"use client";

import Link from "next/link";

import { fetchAgentRunTrace, fetchAgentRuns } from "@/api/agent-runs";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";

import {
  AGENT_EVENT_LABELS,
  AGENT_STATUS_LABELS,
  AGENT_TASK_TYPE_LABELS,
} from "./agentLabels";

const LOOP_STAGES = [
  ["观察与发现", "读取内容与当前版本"],
  ["规划动作", "模型提出受控动作建议"],
  ["人工审批", "逐项确认动作、参数与目标"],
  ["受控执行", "后端复核后原子执行"],
  ["重新观察", "读取执行后的真实状态"],
  ["效果评估", "判断是否达到治理目标"],
  ["终结或转人工", "完成、进入下一轮或交人工"],
] as const;

const SANDBOXES = [
  {
    name: "测试数据库沙箱",
    purpose: "验证 MySQL 并发、迁移、故障注入与 Workflow 状态边界",
    boundary: "仅映射本机端口；使用独立测试数据卷，不承载真实业务数据",
  },
  {
    name: "MCP 隔离沙箱",
    purpose: "验证只读 MCP 工具与外部客户端接入边界",
    boundary: "非 root、只读根文件系统、无数据库凭证，仅监听 127.0.0.1:8790",
  },
] as const;

function LatestRunTrace({ agentRunId }: { agentRunId: string }) {
  const state = useAsyncData(() => fetchAgentRunTrace(agentRunId), [agentRunId]);

  if (state.isLoading) return <LoadingSkeleton variant="list" count={2} />;
  if (state.error !== null || !state.data) {
    return <ErrorState message={state.error ?? "最近运行加载失败"} onRetry={state.reload} />;
  }

  return (
    <section aria-label="最近运行时间轴" className="mt-3 border-t border-line pt-3">
      <h4 className="text-[14px] font-semibold text-ink">最近运行时间轴</h4>
      {state.data.events.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-subtle">该运行暂无事件记录。</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {state.data.events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-mono text-ink-subtle">#{event.sequence_no}</span>
              <span className="text-ink">{AGENT_EVENT_LABELS[event.event_type] ?? event.event_type}</span>
              {event.tool_name ? <span className="rounded bg-panel px-1.5">{event.tool_name}</span> : null}
              {event.duration_ms !== null && event.duration_ms !== undefined ? (
                <span className="text-ink-subtle">{event.duration_ms}ms</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {state.data.tool_calls.length > 0 ? (
        <div className="mt-3">
          <h5 className="text-[12px] font-medium text-ink-muted">工具调用摘要</h5>
          <ul className="mt-1 flex flex-col gap-1 text-[12px] text-ink-subtle">
            {state.data.tool_calls.map((call) => (
              <li key={call.id}>
                {call.tool_name} · {call.result_summary ?? call.args_summary ?? "无摘要"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function AgentLoopGovernanceView() {
  const runsState = useAsyncData(
    () => fetchAgentRuns({ page: 1, page_size: 5 }),
    [],
  );
  const runs = runsState.data?.items ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold text-ink">Agent Loop 治理</h2>
          <p className="mt-2 max-w-[72ch] text-[13px] leading-relaxed text-ink-muted">
            模型只负责观察、规划和提出建议；高风险动作必须经过人工审批，并由业务后端复核后执行。
          </p>
        </div>
        <Link
          href="/admin/agent/runs"
          className="co-focusable rounded-md border border-line bg-canvas px-3 py-2 text-[13px] font-medium text-ink hover:bg-panel"
        >
          查看全部运行
        </Link>
      </div>

      <Card className="p-5">
        <h3 className="text-[16px] font-semibold text-ink">治理闭环</h3>
        <ol className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {LOOP_STAGES.map(([title, description], index) => (
            <li key={title} className="rounded-md border border-line bg-panel p-4">
              <span className="text-[12px] font-medium text-brand">步骤 {index + 1}</span>
              <p className="mt-1 text-[14px] font-semibold text-ink">{title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">{description}</p>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="flex flex-col gap-2 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[16px] font-semibold text-ink">治理预演 dry-run</h3>
          <span className="rounded-sm bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-strong">
            只读预演
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          复用人工审批前的目标状态与版本校验，只统计预计影响的问答与评论；不会创建工单、写审计或修改目标状态。
        </p>
        <p className="rounded-md bg-panel px-3 py-2 text-[12px] text-ink-subtle">
          版本不一致时拒绝继续；真正执行仍须人工审批，并由业务后端复核后完成。
        </p>
      </Card>

      <section aria-labelledby="sandboxes-title" className="flex flex-col gap-3">
        <div>
          <h3 id="sandboxes-title" className="text-[16px] font-semibold text-ink">
            隔离沙箱
          </h3>
          <p className="mt-1 text-[12px] text-ink-subtle">
            当前未接入在线状态探测，以下仅展示本地手动启动的验证环境与隔离边界。
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {SANDBOXES.map((sandbox) => (
            <Card key={sandbox.name} className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-[15px] font-semibold text-ink">{sandbox.name}</h4>
                <span className="rounded-sm bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-ink">
                  本地手动启动
                </span>
              </div>
              <p className="text-[13px] text-ink-muted">{sandbox.purpose}</p>
              <p className="rounded-md bg-panel px-3 py-2 text-[12px] text-ink-subtle">
                隔离边界：{sandbox.boundary}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-[16px] font-semibold text-ink">最近 Agent 运行</h3>
        {runsState.isLoading ? <LoadingSkeleton variant="list" count={3} /> : null}
        {runsState.error !== null ? (
          <ErrorState message={runsState.error} onRetry={runsState.reload} />
        ) : null}
        {!runsState.isLoading && runsState.error === null && runs.length === 0 ? (
          <EmptyState
            title="暂无 Agent 运行"
            description="用户使用智能功能或后台巡检触发后，这里会展示最近运行。"
          />
        ) : null}
        {!runsState.isLoading && runsState.error === null && runs.length > 0 ? (
          <ul className="divide-y divide-line">
            {runs.map((run) => (
              <li key={run.agent_run_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">
                    {AGENT_TASK_TYPE_LABELS[run.task_type] ?? run.task_type}
                    <span className="ml-2 font-normal text-ink-muted">
                      {AGENT_STATUS_LABELS[run.status] ?? run.status}
                    </span>
                  </p>
                  <p className="mt-1 truncate text-[12px] text-ink-subtle">{run.input_summary}</p>
                </div>
                <Link
                  href={`/admin/agent/runs/${encodeURIComponent(run.agent_run_id)}`}
                  className="co-focusable text-[13px] text-brand hover:underline"
                >
                  查看调用链
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {!runsState.isLoading && runsState.error === null && runs[0] ? (
          <LatestRunTrace agentRunId={runs[0].agent_run_id} />
        ) : null}
      </Card>
    </div>
  );
}
