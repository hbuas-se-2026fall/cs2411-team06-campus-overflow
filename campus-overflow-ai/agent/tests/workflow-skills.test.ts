// T-22C：工作流 skill 注入的匹配优先级、预算截断、30s 缓存与失败降级。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowSkillSummaryItem } from "../src/internal-client";
import { buildPlanPrompt } from "../src/prompts/planning";
import {
  estimateSkillTokens,
  loadSkillInjection,
  MAX_SKILL_CHARS,
  MAX_SKILL_TOKENS,
  resetSkillInjectionCacheForTests,
  SKILL_INJECTION_TTL_MS,
} from "../src/skills/workflow-skills";
import { asTraceId } from "../src/types";

const traceId = asTraceId("trace-skill-test");

const item = (
  overrides: Partial<WorkflowSkillSummaryItem> = {},
): WorkflowSkillSummaryItem => ({
  id: 1,
  name: "巡检复用路径",
  taskType: "moderation_scan",
  version: 1,
  summary: "读取现状；核对版本",
  stepCount: 2,
  ...overrides,
});

const detail = (steps: string[] = ["读取现状", "核对版本"]) => ({
  skillId: 1,
  version: 1,
  content: {
    conditions: ["命中同一目标"],
    steps,
    tips: ["先复核工单"],
    checks: ["不重复建单"],
    maxTokens: 1200,
  },
});

beforeEach(() => {
  resetSkillInjectionCacheForTests();
  vi.stubEnv("SKILL_INJECTION_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSkillInjectionCacheForTests();
});

describe("loadSkillInjection", () => {
  it("默认关闭时不访问后端", async () => {
    vi.stubEnv("SKILL_INJECTION_ENABLED", "false");
    const fetchWorkflowSkills = vi.fn();
    const lines = await loadSkillInjection(
      { fetchWorkflowSkills }, "moderation_scan", undefined, traceId,
    );
    expect(lines).toEqual([]);
    expect(fetchWorkflowSkills).not.toHaveBeenCalled();
  });

  it("课程精确匹配优先，且只展开第一条详情", async () => {
    const fetchWorkflowSkills = vi.fn().mockResolvedValue([
      item({ id: 1, name: "全局路径" }),
      item({ id: 2, name: "课程路径", courseId: 7 }),
    ]);
    const fetchWorkflowSkillVersion = vi.fn().mockResolvedValue(detail());
    const lines = await loadSkillInjection(
      { fetchWorkflowSkills, fetchWorkflowSkillVersion },
      "moderation_scan", 7, traceId, 0,
    );

    expect(lines[0]).toContain("[课程路径]");
    expect(lines[0]).toContain("步骤：1. 读取现状");
    expect(lines[1]).toContain("[全局路径]");
    expect(lines[1]).not.toContain("步骤：");
    expect(fetchWorkflowSkillVersion).toHaveBeenCalledTimes(1);
    expect(fetchWorkflowSkillVersion).toHaveBeenCalledWith(
      { skillId: 2, version: 1 }, traceId,
    );
  });

  it("最多注入 3 条", async () => {
    const fetchWorkflowSkills = vi.fn().mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => item({ id: index + 1, name: `路径${index + 1}` })),
    );
    const lines = await loadSkillInjection(
      { fetchWorkflowSkills }, "moderation_scan", undefined, traceId, 0,
    );
    expect(lines).toHaveLength(3);
  });

  it("超出字符或 token 预算时截断并省略后续条目", async () => {
    const longSteps = Array.from({ length: 20 }, (_, index) =>
      `${index + 1}${"核对治理目标与工单状态".repeat(20)}`);
    const fetchWorkflowSkills = vi.fn().mockResolvedValue([
      item({ id: 1, stepCount: longSteps.length }),
      item({ id: 2, name: "第二条路径" }),
    ]);
    const fetchWorkflowSkillVersion = vi.fn().mockResolvedValue(detail(longSteps));
    const lines = await loadSkillInjection(
      { fetchWorkflowSkills, fetchWorkflowSkillVersion },
      "moderation_scan", undefined, traceId, 0,
    );
    const injected = lines.join("\n");
    expect(lines).toHaveLength(1);
    expect(injected.length).toBeLessThanOrEqual(MAX_SKILL_CHARS);
    expect(estimateSkillTokens(injected)).toBeLessThanOrEqual(MAX_SKILL_TOKENS);
    expect(injected.endsWith("…")).toBe(true);
  });

  it("30 秒 TTL 内复用缓存，过期后重新拉取", async () => {
    const fetchWorkflowSkills = vi.fn().mockResolvedValue([item()]);
    const source = { fetchWorkflowSkills };
    await loadSkillInjection(source, "moderation_scan", undefined, traceId, 0);
    await loadSkillInjection(
      source, "moderation_scan", undefined, traceId, SKILL_INJECTION_TTL_MS - 1,
    );
    expect(fetchWorkflowSkills).toHaveBeenCalledTimes(1);

    await loadSkillInjection(
      source, "moderation_scan", undefined, traceId, SKILL_INJECTION_TTL_MS,
    );
    expect(fetchWorkflowSkills).toHaveBeenCalledTimes(2);
  });

  it("后端失败降级为空并缓存空结果", async () => {
    const fetchWorkflowSkills = vi.fn().mockRejectedValue(new Error("backend down"));
    const source = { fetchWorkflowSkills };
    expect(await loadSkillInjection(
      source, "moderation_scan", undefined, traceId, 0,
    )).toEqual([]);
    expect(await loadSkillInjection(
      source, "moderation_scan", undefined, traceId, 1_000,
    )).toEqual([]);
    expect(fetchWorkflowSkills).toHaveBeenCalledTimes(1);
  });

  it("详情读取失败整体降级为空", async () => {
    const fetchWorkflowSkills = vi.fn().mockResolvedValue([item()]);
    const fetchWorkflowSkillVersion = vi.fn().mockRejectedValue(new Error("404"));
    expect(await loadSkillInjection(
      { fetchWorkflowSkills, fetchWorkflowSkillVersion },
      "moderation_scan", undefined, traceId, 0,
    )).toEqual([]);
  });
});

describe("buildPlanPrompt", () => {
  it("注入历史有效路径并保留不可扩大授权提示", () => {
    const prompt = buildPlanPrompt(
      "{}", "[]", ["必须包含至少一次 fetchModerationTarget"], [], ["- [巡检路径] 读取现状"],
    );
    expect(prompt).toContain("历史有效路径");
    expect(prompt).toContain("不得作为授权依据");
    expect(prompt).toContain("- [巡检路径] 读取现状");
  });
});
