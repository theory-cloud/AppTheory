package microvm

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tablemocks "github.com/theory-cloud/tabletheory/v6/pkg/mocks"
)

const m3ListOwnershipFixture = "../../contract-tests/conformance/microvm-list-ownership.v1.json"

type m3ListOwnershipDocument struct {
	Contract struct {
		ID string `json:"id"`
	} `json:"contract"`
	Subject struct {
		Caller          string `json:"caller"`
		SameTenantOther string `json:"same_tenant_other"`
	} `json:"subject"`
	Errors struct {
		OwnerMismatch struct {
			Code   string `json:"code"`
			Status int    `json:"status"`
		} `json:"owner_mismatch"`
		RegistryIncomplete string `json:"registry_incomplete"`
	} `json:"errors"`
	Cases []struct {
		ID       string         `json:"id"`
		Scenario string         `json:"scenario"`
		Expect   map[string]any `json:"expect"`
	} `json:"cases"`
}

func loadM3ListOwnership(t *testing.T) m3ListOwnershipDocument {
	t.Helper()
	raw, err := os.ReadFile(m3ListOwnershipFixture)
	require.NoError(t, err)
	var document m3ListOwnershipDocument
	require.NoError(t, json.Unmarshal(raw, &document))
	require.NotEmpty(t, document.Cases)
	return document
}

func TestM3ListOwnershipFixturePinsRequiredCasesAndShapes(t *testing.T) {
	document := loadM3ListOwnership(t)
	require.Equal(t, "m3.microvm-list-ownership/v1", document.Contract.ID)
	require.Equal(t, "m15.microvm.session_owner_mismatch", document.Errors.OwnerMismatch.Code)
	require.Equal(t, 403, document.Errors.OwnerMismatch.Status)
	require.Equal(t, ErrorCodeSessionRegistryIncomplete, document.Errors.RegistryIncomplete)

	ids := map[string]struct{}{}
	for _, testCase := range document.Cases {
		ids[testCase.ID] = struct{}{}
	}
	for _, id := range []string{
		"list.same_subject_live_records_only",
		"list.empty_subject_returns_empty",
		"list.cross_subject_excluded",
		"list.ownerless_excluded",
		"list.canonical_precedence_over_legacy_duplicate",
		"list.caller_owned_legacy_duplicate_cannot_override_canonical_ownerless",
		"list.expired_records_excluded_before_provider",
		"controller.list.defense_in_depth_filters_registry_ignoring_subject",
		"keyed.owner_mismatch_preserves_denial_shape",
		"keyed.ownerless_record_preserves_registry_incomplete_shape",
		"keyed.ownerless_legacy_read_not_rekeyed_and_owned_rekey_preserves_owner",
		"write.existing_ownerless_record_not_adopted",
	} {
		require.Contains(t, ids, id)
	}
}

func m3RegistryRecord(t *testing.T, record SessionRecord) SessionRegistryRecord {
	t.Helper()
	registry, err := SessionRecordToRegistryRecord(record)
	require.NoError(t, err)
	return registry
}

// m3OwnerlessRegistryRecord builds a valid registry item for an earlier-release
// ownerless record. The write validator rejects an empty owner, so the item is
// converted with a placeholder and then blanked to model retained legacy data.
func m3OwnerlessRegistryRecord(t *testing.T, record SessionRecord) SessionRegistryRecord {
	t.Helper()
	owner := record.AuthSubject
	record.AuthSubject = "placeholder-owner"
	registry := m3RegistryRecord(t, record)
	registry.AuthSubject = owner
	return registry
}

func m3OwnedRecord(now time.Time, sessionID, subject string, expiresAt time.Time, endpoint string) SessionRecord {
	record := registryTestRecord(now)
	record.SessionID = sessionID
	record.AuthSubject = subject
	record.ExpiresAt = expiresAt
	record.Endpoint = endpoint
	return record
}

