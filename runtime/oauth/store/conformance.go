package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"
)

// ConformanceEpoch is the instant every conformance case starts at. It matches
// the shared store conformance fixture's clock block, so a row that advances
// the injected clock measures the same TTL the fixture describes.
var ConformanceEpoch = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

// Conformance outcome vocabulary, matching the fixture's outcomes block.
const (
	conformanceOutcomeOK                       = "ok"
	conformanceOutcomeNotFound                 = "not_found"
	conformanceOutcomeReplayed                 = "replayed"
	conformanceOutcomeExpired                  = "expired"
	conformanceOutcomeLocked                   = "locked"
	conformanceOutcomeRevoked                  = "revoked"
	conformanceOutcomeVersionConflict          = "version_conflict"
	conformanceOutcomeFamilyExists             = "family_exists"
	conformanceOutcomeFamilyStateUnavailable   = "family_state_unavailable"
	conformanceOutcomeFamilyMismatch           = "family_mismatch"
	conformanceOutcomeSuccessorExists          = "successor_exists"
	conformanceOutcomeLegacyLineageUnsupported = "legacy_lineage_unsupported"
	conformanceOutcomeFamilyCapabilityMissing  = "family_capability_missing"
)

// Conformance snapshot keys used by more than one row.
const (
	conformanceParamTTLSeconds  = "ttl_seconds"
	conformanceParamAdvance     = "advance_seconds"
	conformanceParamClockBack   = "clock_back_seconds"
	conformanceParamConcurrency = "concurrency"
	conformanceStoreTransaction = "transaction"
	conformanceStoreAuthCode    = "authorization_code"
	conformanceStoreClient      = "client"
	conformanceStoreBroker      = "route_refresh_broker"
	conformanceKeyGet           = "get"
)

// ConformanceCase is one row of the shared store conformance table
// (contract-tests/fixtures/routing/mcp-auth-facade/facade-store-conformance.v1.json).
type ConformanceCase struct {
	ID       string         `json:"id"`
	Store    string         `json:"store"`
	Scenario string         `json:"scenario"`
	Params   map[string]any `json:"params"`
	Expect   map[string]any `json:"expect"`
}

// LoadConformanceCases reads the shared store conformance fixture at path.
func LoadConformanceCases(path string) ([]ConformanceCase, error) {
	//nolint:gosec // The caller supplies the repository-owned fixture path.
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("store conformance: read fixture: %w", err)
	}
	var document struct {
		Cases []ConformanceCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("store conformance: parse fixture: %w", err)
	}
	if len(document.Cases) == 0 {
		return nil, errors.New("store conformance: fixture carries no cases")
	}
	return document.Cases, nil
}

// RunConformance runs every case against stores and returns how many cases
// completed, so a caller can assert the whole table executed.
//
// Each case starts from ConformanceEpoch on clock, and a row that fails is
// reported through tb and does not stop the remaining rows. clock must be the
// same clock the stores were built with, so a row that advances time is
// observed by the stores. The broker store's lock TTL is a store option, not a
// per-call argument, so a caller running the shared table configures it to the
// fixture's lock_ttl_seconds.
func RunConformance(tb testing.TB, stores Stores, cases []ConformanceCase, clock *ManualClock) int {
	tb.Helper()
	ran := 0
	for index, testCase := range cases {
		if clock != nil {
			clock.Set(ConformanceEpoch)
		}
		harness := &conformanceHarness{tb: tb, stores: stores, clock: clock}
		observed, err := harness.run(testCase)
		if err != nil {
			tb.Errorf("conformance case %d %s: %v", index+1, testCase.ID, err)
			continue
		}
		ran++
		assertConformanceExpectations(tb, testCase, observed)
	}
	return ran
}

// conformanceHarness executes one case against the bundled stores.
type conformanceHarness struct {
	tb     testing.TB
	stores Stores
	clock  *ManualClock
}

