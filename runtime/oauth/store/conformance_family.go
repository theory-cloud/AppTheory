package store

import (
	"fmt"
	"time"
)

// Family conformance scenarios. They execute the transactional family
// capability the front channel requires: atomic root creation, atomic
// rotation, terminal family revocation, tombstone-honoring reads and locks,
// fail-closed legacy/partial-backfill handling, and the listed-versus-aged-out
// enumeration semantics of the shared table.

func (h *conformanceHarness) familyStore() (RouteRefreshBrokerTransactionalFamilyStore, error) {
	family, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		return nil, fmt.Errorf("%w: %T", ErrBrokerFamilyCapabilityMissing, h.stores.RouteRefreshBroker)
	}
	return family, nil
}

// familyRoot builds the generation-1 root a CreateFamily row supplies. The
// family hash of a root is its own handle hash.
func (h *conformanceHarness) familyRoot(familyHash string) *RouteRefreshBrokerRecord {
	return &RouteRefreshBrokerRecord{
		HandleHash:               familyHash,
		Issuer:                   "https://auth.example.test",
		Stage:                    "lab",
		CanonicalResource:        "https://mcp.example.test/mcp",
		ClientNamespace:          "conformance",
		EndpointKind:             "namespace",
		ClientIDHash:             "client-hash",
		SubjectIDHash:            "subject-hash",
		Scopes:                   []string{"mcp:tools"},
		ScopeFingerprint:         "scope-fingerprint",
		UpstreamClientID:         "upstream-client",
		UpstreamRefreshTokenHash: HashKey("upstream-refresh-root"),
		ChainGeneration:          1,
		FamilyHash:               familyHash,
		Status:                   BrokerStatusIssued,
	}
}

// familyMember builds a record that preserves the presented record's identity
// and carries the requested family and generation, so a rotation row can vary
// exactly the binding under test.
func familyMember(presented *RouteRefreshBrokerRecord, handleHash, familyHash string, generation int) *RouteRefreshBrokerRecord {
	return &RouteRefreshBrokerRecord{
		HandleHash:                    handleHash,
		Issuer:                        presented.Issuer,
		Stage:                         presented.Stage,
		CanonicalResource:             presented.CanonicalResource,
		ClientNamespace:               presented.ClientNamespace,
		EndpointKind:                  presented.EndpointKind,
		PartnerID:                     presented.PartnerID,
		AgentID:                       presented.AgentID,
		ClientIDHash:                  presented.ClientIDHash,
		SubjectIDHash:                 presented.SubjectIDHash,
		Scopes:                        append([]string(nil), presented.Scopes...),
		ScopeFingerprint:              presented.ScopeFingerprint,
		EncryptedUpstreamRefreshToken: "upstream-refresh-successor",
		UpstreamRefreshTokenHash:      HashKey("upstream-refresh-successor"),
		UpstreamClientID:              presented.UpstreamClientID,
		Status:                        BrokerStatusIssued,
		ChainGeneration:               generation,
		FamilyHash:                    familyHash,
	}
}

// seedFamilyMember writes one family-marked member through the store's create
// path, so a row can model a backfilled or partially backfilled lineage without
// going through a rotation.
func (h *conformanceHarness) seedFamilyMember(handleHash, familyHash string, generation int) error {
	seeder, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerSeeder)
	if !ok {
		return fmt.Errorf("%w: %T", ErrBrokerNotSeedable, h.stores.RouteRefreshBroker)
	}
	record := h.familyRoot(familyHash)
	record.HandleHash = handleHash
	record.ChainGeneration = generation
	return seeder.Put(h.ctx(), record)
}

// rotateFamily performs one atomic rotation from a locked presented record.
func (h *conformanceHarness) rotateFamily(
	family RouteRefreshBrokerTransactionalFamilyStore,
	rotation RouteRefreshFamilyRotation,
	presented *RouteRefreshBrokerRecord,
	successorKey string,
	generation int,
	familyHash string,
) (*RouteRefreshBrokerRecord, error) {
	rotation.Successor = familyMember(presented, successorKey, familyHash, generation)
	rotation.GraceRefreshResponse = fmt.Sprintf(`{"refresh_token":%q}`, successorKey)
	rotation.GraceExpiresAt = h.now().Add(time.Minute)
	if rotation.PresentedHandleHash == "" {
		rotation.PresentedHandleHash = presented.HandleHash
	}
	if rotation.LockOwner == "" {
		rotation.LockOwner = "conformance-owner"
	}
	return family.RotateFamily(h.ctx(), rotation)
}

