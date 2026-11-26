// Agent 聊天请求统一封装：个人记忆按索引、摘要、详情逐层披露，
// 最终仅将选中的详情作为 browser_memory 只读注入；会话历史按预算截取。
// SSE 事件协议与 Agent routes/chat.ts 对齐：meta / delta / notice / done / error；
// P0-3：请求 id 幂等，断线后按事件 id 游标自动续接，主动取消会通知服务端终止运行。
import { prepareProgressiveMemory } from "@/features/agent-chat/progressive-memory";
import { historyForRequest, type SessionMessage } from "@/features/agent-chat/browser-sessions";
import { useSessionStore } from "@/shared/stores/session-store";

export interface AgentChatMeta {
  agentRunId: string;
  traceId: string;
  ai: boolean;
}

export interface AgentChatHandlers {
  onMeta?: (meta: AgentChatMeta) => void;
  /** 流式增量文本（每 delta 一次） */
  onDelta?: (text: string) => void;
}

export interface AgentChatOptions {
  signal?: AbortSignal;
  sessionId?: string;
  history?: SessionMessage[];
  learningContext?: { course_id?: number; trusted_tag_ids?: number[]; learning_event_id?: string };
}

export class AgentChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentChatError";
  }
}

const CHAT_PATH = "/api/agent/agent/chat";
const resumePath = (requestId: string): string =>
  `/api/agent/agent/chat/runs/${encodeURIComponent(requestId)}/stream`;
const cancelPath = (requestId: string): string =>
  `/api/agent/agent/chat/runs/${encodeURIComponent(requestId)}/cancel`;
/** 自动续接上限：单次回复最多续接 3 次，总时长不超过 200 秒（与 Agent 回放截止一致）。 */
const MAX_RESUME_ATTEMPTS = 3;
const RESUME_DEADLINE_MS = 200_000;

interface SseBlock {
  event: string;
  data: string;
  id?: number;
}

/** 解析单个 SSE 事件块（event / data / id 行；id 为 P0-3 事件游标） */
const parseSseBlock = (block: string): SseBlock | null => {
  let event = "message";
  let data = "";
  let id: number | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    else if (line.startsWith("id:")) {
      const value = Number(line.slice("id:".length).trim());
      if (Number.isInteger(value) && value > 0) id = value;
    }
  }
  return data !== "" ? { event, data, id } : null;
};

interface StreamState {
  finishReason: string;
  sawDone: boolean;
  lastSeq: number;
}

const isSse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

const readEnvelopeMessage = async (response: Response): Promise<string> => {
  const envelope = await response.json().catch(() => null) as { message?: string } | null;
  return envelope?.message ?? "AI 助手暂不可用，请稍后重试";
};

/** 消费一次 SSE 响应直到 done/error 或连接结束；返回后由调用方判断是否续接。 */
const consumeSse = async (
  response: Response,
  handlers: AgentChatHandlers,
  state: StreamState,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<void> => {
  if (!response.body || !isSse(response)) {
    throw new AgentChatError(await readEnvelopeMessage(response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 用户中止时立刻释放读端，让 read() 结束并由 assertCurrent 抛出 AbortError。
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const consumeBlock = (block: string): void => {
    assertCurrent();
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    if (parsed.id !== undefined) state.lastSeq = Math.max(state.lastSeq, parsed.id);
    if (parsed.event === "meta") {
      handlers.onMeta?.(JSON.parse(parsed.data) as AgentChatMeta);
    } else if (parsed.event === "delta") {
      handlers.onDelta?.((JSON.parse(parsed.data) as { text: string }).text);
    } else if (parsed.event === "done") {
      state.finishReason = (JSON.parse(parsed.data) as { finishReason?: string }).finishReason ?? "stop";
      state.sawDone = true;
    } else if (parsed.event === "error") {
      throw new AgentChatError((JSON.parse(parsed.data) as { message?: string }).message ?? "AI 助手处理失败，请稍后重试");
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      assertCurrent();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      if (buffer.length > 100_000) throw new AgentChatError("回复内容过长，请缩小问题范围");
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        consumeBlock(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim() !== "") consumeBlock(buffer);
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

/**
 * 发送一条聊天消息并消费 SSE 流，直到 done。
 * 记忆注入：当前账号 localStorage 中有相关记忆时携带 browser_memory（≤3 条）；
 * 未登录或无记忆时省略该字段（Agent 侧提示词不含记忆段）。
 * 传输中断且未收到 done 时，按 lastSeq 自动续接；用户主动中止不续接并通知服务端取消。
 * 返回 done 事件的 finishReason；error 事件或无法续接时抛 AgentChatError（中文文案）。
 */
export async function sendAgentChat(
  message: string,
  handlers: AgentChatHandlers = {},
  options: AgentChatOptions = {},
): Promise<{ finishReason: string }> {
  const userId = useSessionStore.getState().me?.id;
  const assertCurrent = () => {
    if (options.signal?.aborted || useSessionStore.getState().me?.id !== userId) {
      throw new DOMException("会话已切换或请求已取消", "AbortError");
    }
  };
  assertCurrent();
  const memory = userId !== undefined ? await prepareProgressiveMemory(
    userId, options.sessionId ?? crypto.randomUUID(), message, options.signal, assertCurrent,
  ) : [];
  assertCurrent();
  const requestId = crypto.randomUUID();
  const state: StreamState = { finishReason: "", sawDone: false, lastSeq: 0 };
  const cancelRemote = () => {
    // 取消必须独立于用户信号，否则请求会在发出前被同一 AbortSignal 终止。
    void fetch(cancelPath(requestId), { method: "POST", cache: "no-store" }).catch(() => undefined);
  };
  try {
    let response = await fetch(CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        request_id: requestId,
        ...(memory.length > 0 ? { browser_memory: memory } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
        ...(options.history?.length ? { history: historyForRequest(options.history) } : {}),
        ...(options.learningContext ?? {}),
      }),
      cache: "no-store",
      signal: options.signal,
    });
    assertCurrent();
    await consumeSse(response, handlers, state, assertCurrent, options.signal);

    const startedAt = Date.now();
    let attempts = 0;
    while (!state.sawDone) {
      assertCurrent();
      attempts += 1;
      if (attempts > MAX_RESUME_ATTEMPTS || Date.now() - startedAt > RESUME_DEADLINE_MS) {
        throw new AgentChatError("回复中断，请重试");
      }
      response = await fetch(`${resumePath(requestId)}?after=${state.lastSeq}`, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        signal: options.signal,
      });
      assertCurrent();
      await consumeSse(response, handlers, state, assertCurrent, options.signal);
    }
    return { finishReason: state.finishReason || "stop" };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      cancelRemote();
    }
    throw error;
  }
}
