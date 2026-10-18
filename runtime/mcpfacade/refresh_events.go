package mcpfacade

import (
	"context"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// RouteRefreshEventClass is the closed class vocabulary of the route refresh
// broker telemetry the framework emits. The set follows the families the TMS
// SPEC names (SPEC.md:346-352): broker issuance, local validation rejections,
// refresh lock acquisition, coalesced service from a stored grace response,
// successful refresh, reuse classification, upstream rejection attribution, and
// broker state failures.
type RouteRefreshEventClass string

const (
	// RouteRefreshEventIssued is emitted when the code exchange opens a broker
	// record and mints the chain root handle.
	RouteRefreshEventIssued RouteRefreshEventClass = "issued"
	// RouteRefreshEventValidationRejected is emitted when a refresh presentation
	// is refused by a local check. The client-facing body stays the uniform
	// invalid_grant for record-state failures.
	RouteRefreshEventValidationRejected RouteRefreshEventClass = "validation_rejected"
	// RouteRefreshEventLockAcquired is emitted when the facade takes the route
	// refresh lock before a rotation or a depth-1 serve.
	RouteRefreshEventLockAcquired RouteRefreshEventClass = "lock_acquired"
	// RouteRefreshEventGraceServed is emitted when a rotated-away handle inside
	// its grace window replays the stored successor body.
	RouteRefreshEventGraceServed RouteRefreshEventClass = "grace_served"
	// RouteRefreshEventRefreshed is emitted after a rotation is persisted and
	// the successor handle is handed to the client.
	RouteRefreshEventRefreshed RouteRefreshEventClass = "refreshed"
	// RouteRefreshEventReuse is emitted on EVERY out-of-grace presentation of a
	// rotated-away handle, whatever the classification and outcome.
	RouteRefreshEventReuse RouteRefreshEventClass = "reuse"
	// RouteRefreshEventUpstreamReauthRequired is emitted when the upstream
	// rejects the recorded refresh material terminally.
	RouteRefreshEventUpstreamReauthRequired RouteRefreshEventClass = "upstream_reauth_required"
	// RouteRefreshEventStateFailure is emitted when a store, lock, rewrite, or
	// revocation operation fails, so the retryable class is attributable.
	RouteRefreshEventStateFailure RouteRefreshEventClass = "state_failure"
)

// Reuse outcomes. They are the `Outcome` of a RouteRefreshEventReuse, and they
// are deliberately distinct from the client-facing response, which is the same
// uniform invalid_grant for every terminal outcome.
const (
	// RouteRefreshOutcomeAccessTokenOnly is a beyond-grace depth-1 presentation
	// answered with the access token only.
	RouteRefreshOutcomeAccessTokenOnly = "access_token_only"
	// RouteRefreshOutcomeRevokedFamily is a theft-class presentation answered by
	// revoking the whole family through the store's family capability.
	RouteRefreshOutcomeRevokedFamily = "revoked_family"
	// RouteRefreshOutcomeRevokedWalk is a theft-class presentation answered by
	// the bounded successor walk, because no family hash or no family capability
	// was available.
	RouteRefreshOutcomeRevokedWalk = "revoked_walk"
	// RouteRefreshOutcomeRateLimited is a depth-1 presentation refused by the
	// per-family hourly budget.
	RouteRefreshOutcomeRateLimited = "rate_limited"
	// RouteRefreshOutcomeBindingRejected is a depth-1 presentation whose scope or
	// resource binding was refused before any serve.
	RouteRefreshOutcomeBindingRejected = "binding_rejected"
)

// Failure reasons. They are the `Reason` of a validation-rejected or state
// failure event.
const (
	RouteRefreshReasonHandleMalformed         = "handle_malformed"
	RouteRefreshReasonClientRejected          = "client_rejected"
	RouteRefreshReasonRecordAbsent            = "record_absent"
	RouteRefreshReasonRecordExpired           = "record_expired"
	RouteRefreshReasonRecordRevoked           = "record_revoked"
	RouteRefreshReasonClientMismatch          = "client_mismatch"
	RouteRefreshReasonResourceMismatch        = "resource_mismatch"
	RouteRefreshReasonBindingRejected         = "binding_rejected"
	RouteRefreshReasonLockContention          = "lock_contention"
	RouteRefreshReasonStoreFailure            = "store_failure"
	RouteRefreshReasonRewriteFailure          = "rewrite_failure"
	RouteRefreshReasonFamilyRevokeUnavailable = "family_revoke_unavailable"
	RouteRefreshReasonFamilyRevokeFailed      = "family_revoke_failed"
	RouteRefreshReasonAlreadyServed           = "already_served"
	RouteRefreshReasonUpstreamRejected        = "upstream_rejected"
	RouteRefreshReasonSuccessorBody           = "successor_body"
	RouteRefreshReasonAccessTokenOnly         = "access_token_only"
)

// Expiry signals. The store distinguishes an aged-out handle from one that
// never existed; the client-facing body does not.
const (
	RouteRefreshExpirySignalAbsent  = "absent"
	RouteRefreshExpirySignalExpired = "expired"
)

// RouteRefreshEvent is one schema-redacted route refresh broker telemetry
// event. Every identifier is a hash or a route-derived value; the event never
// carries an authorization code, an access token, an upstream refresh token, a
// route refresh handle, an ID token, a cookie, or provider session material.
type RouteRefreshEvent struct {
	Class RouteRefreshEventClass
	// Reason is the failure or trigger reason vocabulary above.
	Reason string
	// Outcome is the reuse outcome vocabulary above.
	Outcome string
	// ErrorCode is the client-facing OAuth error code the request received, when
	// one was rendered.
	ErrorCode string
	// At is the framework clock instant the event describes.
	At time.Time

	Issuer            string
	Stage             string
	CanonicalResource string
	ClientNamespace   string
	EndpointKind      string
	PartnerID         string
	AgentID           string

	ClientIDHash                     string
	SubjectIDHash                    string
	HandleHash                       string
	FamilyHash                       string
	SuccessorHandleHash              string
	UpstreamRefreshTokenHash         string
	PreviousUpstreamRefreshTokenHash string
	ScopeFingerprint                 string

	StatusFrom string
	StatusTo   string

	// ChainGeneration is the presented record's family generation, 0 for a
	// record that predates the policy.
	ChainGeneration int
	// ChainDepth is the classified distance from the presented handle to the
	// head: 1 for an immediate-predecessor replay, 2 for a deeper replay (the
	// value is capped at 2 because every depth at or above 2 is theft class).
	ChainDepth int
	// ExpirySignal is absent or expired for a record-state rejection.
	ExpirySignal string
	// UpstreamClass is the provider error class for upstream attribution.
	UpstreamClass string
	// RevokedRecords is how many records a family or walk revocation handled.
	RevokedRecords int
}

// RouteRefreshEventHook receives one route refresh broker event. It runs
// synchronously on the request path, after the state transition it describes
// has been decided. A hook must not block or retain the event for later
// mutation; a panic is recovered so telemetry can never fail a refresh.
type RouteRefreshEventHook func(ctx context.Context, event RouteRefreshEvent)

// emitRouteRefresh delivers one event to the configured hook. A nil hook is a
// no-op, and a panicking hook is contained.
func (front *frontChannelConfig) emitRouteRefresh(ctx context.Context, event RouteRefreshEvent) {
	if front == nil || front.events == nil {
		return
	}
	defer func() {
		//nolint:errcheck // recover is the containment mechanism; its value is intentionally discarded.
		_ = recover()
	}()
	front.events(ctx, event)
}

// emitLockAcquired reports a successful refresh lock acquisition. The depth is
// 1 for a beyond-grace depth-1 serve and 0 for a rotation.
func (front *frontChannelConfig) emitLockAcquired(
	ctx *apptheory.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
	depth int,
) {
	if front == nil {
		return
	}
	event := eventFromRecord(record)
	event.Class = RouteRefreshEventLockAcquired
	event.StatusTo = oauthstore.BrokerStatusRefreshing
	event.ChainDepth = depth
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
}

// emitValidationRejected reports a local validation rejection the request had
// no record identity to attribute yet.
func (front *frontChannelConfig) emitValidationRejected(
	ctx *apptheory.Context,
	reason string,
	errorCode string,
) {
	if front == nil {
		return
	}
	front.emitRouteRefresh(ctx.Context(), RouteRefreshEvent{
		Class:     RouteRefreshEventValidationRejected,
		Reason:    reason,
		ErrorCode: errorCode,
		At:        ctx.Now(),
	})
}

// emitRecordStateRejection reports a record-state rejection, including the
// store's internal absent-versus-expired signal. The client-facing body stays
// the uniform invalid_grant.
func (front *frontChannelConfig) emitRecordStateRejection(
	ctx *apptheory.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
	reason string,
	expirySignal string,
) {
	if front == nil {
		return
	}
	event := eventFromRecord(record)
	event.Class = RouteRefreshEventValidationRejected
	event.Reason = reason
	event.ErrorCode = facadeErrorInvalidGrant
	event.ExpirySignal = expirySignal
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
}

// emitStateFailure reports a store, lock, rewrite, or upstream failure that
// rendered the retryable class.
func (front *frontChannelConfig) emitStateFailure(
	ctx *apptheory.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
	reason string,
	upstreamClass string,
) {
	if front == nil {
		return
	}
	event := eventFromRecord(record)
	event.Class = RouteRefreshEventStateFailure
	event.Reason = reason
	event.UpstreamClass = upstreamClass
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
}

// eventFromRecord copies the identity fields every route refresh event carries
// from a broker record.
func eventFromRecord(record *oauthstore.RouteRefreshBrokerRecord) RouteRefreshEvent {
	if record == nil {
		return RouteRefreshEvent{}
	}
	return RouteRefreshEvent{
		Issuer:            record.Issuer,
		Stage:             record.Stage,
		CanonicalResource: record.CanonicalResource,
		ClientNamespace:   record.ClientNamespace,
		EndpointKind:      record.EndpointKind,
		PartnerID:         record.PartnerID,
		AgentID:           record.AgentID,
		ClientIDHash:      record.ClientIDHash,
		SubjectIDHash:     record.SubjectIDHash,
		HandleHash:        record.HandleHash,
		FamilyHash:        record.FamilyHash,
		ScopeFingerprint:  record.ScopeFingerprint,
		ChainGeneration:   record.ChainGeneration,
		StatusFrom:        record.Status,
	}
}