func TestM3MemoryRegistryListOwnershipCanonicalPrecedenceAndExpiry(t *testing.T) {
	now := time.Unix(200_000, 0).UTC()
	registry := NewMemorySessionRegistry()
	registry.now = func() time.Time { return now }

	live := m3OwnedRecord(now, "session-own-live", "subject-a", now.Add(time.Hour), "canonical-live")
	other := m3OwnedRecord(now, "session-other", "subject-b", now.Add(time.Hour), "other")
	expired := m3OwnedRecord(now, "session-own-expired", "subject-a", now.Add(-time.Minute), "expired")
	ownerless := m3OwnedRecord(now, "session-ownerless", "", now.Add(time.Hour), "ownerless")
	preferredCanonical := m3OwnedRecord(now, "session-prefer", "subject-a", now.Add(time.Hour), "canonical")
	preferredLegacy := m3OwnedRecord(now, "session-prefer", "subject-a", now.Add(time.Hour), "legacy")
	duplicateCanonicalOwnerless := m3OwnedRecord(now, "session-dup", "", now.Add(time.Hour), "canonical-ownerless")
	duplicateLegacyOwned := m3OwnedRecord(now, "session-dup", "subject-a", now.Add(time.Hour), "legacy-owned")

	for _, record := range []SessionRecord{live, other, expired, preferredCanonical} {
		registry.records[registryRecordKey(m3RegistryRecord(t, record))] = m3RegistryRecord(t, record)
	}
	canonicalOwnerless := m3OwnerlessRegistryRecord(t, ownerless)
	registry.records[registryRecordKey(canonicalOwnerless)] = canonicalOwnerless
	canonicalDupOwnerless := m3OwnerlessRegistryRecord(t, duplicateCanonicalOwnerless)
	registry.records[registryRecordKey(canonicalDupOwnerless)] = canonicalDupOwnerless

	legacyPreferred := m3RegistryRecord(t, preferredLegacy)
	legacyPreferred.PK = legacySessionRegistryPartitionKey("tenant-1", "namespace-1")
	registry.records[registryRecordKey(legacyPreferred)] = legacyPreferred
	legacyDuplicateOwned := m3RegistryRecord(t, duplicateLegacyOwned)
	legacyDuplicateOwned.PK = legacySessionRegistryPartitionKey("tenant-1", "namespace-1")
	registry.records[registryRecordKey(legacyDuplicateOwned)] = legacyDuplicateOwned

	list, err := registry.List(context.Background(), SessionListInput{TenantID: "tenant-1", Namespace: "namespace-1", AuthSubject: "subject-a"})
	require.NoError(t, err)
	require.Equal(t, []string{"session-own-live", "session-prefer"}, []string{list[0].SessionID, list[1].SessionID})
	require.Equal(t, "canonical-live", list[0].Endpoint)
	require.Equal(t, "canonical", list[1].Endpoint, "canonical record wins over its legacy duplicate")

	emptySubject, err := registry.List(context.Background(), SessionListInput{TenantID: "tenant-1", Namespace: "namespace-1"})
	require.NoError(t, err)
	require.Empty(t, emptySubject)

	otherSubject, err := registry.List(context.Background(), SessionListInput{TenantID: "tenant-1", Namespace: "namespace-1", AuthSubject: "subject-b"})
	require.NoError(t, err)
	require.Equal(t, []string{"session-other"}, []string{otherSubject[0].SessionID})
}

