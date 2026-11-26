"use client";

import { useState, type FormEvent } from "react";

import {
  fetchMcpCalls,
  type McpCallStatus,
} from "@/api/admin-mcp";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingSkeleton,
  Pagination,
  Select,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";

const PAGE_SIZE = 20;

const STATUS_LABELS: Record<McpCallStatus, string> = {
  succeeded: "成功",
  failed: "失败",
  denied: "拒绝",
  unregistered: "未注册",
  rejected: "限流或校验拒绝",
};

interface AppliedFilters {
  client: string;
  tool: string;
  status: "" | McpCallStatus;
}

export function AdminMcpCallsView() {
  const [clientDraft, setClientDraft] = useState("");
  const [toolDraft, setToolDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState<"" | McpCallStatus>("");
  const [filters, setFilters] = useState<AppliedFilters>({ client: "", tool: "", status: "" });
  const [page, setPage] = useState(1);

  const state = useAsyncData(
    () => fetchMcpCalls({
      page,
      page_size: PAGE_SIZE,
      client_name: filters.client || undefined,
      tool_name: filters.tool || undefined,
      status: filters.status || undefined,
    }),
    [filters.client, filters.tool, filters.status, page],
  );
  const items = state.data?.items ?? [];
  const total = state.data?.total ?? 0;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters({
      client: clientDraft.trim(),
      tool: toolDraft.trim(),
      status: statusDraft,
    });
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[22px] font-semibold text-ink">MCP 调用审计</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          仅展示脱敏参数、结果摘要与 trace，不展示外部凭证或业务原文。
        </p>
      </div>

      <form
        onSubmit={applyFilters}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-canvas p-4"
      >
        <div className="w-[180px]">
          <Input
            label="客户端"
            value={clientDraft}
            onChange={(event) => setClientDraft(event.target.value)}
            placeholder="客户端名称"
          />
        </div>
        <div className="w-[180px]">
          <Input
            label="工具"
            value={toolDraft}
            onChange={(event) => setToolDraft(event.target.value)}
            placeholder="工具名称"
          />
        </div>
        <div className="w-[180px]">
          <Select
            label="调用结果"
            value={statusDraft}
            onChange={(event) => setStatusDraft(event.target.value as "" | McpCallStatus)}
            options={[
              { value: "", label: "全部结果" },
              ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <Button type="submit">筛选</Button>
      </form>

      {state.isLoading ? <LoadingSkeleton variant="detail" count={3} /> : null}
      {state.error !== null ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : null}

      {!state.isLoading && state.error === null ? (
        items.length === 0 ? (
          <EmptyState
            title="暂无 MCP 调用"
            description="外部 MCP 工具被调用或拒绝后，脱敏审计会显示在这里。"
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line bg-canvas">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line text-[12px] text-ink-subtle">
                    <th scope="col" className="py-3 pl-5 pr-4 font-medium">时间</th>
                    <th scope="col" className="py-3 pr-4 font-medium">客户端</th>
                    <th scope="col" className="py-3 pr-4 font-medium">工具</th>
                    <th scope="col" className="py-3 pr-4 font-medium">结果</th>
                    <th scope="col" className="py-3 pr-4 font-medium">摘要</th>
                    <th scope="col" className="py-3 pr-4 font-medium">耗时</th>
                    <th scope="col" className="py-3 pr-4 font-medium">trace</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-line-subtle text-[13px]">
                      <td className="whitespace-nowrap py-3 pl-5 pr-4 text-[12px] text-ink-subtle">
                        {new Date(item.created_at).toLocaleString("zh-CN")}
                      </td>
                      <td className="py-3 pr-4">{item.client_name}</td>
                      <td className="py-3 pr-4 font-mono text-[12px]">{item.tool_name}</td>
                      <td className={`py-3 pr-4 ${item.status === "succeeded" ? "" : "text-danger-ink"}`}>
                        {STATUS_LABELS[item.status] ?? item.status}
                      </td>
                      <td className="max-w-[300px] py-3 pr-4 text-[12px] text-ink-subtle">
                        <span className="block truncate" title={item.args_summary}>
                          参数：{item.args_summary || "—"}
                        </span>
                        <span
                          className="block truncate"
                          title={item.error_summary ?? item.result_summary ?? ""}
                        >
                          {item.error_summary ? `错误：${item.error_summary}` : `结果：${item.result_summary ?? "—"}`}
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4">{item.duration_ms}ms</td>
                      <td className="max-w-[180px] truncate py-3 pr-4 font-mono text-[11px]" title={item.trace_id}>
                        {item.trace_id || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-ink-subtle">共 {total} 条</p>
              {total > PAGE_SIZE ? (
                <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
              ) : null}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
