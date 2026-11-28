import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

// 测试密码：运行时生成（避免源码硬编码凭据）
const TEST_PASSWORD = `Aa1!${crypto.randomUUID().slice(0, 8)}`;

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BFF /api/backend/**", () => {
  it("登录成功写入 HttpOnly Cookie，且响应体不回传 token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          code: 200,
          data: { access_token: "jwt-1", token_type: "bearer", user: { id: 1 } },
          message: "登录成功",
        }),
      ),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: "someone", password: TEST_PASSWORD }),
      }),
      context(["api", "auth", "login"]),
    );

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("co_token=jwt-1");
    expect(setCookie).toContain("HttpOnly");

    const body = await response.json();
    expect(body.data.access_token).toBeUndefined();
    expect(body.data.user).toEqual({ id: 1 });
  });

  it("退出登录由 BFF 清 Cookie，不请求后端", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/auth/logout", { method: "POST" }),
      context(["api", "auth", "logout"]),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect((await response.json()).code).toBe(200);
  });

  it("已登录请求自动注入 Authorization，并透传 x-trace-id", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ code: 200, data: null, message: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await POST(
      new Request("http://localhost:3000/api/backend/api/questions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "co_token=jwt-9" },
        body: JSON.stringify({ title: "问题" }),
      }),
      context(["api", "questions"]),
    );

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer jwt-9");
    expect(headers.get("x-trace-id")).toBeTruthy();
  });

  it("文件导出透传 content-disposition 与原始文件体", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("\ufeff课程,周次\n", {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="weekly-report-1-2026-10-13.csv"',
        },
      })),
    );

    const response = await POST(
      new Request(
        "http://localhost:3000/api/backend/api/courses/1/weekly-reports/2/export",
        { method: "GET", headers: { cookie: "co_token=jwt-1" } },
      ),
      context(["api", "courses", "1", "weekly-reports", "2", "export"]),
    );

    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="weekly-report-1-2026-10-13.csv"',
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("课程,周次\n");
  });

  it("后端返回 401 时清除失效 Cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 401, data: null, message: "未登录" }, { status: 401 })),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/users/me", {
        method: "GET",
        headers: { cookie: "co_token=expired" },
      }),
      context(["api", "users", "me"]),
    );

    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect(response.status).toBe(401);
  });

  it("Cookie 无法解码时不抛错：按未登录处理并清除该 Cookie", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ code: 401, data: null, message: "未登录" }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/users/me", {
        method: "GET",
        // 非法 % 转义：decodeURIComponent 会抛 URIError
        headers: { cookie: "co_token=%E0%A4%A" },
      }),
      context(["api", "users", "me"]),
    );

    expect(response.status).toBe(401);
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("上游连接失败返回 502，消息脱敏并带 trace 与重试提示", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:65530");
    }));

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/health"),
      context(["api", "health"]),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      code: 502, data: null, message: "上游服务暂不可用，请稍后重试",
    });
    expect(response.headers.get("x-trace-id")).toBeTruthy();
    expect(response.headers.get("retry-after")).toBe("5");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("上游挂起超时返回 504", async () => {
    vi.resetModules();
    process.env.BACKEND_FETCH_TIMEOUT_MS = "5";
    const { POST: post } = await import("./route");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      })));

    try {
      const response = await post(
        new Request("http://localhost:3000/api/backend/api/health"),
        context(["api", "health"]),
      );

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        code: 504, data: null, message: "上游服务响应超时，请稍后重试",
      });
      expect(response.headers.get("retry-after")).toBe("5");
    } finally {
      delete process.env.BACKEND_FETCH_TIMEOUT_MS;
      errorSpy.mockRestore();
      vi.resetModules();
    }
  });

  it("上游 503 JSON 转脱敏 503，不透传内部地址与密钥", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ code: 503, message: "upstream http://private:9000 secret=hidden" }, { status: 503 }),
    ));

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/health"),
      context(["api", "health"]),
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ code: 503, data: null, message: "上游服务暂不可用，请稍后重试" });
    expect(JSON.stringify(body)).not.toContain("private:9000");
    errorSpy.mockRestore();
  });

  it("上游 500 HTML 转 502 JSON，不透传堆栈与主机", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html>traceback private-host secret=hidden</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    ));

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/health"),
      context(["api", "health"]),
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({ code: 502, data: null, message: "上游服务暂不可用，请稍后重试" });
    expect(JSON.stringify(body)).not.toContain("private-host");
    errorSpy.mockRestore();
  });

  it("上游 200 非 JSON 视为契约异常，返回 502 而不是透传纯文本", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("upstream plain text", { status: 200, headers: { "content-type": "text/plain" } }),
    ));

    const response = await POST(
      new Request("http://localhost:3000/api/backend/api/health"),
      context(["api", "health"]),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe(502);
    errorSpy.mockRestore();
  });
});
