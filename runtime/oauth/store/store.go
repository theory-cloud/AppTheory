// Package store defines the five pluggable store SPIs of the MCP auth facade
// (DESIGN §7, contract fixture facade-store-spi.v1.json) and the framework's
// in-memory reference implementations.
//
// Every store is keyed by the hash of the value it protects, never the value
// itself. An Encrypted* record field carries upstream material exactly as the
// provider handed it to the facade: the framework performs no sealing and adds
// no encryption surface or key management, so a durable store implementation
// MUST encrypt those fields at rest (for example with a persistence-layer
// encryption tag). An upstream refresh token belongs to the broker record's
// encrypted field, and a code record carries the upstream token response only
// in its encrypted field.
//
// The in-memory reference implementations in this package are NON-DURABLE and
// do not encrypt: they exist for deterministic tests and local development
// only, and a deployment replaces them with application-owned durable stores.
//
// Consume-once and compare-and-swap are required operations of these SPIs, not
// conventions: replay handling and single-flight refresh depend on them. The
// in-memory implementations here are for deterministic tests and local
// development; production implementations are application-owned.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

// TransactionStore stores the pre-login transaction of one authorization
// request, keyed by hash(upstream state).
//
// Put normalizes a zero ExpiresAt with the configured transaction TTL and a
// Version below 1 with 1, then stores a copy. Consume is single-use and atomic:
// the record is burned before the expiry check, so concurrent consumes have
// exactly one winner and every later consume reports ErrTransactionNotFound.
type TransactionStore interface {
	Put(ctx context.Context, record *TransactionRecord) error
	Consume(ctx context.Context, stateHash string) (*TransactionRecord, error)
}

// AuthorizationCodeStore stores the facade's authorization codes, keyed by
// hash(facade code).
//
// Consume is single-use and atomic, and it retains the record: a first consume
// reports success, a later consume of the same code returns the retained record
// together with ErrAuthorizationCodeReplayed, and an unknown code reports
// ErrAuthorizationCodeNotFound. A retained replay is therefore distinguishable
// from an unknown code, which is what lets the facade answer a replay with
// invalid_grant and revoke the broker record the code minted.
type AuthorizationCodeStore interface {
	Put(ctx context.Context, record *AuthorizationCodeRecord) error
	Consume(ctx context.Context, codeHash string) (*AuthorizationCodeRecord, error)
}

// ClientStore stores dynamically registered facade clients, keyed by
// hash(client id). Its durability contract is age-out policy, not TTL.
//
// Put normalizes a zero CreatedAt and a Version below 1 with 1 and stores the
// record at version 1. Update is compare-and-swap on the expected version: the
// caller must present the version it read, a stale version reports
// ErrClientVersionConflict, and a successful update stores and returns the
// record at expectedVersion+1.
type ClientStore interface {
	Put(ctx context.Context, record *ClientRecord) error
	Get(ctx context.Context, clientIDHash string) (*ClientRecord, error)
	Update(ctx context.Context, record *ClientRecord, expectedVersion int) (*ClientRecord, error)
}

// RouteRefreshBrokerStore stores the durable upstream refresh material bound to
// one route handle, keyed by hash(route refresh handle).
//
// Get returns a revoked record as it stands (Status == "revoked"): a revoked
// handle is terminal and idempotent, not a not-found. A record whose local
// lifetime policy elapsed reports ErrBrokerExpired, which is distinct from
// ErrBrokerNotFound at the SPI so the facade can attribute the failure; the
// client-facing body stays the uniform invalid_grant either way. AcquireLock is
// exclusive and expires: a live lock reports ErrBrokerLocked before the version
// check, a lock whose RefreshLockExpiresAt has elapsed may be re-acquired, and a
// revoked record reports ErrBrokerRevoked. CompareAndSwap is versioned and
// reports ErrBrokerVersionConflict on a stale version and ErrBrokerRevoked on a
// revoked record. Revoke is idempotent and terminal. The expected version must
// be the version the caller read, so a negative value is never a
// skip-version-check wildcard: it reports ErrBrokerVersionConflict like any
// other mismatch. Every broker operation reports ErrBrokerExpired for a handle
// whose local lifetime policy elapsed.
type RouteRefreshBrokerStore interface {
	Get(ctx context.Context, handleHash string) (*RouteRefreshBrokerRecord, error)
	AcquireLock(
		ctx context.Context,
		handleHash string,
		lockOwner string,
		expectedVersion int,
	) (*RouteRefreshBrokerRecord, error)
	CompareAndSwap(
		ctx context.Context,
		record *RouteRefreshBrokerRecord,
		expectedVersion int,
	) (*RouteRefreshBrokerRecord, error)
	Revoke(ctx context.Context, handleHash string) (*RouteRefreshBrokerRecord, error)
}

