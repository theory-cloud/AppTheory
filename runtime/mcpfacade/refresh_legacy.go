package mcpfacade

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// legacyLineageWalkLimit bounds how many stored successor links the migration
// follows before giving up. A v6.4.0-era chain can be long (one link per
// refresh), and the walk only ever follows server-written bodies, so the bound
// is a corruption guard rather than a security decision.
const legacyLineageWalkLimit = 64

// adoptLegacyLineage migrates a family-less record — a handle minted before the
// family policy, including a v6.4.0-era lineage — onto a fresh refresh family in
// code, with no manual data operation. It follows the stored successor links to
// the lineage's live head (the only record whose upstream material is current),
// then mints a generation-1 family root from that material and returns its token
// response. A sibling migration that already adopted the lineage is detected by
// finding a family-marked record at the end of the walk, and the caller continues
// on the ordinary family path.
//
// A nil record and a nil response mean "retry the loop": another process holds
// the head's lock, or a concurrent migration won the family-create race. A
// non-nil response ends the request, and a nil record with a non-nil response is
// the terminal class.
//
//nolint:gocyclo // the migration order is the security contract.
func (config normalizedConfig) adoptLegacyLineage(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
) (*oauthstore.RouteRefreshBrokerRecord, *apptheory.Response, error) {
	front := config.frontChannel
	head, ok := front.legacyLineageHead(ctx, presented)
	if !ok {
		event := eventFromRecord(presented)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonLegacyLineage
		event.ErrorCode = facadeErrorInvalidGrant
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
	}
	if head.FamilyHash != "" {
		return head, nil, nil
	}
	if head.Status == oauthstore.BrokerStatusRevoked {
		event := eventFromRecord(head)
		event.Class = RouteRefreshEventValidationRejected
		event.Reason = RouteRefreshReasonRecordRevoked
		event.ErrorCode = facadeErrorInvalidGrant
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
	}
	lockOwner, err := oauth.NewOpaqueToken()
	if err != nil {
		return nil, nil, err
	}
	locked, lockErr := front.stores.RouteRefreshBroker.AcquireLock(
		ctx.Context(), head.HandleHash, lockOwner, head.Version)
	if lockErr != nil {
		switch {
		case errors.Is(lockErr, oauthstore.ErrBrokerLocked),
			errors.Is(lockErr, oauthstore.ErrBrokerVersionConflict):
			return nil, nil, nil
		case errors.Is(lockErr, oauthstore.ErrBrokerRevoked),
			errors.Is(lockErr, oauthstore.ErrBrokerNotFound),
			errors.Is(lockErr, oauthstore.ErrBrokerExpired):
			front.emitRecordStateRejection(ctx, head, RouteRefreshReasonRecordExpired, "")
			return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
		default:
			front.emitStateFailure(ctx, head, RouteRefreshReasonStoreFailure, "")
			return nil, facadeTemporarilyUnavailablePage(), nil
		}
	}
	front.emitLockAcquired(ctx, locked)
	attempted, intentResponse, intentErr := config.takeRotationIntent(ctx, head, locked)
	if intentErr != nil || intentResponse != nil {
		return nil, intentResponse, intentErr
	}
	locked = attempted
	upstream, refreshErr := front.refreshUpstream(ctx.Context(), locked)
	if refreshErr != nil {
		return config.failedLegacyAdoption(ctx, head, locked, refreshErr)
	}
	handle, err := oauth.NewOpaqueToken()
	if err != nil {
		front.releaseRefreshLock(ctx, head, locked)
		return nil, nil, err
	}
	material := upstream.RefreshToken
	if strings.TrimSpace(material) == "" {
		material = locked.EncryptedUpstreamRefreshToken
	}
	root := &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(handle),
		FamilyHash:                    oauthstore.HashKey(handle),
		ChainGeneration:               refreshChainRootGeneration,
		Issuer:                        head.Issuer,
		Stage:                         head.Stage,
		CanonicalResource:             head.CanonicalResource,
		ClientNamespace:               head.ClientNamespace,
		EndpointKind:                  head.EndpointKind,
		PartnerID:                     head.PartnerID,
		AgentID:                       head.AgentID,
		ClientIDHash:                  head.ClientIDHash,
		SubjectIDHash:                 head.SubjectIDHash,
		Scopes:                        append([]string(nil), head.Scopes...),
		ScopeFingerprint:              head.ScopeFingerprint,
		EncryptedUpstreamRefreshToken: material,
		UpstreamRefreshTokenHash:      oauthstore.HashKey(material),
		UpstreamClientID:              head.UpstreamClientID,
		Status:                        oauthstore.BrokerStatusIssued,
	}
	body, err := successorTokenBody(upstream, handle)
	if err != nil {
		front.releaseRefreshLock(ctx, head, locked)
		return nil, nil, err
	}
	familyStore, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		front.releaseRefreshLock(ctx, head, locked)
		return nil, nil, errRouteRefreshBrokerFamilyCapabilityMissing
	}
	stored, createErr := familyStore.CreateFamily(ctx.Context(), root)
	if createErr != nil {
		front.releaseRefreshLock(ctx, head, locked)
		switch {
		case errors.Is(createErr, oauthstore.ErrBrokerFamilyExists),
			errors.Is(createErr, oauthstore.ErrBrokerSuccessorExists):
			// A concurrent migration won: the next walk finds its root through
			// the re-armed head body.
			return nil, nil, nil
		default:
			front.emitStateFailure(ctx, head, RouteRefreshReasonRewriteFailure, "")
			return nil, facadeTemporarilyUnavailablePage(), nil
		}
	}
	graceAt := ctx.Now().Add(front.policy.GraceWindow)
	accessAt := ctx.Now().Add(accessTokenLifetime(upstream))
	front.markLegacyHeadAdopted(ctx, head, body, graceAt, accessAt)

	issued := eventFromRecord(stored)
	issued.Class = RouteRefreshEventIssued
	issued.StatusTo = oauthstore.BrokerStatusIssued
	issued.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), issued)

	event := eventFromRecord(head)
	event.Class = RouteRefreshEventRefreshed
	event.Reason = RouteRefreshReasonLegacyLineageAdopted
	event.StatusFrom = oauthstore.BrokerStatusActive
	event.StatusTo = oauthstore.BrokerStatusActive
	event.SuccessorHandleHash = stored.HandleHash
	event.FamilyHash = stored.FamilyHash
	event.ChainGeneration = stored.ChainGeneration
	event.PreviousUpstreamRefreshTokenHash = head.UpstreamRefreshTokenHash
	event.UpstreamRefreshTokenHash = stored.UpstreamRefreshTokenHash
	event.At = ctx.Now()
	front.emitRouteRefresh(ctx.Context(), event)
	return nil, refreshTokenPage(body), nil
}

