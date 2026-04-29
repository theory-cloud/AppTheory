package apptheory

import (
	"encoding/base64"
	"sort"
	"strings"
)

// Request is the canonical HTTP request model used by the AppTheory runtime.
type Request struct {
	Method string
	Path   string
	Query  map[string][]string
	// Headers are canonicalized to lowercase keys during request normalization.
	// Treat header names as case-insensitive and prefer lowercase when accessing values.
	Headers  map[string][]string
	Cookies  map[string]string
	Body     []byte
	IsBase64 bool
	// SourceProvenance is provider-derived HTTP source metadata.
	// Forwarding headers are ordinary headers and are not used to populate this field.
	SourceProvenance SourceProvenance
}

func normalizeRequest(in Request) (Request, error) {
	return normalizeRequestWithMaxBytes(in, 0)
}

func normalizeRequestWithMaxBytes(in Request, maxRequestBytes int) (Request, error) {
	out := in
	out.Method = strings.ToUpper(strings.TrimSpace(in.Method))
	out.Path = normalizePath(in.Path)
	out.Query = cloneQuery(in.Query)
	out.SourceProvenance = normalizeSourceProvenance(in.SourceProvenance)

	out.Headers = canonicalizeHeaders(in.Headers)

	if in.IsBase64 {
		decodedLen, err := decodedBase64Len(in.Body)
		if err != nil {
			return Request{}, &AppError{Code: errorCodeBadRequest, Message: "invalid base64"}
		}
		if maxRequestBytes > 0 && decodedLen > maxRequestBytes {
			out.Cookies = parseCookies(out.Headers["cookie"])
			out.IsBase64 = in.IsBase64
			return out, &AppError{Code: errorCodeTooLarge, Message: errorMessageRequestTooLarge}
		}
		decoded, err := base64.StdEncoding.DecodeString(string(in.Body))
		if err != nil {
			return Request{}, &AppError{Code: errorCodeBadRequest, Message: "invalid base64"}
		}
		out.Body = decoded
	} else {
		out.Body = append([]byte(nil), in.Body...)
	}

	out.Cookies = parseCookies(out.Headers["cookie"])
	out.IsBase64 = in.IsBase64
	return out, nil
}

func decodedBase64Len(src []byte) (int, error) {
	cleanLen := 0
	padStart := -1
	padCount := 0

	for _, b := range src {
		if b == '\r' || b == '\n' {
			continue
		}
		if b == '=' {
			if padStart < 0 {
				padStart = cleanLen
			}
			padCount++
			if padCount > 2 {
				return 0, base64.CorruptInputError(cleanLen)
			}
			cleanLen++
			continue
		}
		if padStart >= 0 || !isBase64AlphabetByte(b) {
			return 0, base64.CorruptInputError(cleanLen)
		}
		cleanLen++
	}

	if cleanLen == 0 {
		return 0, nil
	}
	if cleanLen%4 != 0 {
		return 0, base64.CorruptInputError(cleanLen)
	}
	if padStart >= 0 && cleanLen-padStart > 2 {
		return 0, base64.CorruptInputError(padStart)
	}
	return (cleanLen/4)*3 - padCount, nil
}

func isBase64AlphabetByte(b byte) bool {
	return (b >= 'A' && b <= 'Z') ||
		(b >= 'a' && b <= 'z') ||
		(b >= '0' && b <= '9') ||
		b == '+' ||
		b == '/'
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
