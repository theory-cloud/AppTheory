package localrunner

import (
	"context"
	"strings"
	"testing"
)

// TestSharedNetworkNamesTheRunNetwork covers the switch between a private and a
// shared bridge: a run without --shared-network keeps today's name.
func TestSharedNetworkNamesTheRunNetwork(t *testing.T) {
	appDir := t.TempDir()
	private, err := NewRunner(Options{AppDir: appDir})
	if err != nil {
		t.Fatalf("NewRunner (private): %v", err)
	}
	if private.network != private.namePrefix+"-net" || private.sharedNetwork {
		t.Fatalf("private network = %q shared=%v", private.network, private.sharedNetwork)
	}
	shared, err := NewRunner(Options{AppDir: appDir, SharedNetwork: "w3m1-co-residence"})
	if err != nil {
		t.Fatalf("NewRunner (shared): %v", err)
	}
	if shared.network != "w3m1-co-residence" || !shared.sharedNetwork {
		t.Fatalf("shared network = %q shared=%v", shared.network, shared.sharedNetwork)
	}
}

func TestValidateCoResidence(t *testing.T) {
	appDir := t.TempDir()
	if _, err := NewRunner(Options{AppDir: appDir, PeerHosts: []string{"mcp.localhost"}}); err == nil ||
		!strings.Contains(err.Error(), "--peer-host needs --tls") {
		t.Fatalf("a peer host without public TLS = %v, want a --peer-host needs --tls error", err)
	}
	if _, err := NewRunner(Options{AppDir: appDir, TLS: true, PeerHosts: []string{"mcp.example.com"}}); err == nil {
		t.Fatal("a peer host outside *.localhost must be refused")
	}
	if _, err := NewRunner(Options{AppDir: appDir, TLS: true, PeerHosts: []string{"mcp.localhost", "MCP.localhost"}}); err == nil {
		t.Fatal("a duplicate peer host must be refused")
	}
	runner, err := NewRunner(Options{AppDir: appDir, TLS: true, PeerHosts: []string{"mcp.localhost", "cloud.localhost"}})
	if err != nil {
		t.Fatalf("NewRunner with peer hosts: %v", err)
	}
	if len(runner.options.PeerHosts) != 2 {
		t.Fatalf("peer hosts = %v", runner.options.PeerHosts)
	}
	if _, err := NewRunner(Options{AppDir: appDir, SharedNetwork: "bad name"}); err == nil {
		t.Fatal("a shared network name with a space must be refused")
	}
}

// TestInitTLSMapsPeerHosts pins that a co-resident host goes through the one
// add-host helper, exactly like the run's own host.
func TestInitTLSMapsPeerHosts(t *testing.T) {
	runner := &Runner{
		options: Options{TLS: true, TLSHost: "auth.localhost", PeerHosts: []string{"mcp.localhost", "auth.localhost"}},
		scratch: t.TempDir(),
	}
	if err := runner.initTLS(nil); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	want := map[string]bool{"auth.localhost:host-gateway": true, "mcp.localhost:host-gateway": true}
	for _, entry := range runner.options.AddHosts {
		delete(want, entry)
	}
	if len(want) != 0 {
		t.Fatalf("missing add-host entries: %v", want)
	}
}

func TestSharedAliasAndURLRewrite(t *testing.T) {
	private := &Runner{}
	if private.sharedAlias("moto") != "moto" {
		t.Fatal("a private run must keep the profile alias")
	}
	shared := &Runner{sharedNetwork: true, namePrefix: "tms-run"}
	if shared.sharedAlias("moto") != "tms-run-moto" {
		t.Fatalf("shared alias = %q", shared.sharedAlias("moto"))
	}
	if got := replaceURLHost("http://moto:5000/path", "tms-run-moto"); got != "http://tms-run-moto:5000/path" {
		t.Fatalf("replaceURLHost = %q", got)
	}
	if got := replaceURLHost("not a url", "alias"); got != "not a url" {
		t.Fatalf("replaceURLHost on a non-URL = %q", got)
	}
}

