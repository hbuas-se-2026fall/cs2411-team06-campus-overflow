// P0-3 可恢复流事件存储：先持久化再通知本地订阅者，事件与 SSE 顺序一致。
import type { ChatEventType, UserInternalClient } from "../internal-client.js";
import type { TraceId } from "../types/index.js";

export interface PersistedChatEvent {
  seq: number;
  eventType: ChatEventType;
  data: string;
}

export class ChatStreamPersistenceError extends Error {
  constructor(readonly requestId: string) {
    super("聊天记录写入失败");
    this.name = "ChatStreamPersistenceError";
  }
}

/**
 * 单次运行的追加事件缓冲。持久化失败立即抛错，调用方必须终止运行，
 * 不得继续向订阅者广播未落库内容或宣称可恢复。
 */
export class ChatEventStore {
  private seq = 0;
  private records: PersistedChatEvent[] = [];
  private closed = false;
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly client: UserInternalClient,
    readonly requestId: string,
    private readonly traceId: TraceId,
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async append(eventType: ChatEventType, payload: Record<string, unknown>): Promise<number> {
    const next = this.seq + 1;
    const data = JSON.stringify(payload);
    try {
      const ack = await this.client.appendChatStreamEvent(
        this.requestId, { seq: next, event_type: eventType, data }, this.traceId,
      );
      if (ack.seq !== next) throw new Error("事件序号错配");
    } catch {
      // 持久化失败后立刻关闭订阅：不补发未落库事件，也不宣称可恢复。
      this.closed = true;
      this.notify();
      throw new ChatStreamPersistenceError(this.requestId);
    }
    this.seq = next;
    this.records.push({ seq: next, eventType, data });
    if (eventType === "done" || eventType === "error") this.closed = true;
    this.notify();
    return next;
  }

  snapshotAfter(after: number): PersistedChatEvent[] {
    return this.records.filter((event) => event.seq > after);
  }

  /** 等待新事件或超时；关闭后立即返回，避免订阅循环空转。 */
  waitForChange(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.waiters.delete(finish);
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, timeoutMs);
      timer.unref();
      this.waiters.add(finish);
    });
  }

  private notify(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const finish of pending) finish();
  }
}