// fieldOutcome reports "ok" for a non-nil record and "not_found" for nil.
func fieldOutcome(record *RouteRefreshBrokerRecord, err error) error {
	if err != nil {
		return err
	}
	if record == nil {
		return ErrBrokerNotFound
	}
	return nil
}

// brokerRecordFamily reports a record's family hash, or the "none" sentinel.
func brokerRecordFamily(record *RouteRefreshBrokerRecord) string {
	if record == nil {
		return conformanceNone
	}
	return record.FamilyHash
}

// brokerRecordGeneration reports a record's chain generation, or -1.
func brokerRecordGeneration(record *RouteRefreshBrokerRecord) int {
	if record == nil {
		return -1
	}
	return record.ChainGeneration
}

// brokerRecordGraceSet reports whether a record carries a grace response and
// deadline.
func brokerRecordGraceSet(record *RouteRefreshBrokerRecord) bool {
	return record != nil && record.EncryptedGraceRefreshResponse != "" && !record.GraceExpiresAt.IsZero()
}

// brokerRecordLockCleared reports whether a record holds no refresh lock.
func brokerRecordLockCleared(record *RouteRefreshBrokerRecord) bool {
	return record != nil && record.RefreshLockOwner == "" && record.RefreshLockExpiresAt.IsZero()
}

// brokerFamilyCreate proves atomic root creation: the root lands at version 1
// with the family identity, and a second CreateFamily for the same family ID is
// refused without changing the stored root.
func (h *conformanceHarness) brokerFamilyCreate(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	created, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash))
	_, secondErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash))
	stored, getErr := h.stores.RouteRefreshBroker.Get(h.ctx(), familyHash)
	return map[string]any{
		"create":                    outcomeFor(createErr),
		"root_version":              brokerRecordVersionField(created),
		"root_generation":           brokerRecordGeneration(created),
		"root_family_is_self":       created != nil && created.FamilyHash == created.HandleHash,
		"second_create":             outcomeFor(secondErr),
		"root_after_second_version": brokerRecordVersionField(stored),
		"root_get":                  outcomeFor(getErr),
	}, nil
}

// brokerFamilyCreateBinding proves root creation refuses a root whose family or
// generation binding is not the root-of-its-own-family invariant.
func (h *conformanceHarness) brokerFamilyCreateBinding(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	root := h.familyRoot(familyHash)
	root.ChainGeneration = h.size(testCase, "generation")
	binding := ""
	if raw, ok := testCase.Params["family_binding"].(string); ok {
		binding = raw
	}
	if binding == "other" {
		root.FamilyHash = h.key(testCase, "other-family")
	}
	_, createErr := family.CreateFamily(h.ctx(), root)
	_, getErr := h.stores.RouteRefreshBroker.Get(h.ctx(), root.HandleHash)
	return map[string]any{
		"create":   outcomeFor(createErr),
		"root_get": outcomeFor(getErr),
	}, nil
}

// brokerFamilyRotate proves atomic rotation: the successor lands at the next
// generation, and the presented record at version+1 carries the grace response
// with the lock cleared.
func (h *conformanceHarness) brokerFamilyRotate(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	if _, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash)); createErr != nil {
		return nil, createErr
	}
	root, err := h.stores.RouteRefreshBroker.Get(h.ctx(), familyHash)
	if err != nil {
		return nil, err
	}
	locked, err := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), root.HandleHash, "conformance-owner", root.Version)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	successor, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	presented, presentedErr := h.stores.RouteRefreshBroker.Get(h.ctx(), root.HandleHash)
	return map[string]any{
		"rotate":                   outcomeFor(rotateErr),
		"successor_get":            outcomeFor(fieldOutcome(successor, nil)),
		"successor_version":        brokerRecordVersionField(successor),
		"successor_generation":     brokerRecordGeneration(successor),
		"successor_family_matches": successor != nil && successor.FamilyHash == familyHash,
		"presented_get":            outcomeFor(presentedErr),
		"presented_version":        brokerRecordVersionField(presented),
		"presented_status":         brokerRecordStatusField(presented),
		"presented_grace_set":      brokerRecordGraceSet(presented),
		"presented_lock_cleared":   brokerRecordLockCleared(presented),
	}, nil
}