func TestM3TableTheoryRegistryListOwnershipAndCanonicalPrecedence(t *testing.T) {
	now := time.Unix(210_000, 0).UTC()
	canonicalPK := SessionRegistryPartitionKey("tenant-1", "namespace-1")
	legacyPK := legacySessionRegistryPartitionKey("tenant-1", "namespace-1")

	live := m3RegistryRecord(t, m3OwnedRecord(now, "session-own-live", "subject-a", now.Add(time.Hour), "canonical-live"))
	other := m3RegistryRecord(t, m3OwnedRecord(now, "session-other", "subject-b", now.Add(time.Hour), "other"))
	expired := m3RegistryRecord(t, m3OwnedRecord(now, "session-own-expired", "subject-a", now.Add(-time.Minute), "expired"))
	ownerless := m3OwnerlessRegistryRecord(t, m3OwnedRecord(now, "session-ownerless", "", now.Add(time.Hour), "ownerless"))
	preferredCanonical := m3RegistryRecord(t, m3OwnedRecord(now, "session-prefer", "subject-a", now.Add(time.Hour), "canonical"))
	preferredLegacy := m3RegistryRecord(t, m3OwnedRecord(now, "session-prefer", "subject-a", now.Add(time.Hour), "legacy"))
	preferredLegacy.PK = legacyPK
	legacyUnique := m3RegistryRecord(t, m3OwnedRecord(now, "session-legacy", "subject-a", now.Add(time.Hour), "legacy-only"))
	legacyUnique.PK = legacyPK

	db := new(tablemocks.MockDB)
	canonicalQuery := new(tablemocks.MockQuery)
	legacyQuery := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(canonicalQuery).Once()
	canonicalQuery.On("WithContext", mock.Anything).Return(canonicalQuery).Once()
	canonicalQuery.On("Where", "PK", "=", canonicalPK).Return(canonicalQuery).Once()
	canonicalQuery.On("All", mock.Anything).Run(func(args mock.Arguments) {
		dest, ok := args.Get(0).(*[]SessionRegistryRecord)
		require.True(t, ok)
		*dest = []SessionRegistryRecord{live, other, expired, ownerless, preferredCanonical}
	}).Return(nil).Once()

	db.On("Model", mock.Anything).Return(legacyQuery).Once()
	legacyQuery.On("WithContext", mock.Anything).Return(legacyQuery).Once()
	legacyQuery.On("Where", "PK", "=", legacyPK).Return(legacyQuery).Once()
	legacyQuery.On("All", mock.Anything).Run(func(args mock.Arguments) {
		dest, ok := args.Get(0).(*[]SessionRegistryRecord)
		require.True(t, ok)
		*dest = []SessionRegistryRecord{preferredLegacy, legacyUnique}
	}).Return(nil).Once()

	store, err := NewTableTheorySessionRegistry(db)
	require.NoError(t, err)
	store.now = func() time.Time { return now }

	list, err := store.List(context.Background(), SessionListInput{TenantID: "tenant-1", Namespace: "namespace-1", AuthSubject: "subject-a"})
	require.NoError(t, err)
	require.Equal(t, []string{"session-legacy", "session-own-live", "session-prefer"}, []string{list[0].SessionID, list[1].SessionID, list[2].SessionID})
	require.Equal(t, "canonical", list[2].Endpoint, "canonical record wins over its legacy duplicate")
	require.Equal(t, "legacy-only", list[0].Endpoint)

	db.AssertExpectations(t)
	canonicalQuery.AssertExpectations(t)
	legacyQuery.AssertExpectations(t)
}

type m3IgnoringSubjectRegistry struct {
	records []SessionRecord
	puts    int
}

func (r *m3IgnoringSubjectRegistry) Put(_ context.Context, record SessionRecord) (SessionRecord, error) {
	r.puts++
	return record, nil
}

func (r *m3IgnoringSubjectRegistry) Get(_ context.Context, key SessionKey) (SessionRecord, error) {
	for _, record := range r.records {
		if record.Key() == key {
			return record, nil
		}
	}
	return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry record not found", "")
}

func (r *m3IgnoringSubjectRegistry) Delete(context.Context, SessionKey) error { return nil }

func (r *m3IgnoringSubjectRegistry) List(context.Context, SessionListInput) ([]SessionRecord, error) {
	return append([]SessionRecord(nil), r.records...), nil
}

type m3RecordingListProvider struct {
	*realControllerProvider
	known []ProviderSessionBinding
}

func (p *m3RecordingListProvider) List(ctx context.Context, input ProviderListInput) (ProviderListOutput, error) {
	p.known = append([]ProviderSessionBinding(nil), input.KnownSessions...)
	return p.realControllerProvider.List(ctx, input)
}

func TestM3ControllerListDefenseInDepthFiltersSubjectIgnoringRegistry(t *testing.T) {
	now := time.Unix(220_000, 0).UTC()
	live := m3OwnedRecord(now, "session-own-live", "subject-a", now.Add(time.Hour), "canonical-live")
	other := m3OwnedRecord(now, "session-other", "subject-b", now.Add(time.Hour), "other")
	expired := m3OwnedRecord(now, "session-own-expired", "subject-a", now.Add(-time.Minute), "expired")
	ownerless := m3OwnedRecord(now, "session-ownerless", "", now.Add(time.Hour), "ownerless")
	registry := &m3IgnoringSubjectRegistry{records: []SessionRecord{live, other, expired, ownerless}}

	provider := &m3RecordingListProvider{realControllerProvider: newRealControllerProvider(now)}
	controller, err := NewRealController(provider, registry, withDisabledControllerLogging(), WithControllerClock(fixedControllerClock{now: now}))
	require.NoError(t, err)

	response, err := controller.Handle(context.Background(), ownerControllerRequest(CommandList, "req-defense-list", "", "subject-a"))
	require.NoError(t, err)
	require.Nil(t, response.Error)
	require.Len(t, provider.known, 1, "only the caller's live record may reach provider.List")
	require.Equal(t, "session-own-live", provider.known[0].SessionID)
	require.Equal(t, 0, registry.puts, "list filtering must not refresh or write excluded records")
}

