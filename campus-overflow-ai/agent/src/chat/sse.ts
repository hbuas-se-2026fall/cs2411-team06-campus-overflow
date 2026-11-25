// P0-3 SSE 泵：本地缓冲订阅（同实例）与后端轮询回放（跨实例/断线续接）。
import type { SSEStreamingApi } from "hono/streaming";

import type { ChatEventType, UserInternalClient } from "../internal-client.js";
import { withUpstreamDeadline } from "../loop/abort.js";
import type { TraceId } from "../types/index.js";
import type { ChatEventStore, PersistedChatEvent } from "./event-store.js";

/** 续接总体截止：略大于 180 秒运行预算，覆盖跨实例事件落库延迟。 */
export const REPLAY_DEADLINE_MS = 200_000;
const WRITE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 500;
const LOCAL_WAIT_MS = 15_000;

const isTerminal = (eventType: string): boolean =>
  eventType === "done" || eventType === "error";

const writeEvent = async (
  stream: SSEStreamingApi, event: PersistedChatEvent,
): Promise<boolean> => {
  if (stream.aborted) return false;
  try {
    await withUpstreamDeadline(
      undefined,
      () => stream.writeSSE({
        id: String(event.seq), event: event.eventType, data: event.data,
      }),
      WRITE_TIMEOUT_MS,
    );
    return true;
  } catch {
    // 投递失败只结束本次连接；运行继续并可在续接时回放，不改写运行结果。
    console.error(JSON.stringify({ event: "agent_stream_delivery_failed" }));
    return false;
  }
};

/** 同实例订阅：从本地缓冲回放 after 之后的事件，再等待运行追加。 */
export const pumpStore = async (
  stream: SSEStreamingApi, store: ChatEventStore, after: number,
): Promise<void> => {
  let cursor = after;
  while (!stream.aborted) {
    const pending = store.snapshotAfter(cursor);
    if (pending.length === 0) {
      // 关闭后必须下次循环再取一次，避免终态恰好落在本轮快照之后被跳过。
      if (store.isClosed) return;
      await store.waitForChange(LOCAL_WAIT_MS);
      continue;
    }
    for (const event of pending) {
      if (!(await writeEvent(stream, event))) return;
      cursor = event.seq;
      if (isTerminal(event.eventType)) return;
    }
  }
};

const delay = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  timer.unref();
  signal?.addEventListener("abort", finish, { once: true });
});

/**
 * 跨实例续接：轮询后端已落库事件并原样回放，直到终态或总体截止。
 * 截止后正常结束连接（不伪造 done），由前端在次数/时限内再次续接。
 */
export const pumpBackend = async (
  stream: SSEStreamingApi,
  client: UserInternalClient,
  requestId: string,
  after: number,
  traceId: TraceId,
  signal?: AbortSignal,
): Promise<void> => {
  let cursor = after;
  const deadline = Date.now() + REPLAY_DEADLINE_MS;
  while (!stream.aborted && !signal?.aborted) {
    const snapshot = await client.readChatStream(requestId, cursor, traceId);
    for (const event of snapshot.events) {
      const ok = await writeEvent(stream, {
        seq: event.seq,
        eventType: event.event_type as ChatEventType,
        data: event.data,
      });
      if (!ok) return;
      cursor = event.seq;
      if (isTerminal(event.event_type)) return;
    }
    if (snapshot.status !== "running" || Date.now() >= deadline) return;
    await delay(POLL_INTERVAL_MS, signal);
  }
};
