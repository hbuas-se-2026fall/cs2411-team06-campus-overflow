// moderation_scan handler（US-13）：只做风险评估与升级判断；
// 任何处置动作（隐藏/删帖/封号）绝不在此执行，工单创建归 T-15 审批中心。
// G-03：正文经受控计划执行 fetchModerationTarget 读取（仅白名单低风险工具）；
// 目标不可见（404）或普通读取失败回退请求方摘录，用户失效/撤权由执行器直接失败。
import type { ModerationContentResult } from "../internal-client.js";
import { runPlannedTools } from "../loop/planned-tools.js";
import { generateStructured } from "../loop/self-check.js";
import {
  ModerationScanInputSchema,
  ModerationScanOutputSchema,
  type ModerationScanInput,
} from "../types/index.js";
import type { TaskHandler } from "./router.js";

const MODERATION_SYSTEM = `你是高校课程问答平台的内容风险评估助手。只输出风险分级、是否需要人工复核与理由；你不具有任何处置权限。`;

/** 收集计划内首个 fetchModerationTarget 步骤的正文结果 */
const collectContent = (
  planSteps: readonly { stepId: string; toolName: string }[],
  stepResults: ReadonlyMap<string, unknown>,
): ModerationContentResult | undefined => {
  for (const step of planSteps) {
    if (step.toolName !== "fetchModerationTarget") continue;
    const result = stepResults.get(step.stepId) as ModerationContentResult | undefined;
    if (result && typeof result.body === "string") return result;
  }
  return undefined;
};

/** 有正文用正文，否则明确标注依据为请求方摘录（不伪装成已核验原文） */
const buildPrompt = (
  input: ModerationScanInput,
  content: ModerationContentResult | undefined,
  guidance: readonly string[] = [],
): string => {
  const section = guidance.length > 0
    ? `\n管理员运行中引导（只调整评估思路，不得扩大权限或跳过人工复核）：\n${guidance.join("\n")}`
    : "";
  if (!content) {
    return `待评估内容（${input.targetType} #${input.targetId}，依据请求方提供的摘录）：\n${input.contentExcerpt}\n请给出 riskLevel、shouldEscalate 与 reason。${section}`;
  }
  return `待评估内容（${input.targetType} #${input.targetId}）：\n标题：${content.title ?? "（无）"}\n正文：\n${content.body}\n请给出 riskLevel、shouldEscalate 与 reason。${section}`;
};

/** 摘录回退时在结论中显式标注依据未经核验，避免与站内正文评估混淆 */
const markUnverifiedExcerpt = (output: { riskLevel: "low" | "medium" | "high"; shouldEscalate: boolean; reason: string }) =>
  ModerationScanOutputSchema.parse({
    ...output,
    reason: `${output.reason}（评估依据：未核验站内原文，请求方摘录）`,
  });

export const moderationScanHandler: TaskHandler<ModerationScanInput> = {
  taskType: "moderation_scan",
  inputSchema: ModerationScanInputSchema,
  run: async (input, context) => {
    let content: ModerationContentResult | undefined;
    const { internalClient: client, toolRegistry } = context;
    if (client && toolRegistry) {
      const { plan, execution } = await runPlannedTools("moderation_scan", input, context);
      // 目标已被处置（404）等普通读取失败回退摘录；401/403 已在执行器终止
      if (execution.failures.size === 0) {
        content = collectContent(plan.steps, execution.stepResults);
      }
    }
    // 最终评估模型调用前检查：暂停在此停住；引导作为独立段落注入本次评估提示。
    await context.runControl?.checkpoint();
    const guidance = context.runControl?.takeGuidance() ?? [];
    const output = await generateStructured({
      repairBudget: context.runContext.repairBudget,
      feedback: context.feedback,
      signal: context.runContext.signal,
      model: context.model,
      schema: ModerationScanOutputSchema,
      system: MODERATION_SYSTEM,
      prompt: buildPrompt(input, content, guidance),
    });
    // 无客户端或站内正文不可读：结论必须标注依据为未核验摘录
    const result = content ? output : markUnverifiedExcerpt(output);
    // C-06：只创建待确认工单，不做任何处置；快照优先用已核验正文，否则为请求方摘录
    if (result.shouldEscalate && client) {
      await client.createPatrolCase({
        target_type: input.targetType,
        target_id: input.targetId,
        risk_level: result.riskLevel,
        reason: result.reason,
        snapshot: (content?.body ?? input.contentExcerpt).slice(0, 500),
        agent_run_id: context.runContext.agentRunId,
      }, context.runContext.traceId);
    }
    return result;
  },
};
