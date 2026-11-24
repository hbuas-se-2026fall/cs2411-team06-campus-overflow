// SA-07C：运行配置读取的缓存、失败降级与格式校验（ADR-010）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readPlanParallelEnabled,
  resetRuntimeConfigCache,
  RUNTIME_CONFIG_TTL_MS,
} from "../src/runtime-config";

const envelope = (enabled: boolean) => ({
  code: 200,
  data: { plan_parallel_enabled: enabled },
  message: "success",
});

const respond = (body: unknown, status = 200) => vi.fn(async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetRuntimeConfigCache();
});

beforeEach(() => {
  resetRuntimeConfigCache();
});

describe("计划内并行运行配置", () => {
  it("读取后端开关并在 TTL 内复用缓存", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const fetchMock = respond(envelope(true));
    vi.stubGlobal("fetch", fetchMock);

    expect(await readPlanParallelEnabled("trace-a")).toBe(true);
    expect(await readPlanParallelEnabled("trace-b")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/internal/agent/runtime-config");
    expect(new Headers(init.headers).get("x-trace-id")).toBe("trace-a");
  });

  it("TTL 过期后重新读取", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const fetchMock = respond(envelope(true));
    vi.stubGlobal("fetch", fetchMock);

    await readPlanParallelEnabled("trace-a");
    vi.setSystemTime(1_000 + RUNTIME_CONFIG_TTL_MS + 1);
    await readPlanParallelEnabled("trace-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("读取失败且无缓存时按默认关闭", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("backend down"); }));
    expect(await readPlanParallelEnabled("trace-a")).toBe(false);
  });

  it("读取失败时沿用最后一次有效值", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const fetchMock = respond(envelope(true));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readPlanParallelEnabled("trace-a")).toBe(true);

    vi.setSystemTime(1_000 + RUNTIME_CONFIG_TTL_MS + 1);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("backend down"); }));
    expect(await readPlanParallelEnabled("trace-a")).toBe(true);
  });

  it.each([
    ["非 200 响应", respond({ code: 500, data: null, message: "err" }, 500)],
    ["响应格式无效", respond({ code: 200, data: { plan_parallel_enabled: "yes" }, message: "success" })],
  ])("%s 按默认关闭", async (_label, fetchMock) => {
    vi.stubGlobal("fetch", fetchMock);
    expect(await readPlanParallelEnabled("trace-a")).toBe(false);
  });
});
