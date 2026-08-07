package microvm

import (
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/stretchr/testify/require"
	"github.com/theory-cloud/tabletheory/v3/pkg/marshal"
	"github.com/theory-cloud/tabletheory/v3/pkg/model"
)

// Regression for https://github.com/theory-cloud/AppTheory/issues/883:
// SessionTokenMetadata is designed for nested durable storage. Under
// TableTheory v3 nested marshaling, zero-valued fields must stay omitted
// (matching the TableTheory v2 persisted shape) via the json omitempty tags.
func TestSessionTokenMetadata_NestedMarshalOmitsZeroFields(t *testing.T) {
	registry := model.NewRegistry()
	require.NoError(t, registry.Register(SessionRegistryRecord{}))
	metadata, err := registry.GetMetadata(SessionRegistryRecord{})
	require.NoError(t, err)

	record, err := SessionRecordToRegistryRecord(registryTestRecord(time.Unix(100, 0).UTC()))
	require.NoError(t, err)
	record.TokenMetadata = []SessionTokenMetadata{{}}

	item, err := marshal.NewSafeMarshaler().MarshalItem(record, metadata)
	require.NoError(t, err)

	av, ok := item["token_metadata"]
	require.True(t, ok, "token_metadata attribute must be present")
	list, ok := av.(*types.AttributeValueMemberL)
	require.True(t, ok, "token_metadata must marshal as a list")
	require.Len(t, list.Value, 1)
	entry, ok := list.Value[0].(*types.AttributeValueMemberM)
	require.True(t, ok, "token_metadata element must marshal as a map")
	require.Empty(t, entry.Value, "zero-valued SessionTokenMetadata fields must be omitted, got %v", entry.Value)
}

// Contrast case for issue #883: populated fields must still persist.
func TestSessionTokenMetadata_NestedMarshalPersistsPopulatedFields(t *testing.T) {
	registry := model.NewRegistry()
	require.NoError(t, registry.Register(SessionRegistryRecord{}))
	metadata, err := registry.GetMetadata(SessionRegistryRecord{})
	require.NoError(t, err)

	record, err := SessionRecordToRegistryRecord(registryTestRecord(time.Unix(100, 0).UTC()))
	require.NoError(t, err)
	expiresAt := time.Unix(200, 0).UTC()
	record.TokenMetadata = []SessionTokenMetadata{{
		TokenID:   "token-1",
		TokenType: "bearer",
		ExpiresAt: expiresAt,
		Scope:     []string{"scope-1"},
	}}

	item, err := marshal.NewSafeMarshaler().MarshalItem(record, metadata)
	require.NoError(t, err)

	list, ok := item["token_metadata"].(*types.AttributeValueMemberL)
	require.True(t, ok)
	require.Len(t, list.Value, 1)
	entry, ok := list.Value[0].(*types.AttributeValueMemberM)
	require.True(t, ok)
	require.Len(t, entry.Value, 4, "all populated SessionTokenMetadata fields must persist, got %v", entry.Value)
	require.Contains(t, entry.Value, "token_id")
	require.Contains(t, entry.Value, "token_type")
	require.Contains(t, entry.Value, "expires_at")
	require.Contains(t, entry.Value, "scope")
}