// conformanceScenarios dispatches a fixture scenario onto the store methods.
// Keeping the dispatch in a table keeps each scenario small enough to review
// against the row it implements.
var conformanceScenarios = map[string]func(*conformanceHarness, ConformanceCase) (map[string]any, error){
	"consume_single_use":                 (*conformanceHarness).transactionConsumeSingleUse,
	"consume_unknown":                    (*conformanceHarness).consumeUnknown,
	"consume_after_ttl":                  (*conformanceHarness).consumeAfterTTL,
	"concurrent_consume":                 (*conformanceHarness).concurrentConsume,
	"consume_single_use_then_replay":     (*conformanceHarness).authorizationCodeConsumeReplay,
	"consume_record_payload":             (*conformanceHarness).authorizationCodeConsumeRecordPayload,
	"put_payload":                        (*conformanceHarness).putPayload,
	"consume_after_ttl_then_replay":      (*conformanceHarness).consumeAfterTTLThenReplay,
	"clock_back_after_consume":           (*conformanceHarness).clockBackAroundConsume,
	"clock_back_after_expired_consume":   (*conformanceHarness).clockBackAroundConsume,
	"put_get_update":                     (*conformanceHarness).clientPutGetUpdate,
	"update_stale_version":               (*conformanceHarness).clientUpdateStaleVersion,
	"get_unknown":                        (*conformanceHarness).getUnknown,
	"acquire_lock_exclusive_with_expiry": (*conformanceHarness).brokerAcquireLockExclusive,
	"compare_and_swap_versioned":         (*conformanceHarness).brokerCompareAndSwapVersioned,
	"compare_and_swap_unknown":           (*conformanceHarness).brokerCompareAndSwapUnknown,
	"compare_and_swap_inherits_status":   (*conformanceHarness).brokerCompareAndSwapInheritsStatus,
	"negative_expected_version":          (*conformanceHarness).brokerNegativeExpectedVersion,
	"revoke_idempotent":                  (*conformanceHarness).brokerRevokeIdempotent,
	"revoke_then_lock":                   (*conformanceHarness).brokerRevokeThenLock,
	"revoke_then_swap":                   (*conformanceHarness).brokerRevokeThenSwap,
	"broker_ttl_boundary":                (*conformanceHarness).brokerTTLBoundary,
	"broker_expired_refuses_lock":        (*conformanceHarness).brokerExpiredRefusesLock,
	"broker_expired_refuses_swap":        (*conformanceHarness).brokerExpiredRefusesSwap,
	"broker_expired_vs_unknown":          (*conformanceHarness).brokerExpiredVsUnknown,
	"list_family":                        (*conformanceHarness).brokerListFamily,
	"revoke_family":                      (*conformanceHarness).brokerRevokeFamily,
	"family_create":                      (*conformanceHarness).brokerFamilyCreate,
	"family_create_binding":              (*conformanceHarness).brokerFamilyCreateBinding,
	"family_rotate":                      (*conformanceHarness).brokerFamilyRotate,
	"family_rotate_wrong_owner":          (*conformanceHarness).brokerFamilyRotateWrongOwner,
	"family_rotate_stale_version":        (*conformanceHarness).brokerFamilyRotateStaleVersion,
	"family_rotate_existing_successor":   (*conformanceHarness).brokerFamilyRotateExistingSuccessor,
	"family_rotate_generation_mismatch":  (*conformanceHarness).brokerFamilyRotateGenerationMismatch,
	"family_rotate_family_mismatch":      (*conformanceHarness).brokerFamilyRotateFamilyMismatch,
	"family_rotate_legacy":               (*conformanceHarness).brokerFamilyRotateLegacy,
	"family_missing_state":               (*conformanceHarness).brokerFamilyMissingState,
	"family_mixed_lineage":               (*conformanceHarness).brokerFamilyMixedLineage,
	"family_tombstone_every_member":      (*conformanceHarness).brokerFamilyTombstoneEveryMember,
	"family_tombstone_beyond_batch":      (*conformanceHarness).brokerFamilyTombstoneBeyondBatch,
	"family_revocation_first":            (*conformanceHarness).brokerFamilyRevocationFirst,
	"family_rotation_first":              (*conformanceHarness).brokerFamilyRotationFirst,
	"family_tombstone_survives_expiry":   (*conformanceHarness).brokerFamilyTombstoneSurvivesExpiry,
	"acquire_lock_bumps_version":         (*conformanceHarness).brokerAcquireLockBumpsVersion,
	"revoke_bumps_version":               (*conformanceHarness).brokerRevokeBumpsVersion,
	"acquire_lock_sets_refreshing":       (*conformanceHarness).brokerAcquireLockSetsRefreshing,
	"concurrent_acquire_lock":            (*conformanceHarness).brokerConcurrentAcquireLock,
	"concurrent_revoke":                  (*conformanceHarness).brokerConcurrentRevoke,
	"check_and_increment":                (*conformanceHarness).rateLimitCheckAndIncrement,
	"window_reset":                       (*conformanceHarness).rateLimitWindowReset,
}

func (h *conformanceHarness) run(testCase ConformanceCase) (map[string]any, error) {
	handler, ok := conformanceScenarios[testCase.Scenario]
	if !ok {
		return nil, fmt.Errorf("unsupported scenario %q", testCase.Scenario)
	}
	return handler(h, testCase)
}

func (h *conformanceHarness) ctx() context.Context {
	return context.Background()
}

func (h *conformanceHarness) now() time.Time {
	if h.clock != nil {
		return h.clock.Now()
	}
	return time.Now().UTC()
}

// advance moves the injected clock forward, so an injected-TTL row observes the
// TTL the fixture describes.
func (h *conformanceHarness) advance(seconds int) {
	if h.clock == nil || seconds <= 0 {
		return
	}
	h.clock.Advance(time.Duration(seconds) * time.Second)
}

// recede moves the injected clock backward, so a row can observe whether
// terminal state survives a rewind instead of being resurrected. advance
// ignores non-positive seconds, so a rewind needs its own helper.
func (h *conformanceHarness) recede(seconds int) {
	if h.clock == nil || seconds <= 0 {
		return
	}
	h.clock.Advance(-time.Duration(seconds) * time.Second)
}

// expiry returns the record expiry the fixture's ttl_seconds describes, or the
// zero time (store default) when the row states none.
func (h *conformanceHarness) expiry(testCase ConformanceCase) time.Time {
	ttl := h.seconds(testCase, conformanceParamTTLSeconds)
	if ttl <= 0 {
		return time.Time{}
	}
	return h.now().Add(ttl)
}

func (h *conformanceHarness) seconds(testCase ConformanceCase, name string) time.Duration {
	value, ok := conformanceNumber(testCase.Params[name])
	if !ok {
		return 0
	}
	return time.Duration(int64(value)) * time.Second
}

func (h *conformanceHarness) count(testCase ConformanceCase, name string) int {
	value, ok := conformanceNumber(testCase.Params[name])
	if !ok || value < 1 {
		return 1
	}
	return int(value)
}

// size returns a row's cardinality parameter, where zero is meaningful (an empty
// family) rather than defaulted to one.
func (h *conformanceHarness) size(testCase ConformanceCase, name string) int {
	value, ok := conformanceNumber(testCase.Params[name])
	if !ok || value < 0 {
		return 0
	}
	return int(value)
}