// RateLimitStore is one atomic windowed counter bucket per
// (identifier, resource, operation).
type RateLimitStore interface {
	CheckAndIncrement(ctx context.Context, key RateLimitBucketKey) (RateLimitResult, error)
}

// RouteRefreshBrokerSeeder is the optional capability the conformance runner
// needs to place the broker record a fixture row starts from: the design's
// broker operations are Get, AcquireLock, CompareAndSwap, and Revoke, and the
// record itself is created by the facade's own write path. A durable store
// implements this with whatever create path it already has.
type RouteRefreshBrokerSeeder interface {
	Put(ctx context.Context, record *RouteRefreshBrokerRecord) error
}

// RouteRefreshBrokerFamilyStore is the enumeration/revocation half of the
// family capability of a broker store. A refresh family is the chain of handles
// one authorization grant produced; FamilyHash names it on every record.
// ListFamily answers which live handles belong to a family and what state each
// is in, so an incident responder can enumerate a family without walking
// successor links. RevokeFamily revokes every live record of a family in one
// operation and returns the records it revoked.
//
// This pair alone is not enough for the framework-owned front channel: a
// conforming store must implement RouteRefreshBrokerTransactionalFamilyStore,
// which adds atomic root creation and atomic rotation. The pair remains
// exported because it is the incident surface and because a durable store may
// keep the old pair while it migrates.
type RouteRefreshBrokerFamilyStore interface {
	ListFamily(ctx context.Context, familyHash string) ([]*RouteRefreshBrokerRecord, error)
	RevokeFamily(ctx context.Context, familyHash string) ([]*RouteRefreshBrokerRecord, error)
}

// RouteRefreshBrokerHandleTTLReporter is the optional capability a broker store
// reports its local handle lifetime policy through. The facade compares it with
// the configured policy at registration, so a deployment cannot declare a
// long-lived ceiling while its store silently keeps a shorter one.
type RouteRefreshBrokerHandleTTLReporter interface {
	RouteRefreshBrokerHandleTTL() time.Duration
}

// RouteRefreshFamilyStatus values of the transactional family state.
const (
	// BrokerFamilyStatusActive is a family whose handles may rotate.
	BrokerFamilyStatusActive = "active"
	// BrokerFamilyStatusRevoked is the terminal family tombstone. Every Get,
	// AcquireLock, and RotateFamily for a family-marked handle honors it, and no
	// root creation or rotation can undo it.
	BrokerFamilyStatusRevoked = "revoked"
)

// RouteRefreshFamilyState is the store-internal family-state record a
// transactional broker store keeps alongside the handles of one refresh
// family. It is the authoritative revocation tombstone: a family is more than
// the records enumerated at one instant, so a durable store retains the state
// at least as long as any member can be addressed, including members minted
// before the tombstone.
type RouteRefreshFamilyState struct {
	FamilyHash string
	Status     string
	Version    int
	CreatedAt  time.Time
	RevokedAt  time.Time
}

// RouteRefreshFamilyRotation is one atomic rotation request: the presented
// handle is still locked by LockOwner at ExpectedVersion, its family is active,
// and Successor does not exist. The store creates Successor, checks the family
// and generation bindings, updates the presented record with the grace response
// and deadline, clears the lock, and returns the stored successor — all in one
// serialized transaction. There is no separate successor Put followed by a
// predecessor compare-and-swap.
type RouteRefreshFamilyRotation struct {
	PresentedHandleHash  string
	LockOwner            string
	ExpectedVersion      int
	Successor            *RouteRefreshBrokerRecord
	GraceRefreshResponse string
	GraceExpiresAt       time.Time
}

