import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Segment } from "@/api/drama/type";
import type { Capabilities } from "@/api/model/type";
import { GenerateControls } from "@/pages/drama/studio/generate-controls";
import { PromptPane } from "@/pages/drama/studio/prompt-pane";
import { StudioContext, type Studio } from "@/pages/drama/studio/use-studio";
import { useTasksStore } from "@/store/tasks";
import { planSegmentInput } from "@/utils/drama/segment-input";
import { makeTask } from "../../utils/tasks/fixtures";

const seg = (patch: Partial<Segment> = {}): Segment => ({
  id: "s1",
  episodeNo: 1,
  seq: 0,
  seconds: 10,
  prompt: "【场景】原稿",
  takes: [],
  chosenTaskId: "",
  status: "idle",
  revision: 1,
  updatedAt: "",
  adaptations: {},
  ...patch,
});

/** 夹具的 promptView 默认「原稿」；有转写稿的用例自己传 promptView: "adapted"（真实状态是有转写稿默认看转写） */
const studio = (patch: Partial<Studio>): Studio => {
  const base = {
    promptView: "source",
    assets: [],
    assetsStatus: "ready",
    no: 1,
    format: "h3",
    setPromptView: () => {},
    adapting: new Set<string>(),
    adaptErrors: {},
    adaptStateOf: () => "none",
    setDraft: () => {},
    reportSave: () => {},
    registerEditor: () => () => {},
    submitting: new Set<string>(),
    plan: { errors: {}, input: {}, refs: [], imageCount: 0, imageMax: 9, deadLabels: [] },
    video: { models: [], status: "ready", model: { key: "h3" }, setModel: () => {} },
    actions: { patch: async () => seg(), generate: async () => {}, adapt: async () => true },
    ...patch,
  } as unknown as Studio;
  return base;
};

const render = (value: Studio, node: React.ReactNode) =>
  renderToStaticMarkup(<StudioContext.Provider value={value}>{node}</StudioContext.Provider>);

describe("片场：原稿 / 转写标签", () => {
  test("顶栏是 Seedance 模型：没有转写标签和转写按钮", () => {
    const html = render(
      studio({ format: "seedance", adaptStateOf: () => null }),
      <PromptPane segment={seg()} />,
    );
    expect(html).not.toContain("原稿 · Seedance");
    expect(html).not.toContain("转写为");
  });

  test("H3 模型、还没转写：两个标签，按钮写「转写为 H3」，默认停在原稿", () => {
    const html = render(studio({}), <PromptPane segment={seg()} />);
    expect(html).toContain("原稿 · Seedance");
    expect(html).toContain("转写 · H3");
    expect(html).toContain("转写为 H3");
    expect(html).toMatch(
      /aria-selected="true"[^>]*>(<span[^>]*><\/span>)?<span class="relative">原稿/,
    );
  });

  test("有转写稿但原稿改过：默认停在转写，标「已过期」并提示重新转写", () => {
    const segment = seg({
      adaptations: {
        h3: { prompt: "integrated", sourceHash: "old", edited: false, updatedAt: "" },
      },
    });
    const html = render(
      studio({ adaptStateOf: () => "stale", promptView: "adapted" }),
      <PromptPane segment={segment} />,
    );
    expect(html).toContain("已过期");
    expect(html).toContain("原稿已修改");
    expect(html).toContain("重新转写");
  });

  test("重新转写失败：转写标签里显示原因和重试，旧转写稿还在", () => {
    const segment = seg({
      adaptations: { h3: { prompt: "旧转写", sourceHash: "h", edited: false, updatedAt: "" } },
    });
    const html = render(
      studio({
        adaptStateOf: () => "fresh",
        promptView: "adapted",
        adaptErrors: { "s1:h3": "转写结果不合格，请重试" },
      }),
      <PromptPane segment={segment} />,
    );
    expect(html).toContain("转写结果不合格，请重试");
    expect(html).toContain(">重试<");
  });
});

describe("片场：提示词框撑满剩余高度", () => {
  test("框占右栏剩下的高度（flex-1），文字多了在框里滚，不按视口限高，也不让整个右栏滚", () => {
    for (const format of ["seedance", "h3"] as const) {
      const html = render(studio({ format }), <PromptPane segment={seg()} />);
      const box =
        html.match(/<div[^>]*class="([^"]*bg-panel[^"]*rounded-\[14px\][^"]*)"/)?.[1] ?? "";
      expect(box).toContain("flex-1");
      expect(box).toContain("min-h-48");
      expect(html).not.toContain("max-h-[50vh]");
    }
  });
});

