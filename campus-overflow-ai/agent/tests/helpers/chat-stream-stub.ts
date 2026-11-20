// P0-3 测试替身：内存聊天流后端，语义与 governance 内部接口一致。
import {
  InternalApiError,
  type ChatStreamEventAck,
  type ChatStreamRead,
  type ChatStreamSnapshot,
  type UserInternalClient,
} from "../../src/internal-client";

interface StoredEvent {
  seq: number;
  event_type: string;
  data: string;
}

interface StoredStream {
  status: "running" | "succeeded" | "failed" | "cancelled";
  cancel_requested: boolean;
  agent_run_id: string | null;
  trace_id: string | null;
  expires_at: string;
  events: StoredEvent[];
}

const snapshotOf = (requestId: string, stream: StoredStream, created = false): ChatStreamSnapshot => ({
  request_id: requestId,
  status: stream.status,
  cancel_requested: stream.cancel_requested,
  agent_run_id: stream.agent_run_id,
  trace_id: stream.trace_id,
  expires_at: stream.expires_at,
  created,
});

export const chatStreamStub = () => {
  const streams = new Map<string, StoredStream>();
  const api = {
    ensureChatStream: async (
      requestId: string, body: { agent_run_id?: string; trace_id?: string },
    ): Promise<ChatStreamSnapshot> => {
      const existing = streams.get(requestId);
      if (existing) return snapshotOf(requestId, existing);
      const stored: StoredStream = {
        status: "running", cancel_requested: false,
        agent_run_id: body.agent_run_id ?? null, trace_id: body.trace_id ?? null,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), events: [],
      };
      streams.set(requestId, stored);
      return snapshotOf(requestId, stored, true);
    },
    appendChatStreamEvent: async (
      requestId: string, body: { seq: number; event_type: string; data: string },
    ): Promise<ChatStreamEventAck> => {
      const stream = streams.get(requestId);
      if (!stream) throw new InternalApiError(404, 404, "聊天流不存在");
      const duplicate = stream.events.find((event) => event.seq === body.seq);
      if (duplicate) {
        if (duplicate.event_type !== body.event_type || duplicate.data !== body.data) {
          throw new InternalApiError(409, 409, "事件内容不一致");
        }
        return { seq: body.seq, status: stream.status, duplicate: true };
      }
      if (stream.status !== "running") throw new InternalApiError(409, 409, "聊天流已结束");
      const last = stream.events.at(-1)?.seq ?? 0;
      if (body.seq !== last + 1) throw new InternalApiError(409, 409, "事件序号不连续");
      stream.events.push({ ...body });
      if (body.event_type === "done") stream.status = "succeeded";
      if (body.event_type === "error") {
        stream.status = stream.cancel_requested ? "cancelled" : "failed";
      }
      return { seq: body.seq, status: stream.status, duplicate: false };
    },
    readChatStream: async (requestId: string, after: number): Promise<ChatStreamRead> => {
      const stream = streams.get(requestId);
      if (!stream) throw new InternalApiError(404, 404, "聊天流不存在");
      return {
        ...snapshotOf(requestId, stream),
        events: stream.events.filter((event) => event.seq > after).map((event) => ({ ...event })),
      };
    },
    cancelChatStream: async (requestId: string): Promise<ChatStreamSnapshot> => {
      const stream = streams.get(requestId);
      if (!stream) throw new InternalApiError(404, 404, "聊天流不存在");
      if (stream.status === "running") stream.cancel_requested = true;
      return snapshotOf(requestId, stream);
    },
  };
  const apply = <T extends object>(client: T): T & typeof api => Object.assign(client, api);
  return { api, apply, streams };
};

/** 在既有测试客户端上补齐聊天流能力；同一 fixture 内共享一份内存流。 */
export const withChatStreams = (client: Partial<UserInternalClient>): UserInternalClient =>
  chatStreamStub().apply(client as UserInternalClient);