// RouteRefreshBrokerTransactionalFamilyStore is the mandatory family
// capability of a broker store used by the framework-owned front channel. It
// extends the enumeration/revocation pair with atomic root creation and atomic
// rotation, and every operation honors the family tombstone.
//
// CreateFamily atomically creates an active family-state record and its
// generation-1 root broker record; a pre-existing family ID (active or revoked)
// is never overwritten or reactivated, and the root handle is not returned if
// either write fails. RotateFamily checks, in one serialized transaction, that
// the presented record is still locked by the caller at the expected version,
// its family is active, the family/generation bindings match, and the successor
// does not exist, before it creates the successor and updates the predecessor.
// RevokeFamily atomically writes a terminal tombstone and returns every live
// member it handled; it is idempotent, and Get, AcquireLock, and RotateFamily
// honor it for every family-marked handle. ListFamily remains the incident and
// conformance enumeration surface and lists live members even when the family
// state is missing, so a partially backfilled lineage can be inspected.
//
// Registration requires this capability whenever the front channel is
// configured: a store that only implements the optional
// RouteRefreshBrokerFamilyStore, or that is missing any method, fails before
// routes are mounted and before a root or successor can be minted.
type RouteRefreshBrokerTransactionalFamilyStore interface {
	RouteRefreshBrokerFamilyStore

	CreateFamily(ctx context.Context, root *RouteRefreshBrokerRecord) (*RouteRefreshBrokerRecord, error)
	RotateFamily(ctx context.Context, rotation RouteRefreshFamilyRotation) (*RouteRefreshBrokerRecord, error)
}

// HashKey returns the store key for a protected value: the unpadded base64url
// SHA-256 digest of the value. Every store SPI is keyed by the hash of the
// value it protects and never by the value itself, so a caller that seeds a
// record directly — a pre-registered client, for example — derives the key with
// this helper and the facade derives the same key when it looks the record up.
func HashKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Stores bundles the five store SPIs, so one value can drive the conformance
// runner over every store of a deployment.
type Stores struct {
	Transaction        TransactionStore
	AuthorizationCode  AuthorizationCodeStore
	Client             ClientStore
	RouteRefreshBroker RouteRefreshBrokerStore
	RateLimit          RateLimitStore
}

// TransactionRecord is one pre-login transaction. Fields follow the
// facade-store-spi.v1.json transaction field set.
type TransactionRecord struct {
	StateHash                     string
	ClientIDHash                  string
	ClientID                      string
	RedirectURI                   string
	CodeChallenge                 string
	CodeChallengeMethod           string
	ClientState                   string
	EncryptedUpstreamCodeVerifier string
	Scopes                        []string
	CanonicalResource             string
	EndpointKind                  string
	ClientNamespace               string
	PartnerID                     string
	AgentID                       string
	Status                        string
	ExpiresAt                     time.Time
	Version                       int
}

// AuthorizationCodeRecord is one facade authorization code. Fields follow the
// facade-store-spi.v1.json authorization-code field set. The Encrypted* fields
// carry upstream material as the provider handed it to the facade —
// EncryptedTokenResponse embeds the upstream-minted access token so the
// exchange can return it byte-for-byte unmodified — and the store MUST encrypt
// them at rest; the record holds no plaintext upstream material once stored.
type AuthorizationCodeRecord struct {
	CodeHash                    string
	ClientIDHash                string
	ClientID                    string
	RedirectURI                 string
	CodeChallenge               string
	CodeChallengeMethod         string
	Scopes                      []string
	CanonicalResource           string
	EndpointKind                string
	ClientNamespace             string
	PartnerID                   string
	AgentID                     string
	RouteRefreshHandleHash      string
	EncryptedRouteRefreshHandle string
	EncryptedTokenResponse      string
	Status                      string
	ExpiresAt                   time.Time
	Version                     int
}

