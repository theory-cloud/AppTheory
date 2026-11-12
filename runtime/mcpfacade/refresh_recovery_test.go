package mcpfacade

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// refreshOverride wraps a provider and replaces its Refresh call, so a test can
// script the upstream sequence the local fake cannot produce: a rotation whose
// response is lost after the upstream consumed the material, or a verdict that
// arrives on a later attempt.
type refreshOverride struct {
	oauth.Provider
	refresh func(context.Context, oauth.RefreshRequest) (*oauth.TokenSet, error)
}

func (p *refreshOverride) Refresh(ctx context.Context, req oauth.RefreshRequest) (*oauth.TokenSet, error) {
	return p.refresh(ctx, req)
}

// scriptedRefresh serves a fixed sequence of refresh outcomes; the last step
// repeats, so a script can describe "the upstream keeps answering X".
type scriptedRefresh struct {
	mu    sync.Mutex
	steps []func(context.Context) (*oauth.TokenSet, error)
	calls int
}

func (s *scriptedRefresh) next(ctx context.Context) (*oauth.TokenSet, error) {
	s.mu.Lock()
	index := s.calls
	s.calls++
	steps := s.steps
	s.mu.Unlock()
	if len(steps) == 0 {
		return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "no scripted step")
	}
	if index >= len(steps) {
		index = len(steps) - 1
	}
	return steps[index](ctx)
}

func (s *scriptedRefresh) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// refreshTokenSet is the successor a scripted step hands back: the fake's own
// rotated material, so the facade's body and successor record are the real ones.
func refreshTokenSet() *oauth.TokenSet {
	return &oauth.TokenSet{
		AccessToken:  frontTestRefreshAccessToken,
		RefreshToken: frontTestRotatedUpstreamRefreshToken,
		TokenType:    "Bearer",
		ExpiresIn:    900,
		Scope:        frontTestRotatedUpstreamScope,
	}
}

// TestRefreshGrantReauthRequiredKeepsTheFamily pins the recovery-available
// classification of a stale-or-replaced upstream signal: the family and the
// session survive, the lock is released, and the client is told to retry rather
// than to re-authorize. Under the rotation-recovery contract a stale or replaced
// material is walked to its successor; it is never a family verdict.
func TestRefreshGrantReauthRequiredKeepsTheFamily(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	script := harness.scriptRefresh(
		func(context.Context) (*oauth.TokenSet, error) {
			return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "upstream reported stale material")
		},
		func(context.Context) (*oauth.TokenSet, error) { return refreshTokenSet(), nil },
	)

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	require.Contains(t, string(response.Body), `"error":"temporarily_unavailable"`)
	require.Equal(t, []string{"1"}, response.Headers["retry-after"])
	requireFamilyActive(t, harness, handle)
	require.Equal(t, 1, script.callCount())

	recovered := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, recovered.Status)
	require.Equal(t, 2, script.callCount())
	require.Equal(t, oauthstore.BrokerStatusActive, brokerRecord(t, harness, handle).Status)
}

// TestRefreshGrantPerRequestUpstreamErrorNeverFamilies pins contract R6/R7 at
// the facade: every per-request client code the upstream can answer with is an
// upstream failure, never a family verdict. The presented handle keeps working,
// no revocation event is emitted, and the family stays alive.
func TestRefreshGrantPerRequestUpstreamErrorNeverFamilies(t *testing.T) {
	for _, code := range []string{
		"invalid_scope",
		"invalid_request",
		"access_denied",
		"expired_token",
		"invalid_token",
		"invalid_client",
		"unauthorized_client",
	} {
		t.Run(code, func(t *testing.T) {
			var events []RouteRefreshEvent
			var mu sync.Mutex
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
				routeRefreshEvents: func(_ context.Context, event RouteRefreshEvent) {
					mu.Lock()
					events = append(events, event)
					mu.Unlock()
				},
			})
			handle := mintedRefreshHandle(t, harness)
			harness.scriptRefresh(
				func(context.Context) (*oauth.TokenSet, error) {
					return nil, oauth.NewProviderError(oauth.ProviderUpstreamError, "refresh", "upstream refused the request")
				},
				func(context.Context) (*oauth.TokenSet, error) { return refreshTokenSet(), nil },
			)

			response := harness.token(refreshTestForm(handle))
			require.Equal(t, 502, response.Status)
			require.Contains(t, string(response.Body), `"error":"upstream_error"`)
			requireFamilyActive(t, harness, handle)

			mu.Lock()
			for _, event := range events {
				require.NotEqualf(t, RouteRefreshEventUpstreamReauthRequired, event.Class,
					"code %q emitted a terminal revocation event", code)
				require.NotEqualf(t, RouteRefreshOutcomeRevokedFamily, event.Outcome,
					"code %q emitted a revocation outcome", code)
			}
			mu.Unlock()

			recovered := harness.token(refreshTestForm(handle))
			require.Equal(t, 200, recovered.Status)
		})
	}
}

