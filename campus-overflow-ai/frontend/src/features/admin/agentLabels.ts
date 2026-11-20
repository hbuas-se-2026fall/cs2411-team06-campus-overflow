export const AGENT_TASK_TYPE_LABELS: Record<string, string> = {
  chat: "智能问答",
  suggest_tags: "标签推荐",
  similar_questions: "相似问题",
  moderation_scan: "风险扫描",
  doc_draft: "文档草稿",
  knowledge_tree: "大纲分析",
  teaching_report: "教学周报",
  moderation_patrol: "静默巡检",
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  succeeded: "已成功",
  failed: "已失败",
};

export const AGENT_EVENT_LABELS: Record<string, string> = {
  plan: "生成计划",
  step_started: "步骤开始",
  step_succeeded: "步骤成功",
  step_failed: "步骤失败",
};
