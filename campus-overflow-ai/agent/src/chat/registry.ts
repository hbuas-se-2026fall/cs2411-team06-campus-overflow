// P0-3 本地运行登记表：同一实例内同用户同请求只允许一个运行；
// 运行与 HTTP 连接解耦，登记项保留 30 分钟，过期在下次访问时机会式清理。
import type { RunControl } from "../loop/run-control.js";
import type { RunContext } from "../observability/run-context.js";
import type { ChatEventStore } from "./event-store.js";

export interface LocalChatRun {
  readonly userId: number;
  readonly requestId: string;
  readonly control: RunControl;
  readonly context: RunContext;
  readonly store: ChatEventStore;
}

export const CHAT_RUN_TTL_MS = 30 * 60 * 1_000;

interface RegistryEntry {
  run: LocalChatRun;
  expiresAt: number;
}

export class ChatRunRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /** 同步占位：并发请求只有一个 created=true，其余复用同一运行。 */
  claim(
    userId: number,
    requestId: string,
    build: () => LocalChatRun,
  ): { run: LocalChatRun; created: boolean } {
    this.sweep();
    const key = this.key(userId, requestId);
    const existing = this.entries.get(key);
    if (existing) return { run: existing.run, created: false };
    const run = build();
    this.entries.set(key, { run, expiresAt: Date.now() + CHAT_RUN_TTL_MS });
    return { run, created: true };
  }

  get(userId: number, requestId: string): LocalChatRun | undefined {
    const key = this.key(userId, requestId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.run;
  }

  /** 命中本地运行才中止；跨实例取消由后端 cancel_requested 轮询兜底。 */
  cancel(userId: number, requestId: string): boolean {
    const run = this.get(userId, requestId);
    run?.control.cancel();
    return run !== undefined;
  }

  remove(userId: number, requestId: string): void {
    this.entries.delete(this.key(userId, requestId));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private key(userId: number, requestId: string): string {
    return `${userId}:${requestId}`;
  }
}
