package apptheory

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
)

// Request is the canonical HTTP request model used by the AppTheory runtime.
type Request struct {
	Method   string
	Path     string
	Query    map[string][]string
	Headers  map[string][]string
	Cookies  map[string]string
	Body     []byte
	IsBase64 bool
}

func normalizeRequest(in Request) (Request, error) {
	out := in
	out.Method = strings.ToUpper(strings.TrimSpace(in.Method))
	out.Path = normalizePath(in.Path)
	out.Query = cloneQuery(in.Query)

	out.Headers = canonicalizeHeaders(in.Headers)

	if in.IsBase64 {
		decoded, err := base64.StdEncoding.DecodeString(string(in.Body))
		if err != nil {
			return Request{}, &AppError{Code: errorCodeBadRequest, Message: fmt.Sprintf("invalid base64: %v", err)}
		}
		out.Body = decoded
	} else {
		out.Body = append([]byte(nil), in.Body...)
	}

	out.Cookies = parseCookies(out.Headers["cookie"])
	out.IsBase64 = in.IsBase64
	return out, nil
}

func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	if i := strings.Index(path, "?"); i >= 0 {
		path = path[:i]
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if path == "" {
		return "/"
	}
	return path
}

func parseCookies(cookieHeaders []string) map[string]string {
	out := map[string]string{}
	for _, header := range cookieHeaders {
		parts := strings.Split(header, ";")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			name, value, ok := strings.Cut(part, "=")
			if !ok {
				continue
			}
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			out[name] = strings.TrimSpace(value)
		}
	}
	return out
}

func canonicalizeHeaders(in map[string][]string) map[string][]string {
	if len(in) == 0 {
		return map[string][]string{}
	}

	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := map[string][]string{}
	for _, key := range keys {
		values := in[key]
		lower := strings.ToLower(strings.TrimSpace(key))
		if lower == "" {
			continue
		}
		out[lower] = append(out[lower], values...)
	}
	return out
}

func cloneQuery(in map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range in {
		out[k] = append([]string(nil), v...)
	}
	return out
}
