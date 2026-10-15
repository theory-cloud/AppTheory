package store

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Default TTLs and windows, matching the facade-store-spi.v1.json ttl_seconds
// block. They are the fallback a store applies to a record that arrives without
// its own expiry, and an application overrides them per store.
//
// DefaultRouteRefreshLockTTL is 15 seconds because the lock has to outlast the
// single upstream refresh call it protects while staying as short as possible
// when that call dies: the M2.1 hardened upstream HTTP deadline is 10 seconds
// (oauth's defaultJWKSFetchTimeout, shared by the discovery, token, and JWKS
// fetches), so 15 seconds is that deadline plus a five-second margin. It is also
// well above the facade's three-second coalesce wait cap, so a waiter that is
// waiting for a rotation can never outlive the lock it is waiting on and steal
// it.
const (
	DefaultTransactionTTL        = 10 * time.Minute
	DefaultAuthorizationCodeTTL  = time.Minute
	DefaultRouteRefreshBrokerTTL = 15 * time.Minute
	DefaultRouteRefreshLockTTL   = 15 * time.Second
	DefaultRateLimitWindow       = time.Minute
)

// storeClock returns the injected clock, defaulting to UTC wall time.
func storeClock(now func() time.Time) func() time.Time {
	if now == nil {
		return func() time.Time { return time.Now().UTC() }
	}
	return now
}

// storeTTL returns the configured TTL, defaulting to fallback.
func storeTTL(ttl, fallback time.Duration) time.Duration {
	if ttl > 0 {
		return ttl
	}
	return fallback
}

// recordCopy returns a deep copy, so a caller can mutate neither the record nor
// a slice field through a value the store handed out: the struct is copied and
// every slice field is replaced with an independent slice.
func recordCopy[T any](record *T) *T {
	if record == nil {
		return nil
	}
	clone := *record
	cloneSlices(&clone)
	return &clone
}

// cloneStrings returns an independent copy of a string slice, preserving nil.
func cloneStrings(values []string) []string {
	if values == nil {
		return nil
	}
	clone := make([]string, len(values))
	copy(clone, values)
	return clone
}

// cloneSlices deep-copies the slice fields of a store record in place. The
// record set is closed and small, so the type switch is explicit rather than
// reflective.
func cloneSlices[T any](record *T) {
	switch value := any(record).(type) {
	case *TransactionRecord:
		value.Scopes = cloneStrings(value.Scopes)
	case *AuthorizationCodeRecord:
		value.Scopes = cloneStrings(value.Scopes)
	case *ClientRecord:
		value.RedirectURIs = cloneStrings(value.RedirectURIs)
		value.GrantTypes = cloneStrings(value.GrantTypes)
		value.ResponseTypes = cloneStrings(value.ResponseTypes)
	case *RouteRefreshBrokerRecord:
		value.Scopes = cloneStrings(value.Scopes)
	}
}

// isExpired reports whether expiresAt has been reached at now. A record is
// expired at and after its expiry instant.
func isExpired(now, expiresAt time.Time) bool {
	return !now.Before(expiresAt)
}

// TransactionStoreOptions configures NewMemoryTransactionStore.
type TransactionStoreOptions struct {
	// Now is the clock every operation observes. Nil means time.Now().UTC.
	Now func() time.Time
	// TTL is applied to a record that arrives without an expiry. Zero means
	// DefaultTransactionTTL.
	TTL time.Duration
}

// MemoryTransactionStore is the in-memory reference TransactionStore.
type MemoryTransactionStore struct {
	mu      sync.Mutex
	now     func() time.Time
	ttl     time.Duration
	records map[string]*TransactionRecord
}

// NewMemoryTransactionStore returns an empty in-memory transaction store.
func NewMemoryTransactionStore(opts TransactionStoreOptions) *MemoryTransactionStore {
	return &MemoryTransactionStore{
		now:     storeClock(opts.Now),
		ttl:     storeTTL(opts.TTL, DefaultTransactionTTL),
		records: make(map[string]*TransactionRecord),
	}
}

