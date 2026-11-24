package plugin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"video-canvas/internal/provider"
	"video-canvas/internal/provider/plugin"
	"video-canvas/internal/provider/pluginmeta"
	"video-canvas/internal/provider/pluginrunner"
)

type byyAssets struct{ fakeAssets }

func (a *byyAssets) Open(ctx context.Context, userID, id uint64) (*provider.AssetFile, error) {
	file, err := a.fakeAssets.Open(ctx, userID, id)
	if err == nil {
		file.URL = fmt.Sprintf("https://cdn.example.com/media/%d", id)
	}
	return file, err
}

func newBYYExecutor(t *testing.T, baseURL, modelID string, assets provider.AssetStore) (*plugin.Executor, *provider.Snapshot) {
	t.Helper()
	src, err := os.ReadFile("../../../../plugins/custom/byy-h3-video.js")
	if err != nil {
		t.Fatal(err)
	}
	runner := plugin.NewInProcessRunnerClient(pluginrunner.NewServer(pluginrunner.Options{}).Handler())
	pre, err := runner.Precheck(context.Background(), string(src))
	if err != nil || !pre.OK {
		t.Fatalf("BYY 插件预检失败：%+v %v", pre, err)
	}
	meta, err := pluginmeta.Parse(pre.Meta)
	if err != nil {
		t.Fatal(err)
	}
	exec := plugin.New(plugin.Options{Runner: runner, Codes: codeStore{"code": string(src)}, Secrets: secretResolver{value: "byy-test-key"}, Assets: assets, IPAllowed: allowLoopback})
	snap := &provider.Snapshot{
		Model: provider.ModelSnapshot{Key: "byy-model", Kind: "video", UpstreamModel: modelID, Capabilities: hailuoCaps},
		Channel: provider.ChannelSnapshot{
			Key: "byy", PluginKey: meta.Key, PluginVersionID: 1, BaseURL: baseURL + "/api/h3",
		},
		Plugin: provider.PluginSnapshot{Key: meta.Key, Version: meta.Version, SHA256: pre.SHA256, Meta: *meta},
	}
	return exec, snap
}

func TestBYYH3SubmitsAllReferenceTypesTogether(t *testing.T) {
	keys := make(chan string, 2)
	up := &fakeNewAPI{handler: func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		keys <- r.Header.Get("Idempotency-Key")
		_, _ = io.WriteString(w, `{"task_id":"byy-job"}`)
	}}
	srv := httptest.NewServer(up)
	defer srv.Close()
	assets := &byyAssets{fakeAssets{userID: 9, files: map[uint64][]byte{}}}
	for id := uint64(1); id <= 15; id++ {
		assets.files[id] = []byte("test asset")
	}
	exec, snap := newBYYExecutor(t, srv.URL, "h3-video-flex", assets)
	in := provider.SubmitInput{Task: provider.TaskRef{ID: 117, UserID: 9}, Input: map[string]any{
		"op": "omni", "prompt": "@图片1 和 @视频2 配 @音频3", "duration": 6, "aspect_ratio": "9:16", "resolution": "720p",
		"images": []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9}, "videos": []uint64{10, 11, 12}, "audios": []uint64{13, 14, 15},
	}}
	for range 2 {
		res, err := exec.Submit(context.Background(), snap, in)
		if err != nil || res.ProviderTaskID != "byy-job" {
			t.Fatalf("提交失败：%+v %v", res, err)
		}
	}
	got := up.last()
	if got.Method != "POST" || got.Path != "/api/h3/v2/video_generation" || got.Auth != "Bearer byy-test-key" {
		t.Fatalf("请求不符：%+v", got)
	}
	if got.Body["model"] != "h3-video-flex" || got.Body["resolution"] != "720P" || got.Body["ratio"] != "9:16" || got.Body["duration"] != float64(6) {
		t.Fatalf("模型或参数不符：%v", got.Body)
	}
	if len(keys) != 2 {
		t.Fatal("应收到两次请求")
	}
	if first, second := <-keys, <-keys; len(first) < 16 || first != second {
		t.Fatalf("同任务的幂等键必须稳定：%q / %q", first, second)
	}
	assertBYYContent(t, got.Body["content"])
}

