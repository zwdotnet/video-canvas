import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  adaptSegment,
  addSegment,
  deleteSegment,
  reorderSegments,
  updateSegment,
} from "@/api/drama";
import { DRAMA_ERR, dramaErrorMessage, isDramaError, isRevisionConflict } from "@/api/drama/errors";
import type { CanvasGraphDto } from "@/api/canvas/type";
import type { Drama, EpisodeSummary, Segment, UpdateSegmentInput } from "@/api/drama/type";
import { confirm } from "@/components/admin-ui/confirm-dialog";
import { choose as chooseOption } from "@/components/drama/choice-dialog";
import { useTextHashes } from "@/hooks/use-text-hashes";
import { useDramaAssets, type DramaAssetsState } from "@/hooks/use-drama-assets";
import { useDramaVideoModel } from "@/hooks/use-drama-video-model";
import { useCreditsStore } from "@/store/credits";
import { useDramaJobsStore } from "@/store/drama";
import { segmentKey, useDramaSegmentsStore } from "@/store/drama-segments";
import { useStudioPrefs, useStudioPrefsStore } from "@/store/drama-studio";
import {
  adaptState,
  batchChoice,
  formatLabel,
  segmentNos,
  sha256Hex,
  splitBatch,
  submitTextFor,
  effectiveView,
  type PromptView,
  targetFormat,
  type AdaptState,
  type BatchPick,
  type TargetFormat,
} from "@/utils/drama/adaptation";
import { boardRef, type BoardRef } from "@/utils/drama/board";
import { canvasEntryReducer, type CanvasEntry } from "@/utils/drama/canvas-entry";
import { reloadSegments } from "@/utils/drama/segment-events";
import type { RefAsset } from "@/utils/drama/segment-assets";
import { planSegmentInput, type SegmentPlan } from "@/utils/drama/segment-input";
import {
  applyOrder,
  batchTargets,
  chooseCheck,
  isRunning,
  orderIds,
  playableTake,
  runBatch,
  sameOrder,
} from "@/utils/drama/segments";
import { describeSubmitError } from "@/utils/tasks/submit";
import { submitSegmentTask } from "@/utils/tasks/gateway";

import { useStudioBoards, type StudioBoards } from "./use-studio-boards";
import { priceSpecOf } from "@/utils/tasks/capabilities";
import { quote } from "@/utils/pricing/quote";
import { ApiError } from "@/utils/requests/request";

import { summarizeSave, type SaveSummary } from "../workspace/use-workspace";
import type { AutosaveStatus } from "@/utils/drama/autosave";

const NO_SEGMENTS: Segment[] = [];

/** 中间预览的两面 */
export type PreviewView = "board" | "video";
/** 有片段在生成时多久对账一次：WebSocket 是主通道，这里兜底 */
const POLL_MS = 8000;
/** 新增片段的默认时长（秒），不超过模型上限 */
const DEFAULT_SECONDS = 10;

