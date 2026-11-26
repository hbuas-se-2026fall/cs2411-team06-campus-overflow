import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callUpstreamMcpTool,
  fetchMcpCalls,
  fetchUpstreamMcpConfig,
} from "./admin-mcp";
import {
  getPlanParallelSetting,
  updatePlanParallelSetting,
} from "./runtime-settings";
import {
  archiveSkill,
  createSkill,
  fetchSkill,
  listSkills,
  publishSkill,
  setSkillStatus,
  updateSkill,
} from "./workflow-skills";

const calls: Array<{ url: string; init?: RequestInit }> = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), init });
  return new Response(JSON.stringify({ code: 200, data: {}, message: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  calls.length = 0;
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("管理端治理扩展 API", () => {
  it("MCP 审计、运行设置与 skill 路径使用蛇形参数", async () => {
    await fetchMcpCalls({
      page: 2,
      page_size: 20,
      client_name: "partner",
      tool_name: "search",
      status: "failed",
    });
    expect(calls.at(-1)?.url).toBe(
      "/api/backend/api/governance/mcp/calls?page=2&page_size=20&client_name=partner&tool_name=search&status=failed",
    );

    await getPlanParallelSetting();
    expect(calls.at(-1)?.url).toBe("/api/backend/api/governance/settings/plan-parallel");

    await updatePlanParallelSetting(true);
    expect(calls.at(-1)?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      plan_parallel_enabled: true,
    });

    await listSkills({ page: 2, status: "draft", task_type: "teaching_report" });
    expect(calls.at(-1)?.url).toBe(
      "/api/backend/api/governance/skills?page=2&status=draft&task_type=teaching_report",
    );
  });

  it("skill 创建与发布请求体符合后端 Schema", async () => {
    const content = {
      conditions: ["每周"],
      steps: ["汇总"],
      tips: [],
      checks: ["匿名"],
      max_tokens: 1500,
    };
    await createSkill({
      name: "周报路径",
      task_type: "teaching_report",
      course_id: null,
      content,
    });
    expect(calls.at(-1)?.url).toBe("/api/backend/api/governance/skills");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      name: "周报路径",
      task_type: "teaching_report",
      course_id: null,
      content,
    });

    await publishSkill(7);
    expect(calls.at(-1)?.url).toBe("/api/backend/api/governance/skills/7/publish");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({});

    await publishSkill(7, 3);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ version: 3 });

    await fetchSkill(7);
    expect(calls.at(-1)?.url).toBe("/api/backend/api/governance/skills/7");

    await updateSkill(7, {
      name: "周报路径",
      task_type: "teaching_report",
      course_id: 2,
      content,
    });
    expect(calls.at(-1)?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      name: "周报路径",
      task_type: "teaching_report",
      course_id: 2,
      content,
    });

    await setSkillStatus(7, "disabled");
    expect(calls.at(-1)?.url).toBe("/api/backend/api/governance/skills/7/status");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ status: "disabled" });

    await archiveSkill(7);
    expect(calls.at(-1)?.url).toBe("/api/backend/api/governance/skills/7");
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
  });

  it("Agent MCP 配置与 202 待审批回包走 Agent BFF", async () => {
    await fetchUpstreamMcpConfig();
    expect(calls.at(-1)?.url).toBe("/api/agent/agent/admin/mcp/upstream");

    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        code: 202,
        data: { status: "approval_required", case_id: 12 },
        message: "已生成待确认工单",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await callUpstreamMcpTool({
      server: "knowledge",
      tool: "publish",
      arguments: { id: 1 },
    });
    expect(calls.at(-1)?.url).toBe("/api/agent/agent/admin/mcp/upstream/call");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      server: "knowledge",
      tool: "publish",
      arguments: { id: 1 },
    });
    expect(result).toEqual({ status: "approval_required", case_id: 12 });
  });
});
