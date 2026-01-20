package sanitization

import (
	"encoding/json"
	"fmt"
)

// SanitizeJSON recursively sanitizes JSON data for logging.
//
// It returns a formatted JSON string with known sensitive fields masked/redacted while preserving structure.
func SanitizeJSON(jsonBytes []byte) string {
	if len(jsonBytes) == 0 {
		return "(empty)"
	}

	var data any
	if err := json.Unmarshal(jsonBytes, &data); err != nil {
		return fmt.Sprintf("(malformed JSON: %s)", err.Error())
	}

	sanitized := sanitizeJSONValue(data)
	out, err := json.MarshalIndent(sanitized, "", "  ")
	if err != nil {
		return "(error marshaling sanitized JSON)"
	}
	return string(out)
}

func sanitizeJSONValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		return sanitizeJSONObject(v)
	case []any:
		return sanitizeJSONArray(v)
	default:
		return sanitizeValue(v)
	}
}

func sanitizeJSONObject(obj map[string]any) map[string]any {
	result := make(map[string]any, len(obj))
	for key, value := range obj {
		// Special case: "body" may contain a JSON string (common in AWS events).
		if key == "body" {
			if bodyStr, ok := value.(string); ok {
				var bodyData any
				if err := json.Unmarshal([]byte(bodyStr), &bodyData); err == nil {
					sanitizedBody := sanitizeJSONValue(bodyData)
					if bodyJSON, err := json.Marshal(sanitizedBody); err == nil {
						result[key] = string(bodyJSON)
						continue
					}
				}
			}
		}

		sanitizedValue := SanitizeFieldValue(key, value)
		switch sv := sanitizedValue.(type) {
		case map[string]any:
			result[key] = sanitizeJSONObject(sv)
		case []any:
			result[key] = sanitizeJSONArray(sv)
		default:
			result[key] = sanitizedValue
		}
	}
	return result
}

func sanitizeJSONArray(arr []any) []any {
	result := make([]any, len(arr))
	for i := range arr {
		result[i] = sanitizeJSONValue(arr[i])
	}
	return result
}
