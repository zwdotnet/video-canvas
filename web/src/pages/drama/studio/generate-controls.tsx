import { Loader2 } from "lucide-react";

import { VideoModelMenu } from "@/components/drama/video-model-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTask } from "@/store/tasks";
import { formatLabel } from "@/utils/drama/adaptation";
import { hasVideo } from "@/utils/drama/segments";
import { isTerminalStatus } from "@/utils/tasks/status";

import { useStudio, type Studio } from "./use-studio";

/** 为什么现在不能生成；能生成为 null（写进按钮的悬停提示） */
function blockedReason(studio: Studio, running: boolean, failed: boolean): string | null {
  const { selected, plan, video, submitting, format, promptView, adaptStateOf } = studio;
  if (!selected || !plan) return "还没有片段";
  if (running) return "这个片段正在生成";
  if (submitting.has(selected.id)) return "正在提交";
  if (video.status === "idle" || video.status === "loading") return "正在加载模型清单";
  if (!video.model) return "没有可用的视频模型（需要支持参考图）";
  if (plan.errors.duration) return plan.errors.duration;
  // 选的是「原稿」就不要求转写：原稿直接生成；选的是「转写」才看转写稿好了没有
  if (promptView === "adapted") {
    const adapt = adaptStateOf(selected);
    if (adapt === "busy") return "正在转写";
    if (adapt === "none" && format !== "seedance") return `先把原稿转写为 ${formatLabel(format)}`;
  }
  /** 失败后的重试重新读取素材，由提交动作校验实际请求。 */
  return failed ? null : (Object.values(plan.errors)[0] ?? null);
}

/**
 * 片场顶栏右侧的生成操作：视频模型选择 + 「立即生成 · 积分」。
 * 生成的是当前选中的片段；积分不够时数字标红，原因写在悬停提示里。
 */
export function GenerateControls() {
  const studio = useStudio();
  const { selected, credits, availableCredits, actions, submitting, video } = studio;
  const task = useTask(selected?.takes.at(-1)?.taskId);
  /** 片段快照可能晚于同一次生成的任务终态。 */
  const running = selected?.status === "running" && !(task && isTerminalStatus(task.status));
  const failed = selected?.status === "error" || task?.status === "failed";
  const blocked = blockedReason(studio, running, failed);
  const busy = !!selected && (submitting.has(selected.id) || running);
  const out = !!selected && hasVideo(selected);
  const lowCredits =
    credits !== undefined && availableCredits !== null && credits > availableCredits;

  return (
    <div className="flex items-center gap-1.5">
      <VideoModelMenu
        models={video.models}
        loading={video.status === "idle" || video.status === "loading"}
        model={video.model}
        onPick={video.setModel}
      />
      <span className="inline-flex" title={blocked ?? undefined}>
        <Button
          size="sm"
          disabled={!!blocked}
          title={
            blocked
              ? undefined
              : lowCredits
                ? `积分不足：本次约需 ${credits}，当前可用 ${availableCredits}`
                : "开始生成这个片段的视频（⌘↵）"
          }
          onClick={() => selected && void actions.generate(selected)}
        >
          {busy && <Loader2 className="animate-spin" />}
          {out ? "再生成一次" : "立即生成"}
          {credits !== undefined && (
            <>
              <span aria-hidden className="opacity-50">
                ·
              </span>
              <span className={cn("tabular-nums", lowCredits && "text-destructive")}>
                {credits}
              </span>
            </>
          )}
        </Button>
      </span>
    </div>
  );
}