// failedLegacyAdoption maps a failed upstream refresh during migration. Only an
// upstream invalid_grant may revoke the legacy head — it can never be migrated —
// and only on corroborated evidence: an unconfirmed rotation attempt inside the
// ambiguity horizon keeps the head and answers transiently, exactly like the
// family path. Every other class releases the lock: transient and upstream
// failures are retryable and must not cost the client its lineage.
func (config normalizedConfig) failedLegacyAdoption(
	ctx *apptheory.Context,
	head *oauthstore.RouteRefreshBrokerRecord,
	locked *oauthstore.RouteRefreshBrokerRecord,
	upstreamErr error,
) (*oauthstore.RouteRefreshBrokerRecord, *apptheory.Response, error) {
	front := config.frontChannel
	class := oauth.ProviderTemporarilyUnavailable
	if providerErr, ok := oauth.AsProviderError(upstreamErr); ok {
		class = providerErr.Class
	}
	switch class {
	case oauth.ProviderInvalidGrant:
		if front.refreshVerdictAmbiguous(head, ctx.Now()) {
			front.releaseRefreshLock(ctx, head, locked)
			event := eventFromRecord(head)
			event.Class = RouteRefreshEventStateFailure
			event.Reason = RouteRefreshReasonRecoveryPending
			event.UpstreamClass = string(class)
			event.ErrorCode = facadeErrorTemporarilyUnavailable
			event.At = ctx.Now()
			front.emitRouteRefresh(ctx.Context(), event)
			return nil, facadeTemporarilyUnavailablePage(), nil
		}
		front.releaseRefreshLock(ctx, head, locked)
		if _, err := front.stores.RouteRefreshBroker.Revoke(ctx.Context(), head.HandleHash); err != nil {
			front.emitStateFailure(ctx, head, RouteRefreshReasonStoreFailure, string(class))
			return nil, facadeTemporarilyUnavailablePage(), nil
		}
		event := eventFromRecord(head)
		event.Class = RouteRefreshEventUpstreamReauthRequired
		event.Reason = RouteRefreshReasonUpstreamRejected
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorInvalidGrant
		event.StatusTo = oauthstore.BrokerStatusRevoked
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
	case oauth.ProviderUpstreamError:
		front.releaseRefreshLock(ctx, head, locked)
		event := eventFromRecord(head)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonUpstreamRejected
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorUpstream
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, facadeUpstreamErrorPage(), nil
	default:
		front.releaseRefreshLock(ctx, head, locked)
		event := eventFromRecord(head)
		event.Class = RouteRefreshEventStateFailure
		event.Reason = RouteRefreshReasonUpstreamRejected
		event.UpstreamClass = string(class)
		event.ErrorCode = facadeErrorTemporarilyUnavailable
		event.At = ctx.Now()
		front.emitRouteRefresh(ctx.Context(), event)
		return nil, facadeTemporarilyUnavailablePage(), nil
	}
}