// key derives a per-case store key, so rows in one table never share state.
func (h *conformanceHarness) key(testCase ConformanceCase, suffix string) string {
	if suffix == "" {
		return testCase.ID
	}
	return testCase.ID + ":" + suffix
}

func (h *conformanceHarness) putTransaction(testCase ConformanceCase, key string) error {
	return h.stores.Transaction.Put(h.ctx(), &TransactionRecord{
		StateHash: key,
		ClientID:  "conformance-client",
		Status:    "pending",
		ExpiresAt: h.expiry(testCase),
	})
}

func (h *conformanceHarness) consumeTransaction(key string) error {
	_, err := h.stores.Transaction.Consume(h.ctx(), key)
	return err
}

func (h *conformanceHarness) putCode(testCase ConformanceCase, key string) error {
	return h.stores.AuthorizationCode.Put(h.ctx(), &AuthorizationCodeRecord{
		CodeHash:  key,
		ClientID:  "conformance-client",
		Status:    "issued",
		ExpiresAt: h.expiry(testCase),
	})
}

func (h *conformanceHarness) consumeCode(key string) error {
	_, err := h.stores.AuthorizationCode.Consume(h.ctx(), key)
	return err
}

func (h *conformanceHarness) putBroker(key string) error {
	return h.putBrokerStatus(key, BrokerStatusActive)
}

// putBrokerStatus seeds one handle through the store's own create path with the
// caller's status, so a row can start from a status other than active without
// going through the mutating lock path.
func (h *conformanceHarness) putBrokerStatus(key, status string) error {
	seeder, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerSeeder)
	if !ok {
		return fmt.Errorf("%w: %T", ErrBrokerNotSeedable, h.stores.RouteRefreshBroker)
	}
	return seeder.Put(h.ctx(), &RouteRefreshBrokerRecord{
		HandleHash:        key,
		Issuer:            "https://auth.example.test",
		Stage:             "lab",
		CanonicalResource: "https://mcp.example.test/mcp",
		Status:            status,
	})
}

// runConcurrent runs operation on count goroutines released together and
// returns each goroutine's outcome, which is how the table's exactly-one-winner
// rows are observed.
func (h *conformanceHarness) runConcurrent(count int, operation func() error) []string {
	outcomes := make([]string, count)
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			outcomes[index] = outcomeFor(operation())
		}(index)
	}
	close(start)
	wait.Wait()
	return outcomes
}

func (h *conformanceHarness) transactionConsumeSingleUse(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "state")
	if err := h.putTransaction(testCase, key); err != nil {
		return nil, err
	}
	first := outcomeFor(h.consumeTransaction(key))
	second := outcomeFor(h.consumeTransaction(key))
	return map[string]any{"first": first, "second": second}, nil
}

func (h *conformanceHarness) authorizationCodeConsumeReplay(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "code")
	if err := h.putCode(testCase, key); err != nil {
		return nil, err
	}
	first := outcomeFor(h.consumeCode(key))
	second := outcomeFor(h.consumeCode(key))
	return map[string]any{"first": first, "second": second}, nil
}

// authorizationCodeConsumeRecordPayload reports the record a consume returns, so
// a row pins the payload contract (status and version) and not only the
// outcome. A consume that returns no record — the first consume of an expired
// code — reports the "none" sentinel for its fields.
func (h *conformanceHarness) authorizationCodeConsumeRecordPayload(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "code")
	if err := h.putCode(testCase, key); err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	first, firstErr := h.stores.AuthorizationCode.Consume(h.ctx(), key)
	replay, replayErr := h.stores.AuthorizationCode.Consume(h.ctx(), key)
	return map[string]any{
		"first":          outcomeFor(firstErr),
		"first_status":   codeRecordStatusField(first),
		"first_version":  codeRecordVersionField(first),
		"replay":         outcomeFor(replayErr),
		"replay_status":  codeRecordStatusField(replay),
		"replay_version": codeRecordVersionField(replay),
	}, nil
}

// codeRecordStatusField reports a returned code record's status, or the "none"
// sentinel when the consume returned no record.
func codeRecordStatusField(record *AuthorizationCodeRecord) string {
	if record == nil {
		return "none"
	}
	return record.Status
}

// codeRecordVersionField reports a returned code record's version, or -1 when
// the consume returned no record.
func codeRecordVersionField(record *AuthorizationCodeRecord) int {
	if record == nil {
		return -1
	}
	return record.Version
}

// transactionRecordVersionField reports a consumed transaction record's version,
// or -1 when the consume returned no record. The status is deliberately not
// reported for the transaction store: Go hands back the caller's status while
// TypeScript and Python stamp the consume outcome onto the record.
func transactionRecordVersionField(record *TransactionRecord) int {
	if record == nil {
		return -1
	}
	return record.Version
}

