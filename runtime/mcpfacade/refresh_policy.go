package mcpfacade

import (
	"fmt"
	"time"

	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
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
//     rotated (previous) handle replays the full stored successor body,
//     including its handle material, because that is the lost-response recovery
//     path. The window is bounded by MaxRefreshGraceWindow, and it is exclusive
//     at its end: a presentation at exactly graceExpiresAt is beyond grace.
//   - ReuseRateCeiling bounds, per refresh family per hour, how many
//     out-of-grace depth-1 presentations are answered with the access token
//     only. It must lie in
//     [MinRefreshReuseRateCeiling, MaxRefreshReuseRateCeiling]; the floor is
//     above the benign dual-session cadence of roughly eight rotations per hour
//     per family, so the ceiling throttles harvest without tripping on the race
//     it exists to protect.
type RouteRefreshPolicy struct {
	HandleTTL        time.Duration
	GraceWindow      time.Duration
	ReuseRateCeiling int
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

	// MinRefreshReuseRateCeiling is the smallest accepted per-family hourly
	// budget of beyond-grace access-token-only serves. The documented referent
	// for the floor is the benign dual-session cadence: two sessions rotating
	// about four times an hour produce roughly eight presentations, so a ceiling
	// at or below eight would throttle the race it protects.
	MinRefreshReuseRateCeiling = 9

	// MaxRefreshReuseRateCeiling caps the configured budget so no deployment can
	// turn the throttle into an unbounded access-token harvest path.
	MaxRefreshReuseRateCeiling = 120

	// refreshReuseRateWindow is the fixed window of the per-family reuse budget.
	refreshReuseRateWindow = time.Hour

	// refreshReuseRateOperation is the rate-limit operation the reuse budget is
	// counted under.
	refreshReuseRateOperation = "route_refresh_reuse_depth1"

	// refreshChainRootGeneration is the generation of a handle the facade mints
	// as the root of a new refresh family. Every successor records the presented
	// generation plus one, so depth relative to the head is arithmetic.
	refreshChainRootGeneration = 1
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
	return policy.HandleTTL != 0 || policy.GraceWindow != 0 || policy.ReuseRateCeiling != 0
}
