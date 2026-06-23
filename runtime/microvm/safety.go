package microvm

import "strings"

var forbiddenFieldNames = map[string]struct{}{ //nolint:gosec // Contract field names, not credentials.
	"authorization":              {},
	"aws_access_key_id":          {},
	"aws_secret_access_key":      {},
	"aws_session_token":          {},
	"bearer_token":               {},
	"raw_aws_credentials":        {},
	"raw_lifecycle_hook_payload": {},
	"raw_sdk_client":             {},
	"session_token_plaintext":    {},
	"x-amz-security-token":       {},
}

func forbiddenFieldName(name string) bool {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		return false
	}
	if _, ok := forbiddenFieldNames[key]; ok {
		return true
	}
	key = strings.ReplaceAll(key, "-", "_")
	_, ok := forbiddenFieldNames[key]
	return ok
}

func validateSafeMetadata(metadata map[string]string, requestID string) error {
	for key := range metadata {
		if forbiddenFieldName(key) {
			return safeError(
				ErrorCodeForbiddenField,
				"apptheory: microvm metadata contains forbidden field",
				requestID,
			)
		}
	}
	return nil
}

func cloneStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		trimmed := strings.TrimSpace(key)
		if trimmed == "" {
			continue
		}
		out[trimmed] = value
	}
	return out
}
