package localrunner

import (
	"context"
	"errors"
	"net/http"
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

func TestNormalizeRuntimeErrorType(t *testing.T) {
	cases := map[string]string{
		"Runtime.NoSuchHandler":   "Runtime.NoSuchHandler",
		"Function.ConfigInvalid":  "Function.ConfigInvalid",
		"Runtime.lower":           "Runtime.Unknown",
		"Function.lower":          "Function.Unknown",
		"ValueError":              "Runtime.Unknown",
		"Other.Thing":             "Runtime.Unknown",
		"Runtime.":                "Runtime.Unknown",
		"":                        "",
		"  Runtime.InvalidEntry ": "Runtime.InvalidEntry",
	}
	for value, expected := range cases {
		if got := normalizeRuntimeErrorType(value); got != expected {
			t.Errorf("normalize(%q) = %q, want %q", value, got, expected)
		}
	}
}

func TestRuntimeAPIInitErrorNormalizesTheErrorTypeHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	response := postRuntime(t, api, runtimeInitErrorPath, []byte(`{"errorMessage":"boom"}`),
		http.Header{runtimeErrorTypeHeader: {"ValueError"}})
	if response.status != http.StatusAccepted {
		t.Fatalf("init error status: %d", response.status)
	}
	_, result := api.Invoke(context.Background(), []byte(`{}`))
	var failure *RuntimeAPIError
	if !errors.As(result.err, &failure) {
		t.Fatalf("the init failure must fail the next invocation: %v", result.err)
	}
	if failure.Type != "Runtime.Unknown" {
		t.Fatalf("a non-conforming header must normalize: %q", failure.Type)
	}
}

func TestRuntimeAPIInvocationErrorNormalizesTheErrorTypeHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	outcome := make(chan error, 1)
	go func() {
		_, result := api.Invoke(context.Background(), []byte(`{}`))
		outcome <- result.err
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
		[]byte(`{"errorMessage":"boom"}`), http.Header{runtimeErrorTypeHeader: {"Function.bad-reason"}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("error status: %d", accepted.status)
	}
	var failure *RuntimeAPIError
	if !errors.As(<-outcome, &failure) {
		t.Fatal("the invocation error must fail the invocation")
	}
	if failure.Type != "Function.Unknown" {
		t.Fatalf("a non-conforming Function header must normalize to Function.Unknown: %+v", failure)
	}
	if failure.Message != "boom" {
		t.Fatalf("the body message must be kept: %q", failure.Message)
	}
}

func TestRuntimeAPIInvocationErrorKeepsAConformingErrorTypeHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	outcome := make(chan error, 1)
	go func() {
		_, result := api.Invoke(context.Background(), []byte(`{}`))
		outcome <- result.err
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
		[]byte(`{"errorMessage":"boom"}`), http.Header{runtimeErrorTypeHeader: {"Function.ConfigurationError"}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("error status: %d", accepted.status)
	}
	var failure *RuntimeAPIError
	if !errors.As(<-outcome, &failure) {
		t.Fatal("the invocation error must fail the invocation")
	}
	if failure.Type != "Function.ConfigurationError" {
		t.Fatalf("a conforming header must be kept: %+v", failure)
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
