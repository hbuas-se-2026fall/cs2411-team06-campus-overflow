"use client";

import Link from "next/link";
import { useState } from "react";

import {
  callUpstreamMcpTool,
  fetchUpstreamMcpConfig,
  type UpstreamMcpCallResult,
} from "@/api/admin-mcp";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Select,
  Textarea,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";

export function AdminMcpUpstreamView() {
  const state = useAsyncData(() => fetchUpstreamMcpConfig(), []);
  const [serverName, setServerName] = useState("");
  const [toolName, setToolName] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpstreamMcpCallResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const servers = state.data?.servers ?? [];
  const enabledServers = servers.filter((server) => server.enabled);
  const activeServer = enabledServers.find((server) => server.name === serverName) ?? enabledServers[0];
  const activeTool = activeServer?.tools.find((tool) => tool.name === toolName) ?? activeServer?.tools[0];

  function parseArguments(): Record<string, unknown> | null {
    if (!argsText.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(argsText);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        setError("参数必须是 JSON 对象");
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError("参数必须是合法 JSON 对象");
      return null;
    }
  }

  async function executeCall() {
    if (!activeServer || !activeTool) return;
    const args = parseArguments();
    if (args === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await callUpstreamMcpTool({
        server: activeServer.name,
        tool: activeTool.name,
        arguments: args,
      });
      setResult(next);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "外部 MCP 调用失败");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  function requestCall() {
    if (!activeTool) return;
    if (activeTool.risk !== "low" && !activeTool.confirmed) {
      setError("该高风险工具尚未在部署配置中确认启用");
      return;
    }
    if (activeTool.risk === "high") {
      setConfirming(true);
      return;
    }
    void executeCall();
  }

  if (state.isLoading) return <LoadingSkeleton variant="detail" count={4} />;
  if (state.error !== null) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[22px] font-semibold text-ink">外部 MCP 接入</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          配置由部署环境提供并脱敏展示；高风险工具只生成待确认工单，确认前不会执行。
        </p>
      </div>

      {servers.length === 0 ? (
        <EmptyState
          title="未配置外部 MCP Server"
          description="在 Agent 部署环境配置 MCP_UPSTREAM_SERVERS 后，这里会显示脱敏服务与工具清单。"
        />
      ) : (
        <section aria-label="外部 MCP 配置" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {servers.map((server) => (
            <Card key={server.name} className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[16px] font-semibold text-ink">{server.name}</h3>
                <span className={`rounded-sm px-2 py-0.5 text-[11px] font-medium ${
                  server.enabled
                    ? "bg-success-soft text-success-ink"
                    : "bg-panel text-ink-subtle"
                }`}>
                  {server.enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <p className="font-mono text-[12px] text-ink-subtle">{server.origin || "来源不可解析"}</p>
              {server.tools.length === 0 ? (
                <p className="text-[13px] text-ink-subtle">无已登记工具</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {server.tools.map((tool) => (
                    <li key={tool.name} className="rounded-md border border-line bg-panel px-3 py-2 text-[13px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{tool.name}</span>
                        <span className={tool.risk === "high" ? "text-danger-ink" : "text-ink-muted"}>
                          {tool.risk === "high" ? "高风险" : "低风险"}
                        </span>
                        <span className="text-[12px] text-ink-subtle">
                          {tool.confirmed ? "已确认启用" : "未确认"}
                        </span>
                        {tool.model_visible ? (
                          <span className="rounded bg-brand-soft px-1.5 text-[11px] text-brand-strong">
                            模型可见
                          </span>
                        ) : (
                          <span className="text-[11px] text-ink-subtle">仅管理员通道</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </section>
      )}

      {enabledServers.length > 0 && activeServer && activeTool ? (
        <Card className="flex flex-col gap-3 p-5">
          <h3 className="text-[16px] font-semibold text-ink">管理员调用通道</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Select
              label="服务"
              value={activeServer.name}
              onChange={(event) => {
                setServerName(event.target.value);
                setToolName("");
                setResult(null);
                setError(null);
              }}
              options={enabledServers.map((server) => ({ value: server.name, label: server.name }))}
            />
            <Select
              label="工具"
              value={activeTool.name}
              onChange={(event) => {
                setToolName(event.target.value);
                setResult(null);
                setError(null);
              }}
              options={activeServer.tools.map((tool) => ({
                value: tool.name,
                label: `${tool.name}（${tool.risk === "high" ? "高风险" : "低风险"}）`,
              }))}
            />
          </div>
          <Textarea
            label="调用参数（JSON）"
            rows={5}
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            hint="只填写 JSON 对象；参数摘要会进入审计，请勿放密码、令牌或隐私原文。"
          />
          {activeTool.risk === "high" && !activeTool.confirmed ? (
            <p className="text-[12px] text-danger-ink">
              该高风险工具未在部署配置中确认启用，当前不可调用。
            </p>
          ) : null}
          <div>
            <Button
              onClick={requestCall}
              disabled={busy || (activeTool.risk === "high" && !activeTool.confirmed)}
              isLoading={busy}
            >
              调用工具
            </Button>
          </div>
          {error ? <p role="alert" className="text-[13px] text-danger-ink">{error}</p> : null}
          {result ? (
            <div className="rounded-md border border-line bg-panel p-4 text-[13px]">
              {result.status === "executed" ? (
                <>
                  <p className="font-medium text-success-ink">调用完成</p>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[12px] text-ink-muted">
                    {JSON.stringify(result.result, null, 2)}
                  </pre>
                </>
              ) : (
                <p>
                  已生成待确认工单 #{result.case_id}，确认前不会执行。
                  <Link
                    href={`/admin/moderation/approvals?case_id=${result.case_id}`}
                    className="co-focusable ml-2 text-brand hover:underline"
                  >
                    前往审批
                  </Link>
                </p>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirming}
        busy={busy}
        title="确认调用高风险管理工具"
        description={`将调用 ${activeServer?.name ?? ""}/${activeTool?.name ?? ""}。后端只会生成待确认工单，不会立即执行。`}
        confirmLabel="确认提交"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void executeCall()}
      />
    </div>
  );
}