// putPayload seeds exactly one record through the store's put with the caller's
// status and version, then reports what the store hands back. A row pins the
// put-path payload contract — the caller's status is preserved verbatim and a
// version below 1 is normalized to 1 — rather than only the outcome. An absent
// put_status is the empty string and an absent put_version is 0. The transaction
// store reports only the consumed version: Go returns the caller's status while
// TypeScript and Python stamp the consume outcome on the record, so the status
// encoding deliberately differs and is not compared for that store.
func (h *conformanceHarness) putPayload(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "record")
	status := h.putStatusParam(testCase)
	version := h.putVersionParam(testCase)
	switch testCase.Store {
	case conformanceStoreTransaction:
		if err := h.stores.Transaction.Put(h.ctx(), &TransactionRecord{
			StateHash: key,
			ClientID:  "conformance-client",
			Status:    "pending",
			Version:   version,
			ExpiresAt: h.expiry(testCase),
		}); err != nil {
			return nil, err
		}
		record, err := h.stores.Transaction.Consume(h.ctx(), key)
		return map[string]any{
			"consume": outcomeFor(err),
			"version": transactionRecordVersionField(record),
		}, nil
	case conformanceStoreAuthCode:
		if err := h.stores.AuthorizationCode.Put(h.ctx(), &AuthorizationCodeRecord{
			CodeHash:  key,
			ClientID:  "conformance-client",
			Status:    status,
			Version:   version,
			ExpiresAt: h.expiry(testCase),
		}); err != nil {
			return nil, err
		}
		record, err := h.stores.AuthorizationCode.Consume(h.ctx(), key)
		return map[string]any{
			"consume": outcomeFor(err),
			"status":  codeRecordStatusField(record),
			"version": codeRecordVersionField(record),
		}, nil
	case conformanceStoreBroker:
		seeder, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerSeeder)
		if !ok {
			return nil, fmt.Errorf("%w: %T", ErrBrokerNotSeedable, h.stores.RouteRefreshBroker)
		}
		if err := seeder.Put(h.ctx(), &RouteRefreshBrokerRecord{
			HandleHash:        key,
			Issuer:            "https://auth.example.test",
			Stage:             "lab",
			CanonicalResource: "https://mcp.example.test/mcp",
			Status:            status,
			Version:           version,
		}); err != nil {
			return nil, err
		}
		record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
		return map[string]any{
			"get":     outcomeFor(err),
			"status":  brokerRecordStatusField(record),
			"version": brokerRecordVersionField(record),
		}, nil
	default:
		return nil, fmt.Errorf("put_payload does not apply to store %q", testCase.Store)
	}
}

// putStatusParam returns the row's caller-supplied put status, or the empty
// string when the row states none.
func (h *conformanceHarness) putStatusParam(testCase ConformanceCase) string {
	value, ok := testCase.Params["put_status"].(string)
	if !ok {
		return ""
	}
	return value
}

// putVersionParam returns the row's caller-supplied put version, or 0 when the
// row states none.
func (h *conformanceHarness) putVersionParam(testCase ConformanceCase) int {
	value, ok := conformanceNumber(testCase.Params["put_version"])
	if !ok {
		return 0
	}
	return int(value)
}

// brokerRecordStatusField reports a fetched broker record's status, or the
// "none" sentinel when the fetch returned no record.
func brokerRecordStatusField(record *RouteRefreshBrokerRecord) string {
	if record == nil {
		return "none"
	}
	return record.Status
}

// brokerRecordVersionField reports a fetched broker record's version, or -1 when
// the fetch returned no record.
func brokerRecordVersionField(record *RouteRefreshBrokerRecord) int {
	if record == nil {
		return -1
	}
	return record.Version
}

func (h *conformanceHarness) consumeUnknown(testCase ConformanceCase) (map[string]any, error) {
	switch testCase.Store {
	case conformanceStoreTransaction:
		return map[string]any{"consume": outcomeFor(h.consumeTransaction(h.key(testCase, "state")))}, nil
	case conformanceStoreAuthCode:
		return map[string]any{"consume": outcomeFor(h.consumeCode(h.key(testCase, "code")))}, nil
	default:
		return nil, fmt.Errorf("consume_unknown does not apply to store %q", testCase.Store)
	}
}

// seedConsumeTarget stores the record a consume-based row starts from, keyed by
// the case's store, and returns the consume the row observes. It keeps the
// transaction and authorization-code rows of one scenario in step.
func (h *conformanceHarness) seedConsumeTarget(testCase ConformanceCase) (func() error, error) {
	switch testCase.Store {
	case conformanceStoreTransaction:
		key := h.key(testCase, "state")
		if err := h.putTransaction(testCase, key); err != nil {
			return nil, err
		}
		return func() error { return h.consumeTransaction(key) }, nil
	case conformanceStoreAuthCode:
		key := h.key(testCase, "code")
		if err := h.putCode(testCase, key); err != nil {
			return nil, err
		}
		return func() error { return h.consumeCode(key) }, nil
	default:
		return nil, fmt.Errorf("%s does not apply to store %q", testCase.Scenario, testCase.Store)
	}
}

func (h *conformanceHarness) consumeAfterTTL(testCase ConformanceCase) (map[string]any, error) {
	consume, err := h.seedConsumeTarget(testCase)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	return map[string]any{"consume": outcomeFor(consume())}, nil
}

// consumeAfterTTLThenReplay burns a record past its TTL and then consumes it
// again, so a row observes what the store retains after an expired burn: a
// transaction is gone (not_found) and a code is retained as consumed
// (replayed).
func (h *conformanceHarness) consumeAfterTTLThenReplay(testCase ConformanceCase) (map[string]any, error) {
	consume, err := h.seedConsumeTarget(testCase)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	return map[string]any{
		"first":  outcomeFor(consume()),
		"second": outcomeFor(consume()),
	}, nil
}

// clockBackAroundConsume consumes a record and then winds the clock backward, so
// a row observes whether terminal state survives a rewind. advance_seconds is
// absent for the live-consume row and present for the expired-burn row, so one
// handler serves both clock_back rows.
func (h *conformanceHarness) clockBackAroundConsume(testCase ConformanceCase) (map[string]any, error) {
	consume, err := h.seedConsumeTarget(testCase)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	first := outcomeFor(consume())
	recede, _ := conformanceNumber(testCase.Params[conformanceParamClockBack])
	h.recede(int(recede))
	return map[string]any{
		"first":            first,
		"after_clock_back": outcomeFor(consume()),
	}, nil
}

