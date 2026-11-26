"use client";

import { useState } from "react";

import {
  getPlanParallelSetting,
  updatePlanParallelSetting,
  type PlanParallelSetting,
} from "@/api/runtime-settings";
import {
  Card,
  ErrorState,
  LoadingSkeleton,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";

export function AdminRuntimeSettingsView() {
  const state = useAsyncData(() => getPlanParallelSetting(), []);
  const [updated, setUpdated] = useState<PlanParallelSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setting = updated ?? state.data;

  async function toggle() {
    if (!setting || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updatePlanParallelSetting(!setting.plan_parallel_enabled);
      setUpdated(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "设置更新失败");
    } finally {
      setBusy(false);
    }
  }

  if (state.isLoading) return <LoadingSkeleton variant="detail" count={2} />;
  if (state.error !== null) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }
  if (!setting) return null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[22px] font-semibold text-ink">运行设置</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          控制 Agent 计划内无依赖只读步骤是否并行执行。默认关闭。
        </p>
      </div>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[68ch]">
            <h3 className="text-[16px] font-semibold text-ink">计划内并行</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              开启后仅并发行内无依赖的只读步骤；审批、写操作和失败传播规则不变。
              当前为{setting.plan_parallel_enabled ? "开启" : "关闭"}状态。
            </p>
            <p className="mt-2 text-[12px] text-ink-subtle">
              Agent 下一次配置刷新后生效，最长约 30 秒。
              {setting.updated_at
                ? ` 最近更新：${new Date(setting.updated_at).toLocaleString("zh-CN")}`
                : " 从未修改，使用默认关闭。"}
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[14px] font-medium text-ink">
            <input
              type="checkbox"
              role="checkbox"
              aria-label="启用计划内并行"
              checked={setting.plan_parallel_enabled}
              disabled={busy}
              onChange={() => { void toggle(); }}
              className="h-5 w-5 accent-brand"
            />
            {setting.plan_parallel_enabled ? "当前已开启" : "当前已关闭"}
          </label>
        </div>

        {busy ? <p className="text-[13px] text-ink-subtle">正在保存并等待后端确认…</p> : null}
        {error ? <p role="alert" className="text-[13px] text-danger-ink">{error}</p> : null}
      </Card>
    </div>
  );
}
