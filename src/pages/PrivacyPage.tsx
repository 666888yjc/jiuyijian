import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useStore } from "../store";
import { useSync, isSyncable } from "../sync";
import { isUserConfirmed } from "../sheet";
import { deferredDeleteNotice, privacyDataStatement, wipeConsequence, taskDeleteStatement } from "../storageNotice";
import { navigate } from "../router";
import { ApiError } from "../api";
import { clearErrorLog, readErrorLog } from "../errorLog";
import { buildMyDataExport } from "../myData";
import { makeAudit } from "../store";

export function PrivacyPage() {
  const { state, dispatch } = useStore();
  const sync = useSync();
  const [deleteError, setDeleteError] = useState("");
  const [errorLog, setErrorLog] = useState(() => readErrorLog());
  const [errorLogCleared, setErrorLogCleared] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const docCount = state.tasks.reduce((n, t) => n + t.documents.length, 0);
  const fieldCount = state.tasks.reduce((n, t) => n + t.fields.length, 0);
  const pendingFields = state.tasks.reduce(
    (n, t) => n + t.fields.filter((f) => f.confirmStatus === "pending").length,
    0,
  );
  const uncertainFields = state.tasks.reduce(
    (n, t) => n + t.fields.filter((f) => f.confirmStatus === "uncertain").length,
    0,
  );
  const confirmedFields = state.tasks.reduce((n, t) => n + t.fields.filter(isUserConfirmed).length, 0);
  const auditRows = [
    ...state.tasks.flatMap((t) =>
      t.audit.slice(-30).map((a) => ({ key: a.id, at: a.at, text: `[${t.purpose.slice(0, 10)}] ${a.detail}` })),
    ),
    ...state.tombstones.map((a) => ({ key: a.id, at: a.at, text: a.detail })),
    ...state.events.map((a) => ({ key: a.id, at: a.at, text: a.detail })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  function downloadMyData() {
    const payload = buildMyDataExport(state, new Date().toISOString());
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    a.href = url;
    a.download = `就医笺-我的数据-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    dispatch({
      type: "event.push",
      audit: makeAudit("data.export", `导出我的数据（${state.tasks.length} 个任务、${docCount} 份资料；不含原件图片）`),
    });
    setExportOpen(false);
  }
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">隐私与数据管理</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前版本（M1）数据说明</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>· {privacyDataStatement({ backend: sync.backend, serverMode: sync.serverMode, signedIn: sync.signedIn })}</p>
          <p>· 本原型仅使用脱敏模拟资料，请勿在正式版本上线前录入真实患者数据。</p>
          {/* 「云端原件也没了」这句在离线时不成立（R73）⇒ 措辞由 storageNotice 一处按云端可达性出 */}
          <p>· {taskDeleteStatement({ serverUpload: sync.serverMode && sync.signedIn, backend: sync.backend })}</p>
          {deleteError && <p role="alert" className="text-destructive">{deleteError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">我的数据清单</CardTitle>
          <CardDescription>只显示数量与字段名称，不显示医疗内容。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>· 任务 {state.tasks.length} 个 / 资料 {docCount} 份</p>
          <p>
            · 信息字段 {fieldCount} 项：待确认 {pendingFields} 项 · 不确定 {uncertainFields} 项 · 已确认/已更正{" "}
            {confirmedFields} 项
          </p>
          <p>· 删除留痕 {state.tombstones.length} 条 / 本机异常记录 {errorLog.length} 条</p>
          <Dialog open={exportOpen} onOpenChange={setExportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                导出我的数据（JSON）
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>导出我的数据</DialogTitle>
                <DialogDescription>
                  将下载一份 JSON
                  副本，包含：任务与资料清单、字段（名称、确认状态、来源、识别值与你修改后的值）、问诊问题、行动项、复诊摘要、操作与删除记录。
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                不含原件图片与 OCR
                原文（体积原因，单张资料图片最大可达数 MB）；如需原件，请通过交接单打印或另存为 PDF。
                本次导出会在下方「处理与操作记录」留一条记录。
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setExportOpen(false)}>
                  取消
                </Button>
                <Button onClick={downloadMyData}>下载 JSON 文件</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">删除就诊任务</CardTitle>
          <CardDescription>任务、资料与交接单一并删除，无法恢复。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {state.tasks.length === 0 && <p className="text-sm text-muted-foreground">暂无任务。</p>}
          {state.tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
              <span className="min-w-0 text-sm break-words">{t.purpose || t.id}</span>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="shrink-0 text-destructive">
                    删除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认删除该任务？</AlertDialogTitle>
                    <AlertDialogDescription>
                      「{t.purpose}」及其 {t.documents.length} 份资料、{t.fields.length} 项信息、交接单将全部删除。
                      {sync.backend !== "up" && isSyncable(t) && <span className="mt-1 block text-destructive">{deferredDeleteNotice()}</span>}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={async () => {
                        setDeleteError("");
                        try {
                          await sync.deleteTaskOnServer(t.id);
                        } catch (error) {
                          setDeleteError(error instanceof ApiError ? `删除失败：${error.message}` : "删除失败，请稍后重试");
                        }
                      }}
                    >
                      确认删除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">处理与操作记录（审计）</CardTitle>
          <CardDescription>只记录操作与字段名称，不记录医疗正文。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {auditRows.map((r) => (
            <p key={r.key} className="text-sm text-muted-foreground">
              <span className="mr-2">{new Date(r.at).toLocaleString("zh-CN")}</span>
              {r.text}
            </p>
          ))}
          {state.tasks.every((t) => t.audit.length <= 1) && state.tombstones.length === 0 && state.events.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无新记录。确认字段、导出、删除都会记录在这里。</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">本机异常记录</CardTitle>
          <CardDescription>
            程序出错时在本设备留下最多 50 条记录，只含错误类型、简要信息、所在页面与时间；不含栈、文件名与网址，也不与任务一起上传。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {errorLog.map((e, i) => (
            <p key={`${e.at}-${i}`} className="text-sm text-muted-foreground">
              <span className="mr-2">{new Date(e.at).toLocaleString("zh-CN")}</span>
              {e.page} · {e.type}：{e.message}
            </p>
          ))}
          {errorLog.length === 0 && (
            <p className="text-sm text-muted-foreground">
              暂无异常记录。{errorLogCleared ? "原有记录已清除。" : ""}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={errorLog.length === 0}
            onClick={() => {
              clearErrorLog();
              setErrorLog([]);
              setErrorLogCleared(true);
            }}
          >
            清除异常记录
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => navigate("/")}>
          返回
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" className="text-destructive">
              清除本机全部数据
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认清除本机全部数据？</AlertDialogTitle>
              <AlertDialogDescription>
                将立即清空本设备浏览器存储：{state.tasks.length} 个任务、{state.tombstones.length} 条删除留痕、{errorLog.length} 条异常记录，无法恢复。
                {wipeConsequence({ backend: sync.backend, serverMode: sync.serverMode, signedIn: sync.signedIn })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  localStorage.clear();
                  window.location.reload();
                }}
              >
                确认清除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
