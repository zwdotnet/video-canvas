import { useCallback, useMemo } from "react";

import type { ModelInfo } from "@/api/model/type";
import { useRemoteModels } from "@/hooks/use-models";
import { useStudioPrefs, useStudioPrefsStore } from "@/store/drama-studio";
import {
  pickVideoModel,
  storyboardMaxSeconds,
  type StoryboardTarget,
} from "@/utils/drama/video-models";

/**
 * 一部短剧当前所选的视频模型：分镜按它限制时长和参考音频，片场生成按它下单，
 * 选择存在本机（按短剧分开）。
 * 本机没选时用建剧时选的（projectModel）；再不行或模型已下线 / 不可用，回到第一个可用的。
 */
export function useDramaVideoModel(dramaId: string, projectModel = "") {
  const remote = useRemoteModels("video");
  const prefs = useStudioPrefs(dramaId);
  const model: ModelInfo | undefined = useMemo(
    () => pickVideoModel(remote.models, prefs.videoModel, projectModel),
    [prefs.videoModel, projectModel, remote.models],
  );
  const setModel = useCallback(
    (key: string) => useStudioPrefsStore.getState().patch(dramaId, { videoModel: key }),
    [dramaId],
  );
  const storyboard: StoryboardTarget = useMemo(
    () => ({ maxSeconds: storyboardMaxSeconds(model), videoModel: model?.key }),
    [model],
  );
  return {
    models: remote.models,
    status: remote.status,
    model,
    setModel,
    /** 生成分镜脚本时给后端的视频模型和单段时长上限 */
    storyboard,
  };
}