func TestM3ControllerKeyedOwnerlessAndOwnerMismatchShapes(t *testing.T) {
	now := time.Unix(230_000, 0).UTC()
	ownerless := m3OwnedRecord(now, "session-ownerless", "", now.Add(time.Hour), "ownerless")
	owned := m3OwnedRecord(now, "session-owned", "subject-a", now.Add(time.Hour), "owned")
	registry := NewMemorySessionRegistry()
	registry.now = func() time.Time { return now }
	registry.records[registryRecordKey(m3OwnerlessRegistryRecord(t, ownerless))] = m3OwnerlessRegistryRecord(t, ownerless)
	registry.records[registryRecordKey(m3RegistryRecord(t, owned))] = m3RegistryRecord(t, owned)

	controller, err := NewRealController(newRealControllerProvider(now), registry, withDisabledControllerLogging(), WithControllerClock(fixedControllerClock{now: now}))
	require.NoError(t, err)

	ownerlessResponse, ownerlessErr := controller.Handle(context.Background(), ownerControllerRequest(CommandGet, "req-keyed-ownerless", "session-ownerless", "subject-a"))
	requireSafeError(t, ownerlessErr, ErrorCodeSessionRegistryIncomplete)
	require.NotNil(t, ownerlessResponse.Error)
	require.Equal(t, ErrorCodeSessionRegistryIncomplete, ownerlessResponse.Error.Code)
	ownerlessKey := registryRecordKey(m3OwnerlessRegistryRecord(t, ownerless))
	stored, ok := registry.records[ownerlessKey]
	require.True(t, ok)
	require.Empty(t, stored.AuthSubject, "a keyed refresh must never fill an existing empty owner")

	mismatchResponse, mismatchErr := controller.Handle(context.Background(), ownerControllerRequest(CommandGet, "req-keyed-mismatch", "session-owned", "subject-b"))
	requireSafeError(t, mismatchErr, ErrorCodeSessionOwnerMismatch)
	require.NotNil(t, mismatchResponse.Error)
	require.Equal(t, ErrorCodeSessionOwnerMismatch, mismatchResponse.Error.Code)
}

func TestM3RegistryOwnerlessLegacyReadDoesNotRekey(t *testing.T) {
	now := time.Unix(240_000, 0).UTC()
	registry := NewMemorySessionRegistry()
	registry.now = func() time.Time { return now }

	record := m3OwnerlessRegistryRecord(t, m3OwnedRecord(now, "session-legacy-ownerless", "", now.Add(time.Hour), "ownerless"))
	record.PK = legacySessionRegistryPartitionKey("tenant-1", "namespace-1")
	legacyKey := registryRecordKey(record)
	registry.records[legacyKey] = record

	_, err := registry.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-legacy-ownerless"})
	require.Error(t, err)
	require.Equal(t, ErrorCodeSessionRegistryIncomplete, asSafeError(err, "").Code)
	require.Len(t, registry.records, 1, "an ownerless legacy read must not persist a rekeyed copy")
	require.Contains(t, registry.records, legacyKey)

	ownedRegistry := NewMemorySessionRegistry()
	ownedRegistry.now = func() time.Time { return now }
	owned := m3RegistryRecord(t, m3OwnedRecord(now, "session-legacy-owned", "subject-a", now.Add(time.Hour), "owned"))
	owned.PK = legacySessionRegistryPartitionKey("tenant-1", "namespace-1")
	ownedRegistry.records[registryRecordKey(owned)] = owned
	loaded, err := ownedRegistry.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-legacy-owned"})
	require.NoError(t, err)
	require.Equal(t, "subject-a", loaded.AuthSubject)
}
