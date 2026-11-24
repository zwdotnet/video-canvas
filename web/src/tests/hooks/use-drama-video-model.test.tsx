import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { ParamField } from "@/api/model/type";
import type { useDramaVideoModel as HookType } from "@/hooks/use-drama-video-model";
import { installDom, type DomEnv } from "@/tests/helpers/dom";
import type { useModelsStore as StoreType } from "@/store/models";
import type { useStudioPrefsStore as PrefsType } from "@/store/drama-studio";

/** 分集页视频模型：本机偏好 > 项目建剧时选的 > 第一个可用 */

let dom: DomEnv;
let useDramaVideoModel: typeof HookType;
let useModelsStore: typeof StoreType;
let useStudioPrefsStore: typeof PrefsType;
beforeAll(async () => {
  dom = await installDom();
  useDramaVideoModel = (await import("@/hooks/use-drama-video-model")).useDramaVideoModel;
  useModelsStore = (await import("@/store/models")).useModelsStore;
  useStudioPrefsStore = (await import("@/store/drama-studio")).useStudioPrefsStore;
});
afterAll(() => {
  // models store 是全局单例：清掉本文件灌进去的模型，免得后面的测试（如连线规则）读到残留
  useModelsStore.setState({ byKind: {} });
  dom.restore();
});

const video = (key: string, duration?: ParamField) =>
  ({
    key,
    kind: "video",
    label: key,
    pricing: {},
    capabilities: {
      ops: ["i2v"],
      refs: { image: { on: true, max: 9, max_mb: 10 } },
      params: duration ? { duration } : undefined,
    },
  }) as never;

beforeEach(() => {
  useModelsStore.setState({
    byKind: {
      video: {
        status: "ready",
        loadedAt: Date.now(),
        models: [
          video("first"),
          video("second", { type: "number", label: "时长", open: true, max: 10 }),
          video("third", {
            type: "enum",
            label: "时长",
            open: false,
            default: 8,
            options: [8, 15],
          }),
        ],
      },
    },
  });
  useStudioPrefsStore.setState({ byDrama: {} });
  dom.win.localStorage.clear();
});

/** 挂载一个探针，读取解析出的模型或分镜参数。 */
async function resolved(
  projectModel: string | undefined,
  local = "",
  select: (video: ReturnType<typeof useDramaVideoModel>) => string = (video) =>
    video.model?.key ?? "",
): Promise<string> {
  if (local) useStudioPrefsStore.getState().patch("d1", { videoModel: local });
  function Probe() {
    const video = useDramaVideoModel("d1", projectModel);
    return <span>{select(video)}</span>;
  }
  const m = await dom.mount(<Probe />);
  await dom.flush();
  const key = m.container.textContent ?? "";
  await m.unmount();
  return key;
}

describe("useDramaVideoModel 回退顺序", () => {
  test("本机偏好优先于项目自带的", async () => {
    expect(await resolved("third", "second")).toBe("second");
  });

  test("本机没选：用项目建剧时选的", async () => {
    expect(await resolved("third")).toBe("third");
  });

  test("都没有：第一个可用", async () => {
    expect(await resolved("")).toBe("first");
    expect(await resolved(undefined)).toBe("first");
  });

  test("项目选的已下线：回到第一个可用", async () => {
    expect(await resolved("gone")).toBe("first");
  });
});

describe("生成分镜使用当前视频模型的时长上限", () => {
  const target = (video: ReturnType<typeof useDramaVideoModel>) => JSON.stringify(video.storyboard);

  test("已选 10 秒模型时，分镜请求携带 10 秒上限", async () => {
    expect(JSON.parse(await resolved("first", "second", target))).toEqual({
      maxSeconds: 10,
      videoModel: "second",
    });
  });

  test("固定时长模型使用默认值，未声明时长时使用 15 秒", async () => {
    expect(JSON.parse(await resolved("third", "", target))).toEqual({
      maxSeconds: 8,
      videoModel: "third",
    });
    expect(JSON.parse(await resolved("first", "", target))).toEqual({
      maxSeconds: 15,
      videoModel: "first",
    });
  });
});