// legacyLineageHead follows the stored successor links of a family-less lineage
// to the only record whose upstream material can still be refreshed. A
// family-marked record ends the walk successfully (a sibling adopted the
// lineage); a missing link, a cycle, a revoked member, or the walk limit fails
// the migration rather than guessing which material is current.
func (front *frontChannelConfig) legacyLineageHead(
	ctx *apptheory.Context,
	presented *oauthstore.RouteRefreshBrokerRecord,
) (*oauthstore.RouteRefreshBrokerRecord, bool) {
	current := presented
	visited := make(map[string]bool, legacyLineageWalkLimit)
	for step := 0; step < legacyLineageWalkLimit; step++ {
		if current == nil || visited[current.HandleHash] {
			return nil, false
		}
		visited[current.HandleHash] = true
		if current.FamilyHash != "" {
			return current, true
		}
		if current.Status == oauthstore.BrokerStatusRevoked {
			return nil, false
		}
		if current.GraceExpiresAt.IsZero() {
			return current, true
		}
		successorHandle, ok := legacySuccessorHandle(current.EncryptedGraceRefreshResponse)
		if !ok {
			return nil, false
		}
		next, err := front.stores.RouteRefreshBroker.Get(ctx.Context(), oauthstore.HashKey(successorHandle))
		if err != nil {
			return nil, false
		}
		current = next
	}
	return nil, false
}

// legacySuccessorHandle reads the successor handle a pre-policy rotation stored
// in its grace body. Both v6.4.0 serve shapes stored the full successor response,
// so the link is present; a body that is absent, unreadable, or shaped otherwise
// is not guessed.
func legacySuccessorHandle(body string) (string, bool) {
	if strings.TrimSpace(body) == "" {
		return "", false
	}
	var payload struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return "", false
	}
	handle := strings.TrimSpace(payload.RefreshToken)
	if handle == "" || len(handle) > frontChannelMaxRefreshHandleBytes {
		return "", false
	}
	return handle, true
}

// markLegacyHeadAdopted records the new family root in the legacy head's grace
// body, so a sibling walk lands on the family instead of minting a second one.
// It is best effort: a failed compare-and-swap only means the next sibling
// migration mints its own family, which still serves the client.
func (front *frontChannelConfig) markLegacyHeadAdopted(
	ctx *apptheory.Context,
	head *oauthstore.RouteRefreshBrokerRecord,
	body []byte,
	graceExpiresAt, accessExpiresAt time.Time,
) {
	current, err := front.stores.RouteRefreshBroker.Get(ctx.Context(), head.HandleHash)
	if err != nil {
		return
	}
	updated := *current
	updated.EncryptedGraceRefreshResponse = string(body)
	updated.GraceExpiresAt = graceExpiresAt
	updated.GraceAccessTokenExpiresAt = accessExpiresAt
	// The adoption consumed the material and stored the family root, so the
	// rotation intent is resolved here too.
	updated.RotationUnconfirmedAt = time.Time{}
	updated.Status = oauthstore.BrokerStatusActive
	updated.RefreshLockOwner = ""
	updated.RefreshLockExpiresAt = time.Time{}
	if _, err := front.stores.RouteRefreshBroker.CompareAndSwap(
		ctx.Context(), &updated, current.Version,
	); err != nil {
		return
	}
}
