import { describe, expect, it, vi, afterEach } from "vitest";

import { GET } from "./route";

const mockFetch = (status: number) =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("aggregates all services as up when downstream healthy", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const res = await GET();
    const body = await res.json();
    expect(body.code).toBe(200);
    expect(body.data).toEqual({ frontend: "up", backend: "up", agent: "up" });
  });

  it("degrades gracefully when agent service is down", async () => {
    // fetch 抛错表示服务不可达，接口本身仍返回 200
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("8787")) {
          throw new Error("connection refused");
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.data.agent).toBe("down");
    expect(body.data.backend).toBe("up");
  });

  it("uses container service origins from environment", async () => {
    vi.stubEnv("BACKEND_ORIGIN", "http://backend:8000");
    vi.stubEnv("AGENT_ORIGIN", "http://agent:8787");
    const fetchMock = mockFetch(200);
    vi.stubGlobal("fetch", fetchMock);

    await GET();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://backend:8000/api/health",
      "http://agent:8787/agent/health",
    ]);
  });
});
