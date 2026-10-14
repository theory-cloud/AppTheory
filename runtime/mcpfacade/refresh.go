package mcpfacade

import (
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// Brokered refresh framework defaults (DESIGN §8.4 mechanic 4, THREAT_MODEL T6,
// operator ruling R3). Every value is a framework constant: deliberately not a
// FacadeConfig field and not an environment variable, so no adopter can widen
// the door and Go, TypeScript, and Python can only agree on one number set. Each
// value is pinned by a test.
const (
	// frontChannelMaxRefreshHandleBytes bounds the presented route handle in
	// bytes, checked before any other work. The framework mints a handle as 32
	// random bytes (43 base64url characters), so 512 is far above every
	// legitimate handle while still bounding an unauthenticated caller's payload.
	frontChannelMaxRefreshHandleBytes = 512

	// refreshGraceWindow is how long the successor token response is replayed to
	// a client that presents the rotated (previous) handle. It is the
	// lost-response window of ruling R2: a client whose 200 never arrived replays
	// the same request and receives byte-identical successor tokens instead of
	// provoking a second upstream call. It is measured on the injected framework
	// clock.
	refreshGraceWindow = 30 * time.Second

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

	// refreshRevokeChainLimit bounds the reuse-detection revoke walk of ruling
	// R1.4: the walk follows the successor handle each revoked record names, so
	// the limit is what keeps a crafted or cyclic stored value from looping. The
	// real chain of one facade-opened grant is one link.
	refreshRevokeChainLimit = 8

	// refreshRetryAfterSeconds is the fixed Retry-After the refresh 503 class
	// carries. Unlike the registration endpoint there is no rate-limit window to
	// derive a delay from: the caller was refused either because another caller
	// holds the in-flight lock or because a store could not answer, and both are
	// worth exactly one second of backoff.
	refreshRetryAfterSeconds = 1
)

// errRouteRefreshBrokerNotSeedable is the fail-closed class a broker store that
// cannot be seeded raises. openBrokerRecord raises the same class for the
// callback's record, so a store that cannot place a broker record can neither
// open a grant nor rotate one.
var errRouteRefreshBrokerNotSeedable = errors.New("mcpfacade: route refresh broker store cannot be seeded")

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
// present the same handle, a bounded wait for a caller that loses the lock race,
// and a thirty-second grace window in which the rotated (previous) handle
// replays the successor tokens byte-for-byte. Ruling R4 binds the request's scope
// and resource, and a handle is additionally bound to the route it was minted for
// (DESIGN §7: the broker record binds resource, so a handle is a route handle).
func (config normalizedConfig) handleRefreshTokenGrant(
	ctx *apptheory.Context,
	kind mcproutes.EndpointKind,
	form url.Values,
) (*apptheory.Response, error) {
	// R1.1: bound the handle before anything else is read. The bound applies to
	// the presented bytes, so an oversized value costs the facade one comparison.
	handle := form.Get("refresh_token")
	if strings.TrimSpace(handle) == "" || len(handle) > frontChannelMaxRefreshHandleBytes {
		return facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	// R1.2: identify the registered client through the existing token-client
	// check, which already performs the R1.1 client_id requirement (a missing or
	// empty client_id is its own first refusal), the DCR bound-route enforcement,
	// and the public-auth-method check. Its failure is returned verbatim.
	clientID, failure, err := config.tokenClient(ctx, kind, form)
	if err != nil || failure != nil {
		return failure, err
	}
	// R1.5 (ruling R4): the bound resource a handle may be redeemed for is the
	// advertising route resource of the request being served — the same
	// derivation the record was bound with at authorize — so a handle minted for
	// one route cannot be redeemed at another. The parameter check of ruling R4
	// alone is not enough, because a request that omits `resource` is served as if
	// it asked for the bound resource; comparing the served route closes that.
	endpoint, err := endpointFromRouteParams(ctx, kind)
	if err != nil {
		return nil, err
	}
	routeResource, failure, err := config.frontChannelRouteResource(ctx, endpoint)
	if err != nil || failure != nil {
		return failure, err
	}
	// R2: the coalesce wait budget is measured with REAL elapsed time
	// (time.Since(start)), never the framework clock, because the wait has to
	// terminate even when the framework clock is frozen or moved by a caller: it
	// is an operational backpressure bound, not a security decision. Grace,
	// record lifetime, and rotation timestamps all use the injected framework
	// clock (ctx.Now()), which is what makes them deterministic and testable.
	start := time.Now()
	for {
		record, response := config.frontChannel.resolveRefreshRecord(ctx, form, clientID, handle, routeResource)
		if response != nil {
			return response, nil
		}
		lockOwner, lockOwnerErr := oauth.NewOpaqueToken()
		if lockOwnerErr != nil {
			return nil, lockOwnerErr
		}
		locked, lockErr := config.frontChannel.stores.RouteRefreshBroker.AcquireLock(
			ctx.Context(), record.HandleHash, lockOwner, record.Version)
		if lockErr == nil {
			return config.rotateRefreshGrant(ctx, record, locked)
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
	case errors.Is(err, oauthstore.ErrBrokerRevoked), errors.Is(err, oauthstore.ErrBrokerNotFound):
		return facadeErrorPage(400, facadeErrorInvalidGrant), false
	default:
		return facadeTemporarilyUnavailablePage(), false
	}
}

// resolveRefreshRecord applies validation steps 3 to 6 of ruling R1 to the
// presented handle and returns the record whose lock may be acquired. A non-nil
// response ends the request here, without a lock and without an upstream call.
func (front *frontChannelConfig) resolveRefreshRecord(
	ctx *apptheory.Context,
	form url.Values,
	clientID string,
	handle string,
	routeResource string,
) (*oauthstore.RouteRefreshBrokerRecord, *apptheory.Response) {
	// R1.3: read the record the handle is keyed by. A missing record (which also
	// covers one whose local lifetime policy elapsed), a revoked record, a record
	// bound to another client, and a record bound to another route ALL render the
	// SAME invalid_grant body, so the response is never an oracle for which of the
	// four failed — in particular, a handle redeemed at the wrong route is
	// indistinguishable from a handle that does not exist, which is what keeps the
	// route binding from becoming a handle-existence oracle. A store that cannot
	// answer is the retryable class.
	record, err := front.stores.RouteRefreshBroker.Get(ctx.Context(), oauthstore.HashKey(handle))
	switch {
	case errors.Is(err, oauthstore.ErrBrokerNotFound):
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	case err != nil:
		return nil, facadeTemporarilyUnavailablePage()
	}
	if record.Status == oauthstore.BrokerStatusRevoked ||
		record.ClientIDHash != oauthstore.HashKey(clientID) ||
		record.CanonicalResource != routeResource {
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	// R1.4 reuse: a non-zero grace deadline that has passed means the handle was
	// already rotated and the window in which the successor response can be
	// replayed has closed, so presenting it is reuse. The whole grant is revoked
	// before the client is told the grant is invalid.
	if !record.GraceExpiresAt.IsZero() && !ctx.Now().Before(record.GraceExpiresAt) {
		return nil, front.revokeReusedRefreshGrant(ctx, record)
	}
	// R1.5 (ruling R4): scope and resource are validated on EVERY refresh
	// request, including one that will be answered from the grace window, so a
	// request that asks for something other than what the record grants is
	// refused rather than silently served.
	if failure := refreshRequestBindingFailure(form, record); failure != nil {
		return nil, failure
	}
	// R1.6 grace: the rotation completed inside the window, so the successor
	// response is replayed byte-for-byte. This is the idempotent lost-response
	// path and also how a concurrent waiter is served.
	if response, served := refreshGraceResponse(record, ctx.Now()); served {
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
// mode is deliberately not built.
func refreshRequestBindingFailure(
	form url.Values,
	record *oauthstore.RouteRefreshBrokerRecord,
) *apptheory.Response {
	if resource, present := presentFormValue(form, "resource"); present {
		if oauth.CanonicalResourceURL(resource) != record.CanonicalResource {
			return facadeErrorPage(400, facadeErrorInvalidTarget)
		}
	}
	if scope, present := presentFormValue(form, "scope"); present {
		if facadeScopeFingerprint(strings.Fields(scope)) != record.ScopeFingerprint {
			return facadeErrorPage(400, facadeErrorInvalidScope)
		}
	}
	return nil
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
// is still inside its grace window (ruling R1.6). The body is the exact byte
// sequence the winning caller received, so the replay is byte-identical. A
// record that claims a live grace window but carries no stored response is an
// internal inconsistency: it is answered with the retryable class rather than an
// empty success or a false invalid_grant, and it self-heals when the window
// closes and the request becomes reuse.
func refreshGraceResponse(
	record *oauthstore.RouteRefreshBrokerRecord,
	now time.Time,
) (*apptheory.Response, bool) {
	if record.GraceExpiresAt.IsZero() || !now.Before(record.GraceExpiresAt) {
		return nil, false
	}
	if record.EncryptedGraceRefreshResponse == "" {
		return facadeTemporarilyUnavailablePage(), true
	}
	return refreshTokenPage([]byte(record.EncryptedGraceRefreshResponse)), true
}

// rotateRefreshGrant performs the held-lock rotation of ruling R1 step 7. The
// lock is held when this is called, and the returned record is the presented one
// at version+1 with Status refreshing and the lock owner and expiry set.
func (config normalizedConfig) rotateRefreshGrant(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) (*apptheory.Response, error) {
	front := config.frontChannel
	// The ONE upstream refresh call of this rotation is made under the lock, with
	// the client that owns the recorded material.
	upstream, err := front.provider.Refresh(ctx.Context(), oauth.RefreshRequest{
		RefreshMaterial:  locked.EncryptedUpstreamRefreshToken,
		UpstreamClientID: locked.UpstreamClientID,
	})
	if err != nil {
		return config.failedRefreshGrant(ctx, presented, locked, err)
	}
	handle, err := oauth.NewOpaqueToken()
	if err != nil {
		return nil, err
	}
	successor := successorBrokerRecord(presented, handle, upstream)
	// The successor response body is the token response the client receives and
	// the body the grace path replays. It carries the upstream access token
	// byte-for-byte and the framework's own handle, and never an id_token or any
	// upstream refresh material.
	body, err := successorTokenBody(upstream, handle)
	if err != nil {
		return nil, err
	}
	seeder, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerSeeder)
	if !ok {
		// The same fail-closed class openBrokerRecord raises: a broker store that
		// cannot be seeded cannot hold the successor, so the rotation cannot
		// complete and no successor handle may be handed out.
		return nil, errRouteRefreshBrokerNotSeedable
	}
	if err = seeder.Put(ctx.Context(), successor); err != nil {
		return nil, err
	}
	completed := *locked
	completed.EncryptedGraceRefreshResponse = string(body)
	completed.GraceExpiresAt = ctx.Now().Add(refreshGraceWindow)
	completed.Status = oauthstore.BrokerStatusActive
	completed.RefreshLockOwner = ""
	completed.RefreshLockExpiresAt = time.Time{}
	if _, err = front.stores.RouteRefreshBroker.CompareAndSwap(ctx.Context(), &completed, locked.Version); err != nil {
		// The rotation did not land, so the successor handle was never handed to
		// any client. Discard it and fail closed: a success response may never be
		// returned for state that was not persisted. The lock is left to expire,
		// because the compare-and-swap that would release it failed too.
		front.discardRefreshRecord(ctx, successor.HandleHash)
		return facadeTemporarilyUnavailablePage(), nil
	}
	return refreshTokenPage(body), nil
}

// failedRefreshGrant maps a failed upstream refresh call and unwinds the lock
// (ruling R1 step 7's failure section). A terminal provider failure means the
// recorded upstream material is dead, so the presented record is revoked and the
// client is told invalid_grant. Every other failure releases the lock and
// reports its typed response; a failure to release leaves the lock to expire and
// never becomes a success.
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
	case oauth.ProviderInvalidGrant, oauth.ProviderReauthRequired:
		if err := front.revokeBrokerRecord(ctx, presented.HandleHash); err != nil {
			// The grant is dead upstream but could not be revoked here, so the
			// client is not told the handle is invalid while it is still live.
			return facadeTemporarilyUnavailablePage(), nil
		}
		return facadeErrorPage(400, facadeErrorInvalidGrant), nil
	case oauth.ProviderUpstreamError:
		front.releaseRefreshLock(ctx, presented, locked)
		return facadeUpstreamErrorPage(), nil
	default:
		// ProviderTemporarilyUnavailable, and any provider failure the adapter did
		// not classify: transient by default, so the lock is released and the
		// caller is told to retry.
		front.releaseRefreshLock(ctx, presented, locked)
		return facadeTemporarilyUnavailablePage(), nil
	}
}

// revokeReusedRefreshGrant revokes the whole grant a reused handle belongs to
// (ruling R1.4) and renders the response. The presented record is revoked first,
// then every successor the chain names. A store failure during the walk is the
// retryable class rather than invalid_grant: the client must not be allowed to
// act on state the facade could not revoke.
func (front *frontChannelConfig) revokeReusedRefreshGrant(
	ctx *apptheory.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
) *apptheory.Response {
	if err := front.revokeRefreshChain(ctx, record); err != nil {
		return facadeTemporarilyUnavailablePage()
	}
	return facadeErrorPage(400, facadeErrorInvalidGrant)
}

// revokeRefreshChain revokes one record and the successors it names. The chain
// is what a rotation leaves behind: each rotated record stores its successor's
// token response, so parsing that response yields the successor handle to revoke
// next. A record that is already gone is not an error (revocation is idempotent)
// and a stored value that does not parse simply ends the walk, so the presented
// record is revoked either way. The walk is bounded by refreshRevokeChainLimit
// so a crafted or cyclic value can never loop.
func (front *frontChannelConfig) revokeRefreshChain(
	ctx *apptheory.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
) error {
	current := record
	for walked := 0; walked < refreshRevokeChainLimit; walked++ {
		revoked, err := front.stores.RouteRefreshBroker.Revoke(ctx.Context(), current.HandleHash)
		if errors.Is(err, oauthstore.ErrBrokerNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		successor, ok := successorHandleRecord(revoked.EncryptedGraceRefreshResponse)
		if !ok {
			return nil
		}
		current = successor
	}
	return nil
}

// successorHandleRecord reads the successor handle a rotated record stored as
// its grace response. Only the handle is needed to revoke the successor, so the
// walk never has to read it. An unparseable value, an empty handle, and an
// oversized one all end the walk.
func successorHandleRecord(stored string) (*oauthstore.RouteRefreshBrokerRecord, bool) {
	if stored == "" {
		return nil, false
	}
	var payload struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal([]byte(stored), &payload); err != nil {
		return nil, false
	}
	handle := strings.TrimSpace(payload.RefreshToken)
	if handle == "" || len(handle) > frontChannelMaxRefreshHandleBytes {
		return nil, false
	}
	return &oauthstore.RouteRefreshBrokerRecord{HandleHash: oauthstore.HashKey(handle)}, true
}

// revokeBrokerRecord revokes one broker record. A record that is already gone is
// not an error, because revocation is idempotent; every other store failure is
// reported.
func (front *frontChannelConfig) revokeBrokerRecord(ctx *apptheory.Context, handleHash string) error {
	if _, err := front.stores.RouteRefreshBroker.Revoke(ctx.Context(), handleHash); err != nil &&
		!errors.Is(err, oauthstore.ErrBrokerNotFound) {
		return err
	}
	return nil
}

// discardRefreshRecord discards a successor record that was persisted but never
// handed to a client. It is best effort: the handle is unreachable, so a failed
// discard only leaves a record nothing can present.
func (front *frontChannelConfig) discardRefreshRecord(ctx *apptheory.Context, handleHash string) {
	if _, err := front.stores.RouteRefreshBroker.Revoke(ctx.Context(), handleHash); err != nil {
		return
	}
}

// releaseRefreshLock returns a locked record to the status it had before the
// lock was taken, with the lock cleared, so a caller that failed for a transient
// reason can try again instead of waiting out the lock TTL. It is best effort: a
// failed release leaves the lock to expire, which delays the next attempt but
// never reports a success.
func (front *frontChannelConfig) releaseRefreshLock(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
) {
	released := *locked
	released.RefreshLockOwner = ""
	released.RefreshLockExpiresAt = time.Time{}
	released.Status = presented.Status
	if _, err := front.stores.RouteRefreshBroker.CompareAndSwap(ctx.Context(), &released, locked.Version); err != nil {
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
