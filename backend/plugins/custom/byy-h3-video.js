/**
 * BYY H3 视频（连镜协议插件 v1）。
 * 渠道 Base URL：https://byy.jj.link/api/h3，渠道 Key：BYY 工作区 API 密钥。
 * 上游模型示例：h3-video-flex、h3-video-prism。各规格及附件组合以工作区的模型规则为准。
 * 「全能参考」把三类附件放进同一次请求。由连镜生成 BYY 可下载的公网 HTTPS 素材链接。
 * 文档：https://byy.jj.link/developers
 */
module.exports = {
  meta: {
    apiVersion: 1,
    key: "byy-h3-video",
    name: "BYY · H3 多参视频",
    version: "1.0.0",
    vendor: "byy",
    description: "使用 BYY H3 v2 接口，支持文生视频和图片、视频、音频混合参考",
    auth: { type: "bearer" },
    endpoints: { video: { mode: "async", method: "POST", path: "/v2/video_generation" } },
    channelSettings: {
      mute_reference_video: {
        type: "boolean",
        label: "忽略参考视频原声",
        description: "开启后，独立参考音频从 Audio 1 开始编号。",
        default: false,
      },
    },
    poll: { firstDelay: 5, interval: 5, maxInterval: 15, jitter: 0 },
  },

  buildSubmitRequest: function (ctx) {
    var input = ctx.input || {};
    var prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 18000) {
      throw new Error("BYY 提示词须为 1–18000 个字符");
    }
    var model = ctx.model.upstreamModel;
    if (String(model).toLowerCase() === "h3-video-frames") {
      throw new Error("h3-video-frames 使用首尾帧协议，请选择支持全能参考的 BYY 模型");
    }
    var content = [{ type: "text", text: prompt }];
    appendMedia(content, input.images, "image_url", "reference_image", 9);
    appendMedia(content, input.videos, "video_url", "reference_video", 3);
    appendMedia(content, input.audios, "audio_url", "reference_audio", 3);
    var body = { model: model, content: content };
    if (input.duration != null) {
      body.duration = Number(input.duration);
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
      body.resolution = input.resolution.trim().toUpperCase();
    }
    if (typeof input.aspect_ratio === "string" && input.aspect_ratio.trim()) {
      body.ratio = input.aspect_ratio.trim();
    }
    if (typeof input.generate_audio === "boolean") {
      body.generate_audio = input.generate_audio;
    }
    if (ctx.channel.settings && ctx.channel.settings.mute_reference_video === true) {
      body.mute_reference_video = true;
    }
    var request = { method: "POST", path: "/v2/video_generation", json: body, timeout: 60 };
    if (ctx.task && ctx.task.id) {
      request.headers = { "Idempotency-Key": "video-canvas-byy-h3-" + String(ctx.task.id) };
    }
    return request;
  },

  parseSubmitResponse: function (ctx, resp) {
    var body = resp.body || {};
    var jobID = body.task_id;
    if ((typeof jobID !== "string" && typeof jobID !== "number") || String(jobID).trim() === "") {
      throw new Error("BYY 提交响应缺少 task_id");
    }
    return { providerTaskId: String(jobID) };
  },

  buildQueryRequest: function (ctx) {
    return {
      method: "GET",
      path: "/v2/query/video_generation/" + encodeURIComponent(ctx.task.providerTaskId),
      timeout: 30,
    };
  },

  parseQueryResponse: function (ctx, resp) {
    var task = resp.body && resp.body.task;
    if (!task) {
      throw new Error("BYY 轮询响应缺少 task");
    }
    switch (task.status) {
      case "queued":
        return { status: "queued" };
      case "running":
        return { status: "running" };
      case "succeeded":
        var url = task.content && task.content.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          throw new Error("BYY 任务已完成，但未返回有效的视频下载地址");
        }
        return { status: "succeeded", progress: 100, outputs: [{ type: "url", url: url, media_type: "video", mime: "video/mp4" }] };
      case "failed":
      case "cancelled":
        return { status: "failed", error: byyError(task.error, 0, "BYY 任务状态：" + task.status) };
      default:
        throw new Error("BYY 返回未知的视频任务状态");
    }
  },

  classifyError: function (ctx, resp) {
    var body = resp.body || {};
    return byyError(body.error || body.base_resp || body, resp.status, "BYY 返回 HTTP " + resp.status);
  },
};

// 视频用顶层 url，图片和音频用同名嵌套对象。按原始顺序保留每类素材的编号。
function appendMedia(content, refs, type, role, max) {
  if (!Array.isArray(refs)) {
    return;
  }
  if (refs.length > max) {
    throw new Error("BYY " + role + " 最多可传 " + max + " 项");
  }
  for (var i = 0; i < refs.length; i++) {
    var ref = { __fileRef: refs[i], as: "url" };
    var item = { type: type, role: role };
    if (type === "video_url") {
      item.url = ref;
    } else {
      item[type] = { url: ref };
    }
    content.push(item);
  }
}

function byyError(error, status, fallback) {
  error = error || {};
  var code = error.code || error.status_code;
  var message = error.message || error.status_msg || fallback;
  var detail = String(code || "") + " " + message;
  var kind = "terminal";
  if (status === 429 || status >= 500) {
    kind = "retryable";
  } else if (status === 402 || /api_key_limit_exceeded|insufficient.*(?:balance|credits)|余额不足|积分不足/i.test(detail)) {
    kind = "provider_balance";
  } else if (/moderation|content[_ -]?(?:policy|violation)|审核|违规/i.test(detail)) {
    kind = "moderation";
  }
  return { class: kind, code: code ? String(code) : undefined, message: String(message) };
}
