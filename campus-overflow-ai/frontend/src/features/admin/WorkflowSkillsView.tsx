"use client";

import { useState } from "react";

import {
  archiveSkill,
  createSkill,
  fetchSkill,
  listSkills,
  publishSkill,
  setSkillStatus,
  updateSkill,
  type SkillDetail,
  type SkillItem,
  type SkillUpsertInput,
} from "@/api/workflow-skills";
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  LoadingSkeleton,
  Pagination,
  Select,
  Textarea,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";

const PAGE_SIZE = 20;

const STATUS_LABELS: Record<SkillItem["status"], string> = {
  draft: "草稿",
  active: "已启用",
  disabled: "已停用",
  archived: "已归档",
};

const TASK_TYPES = [
  "moderation_scan",
  "moderation_patrol",
  "similar_questions",
  "suggest_tags",
  "knowledge_tree",
  "doc_draft",
  "teaching_report",
  "chat",
];

type EditorFields = {
  name: string;
  taskType: string;
  courseId: string;
  conditions: string;
  steps: string;
  tips: string;
  checks: string;
  maxTokens: string;
};

const EMPTY_FIELDS: EditorFields = {
  name: "",
  taskType: "moderation_scan",
  courseId: "",
  conditions: "",
  steps: "",
  tips: "",
  checks: "",
  maxTokens: "1500",
};

function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function fieldsFromDetail(detail: SkillDetail): EditorFields {
  const content = detail.versions.find((item) => item.status === "draft")?.content
    ?? detail.versions.find((item) => item.version === detail.current_version)?.content
    ?? detail.versions[0]?.content;
  return {
    name: detail.name,
    taskType: detail.task_type,
    courseId: detail.course_id === null ? "" : String(detail.course_id),
    conditions: content?.conditions.join("\n") ?? "",
    steps: content?.steps.join("\n") ?? "",
    tips: content?.tips.join("\n") ?? "",
    checks: content?.checks.join("\n") ?? "",
    maxTokens: String(content?.max_tokens ?? 1500),
  };
}

