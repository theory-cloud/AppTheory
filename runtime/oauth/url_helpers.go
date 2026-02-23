package oauth

import (
	"net/url"
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
