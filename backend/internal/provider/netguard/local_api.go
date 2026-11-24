package netguard

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// LocalAPIOrigins 是部署端配置的模型 API 来源列表，按协议、IP 和端口匹配。零值表示没有放行项。
type LocalAPIOrigins struct {
	entries map[localAPIOrigin]struct{}
}

type localAPIOrigin struct {
	scheme string
	ip     netip.Addr
	port   uint16
}

// ParseLocalAPIOrigins 读取逗号分隔的 http(s) 来源，只接受局域网 IPv4 或回环 IP 字面量。
func ParseLocalAPIOrigins(raw string) (LocalAPIOrigins, error) {
	if strings.TrimSpace(raw) == "" {
		return LocalAPIOrigins{}, nil
	}
	entries := make(map[localAPIOrigin]struct{})
	for i, value := range strings.Split(raw, ",") {
		u, err := url.Parse(strings.TrimSpace(value))
		if err != nil || (u.Path != "" && u.EscapedPath() != "/") || u.ForceQuery || u.RawQuery != "" || u.Fragment != "" {
			return LocalAPIOrigins{}, fmt.Errorf("第 %d 项须为 http(s)://IP[:端口]，不带路径、参数或片段", i+1)
		}
		origin := localAPIOriginOf(u)
		if !origin.ip.IsValid() {
			return LocalAPIOrigins{}, fmt.Errorf("第 %d 项须为 http(s)://IP[:端口]，使用局域网 IPv4 或回环 IP", i+1)
		}
		entries[origin] = struct{}{}
	}
	return LocalAPIOrigins{entries: entries}, nil
}

func localAPIOriginOf(u *url.URL) localAPIOrigin {
	if u == nil || u.Opaque != "" || CheckURLScheme(u.Scheme, u.Hostname(), u.User != nil) != nil {
		return localAPIOrigin{}
	}
	ip, err := netip.ParseAddr(u.Hostname())
	ip = ip.Unmap()
	if err != nil || ip.Zone() != "" || !isLocalAPIIP(ip) {
		return localAPIOrigin{}
	}
	port := uint64(80)
	if u.Scheme == "https" {
		port = 443
	}
	if p := u.Port(); p != "" {
		port, err = strconv.ParseUint(p, 10, 16)
		if err != nil || port == 0 {
			return localAPIOrigin{}
		}
	}
	return localAPIOrigin{scheme: u.Scheme, ip: ip, port: uint16(port)}
}

func isLocalAPIIP(ip netip.Addr) bool {
	return ip.IsLoopback() || (ip.Is4() && ip.IsPrivate())
}

// APITransport 为模型渠道维护独立的公网与本地连接池，避免公网渠道复用本地连接。
type APITransport struct {
	public  *http.Transport
	local   *http.Transport
	origins LocalAPIOrigins
}

// NewAPITransport 创建模型渠道传输层。本地连接池只供匹配部署端配置的渠道使用。
func NewAPITransport(cfg Config, origins LocalAPIOrigins) *APITransport {
	cfg.ApplyDefaults()
	t := &APITransport{public: NewTransport(&cfg), origins: origins}
	if len(origins.entries) > 0 {
		local := cfg
		local.IPAllowed = func(ip net.IP) bool {
			addr, _ := netip.AddrFromSlice(ip)
			for origin := range origins.entries {
				if origin.ip == addr.Unmap() {
					return true
				}
			}
			return false
		}
		t.local = NewTransport(&local)
	}
	return t
}

// ForChannel 只在请求与已配置的渠道来源一致时使用本地连接池。
func (t *APITransport) ForChannel(baseURL string) http.RoundTripper {
	if t.local != nil {
		base, _ := url.Parse(baseURL)
		origin := localAPIOriginOf(base)
		if _, ok := t.origins.entries[origin]; ok {
			return channelAPITransport{t: t, origin: origin}
		}
	}
	return t.public
}

type channelAPITransport struct {
	t      *APITransport
	origin localAPIOrigin
}

func (c channelAPITransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if localAPIOriginOf(req.URL) == c.origin && c.redirectStayedLocal(req.Response) {
		return c.t.local.RoundTrip(req)
	}
	return c.t.public.RoundTrip(req)
}

// redirectStayedLocal 拒绝将第三方重定向视为受信渠道的本地请求。
func (c channelAPITransport) redirectStayedLocal(prev *http.Response) bool {
	return prev == nil || (prev.Request != nil && localAPIOriginOf(prev.Request.URL) == c.origin)
}