func (h *conformanceHarness) concurrentConsume(testCase ConformanceCase) (map[string]any, error) {
	consume, err := h.seedConsumeTarget(testCase)
	if err != nil {
		return nil, err
	}
	return outcomeCounts(h.runConcurrent(h.count(testCase, conformanceParamConcurrency), consume)), nil
}

// clientPutGetUpdate seeds one client with the row's put version and walks the
// versioned read/update path. The store's put owns the stored version, so a row
// with a put_version above 1 pins that put forces version 1 rather than keeping
// the caller's.
func (h *conformanceHarness) clientPutGetUpdate(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "client")
	record := conformanceClientRecord(key)
	record.Version = h.putVersionParam(testCase)
	if err := h.stores.Client.Put(h.ctx(), record); err != nil {
		return nil, err
	}
	stored, err := h.stores.Client.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	_, updateErr := h.stores.Client.Update(h.ctx(), stored, stored.Version)
	updated, err := h.stores.Client.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"get_version":     stored.Version,
		"update":          outcomeFor(updateErr),
		"updated_version": updated.Version,
	}, nil
}

func (h *conformanceHarness) clientUpdateStaleVersion(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "client")
	if err := h.stores.Client.Put(h.ctx(), conformanceClientRecord(key)); err != nil {
		return nil, err
	}
	stored, err := h.stores.Client.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	if _, firstErr := h.stores.Client.Update(h.ctx(), stored, stored.Version); firstErr != nil {
		return nil, fmt.Errorf("first update: %w", firstErr)
	}
	_, staleErr := h.stores.Client.Update(h.ctx(), stored, stored.Version)
	updated, err := h.stores.Client.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"update":      outcomeFor(staleErr),
		"get_version": updated.Version,
	}, nil
}

func conformanceClientRecord(key string) *ClientRecord {
	return &ClientRecord{
		ClientIDHash: key,
		ClientID:     "conformance-client",
		RedirectURIs: []string{"https://mcp.example.test/_oauth/mcp/callback"},
	}
}

func (h *conformanceHarness) getUnknown(testCase ConformanceCase) (map[string]any, error) {
	switch testCase.Store {
	case conformanceStoreClient:
		_, err := h.stores.Client.Get(h.ctx(), h.key(testCase, "client"))
		return map[string]any{conformanceKeyGet: outcomeFor(err)}, nil
	case conformanceStoreBroker:
		_, err := h.stores.RouteRefreshBroker.Get(h.ctx(), h.key(testCase, "handle"))
		return map[string]any{conformanceKeyGet: outcomeFor(err)}, nil
	default:
		return nil, fmt.Errorf("get_unknown does not apply to store %q", testCase.Store)
	}
}

// brokerVersion reads the current broker record version, which a row passes as
// the expected version of the next lock or swap.
func (h *conformanceHarness) brokerVersion(key string) (int, error) {
	record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return 0, err
	}
	return record.Version, nil
}

func (h *conformanceHarness) brokerAcquireLockExclusive(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}

	_, firstErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-1", version)
	_, contendedErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-2", version)

	lockedVersion, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	_, expiredErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-3", lockedVersion)

	return map[string]any{
		"first":        outcomeFor(firstErr),
		"contended":    outcomeFor(contendedErr),
		"after_expiry": outcomeFor(expiredErr),
	}, nil
}

func (h *conformanceHarness) brokerCompareAndSwapVersioned(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}

	locked, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-1", version)
	if lockErr != nil {
		return nil, fmt.Errorf("acquire lock: %w", lockErr)
	}
	if locked == nil {
		return nil, errors.New("acquire lock: no record returned")
	}
	_, swapErr := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), locked, locked.Version)
	_, staleErr := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), locked, locked.Version)

	return map[string]any{
		"acquire_lock": outcomeFor(lockErr),
		"swap":         outcomeFor(swapErr),
		"stale_swap":   outcomeFor(staleErr),
	}, nil
}

// brokerCompareAndSwapUnknown swaps a handle that was never created. Creation
// is a separate seeder operation, so a compare-and-swap on an absent handle is
// not-found rather than an optimistic create.
func (h *conformanceHarness) brokerCompareAndSwapUnknown(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	_, err := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), &RouteRefreshBrokerRecord{HandleHash: key}, 0)
	return map[string]any{"swap": outcomeFor(err)}, nil
}

// brokerCompareAndSwapInheritsStatus seeds a handle, takes the refresh lock so
// the stored status becomes refreshing, and then swaps in a replacement that
// states no status. The store adopts the stored status, so a rotation that
// carries none cannot silently clear what the handle was in the middle of.
func (h *conformanceHarness) brokerCompareAndSwapInheritsStatus(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBrokerStatus(key, BrokerStatusIssued); err != nil {
		return nil, err
	}
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	if _, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-inherit", version); lockErr != nil {
		return nil, fmt.Errorf("acquire lock: %w", lockErr)
	}
	held, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	swapped, swapErr := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), &RouteRefreshBrokerRecord{
		HandleHash: key,
	}, held.Version)
	if swapErr != nil {
		return nil, fmt.Errorf("compare and swap: %w", swapErr)
	}
	return map[string]any{"status": swapped.Status}, nil
}

// brokerNegativeExpectedVersion pins that a negative expected version is never a
// skip-version-check wildcard: the store reports a version conflict for it, on
// both the swap and the lock, in every runtime, so no caller can rely on one.
func (h *conformanceHarness) brokerNegativeExpectedVersion(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	_, swapErr := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), record, -1)
	_, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-negative", -1)
	return map[string]any{
		"swap":         outcomeFor(swapErr),
		"acquire_lock": outcomeFor(lockErr),
	}, nil
}