// brokerFamilyRotateWrongOwner proves the rotation transaction checks the lock
// owner before minting anything.
func (h *conformanceHarness) brokerFamilyRotateWrongOwner(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	locked, familyHash, err := h.createAndLockFamily(testCase)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	_, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "another-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	presented, presentedErr := h.stores.RouteRefreshBroker.Get(h.ctx(), locked.HandleHash)
	if presentedErr != nil {
		return nil, presentedErr
	}
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	return map[string]any{
		"rotate":            outcomeFor(rotateErr),
		"successor_get":     outcomeFor(successorGetErr),
		"presented_version": brokerRecordVersionField(presented),
		"presented_status":  brokerRecordStatusField(presented),
	}, nil
}

// brokerFamilyRotateStaleVersion proves the expected version is enforced.
func (h *conformanceHarness) brokerFamilyRotateStaleVersion(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	locked, familyHash, err := h.createAndLockFamily(testCase)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	_, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version - 1,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	return map[string]any{
		"rotate":        outcomeFor(rotateErr),
		"successor_get": outcomeFor(successorGetErr),
	}, nil
}

// brokerFamilyRotateExistingSuccessor proves a rotation never overwrites an
// existing handle.
func (h *conformanceHarness) brokerFamilyRotateExistingSuccessor(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	locked, familyHash, err := h.createAndLockFamily(testCase)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	if err := h.seedFamilyMember(successorKey, familyHash, locked.ChainGeneration+1); err != nil {
		return nil, err
	}
	_, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	presented, presentedErr := h.stores.RouteRefreshBroker.Get(h.ctx(), locked.HandleHash)
	if presentedErr != nil {
		return nil, presentedErr
	}
	successor, successorErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	if successorErr != nil {
		return nil, successorErr
	}
	return map[string]any{
		"rotate":                  outcomeFor(rotateErr),
		"successor_status_after":  brokerRecordStatusField(successor),
		"successor_version_after": brokerRecordVersionField(successor),
		"presented_status_after":  brokerRecordStatusField(presented),
		"presented_version_after": brokerRecordVersionField(presented),
	}, nil
}

// brokerFamilyRotateGenerationMismatch and brokerFamilyRotateFamilyMismatch
// prove the family/generation bindings are enforced.
func (h *conformanceHarness) brokerFamilyRotateGenerationMismatch(testCase ConformanceCase) (map[string]any, error) {
	return h.rotateWrongBinding(testCase, "generation")
}

func (h *conformanceHarness) brokerFamilyRotateFamilyMismatch(testCase ConformanceCase) (map[string]any, error) {
	return h.rotateWrongBinding(testCase, "family")
}

func (h *conformanceHarness) rotateWrongBinding(testCase ConformanceCase, binding string) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	locked, familyHash, err := h.createAndLockFamily(testCase)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	generation := locked.ChainGeneration + 1
	if binding == "generation" {
		generation++
	}
	successorFamily := familyHash
	if binding == "family" {
		successorFamily = h.key(testCase, "other-family")
	}
	_, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, generation, successorFamily)
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	return map[string]any{
		"rotate":        outcomeFor(rotateErr),
		"successor_get": outcomeFor(successorGetErr),
	}, nil
}

// brokerFamilyRotateLegacy proves a family-less record cannot rotate or mint a
// successor, even while it holds a valid lock.
func (h *conformanceHarness) brokerFamilyRotateLegacy(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	key := h.key(testCase, "legacy")
	if putErr := h.putBroker(key); putErr != nil {
		return nil, putErr
	}
	record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	locked, err := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "conformance-owner", record.Version)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	_, rotateErr := family.RotateFamily(h.ctx(), RouteRefreshFamilyRotation{
		PresentedHandleHash:  locked.HandleHash,
		LockOwner:            "conformance-owner",
		ExpectedVersion:      locked.Version,
		Successor:            familyMember(locked, successorKey, locked.FamilyHash, 2),
		GraceRefreshResponse: fmt.Sprintf(`{"refresh_token":%q}`, successorKey),
		GraceExpiresAt:       h.now().Add(time.Minute),
	})
	presented, presentedErr := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if presentedErr != nil {
		return nil, presentedErr
	}
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	return map[string]any{
		"rotate":            outcomeFor(rotateErr),
		"successor_get":     outcomeFor(successorGetErr),
		"presented_version": brokerRecordVersionField(presented),
		"presented_status":  brokerRecordStatusField(presented),
	}, nil
}