// TestScopeBackendEndpoints pins X6c: the injected endpoint names a function
// and the preflight probe receive must be the run-scoped alias the container
// publishes on a shared network, and must not change otherwise.
func TestScopeBackendEndpoints(t *testing.T) {
	shared := &Runner{
		sharedNetwork: true,
		namePrefix:    "run-a",
		endpoints: []Endpoint{
			{Service: "kms", URL: "http://moto:5000"},
			{Service: "dynamodb", URL: "http://dynamodb-local:8000"},
			{Service: "sqs", URL: "http://run-a-sqs:9324"},
			{Service: "cloudfront", URL: "https://cloudfront.localhost:8300"},
		},
	}
	shared.scopeBackendEndpoints("moto", shared.sharedAlias("moto"))
	shared.scopeBackendEndpoints(backendDynamoDBName, shared.sharedAlias(backendDynamoDBName))
	want := []string{
		"http://run-a-moto:5000",
		"http://run-a-dynamodb-local:8000",
		"http://run-a-sqs:9324",
		"https://cloudfront.localhost:8300",
	}
	for index, endpoint := range shared.endpoints {
		if endpoint.URL != want[index] {
			t.Fatalf("endpoint %s = %q, want %q", endpoint.Service, endpoint.URL, want[index])
		}
	}
	private := &Runner{endpoints: []Endpoint{{Service: "kms", URL: "http://moto:5000"}}}
	private.scopeBackendEndpoints("moto", private.sharedAlias("moto"))
	if private.endpoints[0].URL != "http://moto:5000" {
		t.Fatalf("a private run rewrote its endpoint to %q", private.endpoints[0].URL)
	}
}

// TestEnsureNetworkAttachesToAnExistingSharedNetwork covers the second run: it
// must not try to create the bridge its sibling already created.
func TestEnsureNetworkAttachesToAnExistingSharedNetwork(t *testing.T) {
	var calls [][]string
	runner := &Runner{
		sharedNetwork: true,
		network:       "w3m1-shared",
		appHash:       "app",
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			calls = append(calls, argv)
			return "w3m1-shared\n", "", nil
		}},
	}
	if err := runner.ensureNetwork(context.Background()); err != nil {
		t.Fatalf("ensureNetwork: %v", err)
	}
	if len(calls) != 1 || calls[0][1] != "network" || calls[0][2] != "ls" {
		t.Fatalf("calls = %v; want one network ls", calls)
	}
}

func TestEnsureNetworkCreatesAMissingSharedNetwork(t *testing.T) {
	var calls [][]string
	runner := &Runner{
		sharedNetwork: true,
		network:       "w3m1-shared",
		appHash:       "app",
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			calls = append(calls, argv)
			if argv[1] == "network" && argv[2] == "ls" {
				return "", "", nil
			}
			return "created", "", nil
		}},
	}
	if err := runner.ensureNetwork(context.Background()); err != nil {
		t.Fatalf("ensureNetwork: %v", err)
	}
	if len(calls) != 2 || calls[1][1] != "network" || calls[1][2] != "create" {
		t.Fatalf("calls = %v; want a network create", calls)
	}
	joined := strings.Join(calls[1], " ")
	if !strings.Contains(joined, labelSharedNetwork+"=true") || !strings.Contains(joined, "w3m1-shared") {
		t.Fatalf("create argv = %v", calls[1])
	}
}

func TestPrivateNetworkStillCreates(t *testing.T) {
	var calls [][]string
	runner := &Runner{
		network: "private-net",
		appHash: "app",
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			calls = append(calls, argv)
			return "created", "", nil
		}},
	}
	if err := runner.ensureNetwork(context.Background()); err != nil {
		t.Fatalf("ensureNetwork: %v", err)
	}
	if len(calls) != 1 || calls[0][2] != "create" {
		t.Fatalf("calls = %v; want one network create", calls)
	}
}