/** 片段工作区的全部状态与动作；各区域组件从 context 取 */
export type Studio = {
  drama: Drama;
  episode: EpisodeSummary;
  no: number;
  segments: Segment[];
  segmentsStatus: "loading" | "ready" | "error";
  selected: Segment | null;
  select: (id: string) => void;
  assets: RefAsset[];
  assetsStatus: DramaAssetsState["status"];
  video: ReturnType<typeof useDramaVideoModel>;
  /** 顶栏选的生成参数（分辨率等） */
  overrides: Record<string, unknown>;
  setOverride: (name: string, value: unknown) => void;
  /** 选中片段的故事板（画布上的图片节点），生视频时作为第一张参考图；没有为 null */
  board: BoardRef | null;
  /** 生视频时不带故事板（本机偏好，按短剧分开） */
  boardOff: boolean;
  setBoardOff: (off: boolean) => void;
  /** 每个片段的故事板：状态、生成、补齐整集 */
  boards: StudioBoards;
  /**
   * 片场整体看哪一面：列表（资产库 / 预览 / 编辑 / 片段条）或画布（当前这张短剧画布）。
   * 像资产管理那样两面都不卸载，切换只改看哪一面（交叉淡入）；画布在片场进入后的空闲时间后台挂好，点的时候已经在了。
   */
  canvasEntry: CanvasEntry;
  /** 空闲时后台挂上画布（仍然看着列表） */
  mountCanvas: () => void;
  /** 切到画布面 */
  showCanvas: () => void;
  /** 切回列表面（画布仍然挂着） */
  showList: () => void;
  /** 画布里已经飞到目标节点（或放弃了） */
  canvasFocused: () => void;
  /** 画布没能加载出来：卸载画布、回列表 */
  canvasFailed: () => void;
  /**
   * 片场里的画布编辑器存盘成功：用存下的图谱更新故事板和资产。
   * 在画布里点生成、隐藏着的画布回填出图都只走编辑器自己的保存（后端不推 canvas.patch），列表那面靠它跟上。
   */
  canvasSaved: (graph: CanvasGraphDto) => void;
  /** 进入画布查看某个故事板节点：切到画布面，画布里视口过渡着飞到它；就在片场里，不跳工序 */
  openBoardInCanvas: (nodeId: string) => void;
  /** 中间预览看哪一面：故事板 / 视频；没手动切过时，选中片段有视频看视频，没有看故事板 */
  view: PreviewView;
  setView: (view: PreviewView) => void;
  /**
   * 选中片段此刻要提交的文字（还没存下来的也算）：目标格式是 Seedance 时是原稿，
   * 其他格式有转写稿时是转写稿、没有时是原稿；参考素材条和报价跟着它变
   */
  prompt: string;
  /** 记下编辑中的文字；kind 默认原稿，转写稿传格式 */
  setDraft: (id: string, text: string, kind?: DraftKind) => void;
  /** 顶栏视频模型要的提示词格式（按后台配置的 prompt_format） */
  format: TargetFormat;
  /**
   * 选中片段此刻用哪份文字生成：提示词面板上选了「原稿」就用原稿（不转写也能生成），选了「转写」就用转写稿；
   * 视频模型本身吃 Seedance 原稿时只有原稿
   */
  promptView: PromptView;
  /** 在提示词面板上选标签；只对选中的片段有效，换片段回到默认 */
  setPromptView: (view: PromptView) => void;
  /** 正在转写的片段 */
  adapting: ReadonlySet<string>;
  /** 转写失败原因，键为「片段 id:格式」；重新转写或成功后清掉 */
  adaptErrors: Readonly<Record<string, string>>;
  /** 片段在当前格式下转写稿的状态；目标是 Seedance 时为 null */
  adaptStateOf: (segment: Segment) => AdaptState | "busy" | null;
  /** 选中片段此刻的组装结果 */
  plan: SegmentPlan | null;
  /** 选中片段的预估积分；算不出来为 undefined */
  credits: number | undefined;
  availableCredits: number | null;
  save: SaveSummary;
  reportSave: (key: string, status: AutosaveStatus) => void;
  /** 正在提交视频的片段 */
  submitting: ReadonlySet<string>;
  /** 提示词编辑器登记：生成 / 转写前立即存盘；返回注销函数 */
  registerEditor: (handle: EditorHandle) => () => void;
  actions: {
    add: () => Promise<void>;
    remove: (segment: Segment) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    setSeconds: (segment: Segment, seconds: number) => Promise<void>;
    patch: (sid: string, fields: Omit<UpdateSegmentInput, "revision">) => Promise<Segment>;
    choose: (segment: Segment, taskId: string) => Promise<void>;
    /**
     * 立即生成。批量用的两个选项：source 不看转写稿、直接交原稿（「原稿生成」）；
     * deadConfirmed 引用失效已在批量开头统一确认过，不再逐个问
     */
    generate: (
      segment: Segment,
      options?: { source?: boolean; deadConfirmed?: boolean },
    ) => Promise<void>;
    batch: () => Promise<void>;
    /**
     * 把原稿转写成当前格式；转写稿手改过时先确认覆盖（force 跳过确认）。
     * 成功返回 true；失败原因写进 adaptErrors
     */
    adapt: (segment: Segment, options?: { force?: boolean }) => Promise<boolean>;
  };
};

/** 编辑中文字的种类：原稿，或某个格式的转写稿 */
export type DraftKind = "source" | TargetFormat;

/** 转写失败等状态的键 */
export const adaptKey = (sid: string, format: TargetFormat) => `${sid}:${format}`;

/** 批量转写的并发数 */
const ADAPT_CONCURRENCY = 3;

export type EditorHandle = {
  flush: () => Promise<void>;
};

