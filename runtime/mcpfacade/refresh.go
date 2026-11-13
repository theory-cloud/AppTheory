package mcpfacade

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// Brokered refresh framework defaults (DESIGN §8.4 mechanic 4, THREAT_MODEL T6,
// operator ruling R3). These are framework constants: deliberately not
// environment variables, so Go, TypeScript, and Python can only agree on one
// number set. Each value is pinned by a test. The handle lifetime, grace
// window, and reuse rate ceiling are the configured RouteRefreshPolicy, not
// constants: see refresh_policy.go.
const (
	// frontChannelMaxRefreshHandleBytes bounds the presented route handle in
	// bytes, checked before any other work. The framework mints a handle as 32
	// random bytes (43 base64url characters), so 512 is far above every
	// legitimate handle while still bounding an unauthenticated caller's payload.
	frontChannelMaxRefreshHandleBytes = 512

	// refreshCoalesceWaitCap bounds how long a caller that lost the refresh lock
	// race waits for the winner's rotation before being told to retry. It is the
	// operational backpressure bound of ruling R2 and is deliberately shorter
	// than the broker's lock TTL (oauthstore.DefaultRouteRefreshLockTTL, 15 s), so
	// a waiter can never outlive the lock it is waiting on and steal it.
	refreshCoalesceWaitCap = 3 * time.Second

	// refreshCoalescePollInterval is how often a waiter re-reads the broker
	// record while the lock is held, and how long a version-conflict retry waits
	// before re-reading. It is the granularity of the wait, not a security
	// decision, and it only has to be small enough that a completed rotation is
	// observed well inside the wait cap; crucially it also separates every retry
	// of the loop, so a store that keeps returning a stale version cannot turn
	// the bounded wait into a tight spin.
	refreshCoalescePollInterval = 50 * time.Millisecond

	// refreshRetryAfterSeconds is the fixed Retry-After the refresh 503 class
	// carries. Unlike the registration endpoint there is no rate-limit window to
	// derive a delay from: the caller was refused either because another caller
	// holds the in-flight lock or because a store could not answer, and both are
	// worth exactly one second of backoff.
	refreshRetryAfterSeconds = 1

	// refreshCredentialFloor is the shortest remaining access-token lifetime a
	// replayed grace body may report. A stored body whose access token has less
	// than this left is never replayed: the facade rotates a fresh one instead.
	// It exists because the defect this policy replaces handed a client an
	// access token 300 ms before the resource refused it, and a credential the
	// facade issues must be accepted for at least the lifetime it reports.
	refreshCredentialFloor = 5 * time.Second
)

// errRouteRefreshBrokerFamilyCapabilityMissing is the fail-closed class a broker
// store that lacks the transactional family capability raises. Registration
// refuses such a store before mounting, and the runtime paths repeat the check
// defensively so a store can never rotate or open a grant without atomic family
// state.
var errRouteRefreshBrokerFamilyCapabilityMissing = errors.New("mcpfacade: route refresh broker store lacks the transactional family capability")

// handleRefreshTokenGrant serves the brokered refresh half of the token endpoint
// (DESIGN §8.4 mechanic 4, journey step 9). The client presents the
// framework-minted opaque route handle the code exchange returned as
// refresh_token; the broker record that handle is keyed by is the only place
// upstream refresh material lives, and neither that material nor an upstream
// id_token can reach the client.
//
// Validation order is ruling R1: cheap local checks first, and neither the lock
// nor the upstream call happens until the request is known valid. Concurrency is
// ruling R2: exactly one upstream refresh call per rotation however many callers
// present the same handle, and a bounded wait for a caller that loses the lock
// race.
//
// Reuse is served, never punished. A rotated-away handle inside its configured
// grace window replays the stored successor body (the lost-response path). A
// rotated-away handle beyond the window is ordinary client behavior — a restart
// holding a stale stored copy, a second process on one login, a lost response
// whose client gave up — so the facade rotates the family's live head and hands
// back fresh credentials. The stale presentation is never the trigger for a
// family revocation: the evidence shows the same sequence on every real client
// that broke, and nothing distinguishes it from a stolen handle. Ruling R4 binds
// the request's scope and resource, and a handle is additionally bound to the
// route it was minted for (DESIGN §7: the broker record binds resource, so a
// handle is a route handle).
//
//nolint:gocognit,gocyclo // the validation order and the serve paths are the security contract.
func (config normalizedConfig) handleRefreshTokenGrant(
	ctx *apptheory.Context,
	kind mcproutes.EndpointKind,
	form url.Values,
) (*apptheory.Response, error) {
	front := config.frontChannel
	handle, clientID, routeResource, response, err := config.refreshRequestTarget(ctx, kind, form)
	if err != nil || response != nil {
		return response, err
	}
	// R2: the coalesce wait budget is measured with REAL elapsed time
	// (time.Since(start)), never the framework clock, because the wait has to
	// terminate even when the framework clock is frozen or moved by a caller: it
	// is an operational backpressure bound, not a security decision. Grace,
	// record lifetime, and rotation timestamps all use the injected framework
	// clock (ctx.Now()), which is what makes them deterministic and testable.
	start := time.Now()
	for {
		presented, response := config.frontChannel.resolveRefreshRecord(ctx, form, clientID, handle, routeResource)
		if response != nil {
			return response, nil
		}
		// A record minted before the family policy carries no family identity. It
		// is migrated in code rather than refused: the client that holds it has a
		// live upstream grant, and demanding a manual re-login would be a break,
		// not a migration.
		if presented.FamilyHash == "" {
			effective, served, err := config.adoptLegacyLineage(ctx, presented)
			if err != nil || served != nil {
				return served, err
			}
			if effective == nil {
				if time.Since(start) >= refreshCoalesceWaitCap {
					return facadeTemporarilyUnavailablePage(), nil
				}
				time.Sleep(refreshCoalescePollInterval)
				continue
			}
			presented = effective
		}
		// A presented record that carries a grace deadline was rotated away. The
		// live grace replay was already served inside resolveRefreshRecord, so
		// this is a stale predecessor: rotate the family's head, not the
		// predecessor, so the upstream is never presented material that has
		// already been rotated (an upstream that detects reuse would otherwise
		// revoke the grant on ordinary client behavior).
		target := presented
		stale := !presented.GraceExpiresAt.IsZero()
		lineageVerified := false
		// R2 post-timeout lineage-verify. A record that carries an unconfirmed
		// rotation attempt may already have had its upstream material consumed by
		// the attempt whose response never arrived. Before presenting anything,
		// verify the family's lineage: if the live head has moved on, the successor
		// already exists and the stale material is never presented again — the head
		// is rotated for the client instead. The presentation is not treated as
		// current state, and the family is never affected.
		if !stale && !presented.RotationUnconfirmedAt.IsZero() {
			head, headResponse := config.refreshFamilyHead(ctx, presented)
			if headResponse != nil {
				return headResponse, nil
			}
			if head.HandleHash != presented.HandleHash {
				target = head
				stale = true
				lineageVerified = true
			}
		}
		if stale && !lineageVerified {
			target, response = config.refreshFamilyHead(ctx, presented)
			if response != nil {
				return response, nil
			}
		}
		lockOwner, lockOwnerErr := oauth.NewOpaqueToken()
		if lockOwnerErr != nil {
			return nil, lockOwnerErr
		}
		locked, lockErr := config.frontChannel.stores.RouteRefreshBroker.AcquireLock(
			ctx.Context(), target.HandleHash, lockOwner, target.Version)
		if lockErr == nil {
			front.emitLockAcquired(ctx, target)
			if stale {
				return config.rotateStalePredecessor(ctx, presented, target, locked, lineageVerified)
			}
			return config.rotateRefreshGrant(ctx, target, locked)
		}
		response, wait := refreshLockFailure(lockErr, time.Since(start))
		if response != nil {
			return response, nil
		}
		if wait {
			time.Sleep(refreshCoalescePollInterval)
		}
	}
}

