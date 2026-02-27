package sanitization

import (
	"encoding/json"
	"fmt"
)

// RawJSON is a marker type for JSON payloads that should be sanitized and logged as structured JSON
// (object/array) rather than as an escaped string.
type RawJSON []byte

// SanitizeJSON recursively sanitizes JSON data for logging.
//
// It returns a formatted JSON string with known sensitive fields masked/redacted while preserving structure.
func SanitizeJSON(jsonBytes []byte) string {
	if len(jsonBytes) == 0 {
		return emptyMaskedValue
	}

	var data any
	if err := json.Unmarshal(jsonBytes, &data); err != nil {
		return fmt.Sprintf("(malformed JSON: %s)", err.Error())
	}

	sanitized := sanitizeJSONValue(data, sanitizeJSONOptions{KeepBodyString: true})
	out, err := json.MarshalIndent(sanitized, "", "  ")
	if err != nil {
		return "(error marshaling sanitized JSON)"
	}
	return string(out)
}

// SanitizeJSONValue returns a sanitized JSON structure suitable for structured logging.
//
// Unlike SanitizeJSON, this function preserves JSON structure (map/slice) so JSON loggers (zap, pino, etc)
// will emit the value as nested JSON instead of an escaped string.
func SanitizeJSONValue(jsonBytes []byte) any {
	if len(jsonBytes) == 0 {
		return emptyMaskedValue
	}

	var data any
	if err := json.Unmarshal(jsonBytes, &data); err != nil {
		return fmt.Sprintf("(malformed JSON: %s)", err.Error())
	}

	return sanitizeJSONValue(data, sanitizeJSONOptions{KeepBodyString: false})
}

type sanitizeJSONOptions struct {
	KeepBodyString bool
}

func sanitizeJSONValue(value any, opts sanitizeJSONOptions) any {
	sanitized := sanitizeValue(value)
	return sanitizeEmbeddedBodyJSON(sanitized, opts)
}

func sanitizeEmbeddedBodyJSON(value any, opts sanitizeJSONOptions) any {
	if v, ok := value.(map[string]any); ok {
		return sanitizeEmbeddedBodyJSONMap(v, opts)
	}
	if v, ok := value.([]any); ok {
		return sanitizeEmbeddedBodyJSONArray(v, opts)
	}
	return value
}

func sanitizeEmbeddedBodyJSONMap(value map[string]any, opts sanitizeJSONOptions) map[string]any {
	out := make(map[string]any, len(value))
	for key, raw := range value {
		if key == "body" {
			if sanitizedBody, ok := sanitizeBodyJSONString(raw, opts); ok {
				out[key] = sanitizedBody
				continue
			}
		}
		out[key] = sanitizeEmbeddedBodyJSON(raw, opts)
	}
	return out
}

func sanitizeEmbeddedBodyJSONArray(value []any, opts sanitizeJSONOptions) []any {
	out := make([]any, len(value))
	for i := range value {
		out[i] = sanitizeEmbeddedBodyJSON(value[i], opts)
	}
	return out
}

func sanitizeBodyJSONString(raw any, opts sanitizeJSONOptions) (any, bool) {
	bodyStr, ok := raw.(string)
	if !ok {
		return nil, false
	}

	var bodyData any
	if err := json.Unmarshal([]byte(bodyStr), &bodyData); err != nil {
		return nil, false
	}

	sanitizedBody := sanitizeJSONValue(bodyData, opts)
	if opts.KeepBodyString {
		bodyJSON, err := json.Marshal(sanitizedBody)
		if err != nil {
			return nil, false
		}
		return string(bodyJSON), true
	}
	return sanitizedBody, true
}