func (h *conformanceHarness) brokerRevokeIdempotent(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	_, revokeErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key)
	_, revokeAgainErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key)
	record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"revoke":       outcomeFor(revokeErr),
		"revoke_again": outcomeFor(revokeAgainErr),
		"status":       record.Status,
	}, nil
}

func (h *conformanceHarness) brokerRevokeThenLock(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	_, revokeErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key)
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	_, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-1", version)
	return map[string]any{
		"revoke":       outcomeFor(revokeErr),
		"acquire_lock": outcomeFor(lockErr),
	}, nil
}

// brokerTTLBoundary reads a handle after advancing to a TTL boundary, so a row
// observes whether the record is still present or has aged out.
func (h *conformanceHarness) brokerTTLBoundary(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	_, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	return map[string]any{conformanceKeyGet: outcomeFor(err)}, nil
}

// brokerExpiredRefusesLock holds the live version, lets the handle age out, and
// then asks for the lock: an aged-out handle is absent, so the lock is refused
// as not_found before the version is considered. The version is read while the
// record is still live, because the read itself reports absence once it expires.
func (h *conformanceHarness) brokerExpiredRefusesLock(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	_, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-ttl", version)
	return map[string]any{"acquire_lock": outcomeFor(lockErr)}, nil
}

// brokerExpiredRefusesSwap holds the live record, lets the handle age out, and
// then swaps it: an aged-out handle is absent, so the swap reports not_found.
func (h *conformanceHarness) brokerExpiredRefusesSwap(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	_, swapErr := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), record, record.Version)
	return map[string]any{"swap": outcomeFor(swapErr)}, nil
}

// brokerExpiredVsUnknown demonstrates the signal the facade attributes through:
// an unknown key and an aged-out key report different outcomes at the SPI, even
// though the client-facing body is the same.
func (h *conformanceHarness) brokerExpiredVsUnknown(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	_, unknownErr := h.stores.RouteRefreshBroker.Get(h.ctx(), h.key(testCase, "unknown"))
	_, expiredErr := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	return map[string]any{
		"unknown": outcomeFor(unknownErr),
		"expired": outcomeFor(expiredErr),
	}, nil
}

// brokerFamilyStore returns the optional family capability, or ErrBrokerNotSeedable
// when the store does not implement it.
func (h *conformanceHarness) brokerFamilyStore() (RouteRefreshBrokerFamilyStore, error) {
	family, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerFamilyStore)
	if !ok {
		return nil, fmt.Errorf("%w: %T", ErrBrokerNotSeedable, h.stores.RouteRefreshBroker)
	}
	return family, nil
}

// putBrokerFamily seeds one handle with a family hash through the store's own
// create path.
func (h *conformanceHarness) putBrokerFamily(key, familyHash string) error {
	seeder, ok := h.stores.RouteRefreshBroker.(RouteRefreshBrokerSeeder)
	if !ok {
		return fmt.Errorf("%w: %T", ErrBrokerNotSeedable, h.stores.RouteRefreshBroker)
	}
	return seeder.Put(h.ctx(), &RouteRefreshBrokerRecord{
		HandleHash:        key,
		Issuer:            "https://auth.example.test",
		Stage:             "lab",
		CanonicalResource: "https://mcp.example.test/mcp",
		Status:            BrokerStatusActive,
		ChainGeneration:   2,
		FamilyHash:        familyHash,
	})
}

// brokerListFamily seeds two families and reports what the family listing
// returns for one of them, so a store that cannot enumerate a family is visible.
// Each family is created through the transactional capability, because the
// front channel requires family state for a family-marked handle.
func (h *conformanceHarness) brokerListFamily(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	otherHash := h.key(testCase, "other-family")
	familySize := h.size(testCase, "family_size")
	otherSize := h.size(testCase, "other_family_size")
	if err := h.seedFamilyWithRoot(testCase, familyHash, familySize, "member"); err != nil {
		return nil, err
	}
	if err := h.seedFamilyWithRoot(testCase, otherHash, otherSize, "other"); err != nil {
		return nil, err
	}
	records, err := family.ListFamily(h.ctx(), familyHash)
	if err != nil {
		return nil, err
	}
	otherRecords, err := family.ListFamily(h.ctx(), otherHash)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"family_size":       len(records),
		"other_family_size": len(otherRecords),
	}, nil
}

// seedFamilyWithRoot creates a family root through the transactional capability
// and backfills the remaining members through the store's create path. It
// returns the handle keys it stored.
func (h *conformanceHarness) seedFamilyWithRoot(
	testCase ConformanceCase,
	familyHash string,
	size int,
	prefix string,
) error {
	if size <= 0 {
		return nil
	}
	family, err := h.familyStore()
	if err != nil {
		return err
	}
	root := h.familyRoot(familyHash)
	root.Status = BrokerStatusActive
	if _, err := family.CreateFamily(h.ctx(), root); err != nil {
		return err
	}
	for index := 1; index < size; index++ {
		key := h.key(testCase, fmt.Sprintf("%s-%d", prefix, index))
		if err := h.putBrokerFamily(key, familyHash); err != nil {
			return err
		}
	}
	return nil
}

