"use client";

// 运行中人工控制（T-21E / RC-R01～R05）：状态回显 + 暂停/继续/取消 + 暂停期间追加引导。
// 仅治理扫描与管理员聊天可控制；其他任务保持只读，避免误导管理员点击必然失败的操作。
import { useCallback, useEffect, useRef, useState } from "react";

import {
  addRunGuidance,
  applyRunControl,
  fetchRunControl,
  type RunControlAction,
  type RunControlItem,
} from "@/api/agent-runs";
import { Button, Card } from "@/shared/components";

const STATE_LABELS: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  cancelled: "已取消",
};

const ACTION_LABELS: Record<RunControlAction, string> = {
  pause: "暂停运行",
  resume: "继续运行",
  cancel: "取消运行",
};

const CONTROLLABLE_TASK_TYPES = new Set(["moderation_scan", "chat"]);
const GUIDANCE_MAX_LENGTH = 2000;

export function AdminRunControlPanel({
  agentRunId,
  taskType,
  isRunActive,
}: {
  agentRunId: string;
  taskType: string;
  isRunActive: boolean;
}) {
  const supported = CONTROLLABLE_TASK_TYPES.has(taskType);
  const [control, setControl] = useState<RunControlItem | null>(null);
  const [isLoading, setIsLoading] = useState(supported);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<RunControlAction | "guidance" | null>(null);
  const [guidance, setGuidance] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!supported) return;
    try {
      const next = await fetchRunControl(agentRunId);
      if (mounted.current) {
        setControl(next);
        setLoadError(null);
      }
    } catch (error) {
      if (mounted.current) {
        setLoadError(error instanceof Error ? error.message : "控制状态加载失败");
      }
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, [agentRunId, supported]);

  // 先让出同步执行栈再加载：react-hooks 禁止在 effect 内同步 setState（同 useAsyncData）
  useEffect(() => {
    async function run(): Promise<void> {
      await Promise.resolve();
      if (!mounted.current) return;
      await load();
    }
    void run();
  }, [load]);

  // 暂停期间轮询：管理员能看到服务端 30 分钟超时自动取消后的状态变化。
  useEffect(() => {
    if (control?.state !== "paused") return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [control?.state, load]);

  const runAction = async (action: RunControlAction) => {
    if (!control) return;
    setPendingAction(action);
    setActionError(null);
    setNotice(null);
    try {
      const next = await applyRunControl(agentRunId, action, control.revision);
      setControl(next);
      setNotice(`已提交：${ACTION_LABELS[action]}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "控制操作失败");
      await load();
    } finally {
      setPendingAction(null);
    }
  };

  const submitGuidance = async () => {
    if (!control) return;
    const text = guidance.trim();
    if (!text) {
      setActionError("请输入引导内容");
      return;
    }
    setPendingAction("guidance");
    setActionError(null);
    setNotice(null);
    try {
      const next = await addRunGuidance(agentRunId, text, control.revision);
      setControl(next);
      setGuidance("");
      setNotice("引导已追加，将在下一次模型调用前注入");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "引导追加失败");
      await load();
    } finally {
      setPendingAction(null);
    }
  };

  if (!supported) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        <h3 className="text-[15px] font-semibold text-ink">运行控制</h3>
        <p className="text-[13px] text-ink-subtle">
          该任务类型不支持运行中人工控制（仅治理扫描与管理员聊天）。
        </p>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="flex flex-col gap-3 p-5" aria-busy="true">
        <h3 className="text-[15px] font-semibold text-ink">运行控制</h3>
        <div className="h-4 w-40 animate-pulse rounded bg-panel motion-reduce:animate-none" />
        <div className="h-9 w-56 animate-pulse rounded bg-panel motion-reduce:animate-none" />
        <p className="text-[12px] text-ink-subtle">控制状态加载中…</p>
      </Card>
    );
  }

  if (loadError && !control) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        <h3 className="text-[15px] font-semibold text-ink">运行控制</h3>
        <p className="text-[13px] text-red-600">{loadError}</p>
        <div>
          <Button variant="ghost" size="sm" onClick={() => { setIsLoading(true); void load(); }}>
            重新加载
          </Button>
        </div>
      </Card>
    );
  }

  if (!control) return null;

  if (!isRunActive) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        <h3 className="text-[15px] font-semibold text-ink">运行控制</h3>
        <p className="text-[13px] text-ink-subtle">运行已结束，无需控制。</p>
      </Card>
    );
  }

  const isBusy = pendingAction !== null;
  const isPaused = control.state === "paused";
  const isCancelled = control.state === "cancelled";

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-ink">运行控制</h3>
        <span className="text-[12px] text-ink-subtle">版本 v{control.revision}</span>
      </div>
      <p className="text-[13px] text-ink-muted">
        当前状态：
        <span className={isPaused ? "font-medium text-amber-700" : isCancelled ? "text-red-600" : ""}>
          {STATE_LABELS[control.state] ?? control.state}
        </span>
        {isPaused && control.pause_deadline ? (
          <> · 暂停截止 {new Date(control.pause_deadline).toLocaleString("zh-CN")}</>
        ) : null}
      </p>
      <p className="text-[12px] text-ink-subtle">
        暂停在下一个步骤或模型调用边界生效；所有控制操作都会写入审计日志。
      </p>

      <div className="flex flex-wrap gap-2">
        {control.state === "running" ? (
          <Button
            variant="ghost"
            onClick={() => { void runAction("pause"); }}
            isLoading={pendingAction === "pause"}
            disabled={isBusy}
          >
            暂停运行
          </Button>
        ) : null}
        {isPaused ? (
          <Button
            onClick={() => { void runAction("resume"); }}
            isLoading={pendingAction === "resume"}
            disabled={isBusy}
          >
            继续运行
          </Button>
        ) : null}
        {!isCancelled ? (
          <Button
            variant="danger"
            onClick={() => { void runAction("cancel"); }}
            isLoading={pendingAction === "cancel"}
            disabled={isBusy}
          >
            取消运行
          </Button>
        ) : null}
      </div>

      {isPaused ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="run-guidance" className="text-[13px] font-medium text-ink">
            追加引导（暂停期间可用，恢复后注入下一次模型调用）
          </label>
          <textarea
            id="run-guidance"
            value={guidance}
            maxLength={GUIDANCE_MAX_LENGTH}
            onChange={(event) => setGuidance(event.target.value)}
            rows={3}
            className="co-focusable w-full rounded-md border border-line bg-canvas px-3 py-2 text-[13px] text-ink"
            placeholder="例如：优先核对内容是否涉及人身攻击，不要扩大检索范围"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-ink-subtle">
              {guidance.length}/{GUIDANCE_MAX_LENGTH}
            </span>
            <Button
              size="sm"
              onClick={() => { void submitGuidance(); }}
              isLoading={pendingAction === "guidance"}
              disabled={isBusy || !guidance.trim()}
            >
              追加引导
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="text-[13px] text-emerald-700">{notice}</p> : null}
      {actionError ? <p className="text-[13px] text-red-600">{actionError}</p> : null}
      {loadError && control ? (
        <p className="text-[12px] text-ink-subtle">状态刷新失败：{loadError}，将按暂停状态定时重试。</p>
      ) : null}
    </Card>
  );
}