// TestRefreshGrantLostRotationRecoversThroughLineage reproduces the 2026-11-11
// 16:00Z shape at the facade plane: the upstream consumed the material and
// minted a successor, the response was lost to a timeout, and the retry presents
// the consumed handle. The facade records the unconfirmed attempt before it
// presents anything, keeps the family, and recovers on the next attempt through
// the recovery path instead of treating the loss as a family verdict.
func TestRefreshGrantLostRotationRecoversThroughLineage(t *testing.T) {
	var (
		markerDuringPre = time.Time{}
		handleForCheck  string
		harnessRef      *frontChannelHarness
	)
	timeout := func(ctx context.Context) (*oauth.TokenSet, error) {
		if harnessRef != nil && handleForCheck != "" {
			record, err := harnessRef.stores.RouteRefreshBroker.Get(ctx, oauthstore.HashKey(handleForCheck))
			if err == nil {
				markerDuringPre = record.RotationUnconfirmedAt
			}
		}
		// The upstream minted and then the response was lost: a retryable failure
		// reaching the facade with no answer.
		return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "upstream response lost after rotation")
	}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		providerWrapper: func(inner oauth.Provider) oauth.Provider {
			script := &scriptedRefresh{steps: []func(context.Context) (*oauth.TokenSet, error){
				timeout,
				func(context.Context) (*oauth.TokenSet, error) { return refreshTokenSet(), nil },
			}}
			return &refreshOverride{Provider: inner, refresh: func(ctx context.Context, _ oauth.RefreshRequest) (*oauth.TokenSet, error) {
				return script.next(ctx)
			}}
		},
	})
	harnessRef = harness
	handleForCheck = mintedRefreshHandle(t, harness)

	lost := harness.token(refreshTestForm(handleForCheck))
	require.Equal(t, 503, lost.Status)
	require.False(t, markerDuringPre.IsZero(),
		"the facade must persist the rotation intent before it presents upstream material")
	requireFamilyActive(t, harness, handleForCheck)
	record := brokerRecord(t, harness, handleForCheck)
	require.False(t, record.RotationUnconfirmedAt.IsZero(),
		"the lost rotation must leave the unconfirmed marker behind")
	require.Equal(t, oauthstore.BrokerStatusIssued, record.Status)
	require.Empty(t, record.RefreshLockOwner)

	recovered := harness.token(refreshTestForm(handleForCheck))
	require.Equal(t, 200, recovered.Status)
	require.NotEqual(t, handleForCheck, refreshResponseHandle(t, recovered))
	rotated := brokerRecord(t, harness, handleForCheck)
	require.Equal(t, oauthstore.BrokerStatusActive, rotated.Status)
	require.True(t, rotated.RotationUnconfirmedAt.IsZero(),
		"a confirmed rotation must clear the unconfirmed marker")
	requireFamilyActive(t, harness, handleForCheck)
}

// TestRefreshGrantUnconfirmedVerdictIsTransientInsideTheHorizon pins the
// ambiguity rule that keeps a lost rotation from becoming a family kill: while an
// unconfirmed attempt is inside the facade's ambiguity horizon (its configured
// grace window), an upstream invalid_grant is answered transiently and the family
// survives. Once the horizon has passed with no recovery, the same verdict is
// corroborated terminal evidence and the family is revoked with a receipt.
func TestRefreshGrantUnconfirmedVerdictIsTransientInsideTheHorizon(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		providerWrapper: func(inner oauth.Provider) oauth.Provider {
			script := &scriptedRefresh{steps: []func(context.Context) (*oauth.TokenSet, error){
				func(context.Context) (*oauth.TokenSet, error) {
					return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "upstream response lost after rotation")
				},
				func(context.Context) (*oauth.TokenSet, error) {
					return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant rejected")
				},
			}}
			return &refreshOverride{Provider: inner, refresh: func(ctx context.Context, _ oauth.RefreshRequest) (*oauth.TokenSet, error) {
				return script.next(ctx)
			}}
		},
	})
	handle := mintedRefreshHandle(t, harness)

	require.Equal(t, 503, harness.token(refreshTestForm(handle)).Status)

	ambiguous := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, ambiguous.Status,
		"a verdict that may be a lost rotation is never rendered as terminal inside the horizon")
	require.Equal(t, []string{"1"}, ambiguous.Headers["retry-after"])
	requireFamilyActive(t, harness, handle)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	terminal := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, terminal.Status)
	require.Contains(t, string(terminal.Body), `"error":"invalid_grant"`)
	requireFamilyRevoked(t, harness, handle)
}

