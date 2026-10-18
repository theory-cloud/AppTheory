package mcpfacade

import (
	"fmt"
	"strings"
	"unicode/utf8"

	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// frontChannelFieldOutsideProvider reports the first front-channel field that is
// set while Provider is nil, so a partially configured front channel fails
// closed instead of half-registering.
func frontChannelFieldOutsideProvider(config FacadeConfig) (string, bool) {
	if frontChannelStoresDeclared(config.Stores) {
		return "Stores", true
	}
	if strings.TrimSpace(config.UpstreamClientID) != "" {
		return "UpstreamClientID", true
	}
	if strings.TrimSpace(config.UpstreamIssuer) != "" {
		return "UpstreamIssuer", true
	}
	if len(config.LifecycleScopes) > 0 {
		return "LifecycleScopes", true
	}
	if config.ProviderHints != nil {
		return "ProviderHints", true
	}
	if routeRefreshPolicyDeclared(config.RouteRefreshPolicy) {
		return "RouteRefreshPolicy", true
	}
	if config.RouteRefreshEvents != nil {
		return "RouteRefreshEvents", true
	}
	return "", false
}

func frontChannelStoresDeclared(stores oauthstore.Stores) bool {
	return stores.Transaction != nil ||
		stores.AuthorizationCode != nil ||
		stores.Client != nil ||
		stores.RouteRefreshBroker != nil ||
		stores.RateLimit != nil
}

// validateFrontChannelStores requires every one of the five store SPIs DESIGN §7
// defines: a facade missing a store cannot persist the state its mechanics
// depend on, so it fails closed rather than degrading.
func validateFrontChannelStores(stores oauthstore.Stores) error {
	missing := make([]string, 0, 5)
	for _, required := range []struct {
		name string
		set  bool
	}{
		{name: "Transaction", set: stores.Transaction != nil},
		{name: "AuthorizationCode", set: stores.AuthorizationCode != nil},
		{name: "Client", set: stores.Client != nil},
		{name: "RouteRefreshBroker", set: stores.RouteRefreshBroker != nil},
		{name: "RateLimit", set: stores.RateLimit != nil},
	} {
		if !required.set {
			missing = append(missing, required.name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("mcpfacade: front channel requires all five stores; missing %s", strings.Join(missing, ", "))
	}
	return nil
}

// validUpstreamClientID reports whether an upstream client id is usable: a
// non-empty, well-formed value. It is a registration identifier, not a secret.
func validUpstreamClientID(clientID string) bool {
	clientID = strings.TrimSpace(clientID)
	return clientID != "" && utf8.ValidString(clientID) && !strings.ContainsRune(clientID, 0)
}
