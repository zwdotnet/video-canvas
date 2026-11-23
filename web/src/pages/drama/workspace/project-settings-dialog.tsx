import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type {
  DramaImageModels,
  DramaStyles,
  MyPrompt,
  PromptChoice,
  PromptSettings,
  PromptStep,
} from "@/api/drama/type";
import { ChipPopover } from "@/components/drama/pickers";
import { PromptEditorPane } from "@/components/drama/prompts/prompt-editor";
import { PromptRow, PromptRows } from "@/components/drama/prompts/prompt-rows";
import {
  usePromptLibrary,
  type PromptLibrary,
} from "@/components/drama/prompts/use-prompt-library";
import { AgentModelPicker } from "@/components/drama/agent-model-picker";
import { ModelMenu } from "@/components/drama/video-model-menu";
import { DialogSession } from "@/components/dialog-session";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useDramaStyles } from "@/hooks/use-drama-styles";
import { useRemoteModels } from "@/hooks/use-models";
import { useModelSwitchStore } from "@/store/drama-model-switch";
import { pickBoardModel } from "@/utils/drama/board-input";
import { CUSTOM_STYLE_KEY } from "@/utils/drama/options";
import { PROMPT_STEPS, sameChoice } from "@/utils/drama/prompts";
import { promptsToChoices, type StartPrompts } from "@/utils/drama/start-settings";

import { useWorkspace } from "./context";

/** 已建剧的提示词设置转成可编辑的选择（只留来源 / id / 技能名） */
export function settingsToPrompts(settings: PromptSettings): StartPrompts {
  const out = {} as StartPrompts;
  for (const { key } of PROMPT_STEPS) {
    const { source, id, skill } = settings[key];
    out[key] = { source, ...(id ? { id } : {}), ...(skill ? { skill } : {}) };
  }
  return out;
}

/** 有哪些环节的选择和已保存的不一样 */
export function changedSteps(settings: PromptSettings, value: StartPrompts): PromptStep[] {
  return PROMPT_STEPS.filter(({ key }) => !sameChoice(settings[key], value[key])).map(
    ({ key }) => key,
  );
}

/** 资产图片的三行：键对应 image_models，前缀是模型胶囊上的字样（同开拍设置） */
const IMAGE_MODEL_SLOTS = [
  { key: "character", prefix: "人物" },
  { key: "scene", prefix: "场景" },
  { key: "prop", prefix: "物品" },
] as const;

/** 改了模型的资产类型（故事板的模型不算资产类型，不在内） */
export function changedImageModels(
  saved: DramaImageModels,
  value: DramaImageModels,
): (typeof IMAGE_MODEL_SLOTS)[number]["key"][] {
  return IMAGE_MODEL_SLOTS.map(({ key }) => key).filter((key) => saved[key] !== value[key]);
}

/** 分区：小标题 + 内容 */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <div className="text-muted-foreground px-3 text-[13px]">{label}</div>
      {children}
    </div>
  );
}

/**
 * 项目设置的内容（弹窗正文，每次打开重新挂载）：Agent 模型、图片模型、提示词和自定义画风；
 * 新建 / 编辑「我的提示词」时整块换成编辑器。
 * 点「完成」才保存；故事板的模型不会让资产卡换模型，只影响之后发起的任务；
 * 换了图片模型的类型，资产区里还没生成的卡跟着换成新模型。
 */