func assertBYYContent(t *testing.T, raw any) {
	t.Helper()
	content, ok := raw.([]any)
	if !ok || len(content) != 16 {
		t.Fatalf("应在同一个请求里传入提示词、9 图、3 视频、3 音频：%v", raw)
	}
	if text := content[0].(map[string]any); text["type"] != "text" || text["text"] != "@图片1 和 @视频2 配 @音频3" {
		t.Fatalf("应透传素材编号：%v", text)
	}
	for _, group := range []struct {
		start, end int
		kind, role string
	}{{1, 10, "image_url", "reference_image"}, {10, 13, "video_url", "reference_video"}, {13, 16, "audio_url", "reference_audio"}} {
		for i, raw := range content[group.start:group.end] {
			item := raw.(map[string]any)
			url := item["url"]
			if group.kind != "video_url" {
				url = item[group.kind].(map[string]any)["url"]
			}
			if item["type"] != group.kind || item["role"] != group.role || url != fmt.Sprintf("https://cdn.example.com/media/%d", group.start+i) {
				t.Fatalf("参考素材结构错误：%v", item)
			}
		}
	}
}

func TestBYYH3QueryAndDownload(t *testing.T) {
	const videoBody = "fake BYY video bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/output.mp4" {
			if r.Header.Get("Authorization") != "" {
				t.Error("产物下载请求不应携带渠道凭证")
			}
			_, _ = io.WriteString(w, videoBody)
			return
		}
		if r.URL.Path != "/api/h3/v2/query/video_generation/byy-job" || r.Header.Get("Authorization") != "Bearer byy-test-key" {
			t.Errorf("轮询地址或鉴权不符：%s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"task": map[string]any{
			"status": "succeeded", "content": map[string]string{"url": "http://" + r.Host + "/output.mp4"},
		}})
	}))
	defer srv.Close()
	exec, snap := newBYYExecutor(t, srv.URL, "h3-video-prism", nil)
	q, err := exec.Query(context.Background(), snap, provider.TaskRef{ProviderTaskID: "byy-job"})
	if err != nil || q.Status != provider.StatusSucceeded || len(q.Outputs) != 1 || q.Outputs[0].MediaType != "video" {
		t.Fatalf("轮询未得到视频产物：%+v %v", q, err)
	}
	dl, err := exec.Download(context.Background(), snap, q.Outputs[0].URL)
	if err != nil {
		t.Fatal(err)
	}
	defer dl.Body.Close()
	body, err := io.ReadAll(dl.Body)
	if err != nil || string(body) != videoBody {
		t.Fatalf("视频下载失败：%q %v", body, err)
	}
}

func TestBYYH3QueryStatus(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       string
	}{
		{"queued", `{"task":{"status":"queued"}}`, provider.StatusQueued},
		{"running", `{"task":{"status":"running"}}`, provider.StatusRunning},
		{"failed", `{"task":{"status":"failed","error":{"code":"reference_import_failed","message":"参考素材读取失败"}}}`, provider.StatusFailed},
		{"cancelled", `{"task":{"status":"cancelled"}}`, provider.StatusFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			exec, snap := newBYYExecutor(t, srv.URL, "h3-video-flex", nil)
			result, err := exec.Query(context.Background(), snap, provider.TaskRef{ProviderTaskID: "byy-job"})
			if err != nil || result.Status != tc.want {
				t.Fatalf("轮询状态：got=%+v err=%v want=%s", result, err, tc.want)
			}
			if tc.name == "failed" && result.ErrorCode != "reference_import_failed" {
				t.Fatalf("未保留 BYY 错误码：%+v", result)
			}
		})
	}
}