// Put stores a copy of the transaction record, normalizing a zero ExpiresAt and
// a zero Version on the supplied record.
func (s *MemoryTransactionStore) Put(_ context.Context, record *TransactionRecord) error {
	if record == nil || strings.TrimSpace(record.StateHash) == "" {
		return fmt.Errorf("%w: transaction record needs a state hash", ErrRecordKeyRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if record.ExpiresAt.IsZero() {
		record.ExpiresAt = now.Add(s.ttl)
	}
	if record.Version < 1 {
		record.Version = 1
	}
	s.records[record.StateHash] = recordCopy(record)
	return nil
}

// Consume burns the record and returns a copy of it. The burn happens before
// the expiry check, so concurrent consumes have exactly one winner; an expired
// record reports ErrTransactionExpired and a later consume reports
// ErrTransactionNotFound.
func (s *MemoryTransactionStore) Consume(_ context.Context, stateHash string) (*TransactionRecord, error) {
	if strings.TrimSpace(stateHash) == "" {
		return nil, ErrTransactionNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[stateHash]
	if !ok {
		return nil, ErrTransactionNotFound
	}
	delete(s.records, stateHash)
	if isExpired(s.now(), record.ExpiresAt) {
		return nil, ErrTransactionExpired
	}
	return recordCopy(record), nil
}

// AuthorizationCodeStoreOptions configures NewMemoryAuthorizationCodeStore.
type AuthorizationCodeStoreOptions struct {
	// Now is the clock every operation observes. Nil means time.Now().UTC.
	Now func() time.Time
	// TTL is applied to a record that arrives without an expiry. Zero means
	// DefaultAuthorizationCodeTTL.
	TTL time.Duration
}

// authorizationCodeEntry is one retained code record plus its consumed flag.
// The record is retained after consume so a replay stays distinguishable from
// an unknown code.
type authorizationCodeEntry struct {
	record   *AuthorizationCodeRecord
	consumed bool
}

// MemoryAuthorizationCodeStore is the in-memory reference
// AuthorizationCodeStore.
type MemoryAuthorizationCodeStore struct {
	mu      sync.Mutex
	now     func() time.Time
	ttl     time.Duration
	records map[string]*authorizationCodeEntry
}

// NewMemoryAuthorizationCodeStore returns an empty in-memory authorization-code
// store.
func NewMemoryAuthorizationCodeStore(opts AuthorizationCodeStoreOptions) *MemoryAuthorizationCodeStore {
	return &MemoryAuthorizationCodeStore{
		now:     storeClock(opts.Now),
		ttl:     storeTTL(opts.TTL, DefaultAuthorizationCodeTTL),
		records: make(map[string]*authorizationCodeEntry),
	}
}

// Put stores a copy of the code record, normalizing a zero ExpiresAt and a zero
// Version on the supplied record. A re-put of the same code replaces the entry
// and clears its consumed flag.
func (s *MemoryAuthorizationCodeStore) Put(_ context.Context, record *AuthorizationCodeRecord) error {
	if record == nil || strings.TrimSpace(record.CodeHash) == "" {
		return fmt.Errorf("%w: authorization code record needs a code hash", ErrRecordKeyRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if record.ExpiresAt.IsZero() {
		record.ExpiresAt = now.Add(s.ttl)
	}
	if record.Version < 1 {
		record.Version = 1
	}
	s.records[record.CodeHash] = &authorizationCodeEntry{record: recordCopy(record)}
	return nil
}

// Consume burns the code and returns a copy of the retained record. The first
// consume of a live code succeeds, a later consume returns the record with
// ErrAuthorizationCodeReplayed, an unknown code reports
// ErrAuthorizationCodeNotFound, and an expired code reports
// ErrAuthorizationCodeExpired.
func (s *MemoryAuthorizationCodeStore) Consume(_ context.Context, codeHash string) (*AuthorizationCodeRecord, error) {
	if strings.TrimSpace(codeHash) == "" {
		return nil, ErrAuthorizationCodeNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.records[codeHash]
	if !ok {
		return nil, ErrAuthorizationCodeNotFound
	}
	if entry.consumed {
		return recordCopy(entry.record), ErrAuthorizationCodeReplayed
	}
	entry.consumed = true
	if isExpired(s.now(), entry.record.ExpiresAt) {
		return nil, ErrAuthorizationCodeExpired
	}
	return recordCopy(entry.record), nil
}

// ClientStoreOptions configures NewMemoryClientStore. A client record has no
// TTL: the design's durability contract for clients is an application-owned
// age-out policy, so there is no TTL to default.
type ClientStoreOptions struct {
	// Now is the clock every operation observes. Nil means time.Now().UTC.
	Now func() time.Time
}

// MemoryClientStore is the in-memory reference ClientStore.
type MemoryClientStore struct {
	mu      sync.Mutex
	now     func() time.Time
	records map[string]*ClientRecord
}

// NewMemoryClientStore returns an empty in-memory client store.
func NewMemoryClientStore(opts ClientStoreOptions) *MemoryClientStore {
	return &MemoryClientStore{
		now:     storeClock(opts.Now),
		records: make(map[string]*ClientRecord),
	}
}

// Put stores a copy of the client record at version 1, normalizing a zero
// CreatedAt on the supplied record.
func (s *MemoryClientStore) Put(_ context.Context, record *ClientRecord) error {
	if record == nil || strings.TrimSpace(record.ClientIDHash) == "" {
		return fmt.Errorf("%w: client record needs a client id hash", ErrRecordKeyRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if record.CreatedAt.IsZero() {
		record.CreatedAt = s.now()
	}
	record.Version = 1
	s.records[record.ClientIDHash] = recordCopy(record)
	return nil
}

// Get returns a copy of the client record, or ErrClientNotFound.
func (s *MemoryClientStore) Get(_ context.Context, clientIDHash string) (*ClientRecord, error) {
	if strings.TrimSpace(clientIDHash) == "" {
		return nil, ErrClientNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[clientIDHash]
	if !ok {
		return nil, ErrClientNotFound
	}
	return recordCopy(record), nil
}

// Update applies a compare-and-swap against expectedVersion: the caller must
// present the version it read, and a successful update stores and returns the
// record at expectedVersion+1.
func (s *MemoryClientStore) Update(
	_ context.Context,
	record *ClientRecord,
	expectedVersion int,
) (*ClientRecord, error) {
	if record == nil || strings.TrimSpace(record.ClientIDHash) == "" {
		return nil, fmt.Errorf("%w: client record needs a client id hash", ErrRecordKeyRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.records[record.ClientIDHash]
	if !ok {
		return nil, ErrClientNotFound
	}
	if expectedVersion != current.Version {
		return nil, ErrClientVersionConflict
	}
	adopted := recordCopy(record)
	adopted.Version = expectedVersion + 1
	s.records[record.ClientIDHash] = adopted
	return recordCopy(adopted), nil
}

// RouteRefreshBrokerStoreOptions configures
// NewMemoryRouteRefreshBrokerStore.
type RouteRefreshBrokerStoreOptions struct {
	// Now is the clock every operation observes. Nil means time.Now().UTC.
	Now func() time.Time
	// TTL is the local lifetime policy for a stored handle: a record older than
	// TTL is treated as absent. Zero means DefaultRouteRefreshBrokerTTL. The
	// design states the broker TTL as min(upstream refresh lifetime,
	// route/session lifetime, local policy); the record's own policy fields
	// carry the other two bounds, and the design's broker field set has no
	// per-record expiry field.
	TTL time.Duration
	// LockTTL is how long an acquired refresh lock is held before another
	// acquirer may take it. Zero means DefaultRouteRefreshLockTTL.
	LockTTL time.Duration
}

// brokerEntry is one stored handle plus the instant it was first stored, which
// is what the local lifetime policy is measured against.
type brokerEntry struct {
	record   *RouteRefreshBrokerRecord
	storedAt time.Time
}

// MemoryRouteRefreshBrokerStore is the in-memory reference
// RouteRefreshBrokerStore.
type MemoryRouteRefreshBrokerStore struct {
	mu      sync.Mutex
	now     func() time.Time
	ttl     time.Duration
	lockTTL time.Duration
	records map[string]*brokerEntry
}

// NewMemoryRouteRefreshBrokerStore returns an empty in-memory broker store.
func NewMemoryRouteRefreshBrokerStore(opts RouteRefreshBrokerStoreOptions) *MemoryRouteRefreshBrokerStore {
	return &MemoryRouteRefreshBrokerStore{
		now:     storeClock(opts.Now),
		ttl:     storeTTL(opts.TTL, DefaultRouteRefreshBrokerTTL),
		lockTTL: storeTTL(opts.LockTTL, DefaultRouteRefreshLockTTL),
		records: make(map[string]*brokerEntry),
	}
}

// entryLocked returns the live entry for handleHash, or ErrBrokerNotFound when
// the handle is unknown or its local lifetime policy has elapsed. The caller
// holds the store mutex.
func (s *MemoryRouteRefreshBrokerStore) entryLocked(handleHash string) (*brokerEntry, error) {
	entry, ok := s.records[handleHash]
	if !ok {
		return nil, ErrBrokerNotFound
	}
	if isExpired(s.now(), entry.storedAt.Add(s.ttl)) {
		delete(s.records, handleHash)
		return nil, ErrBrokerNotFound
	}
	return entry, nil
}

// Put stores a copy of the broker record at version 1, normalizing a zero
// Version on the supplied record.
func (s *MemoryRouteRefreshBrokerStore) Put(_ context.Context, record *RouteRefreshBrokerRecord) error {
	if record == nil || strings.TrimSpace(record.HandleHash) == "" {
		return fmt.Errorf("%w: broker record needs a handle hash", ErrRecordKeyRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if record.Version < 1 {
		record.Version = 1
	}
	s.records[record.HandleHash] = &brokerEntry{record: recordCopy(record), storedAt: s.now()}
	return nil
}

// Get returns a copy of the broker record. A revoked record is returned as it
// stands: revocation is terminal state, not absence.
func (s *MemoryRouteRefreshBrokerStore) Get(_ context.Context, handleHash string) (*RouteRefreshBrokerRecord, error) {
	if strings.TrimSpace(handleHash) == "" {
		return nil, ErrBrokerNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, err := s.entryLocked(handleHash)
	if err != nil {
		return nil, err
	}
	return recordCopy(entry.record), nil
}

// AcquireLock takes the exclusive refresh lock and returns the updated record
// at version+1. A live lock is reported as ErrBrokerLocked before the version
// check, an elapsed lock may be re-acquired, and a revoked record reports
// ErrBrokerRevoked.
func (s *MemoryRouteRefreshBrokerStore) AcquireLock(
	_ context.Context,
	handleHash string,
	lockOwner string,
	expectedVersion int,
) (*RouteRefreshBrokerRecord, error) {
	if strings.TrimSpace(handleHash) == "" {
		return nil, ErrBrokerNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, err := s.entryLocked(handleHash)
	if err != nil {
		return nil, err
	}
	record := entry.record
	if record.Status == BrokerStatusRevoked {
		return nil, ErrBrokerRevoked
	}
	now := s.now()
	if record.RefreshLockOwner != "" && now.Before(record.RefreshLockExpiresAt) {
		return nil, ErrBrokerLocked
	}
	if expectedVersion != record.Version {
		return nil, ErrBrokerVersionConflict
	}
	record.RefreshLockOwner = lockOwner
	record.RefreshLockExpiresAt = now.Add(s.lockTTL)
	record.Status = BrokerStatusRefreshing
	record.Version++
	return recordCopy(record), nil
}

// CompareAndSwap replaces the broker record when expectedVersion matches the
// stored version, storing the replacement at version+1. A stale version reports
// ErrBrokerVersionConflict and a revoked record reports ErrBrokerRevoked, so a
// rotation can never resurrect a revoked handle.
func (s *MemoryRouteRefreshBrokerStore) CompareAndSwap(
	_ context.Context,
	record *RouteRefreshBrokerRecord,
	expectedVersion int,
) (*RouteRefreshBrokerRecord, error) {
	if record == nil || strings.TrimSpace(record.HandleHash) == "" {
		return nil, fmt.Errorf("%w: broker record needs a handle hash", ErrRecordKeyRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, err := s.entryLocked(record.HandleHash)
	if err != nil {
		return nil, err
	}
	current := entry.record
	if current.Status == BrokerStatusRevoked {
		return nil, ErrBrokerRevoked
	}
	if expectedVersion != current.Version {
		return nil, ErrBrokerVersionConflict
	}

	adopted := recordCopy(record)
	adopted.Version = current.Version + 1
	if adopted.Status == "" {
		adopted.Status = current.Status
	}
	// A rotation keeps the handle's original storedAt, so an upstream refresh
	// cannot extend the local lifetime policy.
	s.records[record.HandleHash] = &brokerEntry{record: adopted, storedAt: entry.storedAt}
	return recordCopy(adopted), nil
}

// Revoke marks the record revoked and returns it. Revocation is idempotent and
// terminal: a second revoke is a no-op that still succeeds, and a revoked
// record can be neither locked nor swapped.
func (s *MemoryRouteRefreshBrokerStore) Revoke(_ context.Context, handleHash string) (*RouteRefreshBrokerRecord, error) {
	if strings.TrimSpace(handleHash) == "" {
		return nil, ErrBrokerNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, err := s.entryLocked(handleHash)
	if err != nil {
		return nil, err
	}
	record := entry.record
	if record.Status != BrokerStatusRevoked {
		record.Status = BrokerStatusRevoked
		record.RefreshLockOwner = ""
		record.RefreshLockExpiresAt = time.Time{}
		record.Version++
	}
	return recordCopy(record), nil
}

// RateLimitStoreOptions configures NewMemoryRateLimitStore.
type RateLimitStoreOptions struct {
	// Now is the clock every operation observes. Nil means time.Now().UTC.
	Now func() time.Time
	// Window is applied to a check whose key carries no window. Zero means
	// DefaultRateLimitWindow.
	Window time.Duration
}

// rateLimitBucket is one windowed counter, keyed by
// (identifier, resource, operation).
type rateLimitBucket struct {
	windowStart time.Time
	count       int
}

// MemoryRateLimitStore is the in-memory reference RateLimitStore.
type MemoryRateLimitStore struct {
	mu      sync.Mutex
	now     func() time.Time
	window  time.Duration
	buckets map[string]*rateLimitBucket
}

// NewMemoryRateLimitStore returns an empty in-memory rate-limit store.
func NewMemoryRateLimitStore(opts RateLimitStoreOptions) *MemoryRateLimitStore {
	return &MemoryRateLimitStore{
		now:     storeClock(opts.Now),
		window:  storeTTL(opts.Window, DefaultRateLimitWindow),
		buckets: make(map[string]*rateLimitBucket),
	}
}

// CheckAndIncrement atomically counts one attempt against the key's window and
// reports whether it is within budget. A blank identifier fails closed with
// ErrRecordKeyRequired.
func (s *MemoryRateLimitStore) CheckAndIncrement(
	_ context.Context,
	key RateLimitBucketKey,
) (RateLimitResult, error) {
	identifier := strings.TrimSpace(key.Identifier)
	if identifier == "" {
		return RateLimitResult{}, fmt.Errorf("%w: rate limit identifier is required", ErrRecordKeyRequired)
	}
	window := storeTTL(key.Window, s.window)

	s.mu.Lock()
	defer s.mu.Unlock()
	bucketKey := identifier + "\x1f" + key.Resource + "\x1f" + key.Operation
	bucket, ok := s.buckets[bucketKey]
	if !ok {
		bucket = &rateLimitBucket{}
		s.buckets[bucketKey] = bucket
	}
	now := s.now()
	if bucket.windowStart.IsZero() || isExpired(now, bucket.windowStart.Add(window)) {
		bucket.windowStart = now
		bucket.count = 0
	}
	resetAt := bucket.windowStart.Add(window)
	if bucket.count >= key.Limit {
		return RateLimitResult{Limit: key.Limit, ResetAt: resetAt}, nil
	}
	bucket.count++
	return RateLimitResult{
		Allowed:   true,
		Limit:     key.Limit,
		Remaining: key.Limit - bucket.count,
		ResetAt:   resetAt,
	}, nil
}
