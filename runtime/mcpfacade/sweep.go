package mcpfacade

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// RefreshSweeper rotates the live head of one refresh family out of band, so a
// scheduled trigger (a worker function, a cron entry, a batch invocation) can
// keep credentials fresh without reimplementing the facade's rotation. It is the
// exported sweep entrypoint of the rotation-recovery contract's facade rule
// (theorycloud_refresh_rotation_recovery.v0.1 R7): the same store SPI, the same
// lock, the same rotation transaction, and the same encoded policy the request
// path uses.
//
// The caller decides which families are due. The sweeper does not guess: a
// scheduler that owns the access-token expiry knows it better than the broker
// record, which stores the upstream refresh material and the handle's lifetime,
// not the access token's.
//
// # Concurrency contract
//
// A sweep-driven rotation is an ordinary rotation competitor, never a second
// authority over the family:
//
//  1. Exclusive lock. The sweep takes the same per-record lock the request path
//     takes (AcquireLock with the version it read) before any upstream call. A
//     held lock, a lock the sweep cannot take, or a version that moved since the
//     head was read resolves to RefreshSweepDeferred: no upstream call, no state
//     change, no family effect. The caller retries on its next tick.
//  2. Exactly one winner. The rotation commits through the same RotateFamily
//     transaction, which re-checks the lock owner, the expected version, the
//     family and generation bindings, and successor uniqueness. A loser (the
//     request path rotated first, the lock expired, the family was revoked) gets
//     a typed transient result and never mints a successor: nothing is minted
//     unless every write landed.
//  3. The loser keeps working. A request-path presentation racing a committed
//     sweep rotation finds its handle grace-marked and is served the stored
//     successor body, or — past the grace window — has the family's new live head
//     rotated for it. A sweep racing a committed request-path rotation defers and
//     reads the new head on its next tick. Neither order is family-affecting.
//  4. The sweep never revokes. Continuity maintenance is not a revocation
//     trigger (contract R5). A contract-terminal upstream verdict observed by the
//     sweep releases the lock and returns RefreshSweepTerminalVerdict, leaving the
//     family intact: revocation and its receipt stay on the request path, where
//     the client-facing verdict is rendered and lineage is verified.
//  5. It is bounded. The upstream call carries the same encoded RefreshBudget as
//     the request path, which stays below the broker lock TTL, so a sweep can
//     never outlive the lock it holds.
type RefreshSweeper struct {
	front *frontChannelConfig
	now   func() time.Time
}

// RefreshSweepConfig configures a RefreshSweeper. The provider, the broker store,
// and the route refresh policy are exactly the ones the facade was registered
// with; the sweeper refuses an incomplete set rather than degrading.
type RefreshSweepConfig struct {
	// Provider makes the upstream refresh call. Required.
	Provider oauth.Provider
	// Stores supplies the broker store the rotation transacts through. It must
	// carry the transactional family capability. Required.
	Stores oauthstore.Stores
	// Policy is the encoded route refresh policy: the grace window, the upstream
	// refresh budget, and the handle lifetime. Required.
	Policy RouteRefreshPolicy
	// Events optionally receives the same schema-redacted route refresh telemetry
	// the request path emits. A sweep rotation reports lock_acquired, refreshed,
	// and state_failure; it never reports a reuse or revocation class.
	Events RouteRefreshEventHook
	// Now is the sweeper's clock for the stored deadlines it writes and for the
	// event instants. Nil means wall time.
	Now func() time.Time
}

// RefreshSweepOutcome is the closed result vocabulary of one SweepFamily call.
type RefreshSweepOutcome string