// brokerFamilyMissingState proves a family-marked record whose family state is
// missing fails closed on read, lock, rotation, and revocation, while the
// enumeration surface still lists it for incident/migration work.
func (h *conformanceHarness) brokerFamilyMissingState(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	key := h.key(testCase, "member")
	if err := h.seedFamilyMember(key, familyHash, 1); err != nil {
		return nil, err
	}
	record, getErr := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	_, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "conformance-owner", 1)
	successorKey := h.key(testCase, "successor")
	_, rotateErr := family.RotateFamily(h.ctx(), RouteRefreshFamilyRotation{
		PresentedHandleHash:  key,
		LockOwner:            "conformance-owner",
		ExpectedVersion:      1,
		Successor:            familyMember(h.familyRoot(familyHash), successorKey, familyHash, 2),
		GraceRefreshResponse: fmt.Sprintf(`{"refresh_token":%q}`, successorKey),
		GraceExpiresAt:       h.now().Add(time.Minute),
	})
	_, revokeErr := family.RevokeFamily(h.ctx(), familyHash)
	listed, listErr := family.ListFamily(h.ctx(), familyHash)
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	return map[string]any{
		"get":           outcomeFor(getErr),
		"lock":          outcomeFor(lockErr),
		"rotate":        outcomeFor(rotateErr),
		"revoke":        outcomeFor(revokeErr),
		"list":          outcomeFor(listErr),
		"listed":        len(listed),
		"record_status": brokerRecordStatusField(record),
		"successor_get": outcomeFor(successorGetErr),
	}, nil
}

// brokerFamilyMixedLineage proves a family-less predecessor cannot detach a
// family-marked suffix: the legacy record cannot rotate, while the suffix stays
// enumerable and revocable through its own family.
func (h *conformanceHarness) brokerFamilyMixedLineage(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	if _, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash)); createErr != nil {
		return nil, createErr
	}
	root, err := h.stores.RouteRefreshBroker.Get(h.ctx(), familyHash)
	if err != nil {
		return nil, err
	}
	locked, err := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), root.HandleHash, "conformance-owner", root.Version)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	successor, err := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	if err != nil {
		return nil, err
	}
	legacyKey := h.key(testCase, "legacy")
	seeder, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerSeeder)
	if !ok {
		return nil, fmt.Errorf("%w: %T", ErrBrokerNotSeedable, h.stores.RouteRefreshBroker)
	}
	if putErr := seeder.Put(h.ctx(), &RouteRefreshBrokerRecord{
		HandleHash:                    legacyKey,
		Issuer:                        "https://auth.example.test",
		Stage:                         "lab",
		CanonicalResource:             "https://mcp.example.test/mcp",
		EncryptedGraceRefreshResponse: fmt.Sprintf(`{"refresh_token":%q}`, successorKey),
		Status:                        BrokerStatusActive,
	}); putErr != nil {
		return nil, putErr
	}
	legacy, err := h.stores.RouteRefreshBroker.Get(h.ctx(), legacyKey)
	if err != nil {
		return nil, err
	}
	legacyLocked, legacyLockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), legacyKey, "conformance-owner", legacy.Version)
	var rotateErr error
	if legacyLockErr == nil {
		_, rotateErr = h.rotateFamily(family, RouteRefreshFamilyRotation{
			PresentedHandleHash: legacyKey,
			LockOwner:           "conformance-owner",
			ExpectedVersion:     legacyLocked.Version,
		}, legacyLocked, h.key(testCase, "legacy-successor"), 2, successor.FamilyHash)
	}
	listed, listErr := family.ListFamily(h.ctx(), familyHash)
	legacyListed := false
	for _, record := range listed {
		if record.HandleHash == legacyKey {
			legacyListed = true
		}
	}
	return map[string]any{
		"legacy_lock":          outcomeFor(legacyLockErr),
		"legacy_rotate":        outcomeFor(rotateErr),
		"list":                 outcomeFor(listErr),
		"listed":               len(listed),
		"legacy_listed":        legacyListed,
		"successor_get":        outcomeFor(fieldOutcome(successor, nil)),
		"successor_generation": brokerRecordGeneration(successor),
	}, nil
}

