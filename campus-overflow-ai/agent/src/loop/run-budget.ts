import { MAX_TOOL_CALLS } from "../types/plan.js";

export class PlanBudgetError extends Error {
  constructor(message: string) {
    super(`plan budget exceeded: ${message}`);
    this.name = "PlanBudgetError";
  }
}

export interface ToolCallBudget {
  readonly used: number;
  consume: () => void;
}

/** 预算归属本次运行，异常退出不回滚，调用方不能写入累计值。
 *  initialUsed 仅用于让位重排后继续累计，不允许借此扩大上限。 */
export const createToolCallBudget = (initialUsed = 0): ToolCallBudget => {
  if (!Number.isInteger(initialUsed) || initialUsed < 0) throw new Error("工具调用预算初始值无效");
  let used = Math.min(initialUsed, MAX_TOOL_CALLS);
  return Object.freeze({
    get used() { return used; },
    consume: () => {
      if (used >= MAX_TOOL_CALLS) {
        throw new PlanBudgetError(`达到累计工具调用上限（${MAX_TOOL_CALLS} 次）`);
      }
      used += 1;
    },
  });
};
