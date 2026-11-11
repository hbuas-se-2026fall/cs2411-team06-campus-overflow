import { NewQuestionPanel } from "./NewQuestionPanel";

type QuestionNewSearchParams = Record<string, string | string[] | undefined>;

// ?course_id= 预填（课程详情页"我要提问"入口）；非法值忽略
function parseCourseId(params: QuestionNewSearchParams): number | null {
  const raw = params.course_id;
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

// 发布问题页（P-S06，页面控件级设计说明 §2.6）：Server 壳只解析预填参数，
// 表单、相似问题右栏与草稿交互在 NewQuestionPanel（client）；未登录由 proxy 跳登录
export default async function NewQuestionPage({
  searchParams,
}: {
  searchParams: Promise<QuestionNewSearchParams>;
}) {
  const params = await searchParams;
  const initialCourseId = parseCourseId(params);

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8">
      <div className="flex flex-col gap-5">
        <h1 className="text-[22px] font-semibold text-ink">发布问题</h1>
        <NewQuestionPanel initialCourseId={initialCourseId} />
      </div>
    </main>
  );
}