const (
	// RefreshSweepRotated means the sweep won the lock and committed a rotation.
	RefreshSweepRotated RefreshSweepOutcome = "rotated"
	// RefreshSweepDeferred means another writer held the family, the version moved,
	// the upstream failed transiently, or the store could not answer. Nothing was
	// minted and the family is unchanged; retry on the next tick.
	RefreshSweepDeferred RefreshSweepOutcome = "deferred"
	// RefreshSweepTerminalVerdict means the upstream answered with the one
	// contract-terminal class (invalid_grant). The sweep released the lock and left
	// the family intact: the next request-path presentation verifies lineage and
	// renders the verdict, so no sweep-driven revocation exists.
	RefreshSweepTerminalVerdict RefreshSweepOutcome = "terminal_verdict"
	// RefreshSweepRevokedFamily means the family is already revoked; there is
	// nothing to rotate and nothing to do.
	RefreshSweepRevokedFamily RefreshSweepOutcome = "revoked_family"
	// RefreshSweepNoLiveHead means the family has no member whose upstream material
	// is current (every member is revoked, rotated away, or below the family root).
	RefreshSweepNoLiveHead RefreshSweepOutcome = "no_live_head"
)

// RefreshSweepResult reports one SweepFamily call. It carries hashes and a
// generation only: never a handle, an access token, or upstream material.
type RefreshSweepResult struct {
	Outcome             RefreshSweepOutcome
	FamilyHash          string
	PresentedHandleHash string
	SuccessorHandleHash string
	ChainGeneration     int
	// DeferredReason is the additive cause of a deferred outcome, or empty.
	DeferredReason string
	// UpstreamClass is the provider class the sweep observed, when one applied.
	UpstreamClass string
}

// NewRefreshSweeper validates a sweep configuration and returns the sweeper.
func NewRefreshSweeper(config RefreshSweepConfig) (*RefreshSweeper, error) {
	if config.Provider == nil {
		return nil, fmt.Errorf("mcpfacade: refresh sweeper requires a provider")
	}
	if err := validateFrontChannelStores(config.Stores); err != nil {
		return nil, err
	}
	policy, err := config.Policy.normalized()
	if err != nil {
		return nil, err
	}
	now := config.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &RefreshSweeper{
		front: &frontChannelConfig{
			provider: config.Provider,
			stores:   config.Stores,
			policy:   policy,
			events:   config.Events,
		},
		now: now,
	}, nil
}

