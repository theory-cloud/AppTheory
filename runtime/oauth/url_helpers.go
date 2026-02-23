package oauth

import (
	"net/url"
	"path"
	"strings"
)

func parseAbsoluteURL(raw string) (*url.URL, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, false
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, false
	}
	return u, true
}

func joinURLPath(base *url.URL, segment string) *url.URL {
	u := *base
	segment = strings.TrimPrefix(strings.TrimSpace(segment), "/")
	u.Path = path.Join(strings.TrimSuffix(u.Path, "/"), segment)
	return &u
}
