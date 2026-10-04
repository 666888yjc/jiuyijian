import { Button } from "@/components/ui/button";
import { useStore } from "../store";
import { PageView } from "../shared";
import { navigate, useHashPath } from "../router";
import { hasOriginalEvidence } from "../sheet";

export function EvidencePage() {
  const [, , docId, pageId, fieldId] = useHashPath().split("/");
  const { state } = useStore();
  for (const task of state.tasks) {
    const doc = task.documents.find((d) => d.id === docId);
    const page = doc?.pages.find((p) => p.id === pageId);
    if (doc && page) {
      const field = task.fields.find((f) => f.id === fieldId);
      return (
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">原文证据</h1>
            <Button variant="outline" size="sm" onClick={() => navigate(`/t/${task.id}/review`)}>
              ← 返回核对
            </Button>
          </div>
          {field && (
            <p className="text-sm text-muted-foreground">
              正在核对：<strong>{field.label}</strong>（识别内容：{field.aiValue ?? "未识别"}）。
              {hasOriginalEvidence(field)
                ? "下方黄色高亮为该内容的来源原文。"
                : "这条内容没能指认到原文里的具体行，只能整页对照（不声称行级可回溯）。"}
            </p>
          )}
          <PageView doc={doc} page={page} highlight={field?.blockIds} />
          {page.empty && (
            <p className="text-sm text-muted-foreground">该页为空白页，无文字证据。</p>
          )}
        </div>
      );
    }
  }
  return (
    <div className="mx-auto max-w-xl space-y-3 rounded-lg border bg-card p-6 text-center">
      <p className="font-medium">找不到对应的原文</p>
      <p className="text-sm text-muted-foreground">该资料可能已被删除。相关字段已退回「待确认」，不会以不可追溯的形式进入交接单。</p>
      <Button variant="outline" onClick={() => navigate("/")}>
        返回任务列表
      </Button>
    </div>
  );
}