// SweepFamily rotates the live head of one refresh family. It never revokes and
// never returns an error for a transient race: a rotation it cannot win is a
// RefreshSweepDeferred result, which the documented concurrency contract treats
// as "retry on the next tick". A returned error is a programming or wiring fault
// (a missing family hash, an unreadable entropy source), never a family event.
func (s *RefreshSweeper) SweepFamily(ctx context.Context, familyHash string) (RefreshSweepResult, error) {
	familyHash = strings.TrimSpace(familyHash)
	result := RefreshSweepResult{FamilyHash: familyHash}
	if s == nil || s.front == nil {
		return result, fmt.Errorf("mcpfacade: refresh sweeper is not configured")
	}
	if familyHash == "" {
		return result, fmt.Errorf("mcpfacade: refresh sweep requires a family hash")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := s.now()

	records, err := s.front.listFamily(ctx, familyHash)
	if err != nil {
		result.Outcome = RefreshSweepDeferred
		result.DeferredReason = RouteRefreshReasonFamilyStateUnavailable
		return result, nil
	}
	head := liveFamilyHead(records)
	if head == nil {
		result.Outcome = RefreshSweepRevokedFamily
		if familyStillActive(records) {
			result.Outcome = RefreshSweepNoLiveHead
		}
		return result, nil
	}
	result.PresentedHandleHash = head.HandleHash
	result.ChainGeneration = head.ChainGeneration

	lockOwner, err := oauth.NewOpaqueToken()
	if err != nil {
		return result, err
	}
	locked, lockErr := s.front.stores.RouteRefreshBroker.AcquireLock(
		ctx, head.HandleHash, lockOwner, head.Version)
	if lockErr != nil {
		return s.deferredLock(result, lockErr), nil
	}
	s.emit(now, func(event *RouteRefreshEvent) {
		event.Class = RouteRefreshEventLockAcquired
		event.StatusTo = oauthstore.BrokerStatusRefreshing
	})

	intent, intentErr := s.front.takeRotationIntentAt(ctx, locked, now)
	if intentErr != nil {
		s.front.releaseRefreshLockAt(ctx, head, locked)
		s.emit(now, func(event *RouteRefreshEvent) {
			event.Class = RouteRefreshEventStateFailure
			event.Reason = RouteRefreshReasonRewriteFailure
		})
		result.Outcome = RefreshSweepDeferred
		result.DeferredReason = RouteRefreshReasonRewriteFailure
		return result, nil
	}

	locked = intent
	upstream, refreshErr := s.front.refreshUpstream(ctx, locked)
	if refreshErr != nil {
		class := oauth.ProviderTemporarilyUnavailable
		if providerErr, ok := oauth.AsProviderError(refreshErr); ok {
			class = providerErr.Class
		}
		s.front.releaseRefreshLockAt(ctx, head, locked)
		result.UpstreamClass = string(class)
		s.emit(now, func(event *RouteRefreshEvent) {
			event.Class = RouteRefreshEventStateFailure
			event.Reason = RouteRefreshReasonUpstreamRejected
			event.UpstreamClass = string(class)
		})
		if class == oauth.ProviderInvalidGrant {
			// Contract-terminal verdict: reported, never acted on here. The family
			// stays intact and the request path renders the verdict.
			result.Outcome = RefreshSweepTerminalVerdict
			return result, nil
		}
		result.Outcome = RefreshSweepDeferred
		result.DeferredReason = RouteRefreshReasonUpstreamRejected
		return result, nil
	}

	return s.commitRotation(ctx, result, head, locked, upstream, now)
}

// commitRotation mints the successor and commits it through the family
// transaction, reporting a lost commit race as a deferred tick. Nothing is
// minted unless every write landed.
func (s *RefreshSweeper) commitRotation(
	ctx context.Context,
	result RefreshSweepResult,
	head *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
	upstream *oauth.TokenSet,
	now time.Time,
) (RefreshSweepResult, error) {
	handle, err := oauth.NewOpaqueToken()
	if err != nil {
		s.front.releaseRefreshLockAt(ctx, head, locked)
		return result, err
	}
	successor := successorBrokerRecord(head, handle, upstream)
	body, err := successorTokenBody(upstream, handle)
	if err != nil {
		s.front.releaseRefreshLockAt(ctx, head, locked)
		return result, err
	}
	familyStore, ok := s.front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		s.front.releaseRefreshLockAt(ctx, head, locked)
		return result, errRouteRefreshBrokerFamilyCapabilityMissing
	}
	if _, err := familyStore.RotateFamily(ctx, oauthstore.RouteRefreshFamilyRotation{
		PresentedHandleHash:       locked.HandleHash,
		LockOwner:                 locked.RefreshLockOwner,
		ExpectedVersion:           locked.Version,
		Successor:                 successor,
		GraceRefreshResponse:      string(body),
		GraceExpiresAt:            now.Add(s.front.policy.GraceWindow),
		GraceAccessTokenExpiresAt: now.Add(accessTokenLifetime(upstream)),
	}); err != nil {
		return s.deferredRotation(ctx, result, head, locked, err), nil
	}
	result.Outcome = RefreshSweepRotated
	result.SuccessorHandleHash = successor.HandleHash
	result.ChainGeneration = successor.ChainGeneration
	s.emit(now, func(event *RouteRefreshEvent) {
		event.Class = RouteRefreshEventRefreshed
		event.StatusFrom = oauthstore.BrokerStatusRefreshing
		event.StatusTo = oauthstore.BrokerStatusActive
		event.SuccessorHandleHash = successor.HandleHash
		event.FamilyHash = successor.FamilyHash
		event.ChainGeneration = successor.ChainGeneration
		event.PreviousUpstreamRefreshTokenHash = head.UpstreamRefreshTokenHash
		event.UpstreamRefreshTokenHash = successor.UpstreamRefreshTokenHash
	})
	return result, nil
}