// brokerRevokeFamily seeds two families, revokes one through the family
// capability, and reports what was revoked and what the other family's state is,
// so a family revoke that misses members or leaks across families is visible.
func (h *conformanceHarness) brokerRevokeFamily(testCase ConformanceCase) (map[string]any, error) {
	family, err := h.familyStore()
	if err != nil {
		return nil, err
	}
	familyHash := h.key(testCase, "family")
	otherHash := h.key(testCase, "other-family")
	familySize := h.size(testCase, "family_size")
	otherSize := h.size(testCase, "other_family_size")
	if err := h.seedFamilyWithRoot(testCase, familyHash, familySize, "member"); err != nil {
		return nil, err
	}
	if err := h.seedFamilyWithRoot(testCase, otherHash, otherSize, "other"); err != nil {
		return nil, err
	}
	familyKeys := make([]string, 0, familySize)
	for index := 0; index < familySize; index++ {
		if index == 0 {
			familyKeys = append(familyKeys, familyHash)
			continue
		}
		familyKeys = append(familyKeys, h.key(testCase, fmt.Sprintf("member-%d", index)))
	}
	otherKeys := make([]string, 0, otherSize)
	for index := 0; index < otherSize; index++ {
		if index == 0 {
			otherKeys = append(otherKeys, otherHash)
			continue
		}
		otherKeys = append(otherKeys, h.key(testCase, fmt.Sprintf("other-%d", index)))
	}
	revoked, err := family.RevokeFamily(h.ctx(), familyHash)
	if err != nil {
		return nil, err
	}
	if _, err := family.ListFamily(h.ctx(), familyHash); err != nil {
		return nil, err
	}
	familyStatuses := make([]string, 0, len(familyKeys))
	for _, key := range familyKeys {
		record, getErr := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
		if errors.Is(getErr, ErrBrokerRevoked) {
			familyStatuses = append(familyStatuses, BrokerStatusRevoked)
			continue
		}
		if getErr != nil {
			return nil, getErr
		}
		familyStatuses = append(familyStatuses, record.Status)
	}
	slices.Sort(familyStatuses)
	otherStatuses := make([]string, 0, len(otherKeys))
	for _, key := range otherKeys {
		record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
		if err != nil {
			return nil, err
		}
		otherStatuses = append(otherStatuses, record.Status)
	}
	slices.Sort(otherStatuses)
	return map[string]any{
		"revoked_family_size": len(revoked),
		"family_statuses":     familyStatuses,
		"other_statuses":      otherStatuses,
	}, nil
}

// brokerRevokeThenSwap swaps a revoked record: revocation is terminal, so the
// swap reports revoked rather than resurrecting the handle.
func (h *conformanceHarness) brokerRevokeThenSwap(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	revoked, revokeErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key)
	record := revoked
	if record == nil {
		fetched, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
		if err != nil {
			return nil, err
		}
		record = fetched
	}
	_, swapErr := h.stores.RouteRefreshBroker.CompareAndSwap(h.ctx(), record, record.Version)
	return map[string]any{
		"revoke": outcomeFor(revokeErr),
		"swap":   outcomeFor(swapErr),
	}, nil
}

// brokerAcquireLockBumpsVersion reports the version delta one lock acquisition
// leaves behind.
func (h *conformanceHarness) brokerAcquireLockBumpsVersion(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	before, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	if _, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-bump", before); lockErr != nil {
		return nil, fmt.Errorf("acquire lock: %w", lockErr)
	}
	after, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	return map[string]any{"version_delta": after - before}, nil
}

// brokerAcquireLockSetsRefreshing reports the record status one lock acquisition
// leaves behind: an acquired handle is refreshing, in every runtime.
func (h *conformanceHarness) brokerAcquireLockSetsRefreshing(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	if _, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "owner-status", version); lockErr != nil {
		return nil, fmt.Errorf("acquire lock: %w", lockErr)
	}
	record, err := h.stores.RouteRefreshBroker.Get(h.ctx(), key)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": record.Status}, nil
}

// brokerRevokeBumpsVersion reports the version delta the first revoke leaves
// behind and the delta an idempotent second revoke leaves behind.
func (h *conformanceHarness) brokerRevokeBumpsVersion(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	before, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	if _, revokeErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key); revokeErr != nil {
		return nil, fmt.Errorf("revoke: %w", revokeErr)
	}
	afterFirst, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	if _, revokeAgainErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key); revokeAgainErr != nil {
		return nil, fmt.Errorf("revoke again: %w", revokeAgainErr)
	}
	afterSecond, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"revoke_version_delta":       afterFirst - before,
		"revoke_again_version_delta": afterSecond - afterFirst,
	}, nil
}

func (h *conformanceHarness) brokerConcurrentAcquireLock(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	version, err := h.brokerVersion(key)
	if err != nil {
		return nil, err
	}
	acquire := func() error {
		_, lockErr := h.stores.RouteRefreshBroker.AcquireLock(h.ctx(), key, "concurrent-owner", version)
		return lockErr
	}
	return outcomeCounts(h.runConcurrent(h.count(testCase, conformanceParamConcurrency), acquire)), nil
}

func (h *conformanceHarness) brokerConcurrentRevoke(testCase ConformanceCase) (map[string]any, error) {
	key := h.key(testCase, "handle")
	if err := h.putBroker(key); err != nil {
		return nil, err
	}
	revoke := func() error {
		_, revokeErr := h.stores.RouteRefreshBroker.Revoke(h.ctx(), key)
		return revokeErr
	}
	return outcomeCounts(h.runConcurrent(h.count(testCase, conformanceParamConcurrency), revoke)), nil
}

func (h *conformanceHarness) checkAndIncrement(testCase ConformanceCase) (RateLimitResult, error) {
	limit, _ := conformanceNumber(testCase.Params["limit"])
	window, _ := conformanceNumber(testCase.Params["window_seconds"])
	return h.stores.RateLimit.CheckAndIncrement(h.ctx(), RateLimitBucketKey{
		Identifier: h.key(testCase, "identifier"),
		Resource:   "https://mcp.example.test/mcp",
		Operation:  "dynamic_client_registration",
		Limit:      int(limit),
		Window:     time.Duration(int64(window)) * time.Second,
	})
}