// ClientRecord is one dynamically registered facade client. Fields follow the
// facade-store-spi.v1.json client field set.
type ClientRecord struct {
	ClientIDHash            string
	ClientID                string
	RedirectURIs            []string
	TokenEndpointAuthMethod string
	GrantTypes              []string
	ResponseTypes           []string
	BoundRoute              string
	CreatedAt               time.Time
	Version                 int
}

// RouteRefreshBrokerRecord is the durable state bound to one route refresh
// handle. Fields follow the facade-store-spi.v1.json route-refresh-broker field
// set: a handle is never rebound to a new issuer or client registration.
//
// ChainGeneration and FamilyHash identify the refresh family the handle belongs
// to. A handle minted under the current policy is the root of its own family:
// ChainGeneration is 1 and FamilyHash is the hash of its own handle. Every
// successor records the presented handle's generation plus one and inherits its
// FamilyHash, so the depth of a rotated-away handle relative to the head is
// arithmetic rather than guesswork. A record that predates the policy carries
// ChainGeneration 0 and an empty FamilyHash; it is unsupported for ordinary
// rotation and must be migrated or reauthorized, never normalized online.
//
// DepthOneServedAt is retained for stored-record compatibility. It marked the
// removed beyond-grace access-token-only serve and is no longer written.
type RouteRefreshBrokerRecord struct {
	HandleHash                    string
	Issuer                        string
	Stage                         string
	CanonicalResource             string
	ClientNamespace               string
	EndpointKind                  string
	PartnerID                     string
	AgentID                       string
	ClientIDHash                  string
	SubjectIDHash                 string
	Scopes                        []string
	ScopeFingerprint              string
	EncryptedUpstreamRefreshToken string
	UpstreamRefreshTokenHash      string
	UpstreamClientID              string
	EncryptedGraceRefreshResponse string
	GraceExpiresAt                time.Time
	Status                        string
	RefreshLockOwner              string
	RefreshLockExpiresAt          time.Time
	ChainGeneration               int
	FamilyHash                    string
	DepthOneServedAt              time.Time
	Version                       int
}

// Route refresh broker status values of the facade-store-spi.v1.json status
// vocabulary.
const (
	BrokerStatusIssued         = "issued"
	BrokerStatusActive         = "active"
	BrokerStatusRefreshing     = "refreshing"
	BrokerStatusRevoked        = "revoked"
	BrokerStatusExpired        = "expired"
	BrokerStatusReauthRequired = "reauth_required"
)

// Rate limit outcomes, as they appear in the conformance vocabulary.
const (
	RateLimitAllowed = "allowed"
	RateLimitLimited = "limited"
)