export const StudioContext = createContext<Studio | null>(null);

export function useStudio(): Studio {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudio 必须在片段工作区内部使用");
  return value;
}

/**
 * 片段工作区的数据层：片段列表（HTTP 读取 + WebSocket 推送 + 生成中兜底轮询）、资产库、模型与偏好、
 * 选中的片段及其参考素材组装、积分预估，以及增删改排序、采用结果、立即生成、批量生成这些动作。
 */
export function useStudioState(drama: Drama, no: number, refresh: () => Promise<void>): Studio {
  const dramaId = drama.id;
  const episode = drama.episodes.find((ep) => ep.no === no);
  const key = segmentKey(dramaId, no);
  const list = useDramaSegmentsStore((state) => state.byEpisode[key]);
  const segments = list ?? NO_SEGMENTS;
  const [segmentsStatus, setSegmentsStatus] = useState<Studio["segmentsStatus"]>("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [adapting, setAdapting] = useState<ReadonlySet<string>>(new Set());
  const [adaptErrors, setAdaptErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  const [saveStates, setSaveStates] = useState<Record<string, AutosaveStatus>>({});
  const editors = useRef(new Set<EditorHandle>());
  const queues = useRef(new Map<string, Promise<unknown>>());

  // 载入 + 登记「正在看这一集」（WebSocket 重连 / 回到前台时据此对账）
  useEffect(() => {
    let active = true;
    void reloadSegments(dramaId, no).then(
      (ok) => active && setSegmentsStatus(ok ? "ready" : "error"),
    );
    const unwatch = useDramaSegmentsStore.getState().watch(dramaId, no);
    return () => {
      active = false;
      unwatch();
    };
  }, [dramaId, no]);

  // 有片段在生成：定时对账，推送丢了也能看到结果
  const anyRunning = segments.some(isRunning);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void reloadSegments(dramaId, no), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, dramaId, no]);

  const settled = useDramaJobsStore((state) => state.settled[dramaId] ?? 0);
  const {
    assets,
    status: assetsStatus,
    reload: reloadAssets,
    boards,
    boardsNow,
    applyGraph,
  } = useDramaAssets(drama.canvasId, settled);
  const video = useDramaVideoModel(dramaId, drama.videoModel);
  const prefs = useStudioPrefs(dramaId);
  const availableCredits = useCreditsStore((state) => state.credits?.available ?? null);

  const selected = useMemo(
    () => segments.find((item) => item.id === selectedId) ?? segments[0] ?? null,
    [segments, selectedId],
  );
  const caps = video.model?.capabilities;
  const format = targetFormat(caps);
  const setDraft = useCallback<Studio["setDraft"]>((id, text, kind = "source") => {
    const name = `${id}:${kind}`;
    setDrafts((prev) => (prev[name] === text ? prev : { ...prev, [name]: text }));
  }, []);
  /** 片段原稿此刻的文字：选中片段编辑中的优先（只有它挂着编辑器） */
  const selectedId0 = selected?.id;
  const sourceOf = useCallback(
    (segment: Segment) =>
      (segment.id === selectedId0 ? drafts[`${segment.id}:source`] : undefined) ?? segment.prompt,
    [drafts, selectedId0],
  );
  const sourceTexts = useMemo(() => segments.map(sourceOf), [segments, sourceOf]);
  const hashOf = useTextHashes(sourceTexts);
  const adaptStateOf = useCallback<Studio["adaptStateOf"]>(
    (segment) => {
      if (format === "seedance") return null;
      if (adapting.has(segment.id)) return "busy";
      if (!segment.adaptations[format]) return "none";
      const hash = hashOf(sourceOf(segment));
      // 指纹还没算出来先按最新，算完会重新渲染
      return hash === undefined ? "fresh" : adaptState(segment, format, hash);
    },
    [adapting, format, hashOf, sourceOf],
  );
  /** 选中片段的故事板：过期按原稿（含还没存下的编辑）算 */
  const board = useMemo(
    () => (selected ? boardRef(boards.get(selected.id), hashOf(sourceOf(selected))) : null),
    [boards, hashOf, selected, sourceOf],
  );
  /** 提示词面板上手动选的标签只对当时选中的片段有效，换片段回到默认 */
  const [promptViewPick, setPromptViewPick] = useState<{ id: string; view: PromptView } | null>(
    null,
  );
  const promptView: PromptView = selected
    ? effectiveView(
        format,
        promptViewPick?.id === selected.id ? promptViewPick.view : null,
        selected,
      )
    : "source";
  const setPromptView = useCallback(
    (view: PromptView) => {
      if (selectedId0) setPromptViewPick({ id: selectedId0, view });
    },
    [selectedId0],
  );
  const prompt = useMemo(() => {
    if (!selected) return "";
    const adaptation = format === "seedance" ? undefined : selected.adaptations[format];
    // 选了「转写」且有转写稿：用转写稿（含还没存下的编辑）；其余用原稿
    if (promptView === "adapted" && adaptation) {
      return drafts[`${selected.id}:${format}`] ?? adaptation.prompt;
    }
    return sourceOf(selected);
  }, [drafts, format, promptView, selected, sourceOf]);
  const plan = useMemo(
    () =>
      selected
        ? planSegmentInput({
            caps,
            prompt,
            seconds: selected.seconds,
            ratio: drama.ratio,
            overrides: prefs.overrides,
            assets,
            board,
            boardOff: prefs.boardOff,
          })
        : null,
    [assets, board, caps, drama.ratio, prefs.boardOff, prefs.overrides, prompt, selected],
  );
  const credits = useMemo(() => {
    if (!plan || !video.model || Object.keys(plan.input).length === 0) return undefined;
    return quote(video.model.pricing, caps, priceSpecOf(caps, plan.input));
  }, [caps, plan, video.model]);

  const reportSave = useCallback((name: string, status: AutosaveStatus) => {
    setSaveStates((prev) => (prev[name] === status ? prev : { ...prev, [name]: status }));
  }, []);
  const save = useMemo(() => summarizeSave(saveStates), [saveStates]);

  /** 改片段：同一个片段的修改串行，永远用 store 里最新的 revision；冲突 / 不存在时提示并重新读取 */
  const patch = useCallback<Studio["actions"]["patch"]>(
    (sid, fields) => {
      const run = async () => {
        const current = useDramaSegmentsStore
          .getState()
          .byEpisode[key]?.find((item) => item.id === sid);
        if (!current) throw new Error("片段不存在");
        try {
          const next = await updateSegment(sid, { ...fields, revision: current.revision });
          useDramaSegmentsStore.getState().apply(dramaId, no, next);
          return next;
        } catch (e) {
          if (isRevisionConflict(e)) {
            toast.warning("这个片段在别处被修改过，已为你加载最新内容");
            void reloadSegments(dramaId, no);
          } else if (isDramaError(e, DRAMA_ERR.segmentNotFound)) {
            toast.error(dramaErrorMessage(e));
            useDramaSegmentsStore.getState().remove(dramaId, no, sid);
          } else if (isDramaError(e, DRAMA_ERR.takeInvalid)) {
            toast.error(dramaErrorMessage(e));
            void reloadSegments(dramaId, no);
          } else {
            toast.error(dramaErrorMessage(e, "保存失败，请稍后重试"));
          }
          throw e;
        }
      };
      const prev = queues.current.get(sid) ?? Promise.resolve();
      const result = prev.then(run, run);
      queues.current.set(
        sid,
        result.catch(() => undefined),
      );
      return result;
    },
    [dramaId, key, no],
  );

  /** 带保存状态的一次性修改（时长、采用） */
  const patchWithStatus = useCallback(
    async (sid: string, fields: Omit<UpdateSegmentInput, "revision">) => {
      reportSave("op", "saving");
      try {
        await patch(sid, fields);
      } finally {
        reportSave("op", "saved");
      }
    },
    [patch, reportSave],
  );

  const markSubmitting = useCallback((sid: string, on: boolean) => {
    setSubmitting((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid);
      else next.delete(sid);
      return next;
    });
  }, []);

  /** 所有挂着的提示词编辑器立即存盘（原稿、转写稿） */
  const flushEditors = useCallback(async () => {
    await Promise.all([...editors.current].map((handle) => handle.flush()));
  }, []);

  const markAdapting = useCallback((sid: string, on: boolean) => {
    setAdapting((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid);
      else next.delete(sid);
      return next;
    });
  }, []);

  /** 从 store 取片段的最新快照 */
  const latestOf = useCallback(
    (sid: string) =>
      useDramaSegmentsStore.getState().byEpisode[key]?.find((item) => item.id === sid) ?? null,
    [key],
  );

  /**
   * 转写一个片段到当前格式：先存盘原稿，用 store 里最新的 revision 调后端；
   * 失败只记原因，不动已有转写稿（后端失败也不覆盖）
   */
  const adapt = useCallback<Studio["actions"]["adapt"]>(
    async (segment, options) => {
      if (format === "seedance" || adapting.has(segment.id)) return false;
      const existing = segment.adaptations[format];
      if (existing?.edited && !options?.force) {
        const go = await confirm({
          title: "覆盖手改的转写稿？",
          description: `这份 ${formatLabel(format)} 转写稿被你改过，重新转写会覆盖这些修改。`,
          confirmLabel: "重新转写",
        });
        if (!go) return false;
      }
      const errorKey = adaptKey(segment.id, format);
      markAdapting(segment.id, true);
      setAdaptErrors((prev) => {
        const { [errorKey]: _old, ...rest } = prev;
        return rest;
      });
      try {
        await flushEditors();
        const current = latestOf(segment.id) ?? segment;
        if (!current.prompt.trim()) throw new Error("原稿是空的，先写好原稿再转写");
        const next = await adaptSegment(segment.id, { format, revision: current.revision });
        useDramaSegmentsStore.getState().apply(dramaId, no, next);
        return true;
      } catch (e) {
        const message =
          e instanceof ApiError || !(e instanceof Error)
            ? dramaErrorMessage(e, "转写失败，请稍后重试")
            : e.message;
        setAdaptErrors((prev) => ({ ...prev, [errorKey]: message }));
        if (isRevisionConflict(e)) void reloadSegments(dramaId, no);
        if (isDramaError(e, DRAMA_ERR.segmentNotFound)) {
          useDramaSegmentsStore.getState().remove(dramaId, no, segment.id);
        }
        return false;
      } finally {
        markAdapting(segment.id, false);
      }
    },
    [adapting, dramaId, flushEditors, format, latestOf, markAdapting, no],
  );

  /**
   * 提交前重读一次画布里的资产，用最新的形象和声音组装（资产页刚改的、还没被定时重读捕到的也算）；
   * 读取失败返回 null
   */
  const freshAssets = useCallback(() => reloadAssets(), [reloadAssets]);

  const studioBoards = useStudioBoards({
    drama,
    no,
    segments,
    boards,
    sourceOf,
    hashOf,
    flushEditors,
    freshAssets,
    latestOf,
  });

  /** 手动切过的那一面只对当时选中的片段有效，换片段回到默认 */
  const [viewPick, setViewPick] = useState<{ id: string; view: PreviewView } | null>(null);
  const view: PreviewView =
    selected && viewPick?.id === selected.id
      ? viewPick.view
      : selected && playableTake(selected)
        ? "video"
        : "board";
  const setView = useCallback(
    (next: PreviewView) => {
      if (selectedId0) setViewPick({ id: selectedId0, view: next });
    },
    [selectedId0],
  );

  const submitVideo = useCallback(
    async (segment: Segment, latest: RefAsset[]) => {
      const model = video.model;
      if (!model) return { ok: false as const, message: "没有可用的视频模型" };
      const built = planSegmentInput({
        caps: model.capabilities,
        prompt: segment.prompt,
        seconds: segment.seconds,
        ratio: drama.ratio,
        overrides: prefs.overrides,
        assets: latest,
        // 故事板取刚重读的画布；过期按存下来的原稿算（segment.prompt 可能已换成转写稿）
        board: boardRef(
          boardsNow().get(segment.id),
          await sha256Hex((latestOf(segment.id) ?? segment).prompt),
        ),
        boardOff: prefs.boardOff,
      });
      const firstError = Object.values(built.errors)[0];
      if (firstError) return { ok: false as const, message: firstError };
      try {
        await submitSegmentTask(segment.id, { model_id: model.key, input: built.input });
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, message: describeSubmitError(e).message };
      }
    },
    [boardsNow, drama.ratio, latestOf, prefs.boardOff, prefs.overrides, video.model],
  );

  /**
   * 提交前确认这个片段在当前格式下用哪份文字：Seedance 用原稿；
   * 其他格式要有转写稿，原稿在转写后改过就问一次「重新转写并生成 / 仍用当前转写稿」。
   * 返回要提交的片段快照（prompt 已换成要交的文字），不提交返回 null
   */
  const resolveSubmit = useCallback(
    async (segment: Segment): Promise<Segment | null> => {
      let current = latestOf(segment.id) ?? segment;
      // 选了「原稿」（或视频模型本身吃 Seedance 原稿）：直接交原稿，不要求转写
      if (promptView === "source" || format === "seedance") return current;
      const adaptation = current.adaptations[format];
      if (!adaptation) {
        toast.error(`先把原稿转写为 ${formatLabel(format)}`);
        return null;
      }
      if (adaptation.sourceHash !== (await sha256Hex(current.prompt))) {
        const picked = await chooseOption({
          title: "原稿在转写后改过",
          description: `当前 ${formatLabel(format)} 转写稿是按旧原稿转的${adaptation.edited ? "，并且被你手改过，重新转写会覆盖这些修改" : ""}。`,
          options: [
            { value: "readapt", label: "重新转写并生成", primary: true },
            { value: "keep", label: "仍用当前转写稿生成" },
          ],
        });
        if (!picked) return null;
        if (picked === "readapt") {
          if (!(await adapt(current, { force: true }))) {
            toast.error("转写失败，没有提交");
            return null;
          }
          current = latestOf(segment.id) ?? current;
        }
      }
      return { ...current, prompt: submitTextFor(current, format, "adapted") };
    },
    [adapt, format, latestOf, promptView],
  );

  const generate = useCallback<Studio["actions"]["generate"]>(
    async (segment, options) => {
      if (submitting.has(segment.id)) return;
      markSubmitting(segment.id, true);
      try {
        // 编辑中的提示词先存盘，提交的就是屏幕上看到的
        await flushEditors();
        const current = options?.source
          ? (latestOf(segment.id) ?? segment)
          : await resolveSubmit(segment);
        if (!current) return;
        const latest = await freshAssets();
        if (!latest) {
          toast.error("资产信息读取失败，请稍后重试", { id: "studio-assets-failed" });
          return;
        }
        const preview = planSegmentInput({
          caps: video.model?.capabilities,
          prompt: current.prompt,
          seconds: current.seconds,
          ratio: drama.ratio,
          overrides: prefs.overrides,
          assets: latest,
        });
        if (preview.deadLabels.length > 0 && !options?.deadConfirmed) {
          const go = await confirm({
            title: "有引用已失效",
            description: `「${preview.deadLabels.join("」「")}」对应的资产已被删除，这部分只会按文字提交。要继续生成吗？`,
            confirmLabel: "继续生成",
          });
          if (!go) return;
        }
        const result = await submitVideo(current, latest);
        if (!result.ok) {
          // 同样的原因只弹一条：批量里积分不足、排队已满会让多个片段同时报同一句
          toast.error(result.message, { id: `studio-submit:${result.message}` });
          return;
        }
        // 提交了就切到「视频」看进度
        setViewPick((prev) =>
          prev?.id === segment.id || segment.id === selectedId0
            ? { id: segment.id, view: "video" }
            : prev,
        );
        await reloadSegments(dramaId, no);
      } finally {
        markSubmitting(segment.id, false);
      }
    },
    [
      drama.ratio,
      dramaId,
      flushEditors,
      freshAssets,
      selectedId0,
      markSubmitting,
      no,
      prefs.overrides,
      latestOf,
      resolveSubmit,
      submitVideo,
      submitting,
      video.model,
    ],
  );

  /**
   * 目标格式需要转写时，批量前先把待生成片段分组：未转写 / 已过期的问一次
   * 「转写后生成 / 原稿生成 / 只生成已转写的」；转写失败的跳过。
   * 返回要提交的片段，和其中要直接用原稿提交的片段 id（选了「原稿生成」时是没转写好的那些）；取消为 null
   */
  const prepareBatch = useCallback(
    async (
      targets: Segment[],
    ): Promise<{ targets: Segment[]; source: ReadonlySet<string> } | null> => {
      const noSource: ReadonlySet<string> = new Set();
      // 选了「原稿」（或视频模型本身吃 Seedance 原稿）：这一批全部直接用原稿生成，不要求转写
      if (format === "seedance" || promptView === "source") return { targets, source: noSource };
      const hashes = new Map(
        await Promise.all(
          targets.map(async (item) => [item.id, await sha256Hex(item.prompt)] as const),
        ),
      );
      const split = splitBatch(targets, format, (item) => hashes.get(item.id) ?? "");
      const pending = [...split.none, ...split.stale];
      let picked: BatchPick = "ready";
      if (pending.length > 0) {
        const choice = await chooseOption(batchChoice(split, format));
        if (!choice) return null;
        picked = choice;
      }
      const ids = split.ready.map((item) => item.id);
      // 原稿生成：没转写好的也进来，但交的是原稿，不经过转写
      const source = new Set(picked === "source" ? pending.map((item) => item.id) : []);
      if (picked === "source") ids.push(...source);
      if (picked === "adapt" && pending.length > 0) {
        const failed: Segment[] = [];
        const queue = [...pending];
        const worker = async () => {
          for (let item = queue.shift(); item; item = queue.shift()) {
            if (await adapt(item, { force: true })) ids.push(item.id);
            else failed.push(item);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(ADAPT_CONCURRENCY, queue.length) }, worker),
        );
        if (failed.length > 0) {
          toast.error(`${failed.length} 个片段转写失败，已跳过：片段 ${segmentNos(failed)}`);
        }
      }
      const picks = targets
        .filter((item) => ids.includes(item.id))
        .map((item) => {
          const current = latestOf(item.id) ?? item;
          return source.has(item.id)
            ? current
            : { ...current, prompt: submitTextFor(current, format, "adapted") };
        });
      return { targets: picks, source };
    },
    [adapt, format, latestOf, promptView],
  );

  const batch = useCallback<Studio["actions"]["batch"]>(async () => {
    const all = batchTargets(useDramaSegmentsStore.getState().byEpisode[key] ?? NO_SEGMENTS);
    if (all.length === 0) {
      toast.info("没有待生成的片段");
      return;
    }
    await flushEditors();
    const prepared = await prepareBatch(all);
    if (!prepared) return;
    const { targets, source } = prepared;
    if (targets.length === 0) {
      toast.info("没有可以直接生成的片段");
      return;
    }
    // 引用失效一起问一次，免得同时提交时弹窗叠一摞
    const latest = await freshAssets();
    if (!latest) {
      toast.error("资产信息读取失败，请稍后重试", { id: "studio-assets-failed" });
      return;
    }
    const dead = new Set<string>();
    for (const item of targets) {
      planSegmentInput({
        caps: video.model?.capabilities,
        prompt: item.prompt,
        seconds: item.seconds,
        ratio: drama.ratio,
        overrides: prefs.overrides,
        assets: latest,
      }).deadLabels.forEach((label) => dead.add(label));
    }
    if (dead.size > 0) {
      const go = await confirm({
        title: "有引用已失效",
        description: `「${[...dead].join("」「")}」对应的资产已被删除，这部分只会按文字提交。要继续批量生成吗？`,
        confirmLabel: "继续生成",
      });
      if (!go) return;
    }
    // 和逐个点「立即生成」一样，全部同时提交，并发由后台统一限制
    await runBatch(targets, (item) =>
      generate(item, { source: source.has(item.id), deadConfirmed: true }),
    );
  }, [
    drama.ratio,
    flushEditors,
    freshAssets,
    generate,
    key,
    prefs.overrides,
    prepareBatch,
    video.model,
  ]);

  const add = useCallback<Studio["actions"]["add"]>(async () => {
    try {
      const max = video.model?.capabilities.params?.duration?.max;
      const created = await addSegment(dramaId, no, {
        seconds: max ? Math.min(DEFAULT_SECONDS, max) : DEFAULT_SECONDS,
      });
      useDramaSegmentsStore.getState().apply(dramaId, no, created);
      setSelectedId(created.id);
      void refresh();
    } catch (e) {
      toast.error(dramaErrorMessage(e, "新增失败，请稍后重试"));
    }
  }, [dramaId, no, refresh, video.model]);

  const remove = useCallback<Studio["actions"]["remove"]>(
    async (segment) => {
      const ok = await confirm({
        title: `删除片段 ${String(segment.seq + 1).padStart(2, "0")}？`,
        description: "只删除这个片段和它的提示词；已经生成的视频和素材不会被删除。",
        confirmLabel: "删除",
        destructive: true,
        onConfirm: () => deleteSegment(segment.id),
      });
      if (!ok) return;
      useDramaSegmentsStore.getState().remove(dramaId, no, segment.id);
      void reloadSegments(dramaId, no);
      void refresh();
    },
    [dramaId, no, refresh],
  );

  const reorder = useCallback<Studio["actions"]["reorder"]>(
    async (ids) => {
      const current = useDramaSegmentsStore.getState().byEpisode[key] ?? NO_SEGMENTS;
      if (sameOrder(ids, orderIds(current))) return;
      // 先在本地换序，界面不等请求
      useDramaSegmentsStore.getState().setList(dramaId, no, applyOrder(current, ids));
      try {
        useDramaSegmentsStore
          .getState()
          .setList(dramaId, no, await reorderSegments(dramaId, no, ids));
        // 顺序变了：成片是否过期要跟着刷新
        void refresh();
      } catch (e) {
        toast.error(dramaErrorMessage(e, "排序失败，已恢复原顺序"));
        void reloadSegments(dramaId, no);
      }
    },
    [dramaId, key, no, refresh],
  );

  const setSeconds = useCallback<Studio["actions"]["setSeconds"]>(
    async (segment, seconds) => {
      if (seconds === segment.seconds) return;
      await patchWithStatus(segment.id, { seconds }).catch(() => undefined);
      void refresh();
    },
    [patchWithStatus, refresh],
  );

  const choose = useCallback<Studio["actions"]["choose"]>(
    async (segment, taskId) => {
      const check = chooseCheck(segment, taskId);
      if (check === "already") return;
      if (check === "invalid") {
        toast.error(dramaErrorMessage(null, "只能采用本片段已成功的结果"));
        return;
      }
      await patchWithStatus(segment.id, { chosenTaskId: taskId }).catch(() => undefined);
      void refresh();
    },
    [patchWithStatus, refresh],
  );

  const registerEditor = useCallback((handle: EditorHandle) => {
    editors.current.add(handle);
    return () => {
      editors.current.delete(handle);
    };
  }, []);

  const [canvasEntry, dispatchEntry] = useReducer(canvasEntryReducer, {
    view: "list",
    mounted: false,
    target: null,
  } satisfies CanvasEntry);
  const mountCanvas = useCallback(() => dispatchEntry({ type: "mount" }), []);
  const showCanvas = useCallback(() => dispatchEntry({ type: "show", target: null }), []);
  const showList = useCallback(() => dispatchEntry({ type: "show-list" }), []);
  const canvasFocused = useCallback(() => dispatchEntry({ type: "focused" }), []);
  const canvasFailed = useCallback(() => dispatchEntry({ type: "fail" }), []);
  const canvasSaved = useCallback((graph: CanvasGraphDto) => applyGraph(graph.nodes), [applyGraph]);
  const openBoardInCanvas = useCallback(
    (nodeId: string) => dispatchEntry({ type: "show", target: nodeId }),
    [],
  );

  const setBoardOff = useCallback(
    (off: boolean) => useStudioPrefsStore.getState().patch(dramaId, { boardOff: off }),
    [dramaId],
  );

  const setOverride = useCallback(
    (name: string, value: unknown) =>
      useStudioPrefsStore
        .getState()
        .patch(dramaId, { overrides: { ...prefs.overrides, [name]: value } }),
    [dramaId, prefs.overrides],
  );

  return {
    drama,
    // 调用方保证这一集存在
    episode: episode as EpisodeSummary,
    no,
    segments,
    segmentsStatus,
    selected,
    select: setSelectedId,
    assets,
    assetsStatus,
    video,
    overrides: prefs.overrides,
    setOverride,
    board,
    boardOff: prefs.boardOff,
    setBoardOff,
    boards: studioBoards,
    canvasEntry,
    mountCanvas,
    showCanvas,
    showList,
    canvasFocused,
    canvasFailed,
    canvasSaved,
    openBoardInCanvas,
    view,
    setView,
    prompt,
    setDraft,
    format,
    promptView,
    setPromptView,
    adapting,
    adaptErrors,
    adaptStateOf,
    plan,
    credits,
    availableCredits,
    save,
    reportSave,
    submitting,
    registerEditor,
    actions: { add, remove, reorder, setSeconds, patch, choose, generate, batch, adapt },
  };
}
