package mcpfacade

import (
	"context"
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
	if missingFamily := missingTransactionalFamilyMethods(stores.RouteRefreshBroker); len(missingFamily) > 0 {
		return fmt.Errorf(
			"mcpfacade: front channel requires a transactional refresh-family broker store; route refresh broker is missing %s",
			strings.Join(missingFamily, ", "),
		)
	}
	return nil
}

// missingTransactionalFamilyMethods reports the transactional family methods a
// broker store lacks. Registration checks each method separately so a partially
// duck-typed store is refused eagerly and the error names exactly what must be
// added; the old optional ListFamily/RevokeFamily pair alone is not sufficient.
func missingTransactionalFamilyMethods(broker oauthstore.RouteRefreshBrokerStore) []string {
	missing := make([]string, 0, 4)
	if _, ok := broker.(interface {
		CreateFamily(context.Context, *oauthstore.RouteRefreshBrokerRecord) (*oauthstore.RouteRefreshBrokerRecord, error)
	}); !ok {
		missing = append(missing, "CreateFamily")
	}
	if _, ok := broker.(interface {
		RotateFamily(context.Context, oauthstore.RouteRefreshFamilyRotation) (*oauthstore.RouteRefreshBrokerRecord, error)
	}); !ok {
		missing = append(missing, "RotateFamily")
	}
	if _, ok := broker.(interface {
		ListFamily(context.Context, string) ([]*oauthstore.RouteRefreshBrokerRecord, error)
	}); !ok {
		missing = append(missing, "ListFamily")
	}
	if _, ok := broker.(interface {
		RevokeFamily(context.Context, string) ([]*oauthstore.RouteRefreshBrokerRecord, error)
	}); !ok {
		missing = append(missing, "RevokeFamily")
	}
	return missing
}

// validUpstreamClientID reports whether an upstream client id is usable: a
// non-empty, well-formed value. It is a registration identifier, not a secret.
func validUpstreamClientID(clientID string) bool {
	clientID = strings.TrimSpace(clientID)
	return clientID != "" && utf8.ValidString(clientID) && !strings.ContainsRune(clientID, 0)
}