describe("片场：生成按钮的拦截原因", () => {
  test("片段时长超过模型上限时禁用生成和失败重试，恢复到上限时可生成", () => {
    const base = studio({});
    const unsupported = { on: false, max: 0, max_mb: 0 };
    const caps: Capabilities = {
      ops: ["t2v"],
      refs: { image: unsupported, video: unsupported, audio: unsupported },
      prompt: { max_length: 200000 },
      params: { duration: { type: "number", label: "时长", open: true, max: 10 } },
    };
    const renderButton = (selected: Segment) => {
      const plan = planSegmentInput({
        caps,
        prompt: selected.prompt,
        seconds: selected.seconds,
        ratio: "",
        overrides: {},
        assets: [],
      });
      return render({ ...base, selected, plan }, <GenerateControls />);
    };

    for (const status of ["idle", "error"] as const) {
      const html = renderButton(seg({ seconds: 15, status }));
      expect(html).toContain("片段 15s 超出模型上限 10s");
      expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>立即生成/);
    }
    expect(renderButton(seg({ seconds: 10 }))).not.toMatch(/disabled=""[^>]*>立即生成/);
  });

  test("视频卡片已收到失败，片段快照还在生成中时立即解锁", () => {
    const task = makeTask({ task_ref: "video-attempt", status: "failed" });
    /** 静态渲染使用任务库的服务端初始快照。 */
    const initial = useTasksStore.getInitialState();
    const before = initial.tasks;
    initial.tasks = { [task.id]: task };
    try {
      const html = render(
        studio({
          selected: seg({
            status: "running",
            takes: [
              {
                taskId: task.task_ref!,
                status: "pending",
                asset: null,
                errorMessage: "",
                createdAt: "",
              },
            ],
          }),
        }),
        <GenerateControls />,
      );
      expect(html).not.toContain("这个片段正在生成");
      expect(html).toMatch(/<button[^>]*title="开始生成这个片段的视频[^"]*"[^>]*>立即生成/);
    } finally {
      initial.tasks = before;
    }
  });

  test("片段失败后可重新提交，由提交动作重新读取素材并校验", () => {
    const value = studio({ selected: seg({ status: "error" }) });
    const plan = { ...value.plan!, errors: { images: "预览中缺少参考图片" } };
    const html = render({ ...value, plan }, <GenerateControls />);
    expect(html).toMatch(/<button[^>]*title="开始生成这个片段的视频[^"]*"[^>]*>立即生成/);

    const submitting = render(
      { ...value, plan, submitting: new Set(["s1"]) },
      <GenerateControls />,
    );
    expect(submitting).toContain("正在提交");
    expect(submitting).toMatch(/<button[^>]*\sdisabled=""[^>]*>/);
  });

  test("选的是原稿：H3 模型还没转写也能生成（原稿直接生成，不要求先转写）", () => {
    const html = render(studio({ selected: seg(), promptView: "source" }), <GenerateControls />);
    expect(html).not.toContain("先把原稿转写为 H3");
    expect(html).not.toMatch(/disabled=""[^>]*>[^<]*立即生成/);
  });

  test("选的是转写、还没有转写稿：禁用并写明先转写", () => {
    const html = render(studio({ selected: seg(), promptView: "adapted" }), <GenerateControls />);
    expect(html).toContain("先把原稿转写为 H3");
  });

  test("选的是转写、已有转写稿：能生成", () => {
    const html = render(
      studio({
        selected: seg({
          adaptations: { h3: { prompt: "转写稿", sourceHash: "h", edited: false, updatedAt: "" } },
        }),
        promptView: "adapted",
        adaptStateOf: () => "fresh",
      }),
      <GenerateControls />,
    );
    expect(html).not.toContain("先把原稿转写为 H3");
  });

  test("正在转写：禁用并写明正在转写（选转写时）", () => {
    const html = render(
      studio({ selected: seg(), promptView: "adapted", adaptStateOf: () => "busy" }),
      <GenerateControls />,
    );
    expect(html).toContain("正在转写");
  });
});
