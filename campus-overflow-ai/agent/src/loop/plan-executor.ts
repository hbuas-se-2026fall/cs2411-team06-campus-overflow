// 受控计划执行（G-03 / AG-R02）：程序校验并按依赖执行模型生成的 PlanList。
// 未知工具、非低风险工具、越权参数、非法引用、参数非法 → 拒绝该调用（明确失败，不自动重试）；
// 普通工具错误按步骤收集，401/403 立即终止；预算跨计划/返工累计且不重置。
// 2026-11-24（SA-07 / ADR-010）：开启并行后，同层无依赖步骤并发执行；含审批动作的计划仍整份串行。
import { z } from "zod";
import { SecurityPolicyError } from "../security/contracts.js";

import { InternalApiError } from "../internal-client.js";
import { checkSignal, RunStoppedError, withUpstreamDeadline } from "./abort.js";
import { acquireInflight } from "./inflight-limiter.js";
import type { PlanAudit } from "../observability/persistent-audit.js";
import type { ToolExecutionContext, ToolRegistry } from "../tools/registry.js";
import type { PlanList, PlanStep } from "../types/plan.js";
import { INPUT_REF_ID, MAX_PLAN_STEPS, MAX_TOOL_CALLS } from "../types/plan.js";
import { PlanBudgetError, type ToolCallBudget } from "./run-budget.js";

export { PlanBudgetError } from "./run-budget.js";

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(`plan invalid: ${message}`);
    this.name = "PlanValidationError";
  }
}

export class PlanExecutionError extends Error {
  constructor(message: string) {
    super(`plan execution failed: ${message}`);
    this.name = "PlanExecutionError";
  }
}

/** 内部工具禁止接受模型生成的操作者身份（AG-R02：不能以模型指定用户/角色为授权依据） */
const FORBIDDEN_ARG_KEYS = ["user_id", "role", "principal", "operator", "operator_id", "user", "actor"];

/** 参数键命中身份字段名即拒绝 */
export const assertNoForbiddenArgKey = (key: string): void => {
  if (FORBIDDEN_ARG_KEYS.includes(key)) {
    throw new PlanValidationError(`参数不允许指定模型操作者身份：${key}`);
  }
};

/** 解析引用语法：$s1.items[0].title / $input.questionTitle → { target, path }；非纯引用返回 null */
export const parseStepRef = (
  value: string,
): { target: string; path: Array<string | number> } | null => {
  const match = /^\$(s\d+|input)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$/.exec(value);
  if (!match) return null;
  const path: Array<string | number> = [];
  for (const segment of match[2].matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    path.push(segment[1] ?? Number(segment[2]));
  }
  return { target: match[1], path };
};

const resolveRefValue = (
  ref: string,
  parsed: { target: string; path: Array<string | number> },
  stepResults: ReadonlyMap<string, unknown>,
  input: unknown,
): unknown => {
  let value: unknown;
  if (parsed.target === INPUT_REF_ID) {
    value = input;
  } else {
    if (!stepResults.has(parsed.target)) {
      throw new PlanExecutionError(`引用了未执行的步骤：${parsed.target}`);
    }
    value = stepResults.get(parsed.target);
  }
  for (const segment of parsed.path) {
    if (typeof segment === "number") {
      if (!Array.isArray(value) || segment >= value.length || !Object.hasOwn(value, segment)) {
        throw new PlanExecutionError(`引用路径无效或越界：${ref}`);
      }
      value = value[segment];
    } else {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlanExecutionError(`引用路径类型错误：${ref}`);
      }
      if (!Object.hasOwn(value, segment)) {
        throw new PlanExecutionError(`引用字段不存在：${ref}`);
      }
      value = (value as Record<string, unknown>)[segment];
    }
  }
  return value;
};

/** 解析步骤参数：值若以 $ 开头必须是完整纯引用；其余按字面量传给工具 schema 校验 */
const resolveArgs = (
  step: PlanStep,
  stepResults: ReadonlyMap<string, unknown>,
  input: unknown,
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(step.args)) {
    assertNoForbiddenArgKey(key);
    if (typeof raw === "string" && raw.startsWith("$")) {
      const parsed = parseStepRef(raw);
      if (!parsed) {
        throw new PlanValidationError(`参数 ${key} 不是合法的 $stepId.路径 引用：${raw}`);
      }
      resolved[key] = resolveRefValue(raw, parsed, stepResults, input);
    } else {
      resolved[key] = raw;
    }
  }
  return resolved;
};

export interface PlanValidationOptions {
  /** 请求级工具注册表（G-02：每请求独立注册表，即当前用户能力集） */
  registry: ToolRegistry;
  /** 任务必需的工具步骤：计划中必须至少出现一次，缺失即拒绝 */
  requiredTools?: readonly string[];
}

