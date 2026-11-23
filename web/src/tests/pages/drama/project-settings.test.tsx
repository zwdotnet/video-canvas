import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Drama, PromptSettings, UpdateDramaInput } from "@/api/drama/type";
import type { PromptLibrary } from "@/components/drama/prompts/use-prompt-library";
import { installDom, type DomEnv } from "@/tests/helpers/dom";
import type {
  ProjectSettingsBody as ProjectSettingsBodyType,
  changedImageModels as changedImageModelsType,
  changedSteps as changedStepsType,
  settingsToPrompts as settingsToPromptsType,
} from "@/pages/drama/workspace/project-settings-dialog";
import type { CommandPalette as CommandPaletteType } from "@/pages/drama/workspace/command-palette";
import type { DramaWorkspaceContext as DramaWorkspaceContextType } from "@/pages/drama/workspace/context";
import type { Dialog as DialogType } from "@/components/ui/dialog";
import type { useModelsStore as useModelsStoreType } from "@/store/models";
import type { useModelSwitchStore as useModelSwitchStoreType } from "@/store/drama-model-switch";

/**
 * 工作台「项目设置」：资产图片模型三行 + 提示词四行（同开拍设置）、提示「修改只影响之后发起的任务」、
 * 点完成保存（PATCH image_models / prompts）；入口在顶栏胶囊和 ⌘K 命令面板。
 */

let dom: DomEnv;
let ProjectSettingsBody: typeof ProjectSettingsBodyType;
let changedSteps: typeof changedStepsType;
let changedImageModels: typeof changedImageModelsType;
let useModelsStore: typeof useModelsStoreType;
let useModelSwitchStore: typeof useModelSwitchStoreType;
let settingsToPrompts: typeof settingsToPromptsType;
let CommandPalette: typeof CommandPaletteType;
let DramaWorkspaceContext: typeof DramaWorkspaceContextType;
let Dialog: typeof DialogType;
beforeAll(async () => {
  dom = await installDom();
  const sheet = await import("@/pages/drama/workspace/project-settings-dialog");
  ProjectSettingsBody = sheet.ProjectSettingsBody;
  changedSteps = sheet.changedSteps;
  changedImageModels = sheet.changedImageModels;
  useModelsStore = (await import("@/store/models")).useModelsStore;
  useModelSwitchStore = (await import("@/store/drama-model-switch")).useModelSwitchStore;
  useModelsStore.setState({
    byKind: {
      image: {
        status: "ready",
        loadedAt: Date.now(),
        models: [
          { key: "img-a", label: "img-a", capabilities: {} },
          { key: "img-b", label: "img-b", capabilities: {} },
        ],
      },
      agent: {
        status: "ready",
        loadedAt: Date.now(),
        models: [
          { key: "agent-a", label: "agent-a", capabilities: { context: { window: 200000 } } },
          { key: "agent-b", label: "agent-b", capabilities: { context: { window: 1000000 } } },
          { key: "agent-s", label: "agent-s", capabilities: { context: { window: 32000 } } },
        ],
      },
    } as never,
  });
  settingsToPrompts = sheet.settingsToPrompts;
  CommandPalette = (await import("@/pages/drama/workspace/command-palette")).CommandPalette;
  DramaWorkspaceContext = (await import("@/pages/drama/workspace/context")).DramaWorkspaceContext;
  Dialog = (await import("@/components/ui/dialog")).Dialog;
});
afterAll(() => {
  // models store 是全局单例：清掉本文件灌进去的模型，免得影响后面的测试
  useModelsStore.setState({ byKind: {} });
  dom.restore();
});

const settings = (patch: Partial<PromptSettings> = {}): PromptSettings => ({
  plan: { source: "builtin", label: "内置" },
  scripts: { source: "builtin", label: "内置" },
  assets: { source: "skill", skill: "cross", label: "技能 · 跨集连续性", missing: true },
  asset_prompts: { source: "mine", id: "1f", label: "我的 · 古风资产" },
  video: { source: "builtin", label: "内置" },
  board: { source: "builtin", label: "内置" },
  ...patch,
});