func (h *conformanceHarness) rateLimitCheckAndIncrement(testCase ConformanceCase) (map[string]any, error) {
	checks := h.count(testCase, "checks")
	outcomes := make([]string, 0, checks)
	for index := 0; index < checks; index++ {
		result, err := h.checkAndIncrement(testCase)
		if err != nil {
			return nil, err
		}
		outcomes = append(outcomes, rateLimitOutcome(result))
	}
	return map[string]any{"outcomes": outcomes}, nil
}

func (h *conformanceHarness) rateLimitWindowReset(testCase ConformanceCase) (map[string]any, error) {
	first, err := h.checkAndIncrement(testCase)
	if err != nil {
		return nil, err
	}
	second, err := h.checkAndIncrement(testCase)
	if err != nil {
		return nil, err
	}
	advance, _ := conformanceNumber(testCase.Params[conformanceParamAdvance])
	h.advance(int(advance))
	afterWindow, err := h.checkAndIncrement(testCase)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"first":        rateLimitOutcome(first),
		"second":       rateLimitOutcome(second),
		"after_window": rateLimitOutcome(afterWindow),
	}, nil
}

// rateLimitOutcome renders a rate-limit result in the fixture's vocabulary.
func rateLimitOutcome(result RateLimitResult) string {
	if result.Allowed {
		return RateLimitAllowed
	}
	return RateLimitLimited
}

// outcomeFor renders an error in the fixture's outcome vocabulary. An error the
// vocabulary does not name is reported as itself, so a mismatched row fails
// loudly instead of silently matching something else.
func outcomeFor(err error) string {
	switch {
	case err == nil:
		return conformanceOutcomeOK
	case errors.Is(err, ErrTransactionNotFound),
		errors.Is(err, ErrAuthorizationCodeNotFound),
		errors.Is(err, ErrClientNotFound),
		errors.Is(err, ErrBrokerNotFound):
		return conformanceOutcomeNotFound
	case errors.Is(err, ErrTransactionExpired), errors.Is(err, ErrAuthorizationCodeExpired),
		errors.Is(err, ErrBrokerExpired):
		return conformanceOutcomeExpired
	case errors.Is(err, ErrAuthorizationCodeReplayed):
		return conformanceOutcomeReplayed
	case errors.Is(err, ErrBrokerLocked):
		return conformanceOutcomeLocked
	case errors.Is(err, ErrBrokerRevoked):
		return conformanceOutcomeRevoked
	case errors.Is(err, ErrBrokerFamilyCapabilityMissing):
		return conformanceOutcomeFamilyCapabilityMissing
	case errors.Is(err, ErrBrokerFamilyExists):
		return conformanceOutcomeFamilyExists
	case errors.Is(err, ErrBrokerFamilyStateUnavailable):
		return conformanceOutcomeFamilyStateUnavailable
	case errors.Is(err, ErrBrokerFamilyMismatch):
		return conformanceOutcomeFamilyMismatch
	case errors.Is(err, ErrBrokerSuccessorExists):
		return conformanceOutcomeSuccessorExists
	case errors.Is(err, ErrBrokerLegacyLineageUnsupported):
		return conformanceOutcomeLegacyLineageUnsupported
	case errors.Is(err, ErrClientVersionConflict), errors.Is(err, ErrBrokerVersionConflict):
		return conformanceOutcomeVersionConflict
	default:
		return "error: " + err.Error()
	}
}

// outcomeCounts tallies concurrent outcomes by name.
func outcomeCounts(outcomes []string) map[string]any {
	counts := make(map[string]any, len(outcomes))
	for _, outcome := range outcomes {
		current := 0
		if existing, ok := counts[outcome].(int); ok {
			current = existing
		}
		counts[outcome] = current + 1
	}
	return counts
}

// assertConformanceExpectations asserts every expectation the fixture states.
func assertConformanceExpectations(tb testing.TB, testCase ConformanceCase, observed map[string]any) {
	tb.Helper()
	for name, expected := range testCase.Expect {
		actual, ok := observed[name]
		if !ok {
			tb.Errorf("conformance case %s: no observed value for %q", testCase.ID, name)
			continue
		}
		if !conformanceValuesEqual(actual, expected) {
			tb.Errorf("conformance case %s: %s = %v, want %v", testCase.ID, name, actual, expected)
		}
	}
}

// conformanceValuesEqual compares an observed value with the fixture's, so a
// JSON number matches the Go integer the runner observed and a JSON array
// matches the Go slice.
func conformanceValuesEqual(actual, expected any) bool {
	if actualBool, ok := actual.(bool); ok {
		expectedBool, ok := expected.(bool)
		return ok && actualBool == expectedBool
	}
	if actualNumber, ok := conformanceNumber(actual); ok {
		expectedNumber, ok := conformanceNumber(expected)
		return ok && actualNumber == expectedNumber
	}
	if actualList, ok := conformanceStrings(actual); ok {
		expectedList, ok := conformanceStrings(expected)
		return ok && slices.Equal(actualList, expectedList)
	}
	actualText, actualOK := actual.(string)
	expectedText, expectedOK := expected.(string)
	return actualOK && expectedOK && actualText == expectedText
}

func conformanceNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case json.Number:
		parsed, err := number.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func conformanceStrings(value any) ([]string, bool) {
	switch list := value.(type) {
	case []string:
		return list, true
	case []any:
		values := make([]string, 0, len(list))
		for _, entry := range list {
			text, ok := entry.(string)
			if !ok {
				return nil, false
			}
			values = append(values, text)
		}
		return values, true
	default:
		return nil, false
	}
}