// Store errors. Every failure a store can report is a distinguishable sentinel,
// so a caller never has to read an error string to tell a replay from an
// unknown key or a stale version from a missing record.
var (
	// ErrRecordKeyRequired reports a blank key or an unusable record.
	ErrRecordKeyRequired = errors.New("store: record key is required")

	// ErrTransactionNotFound reports an unknown or already consumed transaction.
	ErrTransactionNotFound = errors.New("store: transaction not found")
	// ErrTransactionExpired reports a transaction whose TTL elapsed.
	ErrTransactionExpired = errors.New("store: transaction expired")

	// ErrAuthorizationCodeNotFound reports an unknown authorization code.
	ErrAuthorizationCodeNotFound = errors.New("store: authorization code not found")
	// ErrAuthorizationCodeReplayed reports an authorization code that was already
	// consumed; the retained record is returned with it.
	ErrAuthorizationCodeReplayed = errors.New("store: authorization code replayed")
	// ErrAuthorizationCodeExpired reports a code whose TTL elapsed.
	ErrAuthorizationCodeExpired = errors.New("store: authorization code expired")

	// ErrClientNotFound reports an unknown client.
	ErrClientNotFound = errors.New("store: client not found")
	// ErrClientVersionConflict reports a client update whose version is stale.
	ErrClientVersionConflict = errors.New("store: client version conflict")

	// ErrBrokerNotFound reports an unknown route refresh handle.
	ErrBrokerNotFound = errors.New("store: route refresh broker record not found")
	// ErrBrokerExpired reports a route refresh handle whose local lifetime policy
	// elapsed. It is deliberately distinguishable from ErrBrokerNotFound at the
	// SPI so the facade can attribute the failure (expiry versus absence) while
	// the client-facing body stays the uniform invalid_grant.
	ErrBrokerExpired = errors.New("store: route refresh broker record expired")
	// ErrBrokerLocked reports a broker record that already holds an unexpired
	// refresh lock.
	ErrBrokerLocked = errors.New("store: route refresh broker record is locked")
	// ErrBrokerVersionConflict reports a broker compare-and-swap whose version is
	// stale.
	ErrBrokerVersionConflict = errors.New("store: route refresh broker version conflict")
	// ErrBrokerRevoked reports a revoked broker record, which can be neither
	// locked nor updated.
	ErrBrokerRevoked = errors.New("store: route refresh broker record is revoked")
	// ErrBrokerNotSeedable reports a broker store that cannot place the record a
	// conformance row starts from, because it does not implement
	// RouteRefreshBrokerSeeder.
	ErrBrokerNotSeedable = errors.New("store: route refresh broker store cannot be seeded")
	// ErrBrokerFamilyCapabilityMissing reports a broker store that does not
	// implement RouteRefreshBrokerTransactionalFamilyStore, so a conformance row
	// or the front channel cannot rely on atomic root creation and rotation.
	ErrBrokerFamilyCapabilityMissing = errors.New("store: route refresh broker store lacks the transactional family capability")
	// ErrBrokerFamilyExists reports CreateFamily for a family ID that already
	// exists, active or revoked. The family is never overwritten or reactivated.
	ErrBrokerFamilyExists = errors.New("store: route refresh family already exists")
	// ErrBrokerFamilyStateUnavailable reports a family-marked record whose
	// required family state is missing or corrupt. The record is unsupported for
	// ordinary rotation and is never normalized or served.
	ErrBrokerFamilyStateUnavailable = errors.New("store: route refresh family state is missing or corrupt")
	// ErrBrokerFamilyMismatch reports a root, successor, or presented record that
	// does not carry the family identity and generation bindings the family state
	// requires.
	ErrBrokerFamilyMismatch = errors.New("store: route refresh family or generation binding mismatch")
	// ErrBrokerSuccessorExists reports a rotation whose successor handle is already
	// stored. A rotation never overwrites a handle.
	ErrBrokerSuccessorExists = errors.New("store: route refresh successor already exists")
	// ErrBrokerLegacyLineageUnsupported reports a family-less (pre-policy) record
	// presented for ordinary rotation. Such a lineage is migration or
	// reauthorization, never online normalization.
	ErrBrokerLegacyLineageUnsupported = errors.New("store: route refresh legacy lineage is unsupported for ordinary rotation")
)

// RateLimitBucketKey identifies one windowed bucket and carries its per-window
// budget, so one store serves buckets with different budgets.
type RateLimitBucketKey struct {
	Identifier string
	Resource   string
	Operation  string
	Limit      int
	Window     time.Duration
}

// RateLimitResult is the outcome of one rate-limit check.
type RateLimitResult struct {
	Allowed   bool
	Limit     int
	Remaining int
	ResetAt   time.Time
}

// ManualClock is a deterministic, concurrency-safe clock for tests. Every store
// takes a Now func, so one ManualClock can drive a whole set of stores.
type ManualClock struct {
	mu  sync.Mutex
	now time.Time
}

// NewManualClock returns a clock frozen at start. A zero start is the Unix
// epoch.
func NewManualClock(start time.Time) *ManualClock {
	if start.IsZero() {
		start = time.Unix(0, 0).UTC()
	}
	return &ManualClock{now: start}
}

// Now returns the frozen instant.
func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Set freezes the clock at at.
func (c *ManualClock) Set(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = at
}

// Advance moves the clock forward by d.
func (c *ManualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}