const library: PromptLibrary = {
  ready: true,
  templates: [],
  mine: {
    plan: [],
    scripts: [],
    assets: [],
    asset_prompts: [
      {
        id: "1f",
        step: "asset_prompts",
        name: "古风资产",
        bodies: {},
        revision: 1,
        updatedAt: "t",
      },
    ],
    video: [],
    board: [
      {
        id: "2b",
        step: "board",
        name: "水彩分镜",
        bodies: { board: "水彩风\n{{画面}}" },
        revision: 1,
        updatedAt: "t",
      },
    ],
  },
  skills: {
    plan: [],
    scripts: [],
    assets: [{ name: "cross", title: "跨集连续性", description: "d" }],
    asset_prompts: [],
    video: [{ name: "tone", title: "镜头语气", description: "d" }],
    board: [],
  },
  save: async () => {
    throw new Error("not used");
  },
  remove: async () => {},
};

const builtinStyle = { key: "real_city_film", name: "都市电影", prompt: "真人电影质感，自然光" };

const dramaOf = (patch: Partial<Drama> = {}) =>
  ({
    id: "d1",
    sourceKind: "novel",
    promptSettings: settings(),
    imageModels: { character: "", scene: "", prop: "", board: "" },
    textModel: "",
    styleKey: builtinStyle.key,
    styleCustom: "",
    episodes: [],
    ...patch,
  }) as never;

const mountBody = (
  drama: Drama,
  patches: Omit<UpdateDramaInput, "revision">[],
  onClose: () => void = () => {},
) =>
  dom.mount(
    <DramaWorkspaceContext.Provider
      value={
        {
          drama,
          jobs: [],
          patch: async (fields: Omit<UpdateDramaInput, "revision">) => {
            patches.push(fields);
            return 2;
          },
        } as never
      }
    >
      <Dialog open>
        <ProjectSettingsBody library={library} styles={[builtinStyle]} onClose={onClose} />
      </Dialog>
    </DramaWorkspaceContext.Provider>,
  );
const chip = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll("span")]
    .find((el) => el.textContent === name)
    ?.parentElement?.querySelector("button") as HTMLButtonElement;
const byText = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);

describe("项目设置：纯逻辑", () => {
  test("比较出改了哪几类资产的图片模型", () => {
    const saved = { character: "", scene: "img-a", prop: "" };
    expect(changedImageModels(saved, saved)).toEqual([]);
    expect(changedImageModels(saved, { character: "img-b", scene: "", prop: "" })).toEqual([
      "character",
      "scene",
    ]);
  });

  test("故事板的模型不算资产类型：只改它时没有资产类型变化", () => {
    const saved = { character: "", scene: "img-a", prop: "", board: "" };
    expect(changedImageModels(saved, { ...saved, board: "img-b" })).toEqual([]);
  });

  test("把已建剧的设置转成可编辑的选择；比较出改了哪些环节", () => {
    const prompts = settingsToPrompts(settings());
    expect(prompts).toEqual({
      plan: { source: "builtin" },
      scripts: { source: "builtin" },
      assets: { source: "skill", skill: "cross" },
      asset_prompts: { source: "mine", id: "1f" },
      video: { source: "builtin" },
      board: { source: "builtin" },
    });
    expect(changedSteps(settings(), prompts)).toEqual([]);
    expect(
      changedSteps(settings(), { ...prompts, video: { source: "skill", skill: "tone" } }),
    ).toEqual(["video"]);
  });
});

