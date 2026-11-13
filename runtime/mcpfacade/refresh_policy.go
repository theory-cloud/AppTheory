package mcpfacade

import (
	"fmt"
	"time"

	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// RouteRefreshPolicy is the encoded static policy of the brokered route refresh
// handle (DESIGN §8.4). It is a FacadeConfig struct field, never an
// environment variable, and it is required whenever the framework-owned front
// channel is configured: a missing or zero value is a registration error, not a
// silent fallback.
//
// The policy has three knobs:
//
//   - HandleTTL is the local lifetime of a route refresh handle. It must lie in
//     [MinRouteRefreshHandleTTL, MaxRouteRefreshHandleTTL]. The store applies
//     it; a broker store that reports its own lifetime through
//     oauthstore.RouteRefreshBrokerHandleTTLReporter must agree with it, so a
//     deployment cannot declare a long ceiling while its store keeps a short
//     one.
//   - GraceWindow is the lost-response replay window measured from the winning
//     rotation. Zero selects DefaultRefreshGraceWindow. Inside the window the
//     rotated (previous) handle replays the stored successor body, including its
//     handle material, because that is the lost-response recovery path; the
//     replayed body reports only the access token's remaining lifetime, so a
//     replayed credential is always accepted for as long as the response says.
//     At and beyond the window the presentation is served by rotating the
//     family's live head and handing back fresh credentials: the evidence from
//     every real client that broke is exactly this presentation (a stale stored
//     copy presented minutes to hours after a successful rotation), so it is
//     ordinary client behavior and never a reason to revoke the family. The
//     window is bounded by MaxRefreshGraceWindow, and it is exclusive at its end.
//   - ReuseRateCeiling is retained for configuration compatibility. It
//     previously bounded the removed beyond-grace access-token-only serve; no
//     refresh path uses it now, because a stale predecessor presentation is
//     served by rotating the head and the re-armed grace window bounds retries.
//     The field and its validation stay so an existing configuration keeps
//     registering unchanged, and the F20 limiter semantics are untouched.
//   - RefreshBudget is the encoded time budget of one upstream refresh call.
//     Zero selects DefaultRefreshBudget. The facade applies it as the deadline
//     of the provider call, so an adapter that ignores the deadline still cannot
//     outlive it, and it is bounded above by the broker lock TTL it has to stay
//     inside (MaxRefreshBudget). It is a configuration field, never an
//     environment variable.
type RouteRefreshPolicy struct {
	HandleTTL        time.Duration
	GraceWindow      time.Duration
	ReuseRateCeiling int
	RefreshBudget    time.Duration
}

const (
	// MinRouteRefreshHandleTTL is the shortest accepted handle lifetime. A
	// shorter local policy defeats the lazy-refresh client the mechanism exists
	// for, and is far below every upstream access-token lifetime the facade is
	// known to front.
	MinRouteRefreshHandleTTL = time.Minute

	// MaxRouteRefreshHandleTTL is the longest accepted handle lifetime: thirty
	// days, equal to the verified upstream refresh-family inactivity default.
	// A ceiling above it would violate the design's min-of rule (route handle
	// lifetime ≤ upstream refresh-token lifetime).
	MaxRouteRefreshHandleTTL = 30 * 24 * time.Hour

	// DefaultRefreshGraceWindow is the lost-response replay window a policy that
	// does not state one selects. It is the pinned maximum, widened from the
	// original thirty seconds, so a lazy client that retries a dropped rotation
	// response inside two minutes recovers without a second upstream call.
	DefaultRefreshGraceWindow = 120 * time.Second

	// MaxRefreshGraceWindow is the hard bound on the lossless replay carve-out.
	MaxRefreshGraceWindow = 120 * time.Second

	// MinRefreshReuseRateCeiling is the smallest accepted value of the retained
	// ReuseRateCeiling field. The field no longer gates a token serve; the floor
	// and ceiling keep every existing configuration valid and are pinned by the
	// policy tests.
	MinRefreshReuseRateCeiling = 9

	// MaxRefreshReuseRateCeiling caps the retained ReuseRateCeiling field so an
	// existing configuration stays within the accepted range.
	MaxRefreshReuseRateCeiling = 120

	// refreshChainRootGeneration is the generation of a handle the facade mints
	// as the root of a new refresh family. Every successor records the presented
	// generation plus one, so depth relative to the head is arithmetic.
	refreshChainRootGeneration = 1

	// DefaultRefreshBudget is the upstream refresh-call budget a policy that does
	// not state one selects. It is the M2.1 hardened upstream HTTP deadline
	// (oauth's default fetch bound, shared by the discovery, token, and JWKS
	// fetches), so an unchanged configuration keeps exactly the deadline the
	// adapter already used.
	DefaultRefreshBudget = 10 * time.Second

	// MinRefreshBudget is the shortest accepted upstream refresh budget. Below it
	// a healthy upstream could not answer, so the facade would report transient
	// failures it caused itself.
	MinRefreshBudget = time.Second

	// refreshBudgetLockMargin is the headroom the budget must leave inside the
	// broker lock TTL so the winner can still commit its rotation before the lock
	// it holds expires and a second caller may take it.
	refreshBudgetLockMargin = 3 * time.Second

	// MaxRefreshBudget is the longest accepted upstream refresh budget: the
	// reference broker lock TTL (oauthstore.DefaultRouteRefreshLockTTL, 15 s) less
	// the commit margin. The ceiling is calibrated to that reference TTL; a store
	// with a shorter one is not rejected at registration. If such a store's lock
	// expires mid-rotation, the second caller runs another upstream refresh and
	// RotateFamily's owner/expiry/version re-check defers its rotation to the
	// winner, so the outcome is an extra upstream call and a deferred loser, never
	// a second mint.
	MaxRefreshBudget = oauthstore.DefaultRouteRefreshLockTTL - refreshBudgetLockMargin
)

// normalized validates the policy and resolves its optional fields. Every
// failure is a registration error: the facade never substitutes a policy for
// the operator's.
func (policy RouteRefreshPolicy) normalized() (RouteRefreshPolicy, error) {
	if policy.HandleTTL <= 0 {
		return RouteRefreshPolicy{}, fmt.Errorf(
			"mcpfacade: route refresh policy handle TTL is required and must be positive",
		)
	}
	if policy.HandleTTL < MinRouteRefreshHandleTTL || policy.HandleTTL > MaxRouteRefreshHandleTTL {
		return RouteRefreshPolicy{}, fmt.Errorf(
			"mcpfacade: route refresh policy handle TTL must be within [%s, %s]",
			MinRouteRefreshHandleTTL, MaxRouteRefreshHandleTTL,
		)
	}
	if policy.GraceWindow < 0 || policy.GraceWindow > MaxRefreshGraceWindow {
		return RouteRefreshPolicy{}, fmt.Errorf(
			"mcpfacade: route refresh policy grace window must be within (0, %s]",
			MaxRefreshGraceWindow,
		)
	}
	if policy.GraceWindow == 0 {
		policy.GraceWindow = DefaultRefreshGraceWindow
	}
	if policy.ReuseRateCeiling <= 0 {
		return RouteRefreshPolicy{}, fmt.Errorf(
			"mcpfacade: route refresh policy reuse rate ceiling is required and must be positive",
		)
	}
	if policy.ReuseRateCeiling < MinRefreshReuseRateCeiling ||
		policy.ReuseRateCeiling > MaxRefreshReuseRateCeiling {
		return RouteRefreshPolicy{}, fmt.Errorf(
			"mcpfacade: route refresh policy reuse rate ceiling must be within [%d, %d] per family per hour",
			MinRefreshReuseRateCeiling, MaxRefreshReuseRateCeiling,
		)
	}
	if policy.RefreshBudget == 0 {
		policy.RefreshBudget = DefaultRefreshBudget
	}
	if policy.RefreshBudget < MinRefreshBudget || policy.RefreshBudget > MaxRefreshBudget {
		return RouteRefreshPolicy{}, fmt.Errorf(
			"mcpfacade: route refresh policy refresh budget must be within [%s, %s]",
			MinRefreshBudget, MaxRefreshBudget,
		)
	}
	return policy, nil
}

// validateRouteRefreshPolicyStore refuses a store that reports a local handle
// lifetime different from the configured ceiling. A store that does not report
// one is accepted: its lifetime is the application's own wiring, and the
// configuration still fails closed on absence.
func validateRouteRefreshPolicyStore(policy RouteRefreshPolicy, stores oauthstore.Stores) error {
	reporter, ok := stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerHandleTTLReporter)
	if !ok {
		return nil
	}
	reported := reporter.RouteRefreshBrokerHandleTTL()
	if reported != policy.HandleTTL {
		return fmt.Errorf(
			"mcpfacade: route refresh policy handle TTL %s does not match the broker store's local lifetime %s",
			policy.HandleTTL, reported,
		)
	}
	return nil
}

// routeRefreshPolicyDeclared reports whether any policy field is set, so a
// policy supplied without Provider fails as part of the anchored field set
// instead of being ignored.
func routeRefreshPolicyDeclared(policy RouteRefreshPolicy) bool {
	return policy.HandleTTL != 0 || policy.GraceWindow != 0 ||
		policy.ReuseRateCeiling != 0 || policy.RefreshBudget != 0
}