const requireExecutableTool = (registry: ToolRegistry, name: string) => {
  const tool = registry.getTool(name);
  if (!tool) throw new PlanValidationError(`计划使用了未知工具：${name}`);
  if (!tool.execute || tool.riskLevel !== "low") {
    throw new PlanValidationError(`工具不允许计划执行（需人工审批或未提供实现）：${name}`);
  }
  return tool;
};

/** 计划静态校验：步骤数、ID 唯一、工具在白名单且低风险可执行、必需工具、引用语法、拒绝身份字段 */
export const validatePlan = (plan: PlanList, options: PlanValidationOptions): void => {
  if (plan.steps.length > MAX_PLAN_STEPS) {
    throw new PlanValidationError(`计划步骤超过上限 ${MAX_PLAN_STEPS}`);
  }
  const seenStepIds = new Set<string>();
  const usedTools = new Set<string>();
  for (const step of plan.steps) {
    if (seenStepIds.has(step.stepId)) {
      throw new PlanValidationError(`步骤 ID 重复：${step.stepId}`);
    }
    seenStepIds.add(step.stepId);
    requireExecutableTool(options.registry, step.toolName);
    usedTools.add(step.toolName);
    for (const [key, value] of Object.entries(step.args)) {
      assertNoForbiddenArgKey(key);
      if (typeof value === "string" && value.startsWith("$") && !parseStepRef(value)) {
        throw new PlanValidationError(`参数 ${key} 不是合法的 $stepId.路径 引用：${value}`);
      }
    }
  }
  for (const required of options.requiredTools ?? []) {
    if (!usedTools.has(required)) {
      throw new PlanValidationError(`计划缺少必需的工具步骤：${required}`);
    }
  }
};

/** 审批/建单类工具：出现即整份计划回退串行，保持审批顺序与幂等语义（ADR-010） */
const SERIAL_TOOL_NAMES = new Set([
  "proposeGovernance",
  "proposeClassMembership",
  "proposeTeachingExperience",
]);

/** 单计划在途上限（ADR-010：默认 4） */
export const DEFAULT_MAX_PARALLEL_STEPS = 4;
/** 进程级在途上限（ADR-010：默认 12，按 4C4G 设定） */
export const DEFAULT_MAX_INFLIGHT_CALLS = 12;

const readPositiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** 并行开关默认关闭；未开启时保持串行执行（ADR-010） */
export const isPlanParallelEnabled = (): boolean => process.env.PLAN_PARALLEL_ENABLED === "true";
export const resolveMaxParallelSteps = (): number =>
  readPositiveInt(process.env.PLAN_MAX_PARALLEL_STEPS, DEFAULT_MAX_PARALLEL_STEPS);
export const resolveMaxInflightCalls = (): number =>
  readPositiveInt(process.env.MAX_INFLIGHT_TOOL_CALLS, DEFAULT_MAX_INFLIGHT_CALLS);

/**
 * 按 `$sN` 引用构建步骤依赖层：同层步骤互不依赖，可并发；层与层之间按依赖顺序执行。
 * 引用不存在或成环按计划执行错误处理，与串行时“引用了未执行的步骤”保持一致。
 */
export const buildPlanLayers = (plan: PlanList): PlanStep[][] => {
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  const deps = new Map<string, readonly string[]>();
  for (const step of plan.steps) {
    const refs = new Set<string>();
    for (const value of Object.values(step.args)) {
      if (typeof value !== "string" || !value.startsWith("$")) continue;
      const parsed = parseStepRef(value);
      if (parsed && parsed.target !== INPUT_REF_ID) refs.add(parsed.target);
    }
    deps.set(step.stepId, [...refs]);
  }

  const layerOf = new Map<string, number>();
  const resolveLayer = (id: string, stack: Set<string>): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (!byId.has(id)) throw new PlanExecutionError(`引用了未执行的步骤：${id}`);
    if (stack.has(id)) throw new PlanExecutionError("计划步骤存在循环引用");
    stack.add(id);
    const layer = (deps.get(id) ?? []).reduce((max, dep) => Math.max(max, resolveLayer(dep, stack) + 1), 0);
    stack.delete(id);
    layerOf.set(id, layer);
    return layer;
  };

  const layers: PlanStep[][] = [];
  for (const step of plan.steps) {
    const layer = resolveLayer(step.stepId, new Set());
    (layers[layer] ??= []).push(step);
  }
  return layers;
};

