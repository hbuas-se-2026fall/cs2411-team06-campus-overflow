// P0-1：治理任务先申请跨实例准入；拒绝时明确繁忙，问答任务不受影响。
import { describe, expect, it, vi } from "vitest";

import { PoolBusyError } from "../src/orchestrator/scheduler.js";
import { AgentPool } from "../src/runtime/agent-pool.js";

describe("治理全局准入", () => {
  it("全局容量满时拒绝且不进入本地槽位", async () => {
    const acquire = vi.fn().mockResolvedValue(null);
    const pool = new AgentPool({ admission: { acquire } });
    const run = vi.fn();

    await expect(pool.run("governance", "job-a", run)).rejects.toBeInstanceOf(PoolBusyError);
    expect(run).not.toHaveBeenCalled();
  });

  it("准入成功后执行任务并释放租约", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const acquire = vi.fn().mockResolvedValue({ release });
    const pool = new AgentPool({ admission: { acquire } });
    const run = vi.fn().mockResolvedValue("ok");

    await expect(pool.run("governance", "job-a", run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ slot_kind: "governance" }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("问答任务不申请全局治理租约", async () => {
    const acquire = vi.fn();
    const pool = new AgentPool({ admission: { acquire } });
    await pool.run("qa", "job-q", async () => "ok");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("注入问答准入后传递运行信号与排队通知，并在结束时释放", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const acquire = vi.fn().mockResolvedValue({ release });
    const pool = new AgentPool({ qaAdmission: { acquire } });
    const onWaiting = vi.fn();
    const signal = new AbortController().signal;

    await expect(pool.run("qa", "job-q", async () => "ok", { signal, onWaiting }))
      .resolves.toBe("ok");
    expect(acquire).toHaveBeenCalledWith("job-q", { signal, onWaiting });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("问答准入排队失败时不进入本地槽位", async () => {
    const acquire = vi.fn().mockRejectedValue(new Error("排队超时"));
    const pool = new AgentPool({ qaAdmission: { acquire } });
    const run = vi.fn();

    await expect(pool.run("qa", "job-q", run)).rejects.toThrow("排队超时");
    expect(run).not.toHaveBeenCalled();
  });
});