describe("项目设置：弹窗内容", () => {
  test("自定义画风放在提示词最后，回显开拍所填内容，点完成才保存", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(
      dramaOf({ styleKey: "custom", styleCustom: "暖色黏土定格" }),
      patches,
    );
    try {
      const row = chip(m.container, "自定义画风");
      expect(row.closest("[data-slot='prompt-rows']")?.lastElementChild).toBe(row.parentElement);
      expect(row.className).toBe(chip(m.container, "故事板提示词").className);
      await dom.click(row);
      const input = dom.win.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='自定义画风']",
      );
      expect(input?.value).toBe("暖色黏土定格");
      await dom.type(input, " ");
      expect(byText(m.container, "完成")?.disabled).toBe(true);
      await dom.type(input, " 水彩手绘，低饱和 ");
      expect(patches).toEqual([]);
      await dom.click(byText(m.container, "完成"));
      expect(patches).toEqual([{ styleCustom: "水彩手绘，低饱和" }]);
    } finally {
      await m.unmount();
    }
  });

  test("内置画风显示开拍时选中的提示词，修改后保存为项目自定义画风", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(dramaOf(), patches);
    try {
      const row = chip(m.container, "自定义画风");
      expect(row?.textContent).toBe("内置");
      await dom.click(row);
      const input = dom.win.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='自定义画风']",
      );
      expect(input?.value).toBe(builtinStyle.prompt);
      await dom.type(input, "剪纸风格");
      await dom.click(byText(m.container, "完成"));
      expect(patches).toEqual([{ styleKey: "custom", styleCustom: "剪纸风格" }]);
    } finally {
      await m.unmount();
    }
  });

  test("提示「修改只影响之后发起的任务」，四行显示已建剧时的设置，来源丢失的行标红提示", async () => {
    const m = await mountBody(dramaOf(), []);
    const text = m.container.textContent ?? "";
    expect(text).toContain("项目设置");
    expect(text).toContain("修改只影响之后发起的任务");
    expect(chip(m.container, "资产拆解").textContent).toBe("技能 · 跨集连续性");
    expect(chip(m.container, "资产拆解").title).toContain("已被删除或停用");
    expect(chip(m.container, "资产拆解").className).toContain("text-status-warning");
    expect(chip(m.container, "资产图提示词").textContent).toBe("我的 · 古风资产");
    expect(chip(m.container, "视频提示词").textContent).toBe("内置");
    await m.unmount();
  });

  test("剧本型项目：分集规划、分集剧本都置灰", async () => {
    const m = await mountBody(dramaOf({ sourceKind: "script" }), []);
    expect(chip(m.container, "分集规划").disabled).toBe(true);
    expect(chip(m.container, "分集剧本").disabled).toBe(true);
    await m.unmount();
  });

  test("没改动点「完成」直接关闭，不发请求", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    let closed = 0;
    const m = await mountBody(dramaOf(), patches, () => (closed += 1));
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toEqual([]);
    expect(closed).toBe(1);
    await m.unmount();
  });

  test("故事板提示词一行：默认内置，下拉里有我的提示词和新建，没有技能；选了完成时只保存这一项的变化", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(dramaOf(), patches);
    expect(chip(m.container, "故事板提示词").textContent).toBe("内置");
    await dom.click(chip(m.container, "故事板提示词"));
    await dom.flush();
    const buttons = [...dom.win.document.body.querySelectorAll("button")];
    expect(buttons.some((b) => (b.textContent ?? "").includes("新建"))).toBe(true);
    expect(buttons.some((b) => (b.textContent ?? "").includes("镜头语气"))).toBe(false);
    await dom.click(buttons.find((b) => (b.textContent ?? "").includes("水彩分镜")));
    expect(chip(m.container, "故事板提示词").textContent).toBe("我的 · 水彩分镜");
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toHaveLength(1);
    expect(patches[0].prompts?.board).toEqual({ source: "mine", id: "2b" });
    await m.unmount();
  });

  test("改了视频提示词的技能，点「完成」带上六个环节的选择一起保存", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    let closed = 0;
    const m = await mountBody(dramaOf(), patches, () => (closed += 1));
    await dom.click(chip(m.container, "视频提示词"));
    await dom.flush();
    const pick = [...dom.win.document.body.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("镜头语气"),
    );
    await dom.click(pick);
    expect(chip(m.container, "视频提示词").textContent).toBe("技能 · 镜头语气");
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toEqual([
      {
        prompts: {
          plan: { source: "builtin" },
          scripts: { source: "builtin" },
          assets: { source: "skill", skill: "cross" },
          asset_prompts: { source: "mine", id: "1f" },
          video: { source: "skill", skill: "tone" },
          board: { source: "builtin" },
        },
      },
    ]);
    expect(closed).toBe(1);
    await m.unmount();
  });
});

