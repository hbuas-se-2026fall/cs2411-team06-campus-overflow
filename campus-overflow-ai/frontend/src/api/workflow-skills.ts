import { apiFetch, buildQuery } from "./client";

export interface SkillContent {
  conditions: string[];
  steps: string[];
  tips: string[];
  checks: string[];
  max_tokens: number;
}

export interface SkillItem {
  id: number;
  name: string;
  task_type: string;
  course_id: number | null;
  status: "draft" | "active" | "disabled" | "archived";
  current_version: number | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SkillList {
  items: SkillItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface SkillVersion {
  skill_id: number;
  version: number;
  content: SkillContent;
  source_run_id: string | null;
  status: string;
  created_by: number | null;
  published_by: number | null;
  published_at: string | null;
  created_at: string | null;
}

export interface SkillDetail extends SkillItem {
  versions: SkillVersion[];
}

export interface SkillUpsertInput {
  name: string;
  task_type: string;
  course_id: number | null;
  content: SkillContent;
}

export function listSkills(
  params: {
    page?: number;
    page_size?: number;
    status?: SkillItem["status"];
    task_type?: string;
    course_id?: number;
  } = {},
) {
  return apiFetch<SkillList>(`/governance/skills${buildQuery(params)}`);
}

export function fetchSkill(skillId: number) {
  return apiFetch<SkillDetail>(`/governance/skills/${skillId}`);
}

export function createSkill(input: SkillUpsertInput) {
  return apiFetch<SkillItem>("/governance/skills", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSkill(skillId: number, input: SkillUpsertInput) {
  return apiFetch<SkillItem>(`/governance/skills/${skillId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function publishSkill(skillId: number, version?: number) {
  return apiFetch<SkillItem>(`/governance/skills/${skillId}/publish`, {
    method: "POST",
    body: JSON.stringify(version === undefined ? {} : { version }),
  });
}

export function setSkillStatus(skillId: number, status: "active" | "disabled") {
  return apiFetch<SkillItem>(`/governance/skills/${skillId}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function archiveSkill(skillId: number) {
  return apiFetch<SkillItem>(`/governance/skills/${skillId}`, { method: "DELETE" });
}