// TestRefreshGrantVerdictAboutSupersededMaterialNeverRevokes pins the lineage
// half of the terminal gate: an invalid_grant about a presentation whose family
// head already moved on is evidence about superseded material, so it is answered
// transiently and the family keeps working.
func TestRefreshGrantVerdictAboutSupersededMaterialNeverRevokes(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)

	// Model the sweep's view: the family's live head is now the successor, while the
	// old handle is presented again after an unconfirmed-attempt marker was written.
	predecessor := brokerRecord(t, harness, handle)
	require.NotEmpty(t, predecessor.FamilyHash)
	updated := *predecessor
	updated.GraceExpiresAt = time.Time{}
	updated.RotationUnconfirmedAt = harness.clock.Now()
	_, err := harness.stores.RouteRefreshBroker.CompareAndSwap(context.Background(), &updated, predecessor.Version)
	require.NoError(t, err)

	head := liveFamilyHead(mustListFamily(t, harness, predecessor.FamilyHash))
	require.NotNil(t, head)
	require.NotEqual(t, predecessor.HandleHash, head.HandleHash)

	require.Equal(t, terminalRefreshSuperseded,
		(&frontChannelConfig{stores: harness.stores}).terminalRefreshEvidence(nil, &updated))
}

// TestRefreshGrantMintsNothingWhenTheRotationWriteFails proves the shipped
// persist-before-ack invariant through the new rotation-intent write: when the
// rotation transaction cannot land, the client receives the retryable class, no
// successor handle is handed out, no record is created, and the presented handle
// is still usable.
func TestRefreshGrantMintsNothingWhenTheRotationWriteFails(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	before := len(harness.broker.handleHashes())

	harness.broker.rotateFamilyErr = oauthstore.ErrBrokerFamilyStateUnavailable
	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	require.NotContains(t, string(response.Body), `"access_token"`)
	require.NotContains(t, string(response.Body), `"refresh_token"`)
	require.Equal(t, before, len(harness.broker.handleHashes()),
		"a failed rotation transaction must not leave a successor record")
	requireFamilyActive(t, harness, handle)
	require.Equal(t, oauthstore.BrokerStatusIssued, brokerRecord(t, harness, handle).Status)

	harness.broker.rotateFamilyErr = nil
	recovered := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, recovered.Status)
	require.NotEqual(t, handle, refreshResponseHandle(t, recovered))
}

// TestRefreshBudgetIsEncodedConfiguration pins the budget as configuration: a
// zero policy selects the documented default, the accepted range is bounded by
// the broker lock TTL, an out-of-range value is a registration error (never a
// silent fallback), and the facade passes a deadline of exactly the configured
// budget to the upstream call.
func TestRefreshBudgetIsEncodedConfiguration(t *testing.T) {
	base := RouteRefreshPolicy{
		HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
		ReuseRateCeiling: MinRefreshReuseRateCeiling,
	}
	normalized, err := base.normalized()
	require.NoError(t, err)
	require.Equal(t, DefaultRefreshBudget, normalized.RefreshBudget)
	require.Less(t, MaxRefreshBudget, oauthstore.DefaultRouteRefreshLockTTL,
		"the budget must leave room inside the lock it holds")
	require.Equal(t, oauthstore.DefaultRouteRefreshLockTTL-refreshBudgetLockMargin, MaxRefreshBudget)

	for _, budget := range []time.Duration{MinRefreshBudget / 2, MaxRefreshBudget + time.Second} {
		policy := base
		policy.RefreshBudget = budget
		_, budgetErr := policy.normalized()
		require.Error(t, budgetErr)
	}

	accepted := base
	accepted.RefreshBudget = 2 * time.Second
	normalized, err = accepted.normalized()
	require.NoError(t, err)
	require.Equal(t, 2*time.Second, normalized.RefreshBudget)

	// The facade enforces the configured budget as the deadline of the upstream
	// call, so an adapter that ignores its own default still cannot outlive it.
	var observed time.Duration
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshPolicy: func(policy *RouteRefreshPolicy) { policy.RefreshBudget = 2 * time.Second },
		providerWrapper: func(inner oauth.Provider) oauth.Provider {
			return &refreshOverride{Provider: inner, refresh: func(ctx context.Context, req oauth.RefreshRequest) (*oauth.TokenSet, error) {
				deadline, ok := ctx.Deadline()
				require.True(t, ok, "the upstream call must carry a deadline")
				observed = time.Until(deadline)
				return inner.Refresh(ctx, req)
			}}
		},
	})
	handle := mintedRefreshHandle(t, harness)
	require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)
	require.Greater(t, observed, time.Second)
	require.LessOrEqual(t, observed, 2*time.Second)
}

