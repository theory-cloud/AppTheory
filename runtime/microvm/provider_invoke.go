package microvm

import (
	"bytes"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultProviderInvokePort       = int32(8080)
	defaultProviderInvokeTTLSeconds = int32(60)
	maxProviderInvokeBodyBytes      = 6 * 1024 * 1024
)

var providerInvokeMethods = map[string]struct{}{
	"DELETE":  {},
	"GET":     {},
	"HEAD":    {},
	"OPTIONS": {},
	"PATCH":   {},
	"POST":    {},
	"PUT":     {},
}

var providerInvokeForbiddenHeaders = map[string]struct{}{
	"authorization":                 {},
	"connection":                    {},
	"content-length":                {},
	"host":                          {},
	"keep-alive":                    {},
	"proxy-authenticate":            {},
	"proxy-authorization":           {},
	"te":                            {},
	"trailer":                       {},
	"transfer-encoding":             {},
	"upgrade":                       {},
	"x-amz-security-token":          {},
	"x-aws-proxy-auth":              {},
	"x-aws-proxy-port":              {},
	"x-apptheory-microvm-port":      {},
	"x-apptheory-microvm-token-ttl": {},
	"x-namespace-id":                {},
	"x-tenant-id":                   {},
}

func validateProviderInvokeInput(input ProviderInvokeInput) (ProviderInvokeInput, error) {
	input = normalizeProviderInvokeInput(input)
	if err := validateProviderInvokeEnvelope(input); err != nil {
		return ProviderInvokeInput{}, err
	}
	binding, err := validateProviderBinding(input.RequestID, input.TenantID, input.Namespace, input.Binding)
	if err != nil {
		return ProviderInvokeInput{}, err
	}
	input.Binding = binding
	if err := validateProviderInvokeTarget(input); err != nil {
		return ProviderInvokeInput{}, err
	}
	if err := validateProviderInvokeLimits(input); err != nil {
		return ProviderInvokeInput{}, err
	}
	input.Headers = sanitizeProviderInvokeHeaders(input.Headers)
	return input, nil
}

func validateProviderInvokeEnvelope(input ProviderInvokeInput) error {
	if err := validateProviderOperation(OperationInvoke, input.RequestID); err != nil {
		return err
	}
	if input.RequestID == "" {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider request_id is required", "")
	}
	return validateProviderAccess(input.RequestID, input.TenantID, input.Namespace, input.AuthContext)
}

func validateProviderInvokeTarget(input ProviderInvokeInput) error {
	if _, ok := providerInvokeMethods[input.Method]; !ok {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke method is unsupported", input.RequestID)
	}
	if input.Endpoint == "" || forbiddenFieldName(input.Endpoint) {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke endpoint is invalid", input.RequestID)
	}
	if _, err := providerInvokeURL(input.Endpoint, input.Path, input.Query); err != nil {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke endpoint is invalid", input.RequestID)
	}
	if input.Path == "" || strings.Contains(input.Path, "\x00") {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke path is invalid", input.RequestID)
	}
	return nil
}

func validateProviderInvokeLimits(input ProviderInvokeInput) error {
	if input.Port <= 0 || input.Port > 65535 {
		return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm invoke port is invalid", input.RequestID)
	}
	if input.TTLSeconds < minProviderTokenTTLSeconds || input.TTLSeconds > maxProviderTokenTTLSeconds {
		return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm invoke token ttl exceeds contract bounds", input.RequestID)
	}
	if len(input.Body) > maxProviderInvokeBodyBytes {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke body is too large", input.RequestID)
	}
	return nil
}

func normalizeProviderInvokeInput(input ProviderInvokeInput) ProviderInvokeInput {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TenantID = strings.TrimSpace(input.TenantID)
	input.Namespace = strings.TrimSpace(input.Namespace)
	input.AuthContext = normalizeProviderAuthContext(input.AuthContext)
	input.Binding = normalizeProviderBinding(input.Binding)
	input.Endpoint = strings.TrimSpace(input.Endpoint)
	input.Method = strings.ToUpper(strings.TrimSpace(input.Method))
	input.Path = normalizeProviderInvokePath(input.Path)
	input.Query = cloneQueryValues(input.Query)
	input.Headers = sanitizeProviderInvokeHeaders(input.Headers)
	input.Body = append([]byte(nil), input.Body...)
	if input.Port == 0 {
		input.Port = defaultProviderInvokePort
	}
	if input.TTLSeconds == 0 {
		input.TTLSeconds = defaultProviderInvokeTTLSeconds
	}
	return input
}

func normalizeProviderInvokePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return path
}

func sanitizeProviderInvokeHeaders(headers map[string][]string) map[string][]string {
	out := map[string][]string{}
	for name, values := range headers {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		if _, forbidden := providerInvokeForbiddenHeaders[name]; forbidden {
			continue
		}
		clean := make([]string, 0, len(values))
		for _, value := range values {
			value = strings.TrimSpace(value)
			if value != "" && !forbiddenFieldName(value) {
				clean = append(clean, value)
			}
		}
		if len(clean) > 0 {
			out[name] = clean
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func sanitizeProviderInvokeResponseHeaders(headers http.Header) map[string][]string {
	raw := map[string][]string{}
	for name, values := range headers {
		raw[name] = append([]string(nil), values...)
	}
	return sanitizeProviderInvokeHeaders(raw)
}

func providerInvokeURL(endpoint string, path string, query map[string][]string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke endpoint is invalid", "")
	}
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}
	base, err := url.Parse(endpoint)
	if err != nil || base.Host == "" {
		return "", safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm invoke endpoint is invalid", "")
	}
	base.Scheme = "https"
	base.Path = normalizeProviderInvokePath(path)
	values := url.Values{}
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		for _, value := range query[key] {
			values.Add(key, value)
		}
	}
	base.RawQuery = values.Encode()
	return base.String(), nil
}

func providerInvokePortHeader(port int32) string {
	if port <= 0 {
		port = defaultProviderInvokePort
	}
	return strconv.FormatInt(int64(port), 10)
}

func providerInvokeResponseIsBase64(headers map[string][]string) bool {
	contentType := ""
	for name, values := range headers {
		if strings.EqualFold(name, "content-type") && len(values) > 0 {
			contentType = strings.ToLower(strings.TrimSpace(values[0]))
			break
		}
	}
	if contentType == "" {
		return false
	}
	textualPrefixes := []string{"text/", "application/json", "application/xml", "application/javascript", "application/problem+json"}
	for _, prefix := range textualPrefixes {
		if strings.HasPrefix(contentType, prefix) {
			return false
		}
	}
	return true
}

func providerInvokeBodyReader(body []byte) *bytes.Reader {
	if len(body) == 0 {
		return bytes.NewReader(nil)
	}
	return bytes.NewReader(body)
}

func cloneQueryValues(query map[string][]string) map[string][]string {
	if len(query) == 0 {
		return nil
	}
	out := make(map[string][]string, len(query))
	for key, values := range query {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		clean := make([]string, 0, len(values))
		for _, value := range values {
			clean = append(clean, strings.TrimSpace(value))
		}
		out[key] = clean
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
