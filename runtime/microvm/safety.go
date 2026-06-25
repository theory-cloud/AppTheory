package microvm

import "strings"

var forbiddenFieldNames = map[string]struct{}{ //nolint:gosec // Contract field names, not credentials.
	"authorization":              {},
	"aws_access_key_id":          {},
	"aws_secret_access_key":      {},
	"aws_session_token":          {},
	"bearer_token":               {},
	"account_wide_list_token":    {},
	"plaintext_token":            {},
	"provider_error":             {},
	"provider_exception":         {},
	"provider_secret":            {},
	"raw_provider_error":         {},
	"raw_provider_exception":     {},
	"raw_aws_credentials":        {},
	"raw_lifecycle_hook_payload": {},
	"raw_sdk_client":             {},
	"session_token_plaintext":    {},
	"token_value":                {},
	"x-amz-security-token":       {},
	"x-aws-proxy-auth":           {},
	"x_aws_proxy_auth":           {},
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
	for key, value := range metadata {
		if forbiddenFieldName(key) {
			return safeError(
				ErrorCodeForbiddenField,
				"apptheory: microvm metadata contains forbidden field",
				requestID,
			)
		}
		if forbiddenFieldValue(value) {
			return safeError(
				ErrorCodeForbiddenField,
				"apptheory: microvm metadata contains forbidden value",
				requestID,
			)
		}
	}
	return nil
}

func validateSafeFieldValue(value string, requestID string) error {
	if forbiddenFieldName(value) || forbiddenFieldValue(value) {
		return safeError(
			ErrorCodeForbiddenField,
			"apptheory: microvm field contains forbidden value",
			requestID,
		)
	}
	return nil
}

func forbiddenFieldValue(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return false
	}
	switch {
	case strings.HasPrefix(normalized, "bearer "):
		return true
	case strings.Contains(normalized, "x-aws-proxy-auth"):
		return true
	case strings.Contains(normalized, "aws_secret_access_key"):
		return true
	case strings.Contains(normalized, "aws_access_key_id"):
		return true
	case strings.Contains(normalized, "aws_session_token"):
		return true
	case strings.Contains(normalized, "raw provider exception"):
		return true
	case strings.Contains(normalized, "raw_provider_exception"):
		return true
	case strings.Contains(normalized, "raw provider error"):
		return true
	case strings.Contains(normalized, "account-wide list token"):
		return true
	case strings.Contains(normalized, "account_wide_list_token"):
		return true
	default:
		return false
	}
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
