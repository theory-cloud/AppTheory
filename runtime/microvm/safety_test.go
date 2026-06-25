package microvm

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSafeFieldValueRejectsForbiddenSentinelValues(t *testing.T) {
	for _, value := range []string{
		"field:aws_secret_access_key",
		"field:aws_access_key_id",
		"field:aws_session_token",
		"field:account-wide list token",
		"field:account_wide_list_token",
	} {
		require.Error(t, validateSafeFieldValue(value, "req-safe"))
	}
	require.NoError(t, validateSafeFieldValue("provider-safe-state", "req-safe"))
	require.Error(t, validateSafeMetadata(map[string]string{"safe": "field:aws_access_key_id"}, "req-safe"))
}
