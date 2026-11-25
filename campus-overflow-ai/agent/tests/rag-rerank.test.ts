// RAG rerank：OpenAI 兼容 provider 的请求、响应校验、超时/取消与配置解析。
import { describe, expect, it, vi } from "vitest";

import {
  createOpenAICompatibleRerankProvider,
  resolveRerankConfig,
} from "../src/knowledge/rag/rerank.js";

const responseOf = (results: unknown, status = 200): Response => new Response(
  JSON.stringify({ results }),
  { status, headers: { "content-type": "application/json" } },
);

const providerWith = (results: unknown, status = 200) =>
  createOpenAICompatibleRerankProvider({
    baseUrl: "https://rerank.example/v1/",
    apiKey: "secret-key",
    model: "rerank-test",
    fetchImpl: (async () => responseOf(results, status)) as unknown as typeof fetch,
  });

describe("OpenAI 兼容 rerank provider", () => {
  it("发送 query/documents/top_n，并按分数降序返回", async () => {
    const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return responseOf([
        { index: 1, relevance_score: 0.21 },
        { index: 0, relevance_score: 0.93 },
      ]);
    });
    const provider = createOpenAICompatibleRerankProvider({
      baseUrl: "https://rerank.example/v1/",
      apiKey: "secret-key",
      model: "rerank-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await provider.rerank("死锁怎么预防", ["摘要 A", "正文 B"], { topN: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://rerank.example/v1/rerank");
    expect(calls[0]?.authorization).toBe("Bearer secret-key");
    expect(calls[0]?.body).toMatchObject({
      model: "rerank-test",
      query: "死锁怎么预防",
      documents: ["摘要 A", "正文 B"],
      top_n: 2,
    });
    expect(results).toEqual([
      { index: 0, score: 0.93 },
      { index: 1, score: 0.21 },
    ]);
  });

  it("topN 超过文档数时按文档数请求", async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = createOpenAICompatibleRerankProvider({
      baseUrl: "https://rerank.example/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return responseOf([{ index: 0, relevance_score: 1 }]);
      }) as unknown as typeof fetch,
    });

    await provider.rerank("q", ["a", "b"], { topN: 9 });
    expect(calls[0]?.top_n).toBe(2);
  });

  it("拒绝越界、重复、非数值与缺失 results 的响应", async () => {
    await expect(providerWith([{ index: 3, relevance_score: 0.5 }]).rerank("q", ["a", "b"]))
      .rejects.toThrow("越界索引");
    await expect(providerWith([
      { index: 0, relevance_score: 0.5 },
      { index: 0, relevance_score: 0.4 },
    ]).rerank("q", ["a", "b"])).rejects.toThrow("重复索引");
    await expect(providerWith([{ index: 0, relevance_score: "high" }]).rerank("q", ["a"]))
      .rejects.toThrow("非数值分数");
    await expect(providerWith(undefined).rerank("q", ["a"]))
      .rejects.toThrow("响应格式不正确");
  });

  it("HTTP 错误不泄漏 API Key", async () => {
    const provider = providerWith([], 401);
    await expect(provider.rerank("q", ["a"])).rejects.toThrow("HTTP 401");
    await expect(provider.rerank("q", ["a"])).rejects.not.toThrow("secret-key");
  });

  it("已取消的信号不再发起请求", async () => {
    const fetchImpl = vi.fn();
    const provider = createOpenAICompatibleRerankProvider({
      baseUrl: "https://rerank.example/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.rerank("q", ["a"], { signal: controller.signal }))
      .rejects.toThrow("已取消");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("超时中止请求并返回超时错误", async () => {
    const provider = createOpenAICompatibleRerankProvider({
      baseUrl: "https://rerank.example/v1",
      apiKey: "k",
      model: "m",
      timeoutMs: 10,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })) as unknown as typeof fetch,
    });

    await expect(provider.rerank("q", ["a"])).rejects.toThrow("超时");
  });

  it("调用方取消后不再继续请求", async () => {
    const provider = createOpenAICompatibleRerankProvider({
      baseUrl: "https://rerank.example/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = provider.rerank("q", ["a"], { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow("已取消");
  });
});

describe("rerank 环境配置", () => {
  it("默认关闭：任一开关不为 true 时返回 null", () => {
    expect(resolveRerankConfig({})).toBeNull();
    expect(resolveRerankConfig({ RAG_ENABLED: "true" })).toBeNull();
    expect(resolveRerankConfig({ RAG_RERANK_ENABLED: "true" })).toBeNull();
  });

  it("地址与密钥可回退到 embedding 配置", () => {
    const config = resolveRerankConfig({
      RAG_ENABLED: "true",
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_MODEL: "bge-reranker",
      RAG_EMBEDDING_BASE_URL: "https://embedding.example/v1",
      RAG_EMBEDDING_API_KEY: "embedding-key",
    });
    expect(config).toEqual({
      baseUrl: "https://embedding.example/v1",
      apiKey: "embedding-key",
      model: "bge-reranker",
      timeoutMs: 15_000,
      candidateLimit: 5,
      minScore: 0,
      maxTotalChars: 2400,
    });
  });

  it("显式配置优先于 embedding 回退", () => {
    const config = resolveRerankConfig({
      RAG_ENABLED: "true",
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_BASE_URL: "https://rerank.example/v1",
      RAG_RERANK_API_KEY: "rerank-key",
      RAG_RERANK_MODEL: "m",
      RAG_RERANK_TIMEOUT_MS: "3000",
      RAG_EMBEDDING_BASE_URL: "https://embedding.example/v1",
      RAG_EMBEDDING_API_KEY: "embedding-key",
    });
    expect(config).toMatchObject({
      baseUrl: "https://rerank.example/v1",
      apiKey: "rerank-key",
      timeoutMs: 3000,
    });
  });

  it("缺少模型或超时越界时拒绝", () => {
    expect(() => resolveRerankConfig({
      RAG_ENABLED: "true",
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_BASE_URL: "https://rerank.example/v1",
      RAG_RERANK_API_KEY: "k",
    })).toThrow("RAG_RERANK_MODEL");
    expect(() => resolveRerankConfig({
      RAG_ENABLED: "true",
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_MODEL: "m",
      RAG_RERANK_BASE_URL: "https://rerank.example/v1",
      RAG_RERANK_API_KEY: "k",
      RAG_RERANK_TIMEOUT_MS: "999",
    })).toThrow("1000～60000");
  });

  it("读取候选数、阈值与总预算并校验范围", () => {
    const base = {
      RAG_ENABLED: "true",
      RAG_RERANK_ENABLED: "true",
      RAG_RERANK_MODEL: "m",
      RAG_RERANK_BASE_URL: "https://rerank.example/v1",
      RAG_RERANK_API_KEY: "k",
    };
    expect(resolveRerankConfig({
      ...base,
      RAG_RERANK_CANDIDATES: "3",
      RAG_RERANK_MIN_SCORE: "-0.5",
      RAG_CONTEXT_MAX_CHARS: "1800",
    })).toMatchObject({
      candidateLimit: 3,
      minScore: -0.5,
      maxTotalChars: 1800,
    });
    expect(() => resolveRerankConfig({ ...base, RAG_RERANK_CANDIDATES: "0" }))
      .toThrow("1～20");
    expect(() => resolveRerankConfig({ ...base, RAG_CONTEXT_MAX_CHARS: "100" }))
      .toThrow("200～20000");
    expect(() => resolveRerankConfig({ ...base, RAG_RERANK_MIN_SCORE: "abc" }))
      .toThrow("数值");
  });
});