export function WorkflowSkillsView() {
  const [status, setStatus] = useState<"" | SkillItem["status"]>("");
  const [taskType, setTaskType] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [page, setPage] = useState(1);
  const normalizedCourseId = Number(courseFilter);
  const state = useAsyncData(
    () => listSkills({
      page,
      page_size: PAGE_SIZE,
      status: status || undefined,
      task_type: taskType || undefined,
      course_id: Number.isInteger(normalizedCourseId) && normalizedCourseId > 0
        ? normalizedCourseId
        : undefined,
    }),
    [status, taskType, courseFilter, page],
  );
  const items = state.data?.items ?? [];
  const total = state.data?.total ?? 0;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillDetail | null>(null);
  const [fields, setFields] = useState<EditorFields>(EMPTY_FIELDS);
  const [editorLoading, setEditorLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SkillItem | null>(null);

  function updateField<K extends keyof EditorFields>(key: K, value: EditorFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    setEditing(null);
    setFields(EMPTY_FIELDS);
    setError(null);
    setEditorOpen(true);
  }

  async function openEdit(item: SkillItem) {
    setEditing(null);
    setError(null);
    setEditorOpen(true);
    setEditorLoading(true);
    try {
      const detail = await fetchSkill(item.id);
      setEditing(detail);
      setFields(fieldsFromDetail(detail));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Skill 详情加载失败");
      setEditorOpen(false);
    } finally {
      setEditorLoading(false);
    }
  }

  function buildInput(): SkillUpsertInput | null {
    const name = fields.name.trim();
    const task = fields.taskType.trim();
    if (!name || !task) {
      setError("名称和任务类型不能为空");
      return null;
    }
    const maxTokens = Number(fields.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 4000) {
      setError("最大 token 必须是 0~4000 的整数");
      return null;
    }
    const courseId = fields.courseId.trim() === "" ? null : Number(fields.courseId);
    if (courseId !== null && (!Number.isInteger(courseId) || courseId < 1)) {
      setError("课程 ID 必须是正整数，或留空表示全局");
      return null;
    }
    const conditions = linesOf(fields.conditions);
    const steps = linesOf(fields.steps);
    const tips = linesOf(fields.tips);
    const checks = linesOf(fields.checks);
    if ([conditions, steps, tips, checks].some((items) => items.length > 20)) {
      setError("条件、步骤、提示和检查项每类最多 20 条");
      return null;
    }
    return {
      name,
      task_type: task,
      course_id: courseId,
      content: {
        conditions,
        steps,
        tips,
        checks,
        max_tokens: maxTokens,
      },
    };
  }

  async function saveDraft() {
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await updateSkill(editing.id, input);
      else await createSkill(input);
      setEditorOpen(false);
      state.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存 Skill 失败");
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: () => Promise<unknown>, afterSuccess?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      afterSuccess?.();
      state.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function publishFromEditor(version?: number) {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (version === undefined) await publishSkill(editing.id);
      else await publishSkill(editing.id, version);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "发布失败");
      setBusy(false);
      return;
    }

    try {
      const next = await fetchSkill(editing.id);
      setEditing(next);
      setFields(fieldsFromDetail(next));
    } catch {
      setError(
        version === undefined
          ? "已发布，但详情刷新失败，请重新打开编辑。"
          : "已回滚，但详情刷新失败，请重新打开编辑。",
      );
    } finally {
      state.reload();
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold text-ink">工作流 Skill</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            管理可复用治理路径。草稿不会注入，发布并经开关启用后才会参与匹配。
          </p>
        </div>
        <Button onClick={openCreate}>新建 Skill</Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-canvas p-4">
        <div className="w-[170px]">
          <Select
            label="状态"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as "" | SkillItem["status"]);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部状态" },
              ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <div className="w-[210px]">
          <Select
            label="任务类型"
            value={taskType}
            onChange={(event) => {
              setTaskType(event.target.value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部任务" },
              ...TASK_TYPES.map((value) => ({ value, label: value })),
            ]}
          />
        </div>
        <div className="w-[170px]">
          <Input
            label="课程 ID 筛选"
            type="number"
            min={1}
            value={courseFilter}
            onChange={(event) => {
              setCourseFilter(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {error && !editorOpen ? (
        <p role="alert" className="rounded-md border border-danger-line bg-danger-soft px-4 py-2 text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}
      {state.isLoading ? <LoadingSkeleton variant="detail" count={3} /> : null}
      {state.error !== null ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : null}
      {!state.isLoading && state.error === null ? (
        items.length === 0 ? (
          <EmptyState
            title="暂无 Skill"
            description="创建草稿后，经过发布与启用才会进入受控注入候选。"
            actionLabel="新建 Skill"
            onAction={openCreate}
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line bg-canvas">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line text-[12px] text-ink-subtle">
                    <th scope="col" className="py-3 pl-5 pr-4 font-medium">名称</th>
                    <th scope="col" className="py-3 pr-4 font-medium">任务类型</th>
                    <th scope="col" className="py-3 pr-4 font-medium">课程</th>
                    <th scope="col" className="py-3 pr-4 font-medium">状态</th>
                    <th scope="col" className="py-3 pr-4 font-medium">当前版本</th>
                    <th scope="col" className="py-3 pr-4 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-line-subtle text-[13px]">
                      <td className="py-3 pl-5 pr-4 font-medium">{item.name}</td>
                      <td className="py-3 pr-4 font-mono text-[12px]">{item.task_type}</td>
                      <td className="py-3 pr-4">{item.course_id === null ? "全局" : `#${item.course_id}`}</td>
                      <td className="py-3 pr-4">{STATUS_LABELS[item.status] ?? item.status}</td>
                      <td className="py-3 pr-4">{item.current_version ? `v${item.current_version}` : "—"}</td>
                      <td className="py-3 pr-4">
                        <div className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="co-focusable text-brand hover:underline"
                            onClick={() => { void openEdit(item); }}
                          >
                            编辑
                          </button>
                          {item.status === "draft" ? (
                            <button
                              type="button"
                              className="co-focusable text-brand hover:underline"
                              disabled={busy}
                              onClick={() => { void runAction(() => publishSkill(item.id)); }}
                            >
                              发布
                            </button>
                          ) : null}
                          {item.status !== "archived" && item.current_version !== null ? (
                            <button
                              type="button"
                              className="co-focusable text-brand hover:underline"
                              disabled={busy}
                              onClick={() => {
                                void runAction(() => setSkillStatus(
                                  item.id,
                                  item.status === "active" ? "disabled" : "active",
                                ));
                              }}
                            >
                              {item.status === "active" ? "停用" : "启用"}
                            </button>
                          ) : null}
                          {item.status !== "archived" ? (
                            <button
                              type="button"
                              className="co-focusable text-danger-ink hover:underline"
                              disabled={busy}
                              onClick={() => setArchiveTarget(item)}
                            >
                              归档
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-ink-subtle">共 {total} 条</p>
              {total > PAGE_SIZE ? (
                <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
              ) : null}
            </div>
          </>
        )
      ) : null}

      <Drawer
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        dismissible={!busy && !editorLoading}
        title={editing ? `编辑 Skill #${editing.id}` : "新建 Skill"}
        className="w-[620px] max-w-[95vw]"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => { void saveDraft(); }} disabled={busy || editorLoading} isLoading={busy}>
              保存草稿
            </Button>
          </>
        )}
      >
        {editorLoading ? <LoadingSkeleton variant="detail" count={3} /> : (
          <div className="flex flex-col gap-3">
            <Input
              label="名称"
              value={fields.name}
              maxLength={200}
              onChange={(event) => updateField("name", event.target.value)}
            />
            <Select
              label="任务类型"
              value={fields.taskType}
              onChange={(event) => updateField("taskType", event.target.value)}
              options={TASK_TYPES.map((value) => ({ value, label: value }))}
            />
            <Input
              label="课程 ID（留空表示全局）"
              type="number"
              min={1}
              value={fields.courseId}
              onChange={(event) => updateField("courseId", event.target.value)}
            />
            <Textarea
              label="适用条件"
              rows={3}
              value={fields.conditions}
              onChange={(event) => updateField("conditions", event.target.value)}
              hint="每行一条，最多 20 条。"
            />
            <Textarea
              label="执行步骤"
              rows={4}
              value={fields.steps}
              onChange={(event) => updateField("steps", event.target.value)}
              hint="每行一步，只描述可复用路径，不授予工具或角色权限。"
            />
            <Textarea
              label="提示"
              rows={3}
              value={fields.tips}
              onChange={(event) => updateField("tips", event.target.value)}
            />
            <Textarea
              label="检查项"
              rows={3}
              value={fields.checks}
              onChange={(event) => updateField("checks", event.target.value)}
            />
            <Input
              label="最大注入 token"
              type="number"
              min={0}
              max={4000}
              value={fields.maxTokens}
              onChange={(event) => updateField("maxTokens", event.target.value)}
            />
            {error ? <p role="alert" className="text-[13px] text-danger-ink">{error}</p> : null}

            {editing && editing.versions.length > 0 ? (
              <section className="mt-3 border-t border-line pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-ink">版本历史</h3>
                  {editing.versions.some((version) => version.status === "draft") ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => { void publishFromEditor(); }}
                    >
                      发布草稿
                    </Button>
                  ) : null}
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {editing.versions.map((version) => (
                    <li key={version.version} className="rounded-md border border-line bg-panel px-3 py-2 text-[12px]">
                      <span className="font-medium">v{version.version} · {version.status}</span>
                      <span className="ml-2 text-ink-subtle">
                        {version.published_at
                          ? new Date(version.published_at).toLocaleString("zh-CN")
                          : "未发布"}
                      </span>
                      {version.status !== "draft" ? (
                        <button
                          type="button"
                          className="co-focusable ml-3 text-brand hover:underline"
                          disabled={busy}
                          onClick={() => { void publishFromEditor(version.version); }}
                        >
                          回滚到此版本
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={archiveTarget !== null}
        busy={busy}
        title="确认归档 Skill"
        description="归档后不再参与注入，但历史版本与运行引用会保留，不能物理删除。"
        confirmLabel="确认归档"
        danger
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => {
          if (!archiveTarget) return;
          void runAction(async () => {
            await archiveSkill(archiveTarget.id);
            setArchiveTarget(null);
          }, () => {
            if (!status) return;
            const lastPage = Math.max(1, Math.ceil((total - 1) / PAGE_SIZE));
            if (page > lastPage) setPage(lastPage);
          });
        }}
      />
    </div>
  );
}
