import { createInternalClient, resolveInternalConfig } from "../internal-client.js";
import { randomUUID } from "node:crypto";
import { createSlotLeaseClient } from "../backend-lease.js";
import { createGovernanceWorkerClient } from "../governance-worker-client.js";
import { getKnowledgeCatalog } from "../knowledge/runtime.js";
import { startGovernanceExecutor } from "../scheduler/governance-executor.js";
import { startModerationPatrolScheduler } from "../scheduler/moderation-patrol.js";
import { startNightlyConsolidationScheduler } from "../scheduler/nightly-scheduler.js";
import { buildQaSnapshot, qaSnapshotSlots } from "../knowledge/qa-snapshot.js";
import { asTraceId } from "../types/index.js";
import { startWeeklyReportScheduler } from "../scheduler/weekly-report.js";
import { createBackgroundServices } from "./background-services.js";
import { startMcpService } from "./mcp-service.js";

export const startKnowledgeService = (catalog: { start: (intervalMs: number) => Promise<void>; stop: () => void } | undefined) => {
  const starting = catalog?.start(Number(process.env.KNOWLEDGE_RECONCILE_MS ?? 60_000)).catch(() => {
    console.error(JSON.stringify({ event: "knowledge_catalog_start_failed" }));
  });
  // 不阻塞健康探针；关闭时等待首次扫描，并清理可能在等待期间创建的watcher。
  return async () => { catalog?.stop(); await starting; catalog?.stop(); };
};

export const createAgentBackgroundServices = () => createBackgroundServices([
  () => startKnowledgeService(getKnowledgeCatalog()),
  () => startWeeklyReportScheduler({ createClient: () => createInternalClient({ ...resolveInternalConfig(), fetchImpl: fetch }) }),
  () => startModerationPatrolScheduler({ createClient: () => createInternalClient({ ...resolveInternalConfig(), fetchImpl: fetch }) }),
  () => startNightlyConsolidationScheduler({
    createClient: () => createInternalClient({ ...resolveInternalConfig(), fetchImpl: fetch }),
    // P0-1：夜间整理跨实例互斥，默认容量 1；后端不可用时本次跳过，避免重复执行
    acquireLease: async () => {
      const leases = createSlotLeaseClient(resolveInternalConfig(), fetch);
      const configured = Number(process.env.AGENT_GLOBAL_MAINTENANCE_LIMIT ?? "1");
      const capacity = Number.isInteger(configured) && configured > 0 ? configured : 1;
      const lease = await leases.claim({
        kind: "maintenance",
        capacity,
        jobId: `nightly:${new Date().toISOString().slice(0, 10)}`,
        instanceId: process.env.AGENT_INSTANCE_ID?.trim() || "agent-nightly",
        ttlSeconds: 900,
      });
      if (!lease) return null;
      return { release: () => leases.release(lease) };
    },
    getCatalog: getKnowledgeCatalog,
    syncQaSnapshot: async () => {
      const client = createInternalClient({ ...resolveInternalConfig(), fetchImpl: fetch });
      const snapshot = await buildQaSnapshot(client, asTraceId(randomUUID()));
      qaSnapshotSlots.stage(snapshot);
      qaSnapshotSlots.promote();
      return { version: snapshot.version, items: snapshot.items.length };
    },
  }),
  () => startGovernanceExecutor(signal => createGovernanceWorkerClient({
    ...resolveInternalConfig(), executorToken: process.env.GOVERNANCE_EXECUTOR_TOKEN ?? "", signal,
  })),
  startMcpService,
]);