const isWaitingResult = (toolName: string, result: unknown): boolean => {
  if (!SERIAL_TOOL_NAMES.has(toolName) || !result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  return (record.approval_required === true) || (record.waiting_for_execution === true);
};

export interface ExecutePlanOptions extends PlanValidationOptions {
  /** 工具执行上下文：principal 来自运行上下文（后端已验证），不来自模型 */
  toolContext: ToolExecutionContext & { readonly toolBudget: ToolCallBudget };
  /** 任务输入：供 $input.* 引用（通过则动态解析） */
  input: unknown;
  /** 解析引用后、实际调用前验证任务范围；策略错误不得按读取故障降级。 */
  assertArgs?: (toolName: string, args: Readonly<Record<string, unknown>>) => void;
  audit?: PlanAudit;
  /** 每次工具调用前的运行控制检查（T-21C）：暂停等待、取消退出，不改变步骤顺序。 */
  beforeStep?: () => Promise<void>;
  /** 并行开关覆盖；缺省读取 PLAN_PARALLEL_ENABLED（全局开关接线后由调用方传入）。 */
  parallel?: boolean;
}

export interface ExecutePlanResult {
  state: "completed" | "waiting";
  /** 步骤结果：stepId → 工具返回值（按实际执行顺序） */
  stepResults: Map<string, unknown>;
  /** 步骤运行期错误：stepId → 错误（工具执行失败，任务按语义降级或转失败） */
  failures: Map<string, unknown>;
  /** 同一运行至今累计发出的工具调用次数（包含失败调用） */
  toolCallCount: number;
}

export const executePlan = async (
  plan: PlanList,
  options: ExecutePlanOptions,
): Promise<ExecutePlanResult> => {
  checkSignal(options.toolContext.signal);
  validatePlan(plan, options);
  const stepResults = new Map<string, unknown>();
  const failures = new Map<string, unknown>();
  let state: "completed" | "waiting" = "completed";

  const runParallel = (options.parallel ?? isPlanParallelEnabled())
    && !plan.steps.some((step) => SERIAL_TOOL_NAMES.has(step.toolName));
  const maxParallel = resolveMaxParallelSteps();
  const maxInflight = resolveMaxInflightCalls();
  const controller = new AbortController();
  const signal = options.toolContext.signal
    ? AbortSignal.any([options.toolContext.signal, controller.signal])
    : controller.signal;

  /** 执行单个步骤；返回 true 表示该步骤要求后续停止（待人工确认）。 */
  const runStep = async (step: PlanStep): Promise<boolean> => {
    await options.beforeStep?.();
    checkSignal(signal);
    const tool = requireExecutableTool(options.registry, step.toolName);
    const args = resolveArgs(step, stepResults, options.input);
    options.assertArgs?.(step.toolName, args);
    let parsedArgs: unknown;
    try {
      parsedArgs = tool.inputSchema ? tool.inputSchema.parse(args) : args;
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? error.issues[0]?.message ?? "参数不合法"
          : error instanceof Error
            ? error.message
            : String(error);
      throw new PlanExecutionError(`步骤 ${step.stepId}（${step.toolName}）参数校验失败：${detail}`);
    }
    if (options.toolContext.toolBudget.used >= MAX_TOOL_CALLS) throw new PlanBudgetError("达到累计工具调用上限");

    const release = await acquireInflight(maxInflight, signal);
    try {
      checkSignal(signal);
      await options.audit?.beforeStep(step);
      checkSignal(signal);
      options.toolContext.toolBudget.consume();
      const startedAt = performance.now();
      let failed = false;
      let failure: unknown;
      let result: unknown;
      try {
        result = await withUpstreamDeadline(signal, (upstream) =>
          tool.execute!(parsedArgs, { ...options.toolContext, signal: upstream }));
      } catch (error) {
        if (error instanceof RunStoppedError || error instanceof SecurityPolicyError) throw error;
        failed = true;
        failure = error;
      }
      // 审计不放入工具错误 catch，写入失败必须终止，不能被任务降级掩盖。
      checkSignal(signal);
      await options.audit?.afterStep(step, failed ? "failed" : "succeeded", Math.round(performance.now() - startedAt));
      checkSignal(signal);
      if (failed) {
        if (failure instanceof InternalApiError && (failure.status === 401 || failure.status === 403)) throw failure;
        failures.set(step.stepId, failure);
        return false;
      }
      stepResults.set(step.stepId, result);
      return isWaitingResult(step.toolName, result);
    } finally {
      release();
    }
  };

  if (!runParallel) {
    for (const step of plan.steps) {
      if (await runStep(step)) {
        state = "waiting";
        break;
      }
    }
    return { state, stepResults, failures, toolCallCount: options.toolContext.toolBudget.used };
  }

  const layers = buildPlanLayers(plan);
  let fatal: unknown;
  const abortAll = (error: unknown): void => {
    if (fatal !== undefined) return;
    fatal = error;
    controller.abort(error);
  };

  for (const layer of layers) {
    // 含 propose* 的计划已在上面回退串行，并行路径不会产生“等待人工确认”。
    if (fatal !== undefined) break;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < layer.length) {
        if (fatal !== undefined) return;
        const step = layer[cursor++];
        try {
          if (await runStep(step)) state = "waiting";
        } catch (error) {
          abortAll(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(layer.length, maxParallel) }, worker));
  }
  if (fatal !== undefined) throw fatal;
  return { state, stepResults, failures, toolCallCount: options.toolContext.toolBudget.used };
};