// mustListFamily enumerates a family through the harness store.
func mustListFamily(t *testing.T, harness *frontChannelHarness, familyHash string) []*oauthstore.RouteRefreshBrokerRecord {
	t.Helper()
	family, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	require.True(t, ok)
	records, err := family.ListFamily(context.Background(), familyHash)
	require.NoError(t, err)
	return records
}

// scriptRefresh replaces the facade's provider with one whose Refresh follows a
// fixed script, so a row can drive the exact upstream sequence it needs while
// every other provider call still reaches the real adapter.
func (h *frontChannelHarness) scriptRefresh(steps ...func(context.Context) (*oauth.TokenSet, error)) *scriptedRefresh {
	script := &scriptedRefresh{steps: steps}
	h.provider.set(&refreshOverride{Provider: h.provider.current(), refresh: func(ctx context.Context, _ oauth.RefreshRequest) (*oauth.TokenSet, error) {
		return script.next(ctx)
	}})
	return script
}

// swappableProvider delegates to a provider that a test may replace. It exists so
// a row can script one upstream sequence without re-registering the facade.
type swappableProvider struct {
	mu    sync.Mutex
	inner oauth.Provider
}

func newSwappableProvider(inner oauth.Provider) *swappableProvider {
	return &swappableProvider{inner: inner}
}

func (p *swappableProvider) set(inner oauth.Provider) {
	p.mu.Lock()
	p.inner = inner
	p.mu.Unlock()
}

func (p *swappableProvider) current() oauth.Provider {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inner
}

func (p *swappableProvider) Discovery(ctx context.Context) (*oauth.ProviderMetadata, error) {
	return p.current().Discovery(ctx)
}

func (p *swappableProvider) AuthorizationURL(req oauth.AuthorizationRequest) (string, error) {
	return p.current().AuthorizationURL(req)
}

func (p *swappableProvider) ExchangeCode(ctx context.Context, req oauth.CodeExchangeRequest) (*oauth.TokenSet, error) {
	return p.current().ExchangeCode(ctx, req)
}

func (p *swappableProvider) Refresh(ctx context.Context, req oauth.RefreshRequest) (*oauth.TokenSet, error) {
	return p.current().Refresh(ctx, req)
}

func (p *swappableProvider) ValidateAccessToken(
	ctx context.Context,
	token string,
	expected oauth.TokenExpectations,
) (*oauth.TokenClaims, error) {
	return p.current().ValidateAccessToken(ctx, token, expected)
}

// providerEvents collects the route refresh telemetry a test asserts on.
type providerEvents struct {
	mu     sync.Mutex
	events []RouteRefreshEvent
}

func (p *providerEvents) hook(_ context.Context, event RouteRefreshEvent) {
	p.mu.Lock()
	p.events = append(p.events, event)
	p.mu.Unlock()
}

func (p *providerEvents) snapshot() []RouteRefreshEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]RouteRefreshEvent(nil), p.events...)
}

// requireNoTerminalEvent asserts no revocation-shaped event was emitted.
func requireNoTerminalEvent(t *testing.T, events []RouteRefreshEvent) {
	t.Helper()
	for _, event := range events {
		require.NotEqual(t, RouteRefreshEventUpstreamReauthRequired, event.Class)
		require.NotEqual(t, RouteRefreshOutcomeRevokedFamily, event.Outcome)
		require.NotEqual(t, RouteRefreshReasonFamilyHeadAbsent, event.Reason)
	}
}