describe("项目设置：资产图片模型", () => {
  const menuRow = (name: string) =>
    [...dom.win.document.body.querySelectorAll("button")].find(
      (b) => b.className.includes("min-h-10") && (b.textContent ?? "").startsWith(name),
    );

  test("三类都跟随默认时胶囊显示默认模型；换了人物的模型，完成时保存并让还没生成的人物卡跟着换", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(dramaOf(), patches);
    for (const prefix of ["人物", "场景", "物品"]) {
      expect(byText(m.container, `${prefix} · img-a`)).toBeTruthy();
    }
    await dom.click(byText(m.container, "人物 · img-a"));
    await dom.flush();
    await dom.click(menuRow("img-b"));
    await dom.flush();
    expect(byText(m.container, "人物 · img-b")).toBeTruthy();
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toEqual([
      { imageModels: { character: "img-b", scene: "", prop: "", board: "" } },
    ]);
    expect(useModelSwitchStore.getState().byDrama.d1).toEqual({ character: "img-b" });
    useModelSwitchStore.setState({ byDrama: {} });
    await m.unmount();
  });

  test("故事板一行：没选时显示场景图片模型；换了模型完成时保存，不会让资产卡换模型", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(
      dramaOf({ imageModels: { character: "", scene: "img-b", prop: "", board: "" } }),
      patches,
    );
    expect(byText(m.container, "故事板 · img-b")).toBeTruthy();
    await dom.click(byText(m.container, "故事板 · img-b"));
    await dom.flush();
    await dom.click(menuRow("img-a"));
    await dom.flush();
    expect(byText(m.container, "故事板 · img-a")).toBeTruthy();
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toEqual([
      { imageModels: { character: "", scene: "img-b", prop: "", board: "img-a" } },
    ]);
    expect(useModelSwitchStore.getState().byDrama.d1).toBeUndefined();
    await m.unmount();
  });
});

describe("项目设置：Agent 模型", () => {
  const agentRow = (name: string) =>
    [...dom.win.document.body.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith(name),
    ) as HTMLButtonElement | undefined;

  test("跟随默认时显示第一个 Agent 模型；换成别的，完成时保存 textModel", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(dramaOf(), patches);
    await dom.click(byText(m.container, "agent-a"));
    await dom.flush();
    await dom.click(agentRow("agent-b"));
    await dom.flush();
    expect(byText(m.container, "agent-b")).toBeTruthy();
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toEqual([{ textModel: "agent-b" }]);
    await m.unmount();
  });

  test("不按固定上下文门槛禁用（装不装得下由后端按原文判断）；选回第一个等于跟随默认（空串）", async () => {
    const patches: Omit<UpdateDramaInput, "revision">[] = [];
    const m = await mountBody(dramaOf({ textModel: "agent-b" }), patches);
    await dom.click(byText(m.container, "agent-b"));
    await dom.flush();
    expect(agentRow("agent-s")?.disabled).toBe(false);
    await dom.click(agentRow("agent-a"));
    await dom.flush();
    await dom.click(byText(m.container, "完成"));
    await dom.flush();
    expect(patches).toEqual([{ textModel: "" }]);
    await m.unmount();
  });
});

describe("项目设置：命令面板入口", () => {
  test("⌘K 里有「项目设置」，选中后打开", async () => {
    const calls: string[] = [];
    const m = await dom.mount(
      <DramaWorkspaceContext.Provider
        value={{ drama: { id: "d1", episodes: [] }, jobs: [] } as never}
      >
        <CommandPalette
          open
          onOpenChange={() => calls.push("close")}
          onGo={() => {}}
          onBreakdownOpen={() => calls.push("breakdown")}
          onSettingsOpen={() => calls.push("settings")}
        />
      </DramaWorkspaceContext.Provider>,
    );
    await dom.flush(50);
    const item = [...dom.win.document.body.querySelectorAll('[cmdk-item], [role="option"]')].find(
      (el) => (el.textContent ?? "").includes("项目设置"),
    );
    expect(item).toBeTruthy();
    await dom.click(item);
    expect(calls).toContain("settings");
    await m.unmount();
  });
});