// deferredLock classifies a lost lock race. Every one of them is transient for
// the sweep: the family is untouched and the next tick retries.
func (s *RefreshSweeper) deferredLock(
	result RefreshSweepResult,
	err error,
) RefreshSweepResult {
	result.Outcome = RefreshSweepDeferred
	switch {
	case errors.Is(err, oauthstore.ErrBrokerLocked):
		result.DeferredReason = RouteRefreshReasonLockContention
	case errors.Is(err, oauthstore.ErrBrokerVersionConflict):
		result.DeferredReason = RouteRefreshReasonLockContention
	case errors.Is(err, oauthstore.ErrBrokerRevoked):
		result.Outcome = RefreshSweepRevokedFamily
	case errors.Is(err, oauthstore.ErrBrokerNotFound), errors.Is(err, oauthstore.ErrBrokerExpired):
		result.Outcome = RefreshSweepNoLiveHead
	case errors.Is(err, oauthstore.ErrBrokerFamilyStateUnavailable),
		errors.Is(err, oauthstore.ErrBrokerFamilyMismatch),
		errors.Is(err, oauthstore.ErrBrokerLegacyLineageUnsupported):
		result.DeferredReason = RouteRefreshReasonFamilyStateUnavailable
	default:
		result.DeferredReason = RouteRefreshReasonStoreFailure
	}
	s.emit(s.now(), func(event *RouteRefreshEvent) {
		event.Class = RouteRefreshEventStateFailure
		event.Reason = result.DeferredReason
	})
	return result
}

// deferredRotation classifies a lost commit race. A rotation that lost the
// transaction minted nothing, so the successor it computed is discarded and the
// next tick retries from the family's real head.
func (s *RefreshSweeper) deferredRotation(
	ctx context.Context,
	result RefreshSweepResult,
	head *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
	err error,
) RefreshSweepResult {
	s.front.releaseRefreshLockAt(ctx, head, locked)
	result.Outcome = RefreshSweepDeferred
	switch {
	case errors.Is(err, oauthstore.ErrBrokerLocked),
		errors.Is(err, oauthstore.ErrBrokerVersionConflict),
		errors.Is(err, oauthstore.ErrBrokerSuccessorExists):
		result.DeferredReason = RouteRefreshReasonLockContention
	case errors.Is(err, oauthstore.ErrBrokerRevoked):
		result.Outcome = RefreshSweepRevokedFamily
	case errors.Is(err, oauthstore.ErrBrokerFamilyStateUnavailable),
		errors.Is(err, oauthstore.ErrBrokerFamilyMismatch),
		errors.Is(err, oauthstore.ErrBrokerLegacyLineageUnsupported):
		result.DeferredReason = RouteRefreshReasonFamilyStateUnavailable
	default:
		result.DeferredReason = RouteRefreshReasonRewriteFailure
	}
	s.emit(s.now(), func(event *RouteRefreshEvent) {
		event.Class = RouteRefreshEventStateFailure
		event.Reason = result.DeferredReason
	})
	return result
}

// emit delivers one event attributed to the record the sweep acted on.
func (s *RefreshSweeper) emit(now time.Time, mutate func(*RouteRefreshEvent)) {
	if s.front.events == nil {
		return
	}
	event := RouteRefreshEvent{At: now}
	mutate(&event)
	s.front.emitRouteRefresh(context.Background(), event)
}

// familyStillActive reports whether any enumerated member is not revoked, so a
// family with no live head is distinguished from a tombstoned family.
func familyStillActive(records []*oauthstore.RouteRefreshBrokerRecord) bool {
	for _, record := range records {
		if record != nil && record.Status != oauthstore.BrokerStatusRevoked {
			return true
		}
	}
	return false
}
