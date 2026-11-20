import { CourseListView } from "@/features/courses/CourseListView";

type CoursesPageSearchParams = Record<string, string | string[] | undefined>;

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

// 课程列表（P-S03 / §2.4）；放在 (student) 路由组内以继承学生端 TopNav，URL 仍为 /courses
export default async function CoursesPage({
  searchParams,
}: {
  searchParams: Promise<CoursesPageSearchParams>;
}) {
  const params = await searchParams;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-6 sm:px-8">
      <CourseListView
        initialKeyword={readParam(params.keyword)}
        initialSemester={readParam(params.semester)}
      />
    </main>
  );
}