// refreshRequestTarget applies the pre-lock validation of ruling R1 steps 1, 2,
// and 5 to one refresh request and resolves the values the loop needs: the
// bounded handle, the registered client, and the served route's bound resource.
// A non-nil response ends the request before any record read.
func (config normalizedConfig) refreshRequestTarget(
	ctx *apptheory.Context,
	kind mcproutes.EndpointKind,
	form url.Values,
) (string, string, string, *apptheory.Response, error) {
	front := config.frontChannel
	// R1.1: bound the handle before anything else is read. The bound applies to
	// the presented bytes, so an oversized value costs the facade one comparison.
	handle := form.Get("refresh_token")
	if strings.TrimSpace(handle) == "" || len(handle) > frontChannelMaxRefreshHandleBytes {
		front.emitValidationRejected(ctx, RouteRefreshReasonHandleMalformed, facadeErrorInvalidRequest)
		return "", "", "", facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	// R1.2: identify the registered client through the existing token-client
	// check, which already performs the R1.1 client_id requirement (a missing or
	// empty client_id is its own first refusal), the DCR bound-route enforcement,
	// and the public-auth-method check. Its failure is returned verbatim.
	clientID, failure, err := config.tokenClient(ctx, kind, form)
	if err != nil || failure != nil {
		if failure != nil {
			front.emitValidationRejected(ctx, RouteRefreshReasonClientRejected, facadeErrorInvalidClient)
		}
		return "", "", "", failure, err
	}
	// R1.5 (ruling R4): the bound resource a handle may be redeemed for is the
	// advertising route resource of the request being served — the same
	// derivation the record was bound with at authorize — so a handle minted for
	// one route cannot be redeemed at another. The parameter check of ruling R4
	// alone is not enough, because a request that omits `resource` is served as if
	// it asked for the bound resource; comparing the served route closes that.
	endpoint, err := endpointFromRouteParams(ctx, kind)
	if err != nil {
		return "", "", "", nil, err
	}
	routeResource, failure, err := config.frontChannelRouteResource(ctx, endpoint)
	if err != nil || failure != nil {
		return "", "", "", failure, err
	}
	return handle, clientID, routeResource, nil, nil
}

// refreshLockFailure classifies a failed lock acquisition (ruling R2's lock
// section) and returns the response that ends the request, or nil to retry —
// waiting one poll interval first when the returned bool is true. A held lock and
// a stale version are both retried until the coalesce cap, because the record may
// already carry the winner's completed rotation by the next read; both wait the
// poll interval before re-reading, so the retry is a bounded, yielding wait
// rather than a spin. A revoked or missing record is the same invalid_grant every
// unusable handle gets; and any other store failure is the retryable class,
// because a store that cannot answer the lock must not become an unlimited
// refresh path.
func refreshLockFailure(err error, elapsed time.Duration) (*apptheory.Response, bool) {
	capped := elapsed >= refreshCoalesceWaitCap
	switch {
	case errors.Is(err, oauthstore.ErrBrokerLocked):
		if capped {
			return facadeTemporarilyUnavailablePage(), false
		}
		return nil, true
	case errors.Is(err, oauthstore.ErrBrokerVersionConflict):
		if capped {
			return facadeTemporarilyUnavailablePage(), false
		}
		return nil, true
	case errors.Is(err, oauthstore.ErrBrokerRevoked), errors.Is(err, oauthstore.ErrBrokerNotFound),
		errors.Is(err, oauthstore.ErrBrokerExpired),
		errors.Is(err, oauthstore.ErrBrokerLegacyLineageUnsupported):
		return facadeErrorPage(400, facadeErrorInvalidGrant), false
	case errors.Is(err, oauthstore.ErrBrokerFamilyStateUnavailable),
		errors.Is(err, oauthstore.ErrBrokerFamilyMismatch):
		return facadeTemporarilyUnavailablePage(), false
	default:
		return facadeTemporarilyUnavailablePage(), false
	}
}

// resolveRefreshRecord applies validation steps 3 to 6 of ruling R1 to the
// presented handle and returns the record whose lock may be acquired. A non-nil
// response ends the request here, without a lock and without an upstream call.
// A returned record with a non-zero GraceExpiresAt has been rotated away: the
// caller serves it by rotating the family's live head.
//
//nolint:gocyclo // the validation order is the security contract.
func (front *frontChannelConfig) resolveRefreshRecord(
	ctx *apptheory.Context,
	form url.Values,
	clientID string,
	handle string,
	routeResource string,
) (*oauthstore.RouteRefreshBrokerRecord, *apptheory.Response) {
	// R1.3: read the record the handle is keyed by. A missing record, a record
	// whose local lifetime policy elapsed, a revoked record, a record bound to
	// another client, and a record bound to another route ALL render the SAME
	// invalid_grant body, so the response is never an oracle for which of the
	// four failed — in particular, a handle redeemed at the wrong route is
	// indistinguishable from a handle that does not exist, which is what keeps the
	// route binding from becoming a handle-existence oracle. The store's expired
	// and absent signals remain distinguishable only in telemetry. A store that
	// cannot answer is the retryable class.
	record, err := front.stores.RouteRefreshBroker.Get(ctx.Context(), oauthstore.HashKey(handle))
	switch {
	case errors.Is(err, oauthstore.ErrBrokerNotFound):
		front.emitRecordStateRejection(ctx, nil, RouteRefreshReasonRecordAbsent, RouteRefreshExpirySignalAbsent)
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	case errors.Is(err, oauthstore.ErrBrokerExpired):
		front.emitRecordStateRejection(ctx, nil, RouteRefreshReasonRecordExpired, RouteRefreshExpirySignalExpired)
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	case errors.Is(err, oauthstore.ErrBrokerRevoked):
		front.emitRecordStateRejection(ctx, nil, RouteRefreshReasonRecordRevoked, "")
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	case errors.Is(err, oauthstore.ErrBrokerLegacyLineageUnsupported):
		front.emitRecordStateRejection(ctx, nil, RouteRefreshReasonLegacyLineage, "")
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	case errors.Is(err, oauthstore.ErrBrokerFamilyStateUnavailable),
		errors.Is(err, oauthstore.ErrBrokerFamilyMismatch):
		front.emitStateFailure(ctx, nil, RouteRefreshReasonFamilyStateUnavailable, "")
		return nil, facadeTemporarilyUnavailablePage()
	case err != nil:
		front.emitStateFailure(ctx, nil, RouteRefreshReasonStoreFailure, "")
		return nil, facadeTemporarilyUnavailablePage()
	}
	if record.ClientIDHash != oauthstore.HashKey(clientID) {
		front.emitRecordStateRejection(ctx, record, RouteRefreshReasonClientMismatch, "")
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	if record.CanonicalResource != routeResource {
		front.emitRecordStateRejection(ctx, record, RouteRefreshReasonResourceMismatch, "")
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	if record.Status == oauthstore.BrokerStatusRevoked {
		front.emitRecordStateRejection(ctx, record, RouteRefreshReasonRecordRevoked, "")
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	// A family-less record predates the family policy. It is not refused: the
	// caller migrates it in code (adoptLegacyLineage) so a client that upgraded
	// keeps working with no manual data operation. A family-marked record with a
	// generation below the root is corrupt and fails closed before the lock and
	// before any upstream call.
	if record.FamilyHash != "" && record.ChainGeneration < refreshChainRootGeneration {
		front.emitRecordStateRejection(ctx, record, RouteRefreshReasonFamilyStateUnavailable, "")
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	// R1.4 reuse: a record that carries a grace deadline was rotated away. The
	// record is returned to the caller when the window has closed, and served
	// here when it is still open and the stored body is still replayable. A
	// non-replayable body falls through to the same stale-predecessor path, so a
	// client never loses a rotation to a store that did not persist the access
	// token's lifetime.
	//
	// R1.5 (ruling R4): scope and resource are validated on EVERY refresh
	// request, including one that will be answered from the grace window, so a
	// request that asks for something other than what the record grants is
	// refused rather than silently served.
	if failure, failureCode := refreshRequestBindingFailure(form, record); failure != nil {
		front.emitValidationRejected(ctx, RouteRefreshReasonBindingRejected, failureCode)
		return nil, failure
	}
	// R1.6 grace: the rotation completed inside the window, so the successor
	// response is replayed. The body carries the same access token and the same
	// successor handle; only expires_in is recomputed to what the credential
	// actually has left.
	if response, served := refreshGraceResponse(record, ctx.Now(), front.policy.GraceWindow); served {
		event := eventFromRecord(record)
		event.Class = RouteRefreshEventGraceServed
		event.Reason = RouteRefreshReasonSuccessorBody
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, response
	}
	return record, nil
}

// refreshRequestBindingFailure applies ruling R4 to one refresh request: a
// present resource member must canonicalize to the bound resource and a present
// scope member must fingerprint to exactly the granted scope set. Presence — not
// emptiness — is what triggers a check, so an absent member takes the recorded
// value (allowed), while a present but empty scope is the empty set and is
// therefore refused like any other non-exact set. A requesting-wider-or-subset
// mode is deliberately not built. The second return value is the client-facing
// error code for telemetry, empty when the binding holds.
func refreshRequestBindingFailure(
	form url.Values,
	record *oauthstore.RouteRefreshBrokerRecord,
) (*apptheory.Response, string) {
	if resource, present := presentFormValue(form, "resource"); present {
		if oauth.CanonicalResourceURL(resource) != record.CanonicalResource {
			return facadeErrorPage(400, facadeErrorInvalidTarget), facadeErrorInvalidTarget
		}
	}
	if scope, present := presentFormValue(form, "scope"); present {
		if facadeScopeFingerprint(strings.Fields(scope)) != record.ScopeFingerprint {
			return facadeErrorPage(400, facadeErrorInvalidScope), facadeErrorInvalidScope
		}
	}
	return nil, ""
}

// presentFormValue reports whether the form carries the member at all, and
// returns its first value. url.Values cannot distinguish an absent member from a
// present empty one through Get, and ruling R4 needs exactly that distinction.
func presentFormValue(form url.Values, name string) (string, bool) {
	values, present := form[name]
	if !present || len(values) == 0 {
		return "", false
	}
	return values[0], true
}

// refreshGraceResponse renders the stored successor response when the rotation
// is still inside its grace window (ruling R1.6). The body carries the same
// access token and the same successor handle the winning caller received, so a
// lost response recovers without a second upstream call. Only expires_in is
// recomputed, because a replayed credential must be accepted by the resource for
// at least the lifetime the response states; a stored body whose access token
// has less than refreshCredentialFloor left is not replayed at all, and the
// caller rotates a fresh one instead. A record that claims a live grace window
// but carries no stored response is an internal inconsistency: it is answered
// with the retryable class rather than an empty success or a false
// invalid_grant.
func refreshGraceResponse(
	record *oauthstore.RouteRefreshBrokerRecord,
	now time.Time,
	graceWindow time.Duration,
) (*apptheory.Response, bool) {
	if record.GraceExpiresAt.IsZero() || !now.Before(record.GraceExpiresAt) {
		return nil, false
	}
	if record.EncryptedGraceRefreshResponse == "" {
		return facadeTemporarilyUnavailablePage(), true
	}
	body := []byte(record.EncryptedGraceRefreshResponse)
	expiresAt := record.GraceAccessTokenExpiresAt
	if expiresAt.IsZero() {
		// A record written before the field existed: the rotation instant is the
		// grace deadline minus the window, and the stored body states the access
		// token's lifetime. An unknown lifetime is zero, which refuses the replay.
		expiresAt = record.GraceExpiresAt.Add(-graceWindow).Add(storedAccessTokenLifetime(body))
	}
	remaining := expiresAt.Sub(now)
	if remaining < refreshCredentialFloor {
		return nil, false
	}
	replayed, err := replayTokenBody(body, remaining)
	if err != nil {
		return nil, false
	}
	return refreshTokenPage(replayed), true
}

// storedAccessTokenLifetime returns the access-token lifetime the stored
// successor body states, or zero when the body is unreadable or states none.
func storedAccessTokenLifetime(body []byte) time.Duration {
	var payload struct {
		ExpiresIn int `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.ExpiresIn <= 0 {
		return 0
	}
	return time.Duration(payload.ExpiresIn) * time.Second
}

// replayTokenBody rewrites the stored successor body's expires_in to what the
// credential has left, so a replay never advertises a lifetime the access token
// does not have. The access token, its type, the scope, and the successor handle
// are unchanged.
func replayTokenBody(body []byte, remaining time.Duration) ([]byte, error) {
	payload := facadeTokenPayload{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	seconds := int(remaining / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	payload.ExpiresIn = seconds
	return json.Marshal(payload) // #nosec G117 -- the access token is deliberately returned to the client it was minted for, per DESIGN §8.4; only upstream refresh material and id_token are withheld.
}

// refreshFamilyHead resolves the live head of the family a rotated-away handle
// belongs to. The head is the highest-generation member that carries no grace
// deadline: the only record whose recorded upstream material is current. A
// predecessor is never presented to the upstream, because an upstream that
// detects refresh-token reuse would then revoke the grant on ordinary client
// behavior. A family with no live head cannot rotate, so the handle is terminal.
func (config normalizedConfig) refreshFamilyHead(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
) (*oauthstore.RouteRefreshBrokerRecord, *apptheory.Response) {
	front := config.frontChannel
	familyStore, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		front.emitStateFailure(ctx, presented, RouteRefreshReasonFamilyStateUnavailable, "")
		return nil, facadeTemporarilyUnavailablePage()
	}
	records, err := familyStore.ListFamily(ctx.Context(), presented.FamilyHash)
	if err != nil {
		front.emitStateFailure(ctx, presented, RouteRefreshReasonFamilyStateUnavailable, "")
		return nil, facadeTemporarilyUnavailablePage()
	}
	head := liveFamilyHead(records)
	if head == nil {
		event := eventFromRecord(presented)
		event.Class = RouteRefreshEventReuse
		event.Reason = RouteRefreshReasonFamilyHeadAbsent
		event.ErrorCode = facadeErrorInvalidGrant
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	return head, nil
}

// listFamily enumerates a family through the broker store's family capability.
// A store without the capability, and a store that cannot answer, are both
// unreadable family state: the caller must not draw a terminal conclusion.
func (front *frontChannelConfig) listFamily(
	ctx context.Context,
	familyHash string,
) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	familyStore, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		return nil, oauthstore.ErrBrokerFamilyStateUnavailable
	}
	return familyStore.ListFamily(ctx, familyHash)
}

// liveFamilyHead selects the record whose upstream material is current: the
// highest-generation member that is neither revoked nor rotated away. Ties are
// broken by handle hash so every caller resolves the same head.
func liveFamilyHead(records []*oauthstore.RouteRefreshBrokerRecord) *oauthstore.RouteRefreshBrokerRecord {
	var head *oauthstore.RouteRefreshBrokerRecord
	for _, candidate := range records {
		if candidate == nil || candidate.Status == oauthstore.BrokerStatusRevoked {
			continue
		}
		if !candidate.GraceExpiresAt.IsZero() || candidate.ChainGeneration < refreshChainRootGeneration {
			continue
		}
		if head == nil || candidate.ChainGeneration > head.ChainGeneration ||
			(candidate.ChainGeneration == head.ChainGeneration && candidate.HandleHash > head.HandleHash) {
			head = candidate
		}
	}
	return head
}

// refreshUpstream makes the ONE upstream refresh call of a rotation under the
// configured encoded budget. The deadline is enforced here, not only inside the
// adapter, so an implementation that ignores it still cannot outlive the budget
// the deployment chose.
func (front *frontChannelConfig) refreshUpstream(
	ctx context.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
) (*oauth.TokenSet, error) {
	if record == nil {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidRequest, "refresh", "refresh record is required")
	}
	budgeted, cancel := context.WithTimeout(ctx, front.policy.RefreshBudget)
	defer cancel()
	return front.provider.Refresh(budgeted, oauth.RefreshRequest{
		RefreshMaterial:  record.EncryptedUpstreamRefreshToken,
		UpstreamClientID: record.UpstreamClientID,
	})
}

// refreshRotation is one persisted rotation: the body the client receives, the
// successor record, and the deadlines the presented record carries afterwards.
type refreshRotation struct {
	body            []byte
	successor       *oauthstore.RouteRefreshBrokerRecord
	graceExpiresAt  time.Time
	accessExpiresAt time.Time
}

// rotateRefreshGrant performs the held-lock rotation of ruling R1 step 7. The
// lock is held on the presented live head when this is called.
func (config normalizedConfig) rotateRefreshGrant(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) (*apptheory.Response, error) {
	rotation, response, err := config.performRefreshRotation(ctx, presented, locked)
	if err != nil || response != nil {
		return response, err
	}
	return refreshTokenPage(rotation.body), nil
}

// rotateStalePredecessor serves a rotated-away handle whose grace window has
// closed. It rotates the family's live head — never the predecessor, whose
// recorded material the upstream has already rotated — and hands the client
// fresh credentials. The presented record is re-armed with the new body and a
// fresh grace window (best effort), so a retry storm inside one window is served
// from the stored body instead of buying another upstream rotation; the family
// is never revoked. The presentation is reported as reuse with the additive
// rotated_from_head outcome: it is ordinary client behavior, not theft.
// lineageVerified reports that the presentation was resolved by the
// post-timeout lineage check rather than by an elapsed grace window; it changes
// the telemetry reason only.
func (config normalizedConfig) rotateStalePredecessor(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	head *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
	lineageVerified bool,
) (*apptheory.Response, error) {
	front := config.frontChannel
	rotation, response, err := config.performRefreshRotation(ctx, head, locked)
	if err != nil || response != nil {
		return response, err
	}
	front.rearmStalePredecessor(ctx, presented, rotation)
	event := eventFromRecord(presented)
	event.Class = RouteRefreshEventReuse
	event.Reason = RouteRefreshReasonStalePredecessor
	if lineageVerified {
		event.Reason = RouteRefreshReasonLineageVerified
	}
	event.Outcome = RouteRefreshOutcomeRotatedFromHead
	event.SuccessorHandleHash = rotation.successor.HandleHash
	event.FamilyHash = rotation.successor.FamilyHash
	event.StatusTo = oauthstore.BrokerStatusActive
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
	return refreshTokenPage(rotation.body), nil
}

// rearmStalePredecessor stores the rotation's body and deadlines on the
// presented predecessor so a repeat presentation inside the grace window
// replays it. It is best effort: a failed compare-and-swap only means the next
// presentation rotates again, which is still a served request.
func (front *frontChannelConfig) rearmStalePredecessor(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	rotation *refreshRotation,
) {
	current, err := front.stores.RouteRefreshBroker.Get(ctx.Context(), presented.HandleHash)
	if err != nil {
		return
	}
	updated := *current
	updated.EncryptedGraceRefreshResponse = string(rotation.body)
	updated.GraceExpiresAt = rotation.graceExpiresAt
	updated.GraceAccessTokenExpiresAt = rotation.accessExpiresAt
	if _, err := front.stores.RouteRefreshBroker.CompareAndSwap(
		ctx.Context(), &updated, current.Version,
	); err != nil {
		return
	}
}

// performRefreshRotation makes the ONE upstream refresh call of a rotation under
// the held lock, persists the successor transactionally, and reports it. The
// rotation intent is written to the store before any upstream material is
// presented, and nothing is minted unless every write landed.
func (config normalizedConfig) performRefreshRotation(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) (*refreshRotation, *apptheory.Response, error) {
	front := config.frontChannel
	attempted, response, err := config.takeRotationIntent(ctx, presented, locked)
	if err != nil || response != nil {
		return nil, response, err
	}
	locked = attempted
	upstream, err := front.refreshUpstream(ctx.Context(), locked)
	if err != nil {
		response, failure := config.failedRefreshGrant(ctx, presented, locked, err)
		return nil, response, failure
	}
	handle, err := oauth.NewOpaqueToken()
	if err != nil {
		return nil, nil, err
	}
	successor := successorBrokerRecord(presented, handle, upstream)
	// The successor response body is the token response the client receives and
	// the body the grace path replays. It carries the upstream access token
	// byte-for-byte and the framework's own handle, and never an id_token or any
	// upstream refresh material.
	body, err := successorTokenBody(upstream, handle)
	if err != nil {
		return nil, nil, err
	}
	familyStore, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		// Registration requires the capability; a store that lost it cannot hold
		// the successor, so the rotation cannot complete and no successor handle
		// may be handed out.
		return nil, nil, errRouteRefreshBrokerFamilyCapabilityMissing
	}
	rotation := &refreshRotation{
		body:            body,
		successor:       successor,
		graceExpiresAt:  ctx.Now().Add(front.policy.GraceWindow),
		accessExpiresAt: ctx.Now().Add(accessTokenLifetime(upstream)),
	}
	// One atomic transaction creates the successor and updates the presented
	// record's grace response/status. There is deliberately no separate successor
	// Put followed by a predecessor compare-and-swap: a crash between the two
	// would leave a minted successor nothing can revoke.
	if _, err = familyStore.RotateFamily(ctx.Context(), oauthstore.RouteRefreshFamilyRotation{
		PresentedHandleHash:       locked.HandleHash,
		LockOwner:                 locked.RefreshLockOwner,
		ExpectedVersion:           locked.Version,
		Successor:                 successor,
		GraceRefreshResponse:      string(body),
		GraceExpiresAt:            rotation.graceExpiresAt,
		GraceAccessTokenExpiresAt: rotation.accessExpiresAt,
	}); err != nil {
		// Nothing was minted. A family revoked between the lock and the rotation is
		// the uniform invalid_grant; every other failure releases the lock and is
		// retryable, because a success response may never be returned for state that
		// was not persisted. The unconfirmed-rotation marker stays behind, so the next
		// attempt knows the upstream material may already have been consumed.
		switch {
		case errors.Is(err, oauthstore.ErrBrokerRevoked):
			event := eventFromRecord(presented)
			event.Class = RouteRefreshEventReuse
			event.Reason = RouteRefreshReasonRecordRevoked
			event.ErrorCode = facadeErrorInvalidGrant
			event.StatusTo = oauthstore.BrokerStatusRevoked
			event.At = ctx.Now()
			front.emitRouteRefresh(ctx.Context(), event)
			return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
		case errors.Is(err, oauthstore.ErrBrokerLegacyLineageUnsupported):
			front.emitStateFailure(ctx, presented, RouteRefreshReasonLegacyLineage, "")
			return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
		case errors.Is(err, oauthstore.ErrBrokerFamilyStateUnavailable),
			errors.Is(err, oauthstore.ErrBrokerFamilyMismatch):
			front.releaseRefreshLock(ctx, presented, locked)
			front.emitStateFailure(ctx, presented, RouteRefreshReasonFamilyStateUnavailable, "")
			return nil, facadeTemporarilyUnavailablePage(), nil
		default:
			front.releaseRefreshLock(ctx, presented, locked)
			front.emitStateFailure(ctx, presented, RouteRefreshReasonRewriteFailure, "")
			return nil, facadeTemporarilyUnavailablePage(), nil
		}
	}
	event := eventFromRecord(presented)
	event.Class = RouteRefreshEventRefreshed
	event.StatusFrom = oauthstore.BrokerStatusRefreshing
	event.StatusTo = oauthstore.BrokerStatusActive
	event.SuccessorHandleHash = successor.HandleHash
	event.FamilyHash = successor.FamilyHash
	event.ChainGeneration = successor.ChainGeneration
	event.PreviousUpstreamRefreshTokenHash = presented.UpstreamRefreshTokenHash
	event.UpstreamRefreshTokenHash = successor.UpstreamRefreshTokenHash
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
	return rotation, nil, nil
}

// accessTokenLifetime is the lifetime an upstream token set states. An unknown
// or non-positive lifetime is zero, which makes the stored body non-replayable
// and every presentation rotate a fresh credential.
func accessTokenLifetime(tokenSet *oauth.TokenSet) time.Duration {
	if tokenSet == nil || tokenSet.ExpiresIn <= 0 {
		return 0
	}
	return time.Duration(tokenSet.ExpiresIn) * time.Second
}

// failedRefreshGrant maps a failed upstream refresh call and unwinds the lock
// (ruling R1 step 7's failure section). Only one class may be family-terminal —
// an upstream invalid_grant — and even that one is revocable only after lineage
// verification (see failedTerminalRefreshGrant). Every other failure releases the
// lock and reports its typed response; a failure to release leaves the lock to
// expire and never becomes a success.
func (config normalizedConfig) failedRefreshGrant(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
	upstreamErr error,
) (*apptheory.Response, error) {
	front := config.frontChannel
	class := oauth.ProviderTemporarilyUnavailable
	if providerErr, ok := oauth.AsProviderError(upstreamErr); ok {
		class = providerErr.Class
	}
	switch class {
	case oauth.ProviderInvalidGrant:
		return config.failedTerminalRefreshGrant(ctx, presented, locked, class)
	case oauth.ProviderUpstreamError:
		front.releaseRefreshLock(ctx, presented, locked)
		event := eventFromRecord(presented)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonUpstreamRejected
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorUpstream
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return facadeUpstreamErrorPage(), nil
	default:
		// ProviderTemporarilyUnavailable, ProviderReauthRequired (a stale-or-replaced
		// signal is recovery-available under the rotation-recovery contract), and any
		// provider failure the adapter did not classify: transient by default, so the
		// lock is released, the unconfirmed-attempt marker is left in place, and the
		// caller is told to retry.
		front.releaseRefreshLock(ctx, presented, locked)
		event := eventFromRecord(presented)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonUpstreamRejected
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorTemporarilyUnavailable
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return facadeTemporarilyUnavailablePage(), nil
	}
}

// terminalRefreshEvidence classifies what one upstream invalid_grant is evidence
// about, from the store's own view of the family.
type terminalRefreshEvidence int

const (
	// terminalRefreshUnverified means the family could not be read, so no terminal
	// conclusion may be drawn from the verdict.
	terminalRefreshUnverified terminalRefreshEvidence = iota
	// terminalRefreshSuperseded means the verdict is about material the family's
	// live head has already replaced: it is not evidence about the family.
	terminalRefreshSuperseded
	// terminalRefreshLiveHead means the verdict is about the family's current live
	// head, which is the only record whose material speaks for the family.
	terminalRefreshLiveHead
)

// failedTerminalRefreshGrant renders the one upstream verdict class that may be
// family-terminal, and only on corroborated evidence. It is terminal when the
// verdict is about the family's current live head and no rotation attempt of that
// record is unconfirmed inside the facade's ambiguity horizon. Every other shape
// stays transient: an unconfirmed attempt (a timeout, a lost response, the
// 16:00Z class), a verdict about superseded material, or a family the facade
// cannot read. Latency, a lost response, an informed serve-off state, and client
// naivety must never kill a family (contract R1/R5/R7).
func (config normalizedConfig) failedTerminalRefreshGrant(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
	class oauth.ProviderErrorClass,
) (*apptheory.Response, error) {
	front := config.frontChannel
	if front.refreshVerdictAmbiguous(presented, ctx.Now()) {
		front.releaseRefreshLock(ctx, presented, locked)
		event := eventFromRecord(presented)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonRecoveryPending
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorTemporarilyUnavailable
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return facadeTemporarilyUnavailablePage(), nil
	}
	switch front.terminalRefreshEvidence(ctx, presented) {
	case terminalRefreshLiveHead:
		// The family's current material was rejected: the one genuinely terminal
		// shape. The family tombstone is written before the client is told.
	case terminalRefreshSuperseded:
		if presented.Status == oauthstore.BrokerStatusRevoked {
			// The family is already tombstoned; every presentation is the same
			// terminal answer and no second revocation is emitted.
			return facadeErrorPage(400, facadeErrorInvalidGrant), nil
		}
		front.releaseRefreshLock(ctx, presented, locked)
		event := eventFromRecord(presented)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonLineageVerified
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorTemporarilyUnavailable
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return facadeTemporarilyUnavailablePage(), nil
	default:
		front.releaseRefreshLock(ctx, presented, locked)
		front.emitStateFailure(ctx, presented, RouteRefreshReasonFamilyStateUnavailable, string(class))
		return facadeTemporarilyUnavailablePage(), nil
	}
	if err := front.revokeFamilyForRecord(ctx, presented); err != nil {
		// The grant is dead upstream but could not be revoked here, so the
		// client is not told the handle is invalid while it is still live.
		front.emitStateFailure(ctx, presented, RouteRefreshReasonStoreFailure, string(class))
		return facadeTemporarilyUnavailablePage(), nil
	}
	event := eventFromRecord(presented)
	event.Class = RouteRefreshEventUpstreamReauthRequired
	event.Reason = RouteRefreshReasonUpstreamRejected
	event.UpstreamClass = string(class)
	event.ErrorCode = facadeErrorInvalidGrant
	event.StatusTo = oauthstore.BrokerStatusRevoked
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
	return facadeErrorPage(400, facadeErrorInvalidGrant), nil
}

// refreshVerdictAmbiguous reports whether the record carries an unconfirmed
// rotation attempt that is still inside the facade's ambiguity horizon. The
// horizon is the configured grace window: it is the facade's own measured
// recovery-attempt window, it is the interval in which the upstream's walk can
// still serve the replaced material, and inside it an upstream invalid_grant
// cannot be told apart from a lost response. The marker's earliest instant is
// never moved forward, so retries cannot extend the horizon.
func (front *frontChannelConfig) refreshVerdictAmbiguous(
	record *oauthstore.RouteRefreshBrokerRecord,
	now time.Time,
) bool {
	if front == nil || record == nil || record.RotationUnconfirmedAt.IsZero() {
		return false
	}
	return !now.After(record.RotationUnconfirmedAt.Add(front.policy.GraceWindow))
}

// terminalRefreshEvidence reads the family the presented record belongs to and
// classifies what an upstream verdict about the presented material is evidence
// of. A family-less record cannot be family-revoked; it is treated as its own
// live head so the caller's revocation fails closed on the legacy path instead
// of revoking something.
func (front *frontChannelConfig) terminalRefreshEvidence(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
) terminalRefreshEvidence {
	if front == nil || presented == nil {
		return terminalRefreshUnverified
	}
	if presented.FamilyHash == "" {
		return terminalRefreshLiveHead
	}
	records, err := front.listFamily(ctx.Context(), presented.FamilyHash)
	if err != nil {
		return terminalRefreshUnverified
	}
	head := liveFamilyHead(records)
	if head == nil {
		return terminalRefreshSuperseded
	}
	if head.HandleHash == presented.HandleHash &&
		head.UpstreamRefreshTokenHash == presented.UpstreamRefreshTokenHash {
		return terminalRefreshLiveHead
	}
	return terminalRefreshSuperseded
}

// takeRotationIntent persists, in the store, that this record's upstream material
// is about to be presented, and returns the locked record at its new version. It
// is the read-side twin of persist-before-ack: the facade never presents material
// it has not recorded an attempt for, so a process that loses the answer leaves
// evidence a later attempt can verify lineage against. A failed write releases the
// lock and answers transiently without calling the upstream.
func (config normalizedConfig) takeRotationIntent(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) (*oauthstore.RouteRefreshBrokerRecord, *apptheory.Response, error) {
	front := config.frontChannel
	attempted, err := front.takeRotationIntentAt(ctx.Context(), locked, ctx.Now())
	if err != nil {
		front.releaseRefreshLock(ctx, presented, locked)
		front.emitStateFailure(ctx, presented, RouteRefreshReasonRewriteFailure, "")
		return nil, facadeTemporarilyUnavailablePage(), nil
	}
	return attempted, nil, nil
}

// takeRotationIntentAt writes the unconfirmed-rotation marker under the held
// lock. An already-set marker is preserved, so the ambiguity horizon stays
// anchored to the first lost attempt and retries cannot extend it.
func (front *frontChannelConfig) takeRotationIntentAt(
	ctx context.Context,
	locked *oauthstore.RouteRefreshBrokerRecord,
	now time.Time,
) (*oauthstore.RouteRefreshBrokerRecord, error) {
	if locked == nil {
		return nil, oauthstore.ErrRecordKeyRequired
	}
	if !locked.RotationUnconfirmedAt.IsZero() {
		return locked, nil
	}
	updated := *locked
	updated.RotationUnconfirmedAt = now
	return front.stores.RouteRefreshBroker.CompareAndSwap(ctx, &updated, locked.Version)
}

// revokeFamilyForRecord revokes the family of a record whose upstream material
// is terminally dead. It reports whether the revocation landed; a family-less
// record cannot be revoked safely and is reported as a failure rather than a
// success.
func (front *frontChannelConfig) revokeFamilyForRecord(
	ctx *apptheory.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
) error {
	if record.FamilyHash == "" {
		return oauthstore.ErrBrokerLegacyLineageUnsupported
	}
	familyStore, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		return errRouteRefreshBrokerFamilyCapabilityMissing
	}
	_, err := familyStore.RevokeFamily(ctx.Context(), record.FamilyHash)
	return err
}

// releaseRefreshLock returns a locked record to the status it had before the
// lock was taken, with the lock cleared, so a caller that failed for a transient
// reason can try again instead of waiting out the lock TTL. It is best effort: a
// failed release leaves the lock to expire, which delays the next attempt but
// never reports a success. The unconfirmed-rotation marker is deliberately
// preserved: the attempt that failed may still have landed upstream.
func (front *frontChannelConfig) releaseRefreshLock(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) {
	front.releaseRefreshLockAt(ctx.Context(), presented, locked)
}

// releaseRefreshLockAt is releaseRefreshLock for a caller that has no request
// context, such as the out-of-band refresh sweeper.
func (front *frontChannelConfig) releaseRefreshLockAt(
	ctx context.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) {
	if locked == nil {
		return
	}
	released := *locked
	released.RefreshLockOwner = ""
	released.RefreshLockExpiresAt = time.Time{}
	if presented != nil {
		released.Status = presented.Status
	}
	if _, err := front.stores.RouteRefreshBroker.CompareAndSwap(ctx, &released, locked.Version); err != nil {
		return
	}
}

// successorBrokerRecord builds the record the rotated handle is stored under. It
// carries the identity of the presented record unchanged — issuer, stage,
// resource, namespace, endpoint kind, partner, agent, client, subject, scopes,
// and the upstream client — so a handle is never rebound to new identity, and it
// takes the freshly rotated upstream refresh material when the upstream issued
// one. An upstream that rotates nothing leaves the previous material valid (RFC
// 6749 §6), so the presented material is carried forward.
func successorBrokerRecord(
	presented *oauthstore.RouteRefreshBrokerRecord,
	handle string,
	upstream *oauth.TokenSet,
) *oauthstore.RouteRefreshBrokerRecord {
	material := upstream.RefreshToken
	if strings.TrimSpace(material) == "" {
		material = presented.EncryptedUpstreamRefreshToken
	}
	return &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(handle),
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
		EncryptedUpstreamRefreshToken: material,
		UpstreamRefreshTokenHash:      oauthstore.HashKey(material),
		UpstreamClientID:              presented.UpstreamClientID,
		Status:                        oauthstore.BrokerStatusIssued,
		ChainGeneration:               presented.ChainGeneration + 1,
		FamilyHash:                    presented.FamilyHash,
	}
}

// successorTokenBody renders the refresh success body: the same payload shape
// tokenResponse renders, with the upstream access token byte-for-byte unmodified
// and the framework's successor handle as refresh_token. No id_token and no
// upstream refresh material is ever part of it.
func successorTokenBody(upstream *oauth.TokenSet, handle string) ([]byte, error) {
	return json.Marshal(facadeTokenPayload{ // #nosec G117 -- the access token is deliberately returned to the client it was minted for, per DESIGN §8.4; only upstream refresh material and id_token are withheld.
		AccessToken:  upstream.AccessToken,
		TokenType:    upstream.TokenType,
		ExpiresIn:    upstream.ExpiresIn,
		Scope:        upstream.Scope,
		RefreshToken: handle,
	})
}

// refreshTokenPage renders one refresh success with the fixed non-cacheable
// header set tokenResponse uses, so the grace replay is byte-identical in status,
// headers, and body to the response the winning caller received.
func refreshTokenPage(body []byte) *apptheory.Response {
	return &apptheory.Response{
		Status: 200,
		Headers: map[string][]string{
			"content-type":  {"application/json; charset=utf-8"},
			"cache-control": {"no-store"},
			"pragma":        {"no-cache"},
		},
		Body: body,
	}
}

// facadeTemporarilyUnavailablePage is the token endpoint's retryable failure
// class (RFC 6749 §5.2 temporarily_unavailable): lock contention beyond the
// coalesce wait cap, a store or lock failure, and a transient provider failure.
// It mirrors the registration endpoint's page, with a fixed one-second
// Retry-After because there is no window to derive a delay from here.
func facadeTemporarilyUnavailablePage() *apptheory.Response {
	response := facadeErrorPage(503, facadeErrorTemporarilyUnavailable)
	response.Headers["retry-after"] = []string{strconv.Itoa(refreshRetryAfterSeconds)}
	return response
}