export function ProjectSettingsBody({
  library,
  styles,
  onClose,
}: {
  /** 提示词库 */
  library: PromptLibrary;
  /** 内置画风，用于回显开拍时选中的内置提示词 */
  styles: DramaStyles["styles"];
  /** 关闭弹窗 */
  onClose: () => void;
}) {
  const { drama, patch } = useWorkspace();
  const imageRemote = useRemoteModels("image");
  const [value, setValue] = useState<StartPrompts>(() => settingsToPrompts(drama.promptSettings));
  const [imageModels, setImageModels] = useState<DramaImageModels>(() => drama.imageModels);
  const [textModel, setTextModel] = useState(drama.textModel);
  const [styleDraft, setStyleDraft] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ step: PromptStep; item: MyPrompt | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = changedSteps(drama.promptSettings, value);
  const changedModels = changedImageModels(drama.imageModels, imageModels);
  const boardChanged = imageModels.board !== drama.imageModels.board;
  const textChanged = textModel !== drama.textModel;
  const isCustomStyle = drama.styleKey === CUSTOM_STYLE_KEY;
  const savedStyle = isCustomStyle
    ? drama.styleCustom
    : (styles.find(({ key }) => key === drama.styleKey)?.prompt ?? "");
  const style = styleDraft ?? savedStyle;
  const styleCustom = style.trim();
  const styleChanged = styleCustom !== savedStyle.trim();
  const styleInvalid = styleChanged && !styleCustom;

  const done = async () => {
    if (
      changed.length === 0 &&
      changedModels.length === 0 &&
      !boardChanged &&
      !textChanged &&
      !styleChanged
    ) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await patch({
        ...(changed.length > 0 ? { prompts: promptsToChoices(value) } : {}),
        ...(changedModels.length > 0 || boardChanged ? { imageModels } : {}),
        ...(textChanged ? { textModel } : {}),
        ...(styleChanged ? { styleCustom } : {}),
        ...(styleChanged && !isCustomStyle ? { styleKey: CUSTOM_STYLE_KEY } : {}),
      });
      if (changedModels.length > 0) {
        useModelSwitchStore
          .getState()
          .request(
            drama.id,
            Object.fromEntries(changedModels.map((key) => [key, imageModels[key]])),
          );
      }
      toast.success("已保存，之后的任务使用新设置");
      onClose();
    } catch {
      /** 失败提示已由 patch 弹出，留在弹窗里方便改 */
      setSaving(false);
    }
  };

  if (editor) {
    return (
      <div className="min-h-0 overflow-y-auto p-5">
        <PromptEditorPane
          key={`${editor.step}:${editor.item?.id ?? "new"}`}
          step={editor.step}
          item={editor.item}
          library={library}
          onClose={(saved) => {
            if (saved) {
              setValue((prev) => ({ ...prev, [saved.step]: { source: "mine", id: saved.id } }));
            }
            setEditor(null);
          }}
        />
      </div>
    );
  }

  return (
    <>
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>项目设置</DialogTitle>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-2 py-4">
        <div className="bg-chrome-hover/60 mx-3 rounded-xl px-3 py-2 text-[13px]">
          修改只影响之后发起的任务，还没生成的资产会换成新的图片模型
        </div>
        <Section label="Agent 模型">
          <div className="grid px-3">
            {/* 装不装得下由后端按这部剧最长一章判断，装不下时保存报 67022 并点名那一章 */}
            <AgentModelPicker variant="field" value={textModel} onChange={setTextModel} />
          </div>
        </Section>
        <Section label="资产图片">
          <div className="grid gap-2 px-3">
            {IMAGE_MODEL_SLOTS.map(({ key, prefix }) => (
              <ModelMenu
                key={key}
                variant="field"
                prefix={prefix}
                kindName="图片"
                models={imageRemote.models}
                loading={imageRemote.status === "idle" || imageRemote.status === "loading"}
                model={imageRemote.models.find((m) => m.key === imageModels[key])}
                fallback={imageRemote.models[0]}
                onPick={(picked) => setImageModels((prev) => ({ ...prev, [key]: picked }))}
                defaultLabel="跟随默认"
              />
            ))}
          </div>
        </Section>
        <Section label="故事板">
          <div className="grid px-3">
            <ModelMenu
              variant="field"
              prefix="故事板"
              kindName="图片"
              models={imageRemote.models}
              loading={imageRemote.status === "idle" || imageRemote.status === "loading"}
              model={imageRemote.models.find((m) => m.key === imageModels.board)}
              fallback={pickBoardModel(imageRemote.models, "", imageModels.scene)}
              onPick={(picked) => setImageModels((prev) => ({ ...prev, board: picked }))}
              defaultLabel="跟随场景图片"
            />
          </div>
        </Section>
        <Section label="提示词">
          <PromptRows
            kind={drama.sourceKind === "script" ? "script" : "novel"}
            value={value}
            library={library}
            saved={drama.promptSettings}
            onChange={(step: PromptStep, choice: PromptChoice) =>
              setValue((prev) => ({ ...prev, [step]: choice }))
            }
            onEdit={(step, item) => setEditor({ step, item })}
          >
            <PromptRow name="自定义画风">
              <ChipPopover
                variant="field"
                label={isCustomStyle || styleChanged ? "自定义" : "内置"}
                ariaLabel="自定义画风"
                width="w-80 max-w-[calc(100vw-2rem)]"
              >
                {() => (
                  <Textarea
                    aria-label="自定义画风"
                    aria-invalid={styleInvalid}
                    value={style}
                    maxLength={500}
                    onChange={(event) => setStyleDraft(event.target.value)}
                    className="max-h-36 min-h-24 overflow-y-auto"
                  />
                )}
              </ChipPopover>
            </PromptRow>
          </PromptRows>
        </Section>
      </div>
      <DialogFooter className="m-0 border-0 bg-transparent px-5 pb-5">
        <Button variant="ghost" className="rounded-full" onClick={onClose}>
          取消
        </Button>
        <Button
          className="rounded-full px-6"
          disabled={saving || styleInvalid}
          title={styleInvalid ? "请输入自定义画风" : undefined}
          onClick={() => void done()}
        >
          {saving && <Loader2 className="animate-spin" />}
          完成
        </Button>
      </DialogFooter>
    </>
  );
}

/** 打开后才加载提示词库，关闭即释放 */
function ProjectSettingsContent({ onClose }: { onClose: () => void }) {
  const library = usePromptLibrary();
  const { styles } = useDramaStyles();
  return <ProjectSettingsBody library={library} styles={styles} onClose={onClose} />;
}

/**
 * 工作台「项目设置」：顶栏画风 / 比例 / 模型胶囊和 ⌘K 命令面板都能打开。
 * 改 Agent 模型、资产图片模型和各环节提示词；保存后只影响之后发起的任务（已在跑的和已有的结果不变）。
 */
export function ProjectSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-chrome ring-chrome-border flex max-h-[min(88svh,760px)] flex-col gap-0 overflow-hidden rounded-2xl p-0 [corner-shape:squircle] shadow-2xl backdrop-blur-2xl backdrop-saturate-150 sm:max-w-lg">
        <DialogSession open={open}>
          <ProjectSettingsContent onClose={() => onOpenChange(false)} />
        </DialogSession>
      </DialogContent>
    </Dialog>
  );
}
