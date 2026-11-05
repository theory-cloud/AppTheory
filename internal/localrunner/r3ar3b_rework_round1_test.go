package localrunner

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Round-1 rework tests for the LOCAL-W2-R3a/R3b PR.

func TestRuntimeAPIListenerBindsLoopback(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	address := api.boundAddress()
	if address == nil {
		t.Fatal("the runtime API has no bound address")
	}
	if address.IP.IsUnspecified() {
		t.Fatalf("the runtime API listener binds every interface: %s", address)
	}
	if !address.IP.IsLoopback() {
		t.Fatalf("the loopback bind is the narrowest address: %s", address)
	}
	if !strings.HasPrefix(api.HostURL(), "http://127.0.0.1:") {
		t.Fatalf("the host URL is the loopback address: %q", api.HostURL())
	}
}

func TestRuntimeAPIGatewayFallbackKeepsLoopbackWhenTheAddressIsNotLocal(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.gateway = func(context.Context) (string, error) {
		// TEST-NET-1 is never an address this host owns; binding it fails, and
		// the loopback listener must stay in place.
		return "192.0.2.1", nil
	}
	before := api.listener.Addr().String()
	if api.rebindToGateway(context.Background()) {
		t.Fatal("binding a non-local gateway address must fail")
	}
	if api.listener.Addr().String() != before {
		t.Fatalf("the failed fallback moved the listener: %s -> %s", before, api.listener.Addr())
	}
	if api.gatewayBound() != "" {
		t.Fatalf("a loopback listener is not a gateway bind: %q", api.gatewayBound())
	}
}

func TestRuntimeAPIGatewayFallbackReportsAMissingGateway(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.gateway = func(context.Context) (string, error) {
		return "", errors.New("the run network has no gateway")
	}
	if api.rebindToGateway(context.Background()) {
		t.Fatal("a missing gateway must not move the listener")
	}
	if !api.boundAddress().IP.IsLoopback() {
		t.Fatalf("the listener must stay on loopback: %s", api.boundAddress())
	}
}

func TestDockerNetworkGatewayReadsTheConfiguredGateway(t *testing.T) {
	docker := &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		if !strings.Contains(strings.Join(argv, " "), "network inspect") {
			t.Fatalf("unexpected argv: %v", argv)
		}
		return "\n172.20.0.1\n\n", "", nil
	}}
	address, err := docker.NetworkGateway(context.Background(), "run-net")
	if err != nil {
		t.Fatalf("network gateway: %v", err)
	}
	if address != "172.20.0.1" {
		t.Fatalf("gateway: %q", address)
	}
}

func TestDockerNetworkGatewayFailsWithoutOne(t *testing.T) {
	docker := &Docker{exec: func(context.Context, []string) (string, string, error) {
		return "\n\n", "", nil
	}}
	if _, err := docker.NetworkGateway(context.Background(), "run-net"); err == nil {
		t.Fatal("a network with no gateway must fail")
	}
	failing := &Docker{exec: func(context.Context, []string) (string, string, error) {
		return "", "no such network", errors.New("exit status 1")
	}}
	if _, err := failing.NetworkGateway(context.Background(), "run-net"); err == nil ||
		!strings.Contains(err.Error(), "no such network") {
		t.Fatalf("inspect failure: %v", err)
	}
}
