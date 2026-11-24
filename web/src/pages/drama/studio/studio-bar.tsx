import { useSharedWorkspace } from "@/hooks/use-shared-workspace";
import { CloudAlert, Loader2, MonitorPlay, RotateCw, Timer } from "lucide-react";

import { ChipPopover, MenuLabel } from "@/components/drama/pickers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDramaJobsStore } from "@/store/drama";
import { jobConflictReason } from "@/utils/drama/jobs";
import { modelMaxSeconds } from "@/utils/drama/video-models";
import { matchOption, paramEntries } from "@/utils/tasks/capabilities";

import { useStoryboardStart } from "../workspace/storyboard-start";
import { StoryboardBatchButton } from "../workspace/storyboard-batch-dialog";
import { GenerateControls } from "./generate-controls";
import type { SaveSummary } from "../workspace/use-workspace";
import { StudioViewToggle } from "./view-toggle";
import { useStudio } from "./use-studio";

/** 只在保存出了问题时显示；正常的「已保存 / 保存中」不放在顶部条上 */
const SAVE_LABEL: Partial<
  Record<SaveSummary, { text: string; icon: React.ReactNode; tone?: string }>
> = {
  error: {
    text: "保存失败，将重试",
    icon: <CloudAlert className="size-3.5" />,
    tone: "text-destructive",
  },
  conflict: {
    text: "有冲突，已停止保存",
    icon: <CloudAlert className="size-3.5" />,
    tone: "text-status-warning",
  },
};

/** 分辨率：模型有开放的分辨率参数才显示；选择存在本机，按短剧分开 */
function ResolutionChip() {
  const { video, overrides, setOverride } = useStudio();
  const field = paramEntries(video.model?.capabilities).find(
    (entry) => entry.open && entry.type === "enum" && entry.name === "resolution",
  );
  if (!field) return null;
  const current = overrides[field.name] ?? field.default;
  const hit = matchOption(field, current);
  return (
    <ChipPopover
      variant="bar"
      icon={<MonitorPlay />}
      label={String(hit ?? field.default ?? "分辨率")}
    >
      {(close) => (
        <>
          <MenuLabel>{field.label}</MenuLabel>
          {(field.options ?? []).map((option) => (
            <button
              key={String(option)}
              type="button"
              onClick={() => {
                close();
                setOverride(field.name, option);
              }}
              className={cn(
                "hover:bg-muted focus-visible:ring-ring/50 flex min-h-8 items-center rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2",
                String(option) === String(hit) && "bg-muted font-medium",
              )}
            >
              {String(option)}
            </button>
          ))}
        </>
      )}
    </ChipPopover>
  );
}

const SECOND_CHOICES = [3, 4, 5, 6, 8, 10, 12, 15, 20, 30];

/** 片段时长选项按所选模型筛选，当前片段时长始终显示。 */
function SecondsChip() {
  const { selected, actions, video, plan } = useStudio();
  if (!selected) return null;
  const max = modelMaxSeconds(video.model?.capabilities) ?? 15;
  const options = [...new Set([...SECOND_CHOICES.filter((s) => s <= max), selected.seconds])].sort(
    (a, b) => a - b,
  );
  return (
    <ChipPopover
      variant="bar"
      icon={<Timer />}
      label={`${selected.seconds}s`}
      labelClassName={plan?.errors.duration ? "text-status-warning" : "text-foreground"}
      title={`片段时长 · 模型上限 ${max}s`}
      width="w-40"
    >
      {(close) =>
        options.map((seconds) => (
          <button
            key={seconds}
            type="button"
            onClick={() => {
              close();
              if (seconds !== selected.seconds) void actions.setSeconds(selected, seconds);
            }}
            className={cn(
              "hover:bg-muted focus-visible:ring-ring/50 flex min-h-8 items-center rounded-md px-2 text-left text-sm tabular-nums outline-none focus-visible:ring-2",
              seconds === selected.seconds && "bg-muted font-medium",
              seconds > max && "text-status-warning",
            )}
          >
            {seconds}s{seconds > max && <span className="ml-auto text-[11px]">超出模型上限</span>}
          </button>
        ))
      }
    </ChipPopover>
  );
}

const NO_JOBS: never[] = [];

/**
 * 片场顶部条：左边是「列表 | 画布」切换（画布视图下只剩它）和保存出错时的状态（集名挪到右侧面板顶部了），右边是「批量生成脚本」、
 * 「重新生成分镜脚本」，再往右是当前片段的时长、分辨率、比例，最右是视频模型和「立即生成」。
 * 合成整集挪到了「成片」页；这里只管把片段做出来。
 */
export function StudioBar() {
  const shared = useSharedWorkspace();
  const { drama, episode, no, save, video, canvasEntry } = useStudio();
  const jobs = useDramaJobsStore((state) => state.byDrama[drama.id]) ?? NO_JOBS;
  const starter = useStoryboardStart(video.storyboard);
  const status = SAVE_LABEL[save];
  const blocked = jobConflictReason(jobs, "storyboard", [no]);
  return (
    <div className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <StudioViewToggle />
      {status && (
        <span
          role="status"
          className={cn(
            "text-muted-foreground inline-flex items-center gap-1 text-xs max-sm:hidden",
            status.tone,
          )}
        >
          {status.icon}
          {status.text}
        </span>
      )}
      <span className="flex-1" />
      {/* 画布视图里用不上这些按钮，藏起来免得误点；只留左边的切换 */}
      {!shared && canvasEntry.view === "list" && (
        <>
          <StoryboardBatchButton current={no} storyboard={video.storyboard} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重新生成分镜脚本"
            title={blocked ?? "重新生成分镜脚本（已有出视频的片段会先确认）"}
            disabled={!!blocked || starter.pending === no}
            onClick={() => void starter.start(episode)}
          >
            {starter.pending === no ? <Loader2 className="animate-spin" /> : <RotateCw />}
          </Button>
          <div className="flex items-center gap-0.5 max-md:hidden">
            <SecondsChip />
            <ResolutionChip />
            <span className="text-muted-foreground px-2 font-mono text-xs">
              {drama.ratio || "比例未定"}
            </span>
          </div>
          <GenerateControls />
        </>
      )}
    </div>
  );
}
