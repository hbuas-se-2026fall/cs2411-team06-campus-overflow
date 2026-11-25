// T-21C 运行中人工控制门：开关关闭保持现状、暂停/恢复/取消、引导顺序与本地兜底
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRunControlGate,
  type RunControlClient,
  type RunControlSnapshot,
} from "../src/loop/run-control-gate";
import { RunStoppedError } from "../src/loop/abort";

const running = (): RunControlSnapshot => ({ enabled: true, state: "running", revision: 0, commands: [] });

const snapshot = (overrides: Partial<RunControlSnapshot>): RunControlSnapshot => ({
  ...running(), ...overrides,
});

const fakeClient = (queue: Array<RunControlSnapshot | Error>) => {
  const getRunControl = vi.fn(async () => {
    const next = queue.shift() ?? running();
    if (next instanceof Error) throw next;
    return next;
  });
  const ackRunControl = vi.fn(async (_runId: string, ids: readonly number[]) => ids.length);
  return { client: { getRunControl, ackRunControl } as RunControlClient, getRunControl, ackRunControl };
};

afterEach(() => { vi.restoreAllMocks(); });

describe("运行控制门（T-21C）", () => {
  it("开关关闭（后端 enabled=false）后不再轮询，也不产生事件", async () => {
    const fake = fakeClient([snapshot({ enabled: false })]);
    const events: string[] = [];
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(), recordEvent: async (type) => { events.push(type); },
    });
    await gate.checkpoint();
    await gate.checkpoint();
    expect(fake.getRunControl).toHaveBeenCalledTimes(1);
    expect(fake.ackRunControl).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(gate.takeGuidance()).toEqual([]);
  });

  it("暂停后按 2s 间隔轮询，恢复事件只记录一次", async () => {
    const fake = fakeClient([
      snapshot({ state: "paused", revision: 1, commands: [{ id: 1, revision: 1, action: "pause" }] }),
      snapshot({ state: "running", revision: 2, commands: [{ id: 2, revision: 2, action: "resume" }] }),
    ]);
    const events: string[] = [];
    const onCancel = vi.fn();
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel, recordEvent: async (type) => { events.push(type); },
      sleep: async () => undefined,
    });
    await gate.checkpoint();
    expect(events).toEqual(["control_pause", "control_resume"]);
    expect(onCancel).not.toHaveBeenCalled();
    expect(fake.ackRunControl.mock.calls.map(([, ids]) => [...ids])).toEqual([[1], [2]]);
  });

  it("取消命令中止运行并抛 RunStoppedError", async () => {
    const fake = fakeClient([
      snapshot({ state: "cancelled", revision: 1, commands: [{ id: 1, revision: 1, action: "cancel" }] }),
    ]);
    const events: string[] = [];
    const onCancel = vi.fn();
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel, recordEvent: async (type) => { events.push(type); },
    });
    await expect(gate.checkpoint()).rejects.toBeInstanceOf(RunStoppedError);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["control_cancel"]);
  });

  it("引导按命令顺序累积并注入下一次提示，只 ack 一次", async () => {
    const fake = fakeClient([
      snapshot({ state: "paused", revision: 1, commands: [{ id: 1, revision: 1, action: "pause" }] }),
      snapshot({ state: "paused", revision: 2, commands: [
        { id: 2, revision: 2, action: "guidance", guidance_text: "先核对来源", guidance_digest: "d2" },
        { id: 3, revision: 3, action: "guidance", guidance_text: "再看课程范围", guidance_digest: "d3" },
      ] }),
      snapshot({ state: "running", revision: 4, commands: [{ id: 4, revision: 4, action: "resume" }] }),
    ]);
    const events: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(), recordEvent: async (type) => { events.push(type); },
      sleep: async () => undefined,
    });
    await gate.checkpoint();
    expect(gate.takeGuidance()).toEqual(["先核对来源", "再看课程范围"]);
    expect(events).toEqual(["control_pause", "control_guidance", "control_guidance", "control_resume"]);
    expect(fake.ackRunControl.mock.calls.map(([, ids]) => [...ids])).toEqual([[1], [2, 3], [4]]);
    expect(gate.takeGuidance()).toEqual([]);
    expect(info).toHaveBeenCalled();
  });

  it("暂停超过本地兜底（30 分钟）自动取消并标记 pause_timeout", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    let clock = 0;
    const fake = fakeClient([
      snapshot({ state: "paused", revision: 1, commands: [{ id: 1, revision: 1, action: "pause" }] }),
      snapshot({ state: "paused", revision: 1 }),
      snapshot({ state: "paused", revision: 1 }),
    ]);
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(), pauseTimeoutMs: 100, now: () => (clock += 60),
      sleep: async () => undefined,
    });
    await expect(gate.checkpoint()).rejects.toMatchObject({
      kind: "pause_timeout", summary: "暂停超时，任务已取消",
    });
  });

  it("后端系统取消命令同样标记 pause_timeout，管理员取消保持 cancelled", async () => {
    const system = fakeClient([
      snapshot({ state: "cancelled", revision: 2, commands: [
        { id: 1, revision: 2, action: "cancel", requested_by: null, trace_id: "system:pause_timeout" },
      ] }),
    ]);
    const systemGate = createRunControlGate({
      client: system.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(),
    });
    await expect(systemGate.checkpoint()).rejects.toMatchObject({ kind: "pause_timeout" });

    const admin = fakeClient([
      snapshot({ state: "cancelled", revision: 2, commands: [
        { id: 1, revision: 2, action: "cancel", requested_by: 9, trace_id: "admin-9" },
      ] }),
    ]);
    const adminGate = createRunControlGate({
      client: admin.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(),
    });
    await expect(adminGate.checkpoint()).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("拉取失败不误停：保持运行并继续后续检查", async () => {
    const fake = fakeClient([new Error("timeout"), snapshot({ state: "running" })]);
    const events: string[] = [];
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(), recordEvent: async (type) => { events.push(type); },
    });
    await expect(gate.checkpoint()).resolves.toBeUndefined();
    await expect(gate.checkpoint()).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(fake.getRunControl).toHaveBeenCalledTimes(2);
  });

  it("暂停期间网络失败保持暂停，只有后端明确 running 才恢复", async () => {
    const fake = fakeClient([
      snapshot({ state: "paused", revision: 1, commands: [{ id: 1, revision: 1, action: "pause" }] }),
      new Error("network down"),
      snapshot({ state: "paused", revision: 1 }),
      snapshot({ state: "running", revision: 2, commands: [{ id: 2, revision: 2, action: "resume" }] }),
    ]);
    const events: string[] = [];
    const gate = createRunControlGate({
      client: fake.client, agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(), recordEvent: async (type) => { events.push(type); },
      sleep: async () => undefined, pauseTimeoutMs: 60_000,
    });

    await gate.checkpoint();

    expect(events).toEqual(["control_pause", "control_resume"]);
    expect(fake.getRunControl).toHaveBeenCalledTimes(4);
  });

  it("暂停期间拉取超时保持暂停，超时结果不当作恢复", async () => {
    let calls = 0;
    const getRunControl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return snapshot({ state: "paused", revision: 1 });
      if (calls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return snapshot({ state: "running", revision: 2 });
      }
      return snapshot({ state: "running", revision: 2 });
    });
    const ackRunControl = vi.fn(async (_runId: string, ids: readonly number[]) => ids.length);
    const events: string[] = [];
    const gate = createRunControlGate({
      client: { getRunControl, ackRunControl } as RunControlClient,
      agentRunId: "run-1", traceId: "trace-1" as never,
      onCancel: vi.fn(), recordEvent: async (type) => { events.push(type); },
      sleep: async () => undefined, requestTimeoutMs: 5, pauseTimeoutMs: 60_000,
    });

    await gate.checkpoint();

    expect(events).toEqual(["control_pause", "control_resume"]);
    expect(getRunControl).toHaveBeenCalledTimes(3);
  });
});