// brokerFamilyTombstoneEveryMember rotates a family past the removed
// eight-link budget, revokes it, and proves every enumerated member is
// unusable, no late successor can be minted, and revocation is idempotent.
//
//nolint:gocyclo // one branch per shared-table binding under test.
func (h *conformanceHarness) brokerFamilyTombstoneEveryMember(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	if _, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash)); createErr != nil {
		return nil, createErr
	}
	current, err := h.stores.RouteRefreshBroker.Get(h.ctx(), familyHash)
	if err != nil {
		return nil, err
	}
	rotations := h.count(testCase, "rotations")
	for index := 0; index < rotations; index++ {
		locked, lockErr := h.stores.RouteRefreshBroker.AcquireLock(
			h.ctx(), current.HandleHash, fmt.Sprintf("owner-%d", index), current.Version)
		if lockErr != nil {
			return nil, lockErr
		}
		next, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
			PresentedHandleHash: locked.HandleHash,
			LockOwner:           fmt.Sprintf("owner-%d", index),
			ExpectedVersion:     locked.Version,
		}, locked, h.key(testCase, fmt.Sprintf("successor-%d", index)), locked.ChainGeneration+1, familyHash)
		if rotateErr != nil {
			return nil, rotateErr
		}
		current = next
	}
	revoked, revokeErr := family.RevokeFamily(h.ctx(), familyHash)
	listed, listErr := family.ListFamily(h.ctx(), familyHash)
	allRevoked := true
	for _, record := range listed {
		if record.Status != BrokerStatusRevoked {
			allRevoked = false
		}
	}
	_, headGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), current.HandleHash)
	_, headLockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), current.HandleHash, "late-owner", -1)
	lateSuccessor := h.key(testCase, "late-successor")
	_, headRotateErr := family.RotateFamily(h.ctx(), RouteRefreshFamilyRotation{
		PresentedHandleHash:  current.HandleHash,
		LockOwner:            "late-owner",
		ExpectedVersion:      -1,
		Successor:            familyMember(current, lateSuccessor, familyHash, current.ChainGeneration+1),
		GraceRefreshResponse: fmt.Sprintf(`{"refresh_token":%q}`, lateSuccessor),
		GraceExpiresAt:       h.now().Add(time.Minute),
	})
	_, lateGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), lateSuccessor)
	_, createAgainErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash))
	revokedAgain, revokeAgainErr := family.RevokeFamily(h.ctx(), familyHash)
	return map[string]any{
		"revoke":             outcomeFor(revokeErr),
		"revoked":            len(revoked),
		"list":               outcomeFor(listErr),
		"listed":             len(listed),
		"all_listed_revoked": allRevoked,
		"head_get":           outcomeFor(headGetErr),
		"head_lock":          outcomeFor(headLockErr),
		"head_rotate":        outcomeFor(headRotateErr),
		"late_successor_get": outcomeFor(lateGetErr),
		"create_again":       outcomeFor(createAgainErr),
		"revoke_again":       outcomeFor(revokeAgainErr),
		"revoke_again_count": len(revokedAgain),
	}, nil
}

// brokerFamilyTombstoneBeyondBatch revokes a family larger than one DynamoDB
// transaction's 100-action cap, proving revocation is tombstone-based rather
// than a per-member transaction.
func (h *conformanceHarness) brokerFamilyTombstoneBeyondBatch(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	if _, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash)); createErr != nil {
		return nil, createErr
	}
	members := h.count(testCase, "members")
	for index := 0; index < members; index++ {
		if seedErr := h.seedFamilyMember(h.key(testCase, fmt.Sprintf("member-%d", index)), familyHash, index+2); seedErr != nil {
			return nil, seedErr
		}
	}
	revoked, revokeErr := family.RevokeFamily(h.ctx(), familyHash)
	listed, listErr := family.ListFamily(h.ctx(), familyHash)
	allRevoked := true
	for _, record := range listed {
		if record.Status != BrokerStatusRevoked {
			allRevoked = false
		}
	}
	_, firstGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), h.key(testCase, "member-0"))
	_, lastGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), h.key(testCase, fmt.Sprintf("member-%d", members-1)))
	_, createAgainErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash))
	return map[string]any{
		"revoke":             outcomeFor(revokeErr),
		"revoked":            len(revoked),
		"list":               outcomeFor(listErr),
		"listed":             len(listed),
		"all_listed_revoked": allRevoked,
		"first_get":          outcomeFor(firstGetErr),
		"last_get":           outcomeFor(lastGetErr),
		"create_again":       outcomeFor(createAgainErr),
	}, nil
}

