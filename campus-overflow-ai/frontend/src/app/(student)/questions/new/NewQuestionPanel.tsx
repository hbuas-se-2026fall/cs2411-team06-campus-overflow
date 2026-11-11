"use client";

// 发布问题表单接线（页面控件级设计说明 §2.6）：createQuestion 成功 → 表单 Toast"发布成功"
// → 跳转问题详情；未登录访问已由 middleware 拦截
// 标签两段式提交（E-09 两个写入点）：发布接口 tag_ids 仅收已有标签 id（int），
// 新自定义标签名（str）在发布成功后走绑定接口内联创建（后端 QuestionTagBindRequest 二态）
import { useState } from "react";
import { useRouter } from "next/navigation";

import { JUST_CREATED_QUESTION_KEY } from "@/api/agent-assist";
import { bindQuestionTags, createQuestion } from "@/api/questions";
import { Toast, type ToastTone } from "@/shared/components";
import { SimilarQuestionsCard } from "@/features/agent-assist/SimilarQuestionsCard";
import { QuestionForm } from "@/features/questions/QuestionForm";
import {
  NEW_QUESTION_DRAFT_KEY,
  saveDraft,
  type QuestionDraftValues,
} from "@/features/questions/draft";
import type { QuestionCreated } from "@/shared/types/question";

export function NewQuestionPanel({ initialCourseId }: { initialCourseId: number | null }) {
  const router = useRouter();
  // 绑定失败的提示用本页 toast 承载（QuestionForm 的 toast 只管发布本身）；
  // 跳转详情后用户可直接看到标签落库结果
  const [bindToast, setBindToast] = useState<{ tone: ToastTone; message: string } | null>(null);
  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    courseId: number | null;
    tagIds: Array<number | string>;
    tagNames: string[];
  }>({
    title: "",
    body: "",
    courseId: initialCourseId,
    tagIds: [],
    tagNames: [],
  });
  return (
    <>
      <SimilarQuestionsCard
        questionTitle={draft.title}
        questionBody={draft.body}
        courseId={draft.courseId}
        onNavigate={() => {
          saveDraft(NEW_QUESTION_DRAFT_KEY, {
            title: draft.title,
            content: draft.body,
            course_id: draft.courseId,
            tag_ids: draft.tagIds,
            tag_names: draft.tagNames,
          } satisfies QuestionDraftValues);
        }}
      />
      <QuestionForm<QuestionCreated>
        draftKey={NEW_QUESTION_DRAFT_KEY}
        initialValues={{ course_id: initialCourseId }}
        onSubmit={async (values) => {
          const intTagIds = values.tag_ids?.filter((t): t is number => typeof t === "number");
          const newTagNames = values.tag_ids?.filter((t): t is string => typeof t === "string");
          const created = await createQuestion({
            title: values.title,
            body: values.body,
            course_id: values.course_id,
            tag_ids: intTagIds,
          });
          // 只有当前浏览器会话知道“刚创建”的是哪个问题；实际写标签仍由服务端鉴权。
          try {
            window.sessionStorage.setItem(JUST_CREATED_QUESTION_KEY, String(created.id));
          } catch {
            // 浏览器禁用存储不能反过来把已成功的发布显示为失败。
          }
          if (newTagNames && newTagNames.length > 0) {
            try {
              await bindQuestionTags(created.id, newTagNames);
            } catch (error) {
              // 新标签绑定失败不阻断主流程：问题已发布，进入详情后可重试
              setBindToast({
                tone: "error",
                message: error instanceof Error ? error.message : "新标签绑定失败，可在详情页重试",
              });
            }
          }
          return created;
        }}
        onSuccess={(created) => router.push(`/questions/${created.id}`)}
        onDraftChange={setDraft}
      />
      {bindToast && (
        <Toast
          tone={bindToast.tone}
          message={bindToast.message}
          onClose={() => setBindToast(null)}
        />
      )}
    </>
  );
}
