import { apiFetch } from "./client";

export interface PlanParallelSetting {
  plan_parallel_enabled: boolean;
  updated_at: string | null;
}

export function getPlanParallelSetting() {
  return apiFetch<PlanParallelSetting>("/governance/settings/plan-parallel");
}

export function updatePlanParallelSetting(planParallelEnabled: boolean) {
  return apiFetch<PlanParallelSetting>("/governance/settings/plan-parallel", {
    method: "PUT",
    body: JSON.stringify({ plan_parallel_enabled: planParallelEnabled }),
  });
}