// brokerFamilyRevocationFirst proves a revocation that linearizes before a
// rotation mints no successor.
func (h *conformanceHarness) brokerFamilyRevocationFirst(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	locked, familyHash, err := h.createAndLockFamily(testCase)
	if err != nil {
		return nil, err
	}
	revoked, revokeErr := family.RevokeFamily(h.ctx(), familyHash)
	successorKey := h.key(testCase, "successor")
	_, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	_, predecessorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), locked.HandleHash)
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successorKey)
	_, lockAgainErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), locked.HandleHash, "late-owner", -1)
	_, revokeAgainErr := family.RevokeFamily(h.ctx(), familyHash)
	return map[string]any{
		"revoke":        outcomeFor(revokeErr),
		"revoked":       len(revoked),
		"rotate":        outcomeFor(rotateErr),
		"presented_get": outcomeFor(predecessorGetErr),
		"successor_get": outcomeFor(successorGetErr),
		"lock_again":    outcomeFor(lockAgainErr),
		"revoke_again":  outcomeFor(revokeAgainErr),
	}, nil
}

// brokerFamilyRotationFirst proves a rotation that linearizes before a
// revocation leaves the successor covered by the subsequent tombstone.
func (h *conformanceHarness) brokerFamilyRotationFirst(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	locked, familyHash, err := h.createAndLockFamily(testCase)
	if err != nil {
		return nil, err
	}
	successorKey := h.key(testCase, "successor")
	successor, rotateErr := h.rotateFamily(family, RouteRefreshFamilyRotation{
		PresentedHandleHash: locked.HandleHash,
		LockOwner:           "conformance-owner",
		ExpectedVersion:     locked.Version,
	}, locked, successorKey, locked.ChainGeneration+1, familyHash)
	if rotateErr != nil {
		return nil, rotateErr
	}
	revoked, revokeErr := family.RevokeFamily(h.ctx(), familyHash)
	_, successorGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), successor.HandleHash)
	_, successorLockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), successor.HandleHash, "late-owner", -1)
	_, successorRotateErr := family.RotateFamily(h.ctx(), RouteRefreshFamilyRotation{
		PresentedHandleHash:  successor.HandleHash,
		LockOwner:            "late-owner",
		ExpectedVersion:      -1,
		Successor:            familyMember(successor, h.key(testCase, "late-successor"), familyHash, successor.ChainGeneration+1),
		GraceRefreshResponse: fmt.Sprintf(`{"refresh_token":%q}`, h.key(testCase, "late-successor")),
		GraceExpiresAt:       h.now().Add(time.Minute),
	})
	_, lateGetErr := h.stores.RouteRefreshBroker.Get(h.ctx(), h.key(testCase, "late-successor"))
	return map[string]any{
		"revoke":             outcomeFor(revokeErr),
		"revoked":            len(revoked),
		"successor_get":      outcomeFor(successorGetErr),
		"successor_lock":     outcomeFor(successorLockErr),
		"successor_rotate":   outcomeFor(successorRotateErr),
		"late_successor_get": outcomeFor(lateGetErr),
	}, nil
}

// brokerFamilyTombstoneSurvivesExpiry proves the family tombstone outlives its
// members: after every member ages out, the family cannot be recreated.
func (h *conformanceHarness) brokerFamilyTombstoneSurvivesExpiry(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	if _, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash)); createErr != nil {
		return nil, createErr
	}
	if _, err := family.RevokeFamily(h.ctx(), familyHash); err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	// Read before listing: the read observes the aged-out record, and the list
	// purges it. After both, the tombstone must still refuse recreation.
	_, getErr := h.stores.RouteRefreshBroker.Get(h.ctx(), familyHash)
	listed, listErr := family.ListFamily(h.ctx(), familyHash)
	_, createAgainErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash))
	revoked, revokeErr := family.RevokeFamily(h.ctx(), familyHash)
	return map[string]any{
		"list":               outcomeFor(listErr),
		"listed":             len(listed),
		"get":                outcomeFor(getErr),
		"create_again":       outcomeFor(createAgainErr),
		"revoke_again":       outcomeFor(revokeErr),
		"revoke_again_count": len(revoked),
	}, nil
}

// createAndLockFamily creates one family and locks its root at the family's
// generation-1 version.
func (h *conformanceHarness) createAndLockFamily(testCase ConformanceCase) (*RouteRefreshBrokerRecord, string, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, "", err
	}
	familyHash := h.key(testCase, "family")
	if _, createErr := family.CreateFamily(h.ctx(), h.familyRoot(familyHash)); createErr != nil {
		return nil, "", createErr
	}
	root, err := h.stores.RouteRefreshBroker.Get(h.ctx(), familyHash)
	if err != nil {
		return nil, "", err
	}
	locked, err := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), root.HandleHash, "conformance-owner", root.Version)
	if err != nil {
		return nil, "", err
	}
	return locked, familyHash, nil
}

// brokerRecordFamily is referenced by family rows that report which family a
// listed record belongs to.
var _ = brokerRecordFamily
