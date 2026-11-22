package initialize

import (
	"net"

	"video-canvas/internal/config"
	"video-canvas/internal/llmgateway"
	"video-canvas/internal/llmgateway/llmlog"
	"video-canvas/internal/provider/netguard"
)

// outboundIPPolicy 返回默认出站 IP 策略。开发机配置 ai.allow_fake_ip 时额外放行 198.18.0.0/15。
func outboundIPPolicy(cfg *config.Config) func(net.IP) bool {
	if cfg.AI.AllowFakeIP {
		return netguard.IPAllowedWithFakeIP
	}
	return nil
}

// newModelGateway 为短剧与画布 Agent 统一装配模型渠道的出站策略。
func newModelGateway(cfg *config.Config) *llmgateway.Gateway {
	return llmgateway.New(llmgateway.Options{
		IPAllowed:       outboundIPPolicy(cfg),
		LocalAPIOrigins: cfg.AI.LocalAPIOrigins,
		Observer:        llmlog.Observer{},
	})
}
