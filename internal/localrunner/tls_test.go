package localrunner

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestValidateTLSHost(t *testing.T) {
	valid := []string{"localhost", "app.localhost", "idp.localhost", "a1.localhost"}
	for _, host := range valid {
		if err := validateTLSHost(host); err != nil {
			t.Fatalf("validateTLSHost(%q) = %v, want nil", host, err)
		}
	}
	invalid := []string{
		"", "App.localhost", "example.com", "app.example.com", "a.b.localhost",
		"-app.localhost", "app-.localhost", "app_localhost", "app.localhost:8443",
		"https://app.localhost", "127.0.0.1", "app.localhost.",
	}
	for _, host := range invalid {
		if err := validateTLSHost(host); err == nil {
			t.Fatalf("validateTLSHost(%q) = nil, want an error", host)
		}
	}
}

func TestNewLocalTLSCreatesAReusableCA(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tls")
	first, err := newLocalTLS(dir, "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if first.host != "app.localhost" {
		t.Fatalf("host = %q", first.host)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat the TLS directory: %v", err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("TLS directory mode = %o, want 0700", info.Mode().Perm())
	}
	keyInfo, err := os.Stat(first.caKeyPath)
	if err != nil {
		t.Fatalf("stat the CA key: %v", err)
	}
	if keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("CA key mode = %o, want 0600", keyInfo.Mode().Perm())
	}
	certInfo, err := os.Stat(first.caPath)
	if err != nil {
		t.Fatalf("stat the CA certificate: %v", err)
	}
	if certInfo.Mode().Perm() != 0o644 {
		t.Fatalf("CA certificate mode = %o, want 0644", certInfo.Mode().Perm())
	}

	second, err := newLocalTLS(dir, "app.localhost")
	if err != nil {
		t.Fatalf("reload the CA: %v", err)
	}
	if string(second.caPEM) != string(first.caPEM) {
		t.Fatal("a second open rewrote the CA; the trust decision must survive")
	}

	if _, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost"); err != nil {
		t.Fatalf("another directory must get its own CA: %v", err)
	} else if string(second.caPEM) == "" {
		t.Fatal("the CA PEM is empty")
	}
}

func TestNewLocalTLSCertificatesVerify(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tls")
	state, err := newLocalTLS(dir, "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if !state.caCert.IsCA {
		t.Fatal("the CA certificate does not set the CA basic constraint")
	}
	if state.caCert.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Fatal("the CA certificate cannot sign")
	}
	if lifetime := state.caCert.NotAfter.Sub(state.caCert.NotBefore); lifetime > 826*24*time.Hour {
		t.Fatalf("CA lifetime = %v", lifetime)
	}

	block, _ := pem.Decode(state.publicLeafPEM)
	if block == nil {
		t.Fatal("the public leaf is not PEM")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse the public leaf: %v", err)
	}
	if lifetime := leaf.NotAfter.Sub(leaf.NotBefore); lifetime > 200*24*time.Hour {
		t.Fatalf("leaf lifetime = %v, want under 200 days", lifetime)
	}
	names := map[string]bool{}
	for _, name := range leaf.DNSNames {
		names[name] = true
	}
	for _, want := range []string{"app.localhost"} {
		if !names[want] {
			t.Fatalf("leaf SANs %v do not include %s", leaf.DNSNames, want)
		}
	}
	if len(leaf.IPAddresses) < 2 {
		t.Fatalf("leaf IP SANs = %v, want loopback addresses", leaf.IPAddresses)
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Fatalf("leaf EKU = %v, want serverAuth", leaf.ExtKeyUsage)
	}

	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(state.caPEM) {
		t.Fatal("the CA PEM did not load")
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:   roots,
		DNSName: "app.localhost",
	}); err != nil {
		t.Fatalf("the public leaf does not verify against the CA: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "wrong.localhost"}); err == nil {
		t.Fatal("the leaf verifies for a name it does not carry")
	}
}

func TestNewLocalTLSIssuesAdditionalCertificates(t *testing.T) {
	state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	certificate, err := state.issueCertificate([]string{"host.docker.internal", "localhost"}, nil)
	if err != nil {
		t.Fatalf("issueCertificate: %v", err)
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		t.Fatalf("parse the issued certificate: %v", err)
	}
	if leaf.Subject.CommonName != "host.docker.internal" {
		t.Fatalf("CommonName = %q", leaf.Subject.CommonName)
	}
	if _, err := state.issueCertificate(nil, nil); err == nil {
		t.Fatal("issueCertificate without a name must fail")
	}
}

func TestNewLocalTLSRefusesABadCA(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tls")
	if _, err := newLocalTLS(dir, "example.com"); err == nil {
		t.Fatal("an unsupported host must be refused")
	}

	state, err := newLocalTLS(dir, "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if err := os.WriteFile(state.caPath, []byte("not a certificate"), 0o644); err != nil { //nolint:gosec // test fixture
		t.Fatalf("corrupt the CA: %v", err)
	}
	if _, err := newLocalTLS(dir, "app.localhost"); err == nil {
		t.Fatal("a malformed CA must fail closed")
	}
}

func TestLocalCARejectsAMismatchedKey(t *testing.T) {
	first, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	second, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if _, _, err := parseCA(first.caPEM, secondKeyPEM(t, second)); err == nil {
		t.Fatal("a CA certificate and a foreign key must not parse together")
	}
}

func secondKeyPEM(t *testing.T, state *localTLS) []byte {
	t.Helper()
	contents, err := os.ReadFile(state.caKeyPath)
	if err != nil {
		t.Fatalf("read the CA key: %v", err)
	}
	return contents
}

func TestNewLocalTLSEphemeralCAsDiffer(t *testing.T) {
	first, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	second, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if string(first.caPEM) == string(second.caPEM) {
		t.Fatal("two ephemeral runs produced the same CA")
	}
}

func TestInitTLSAddsTheHostEntryAndTrustBundle(t *testing.T) {
	runner := &Runner{
		options: Options{TLS: true, TLSHost: "app.localhost", TLSAuxHosts: []string{"idp.localhost"}},
		scratch: t.TempDir(),
	}
	if err := runner.initTLS(nil); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	if runner.tls == nil {
		t.Fatal("initTLS did not create the CA")
	}
	if runner.tlsBundlePath == "" {
		t.Fatal("initTLS did not write the trust bundle")
	}
	if contents, err := os.ReadFile(runner.tlsBundlePath); err != nil || string(contents) != string(runner.tls.caPEM) {
		t.Fatalf("trust bundle = %q, %v", contents, err)
	}
	wantHosts := map[string]bool{"app.localhost:host-gateway": true, "idp.localhost:host-gateway": true}
	for _, entry := range runner.options.AddHosts {
		delete(wantHosts, entry)
	}
	if len(wantHosts) != 0 {
		t.Fatalf("missing add-host entries: %v", wantHosts)
	}
	if runner.tls.dir != filepath.Join(runner.scratch, tlsCADirName) {
		t.Fatalf("ephemeral CA directory = %s", runner.tls.dir)
	}
}

func TestInitTLSPersistsUnderDataDir(t *testing.T) {
	dataDir := t.TempDir()
	first := &Runner{
		options: Options{TLS: true, TLSHost: "app.localhost"},
		scratch: t.TempDir(),
		dataDir: dataDir,
	}
	if err := first.initTLS(nil); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	second := &Runner{
		options: Options{TLS: true, TLSHost: "app.localhost"},
		scratch: t.TempDir(),
		dataDir: dataDir,
	}
	if err := second.initTLS(nil); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	if string(first.tls.caPEM) != string(second.tls.caPEM) {
		t.Fatal("--data-dir did not keep the CA across runs")
	}
	if second.tls.dir != filepath.Join(dataDir, tlsCADirName) {
		t.Fatalf("persistent CA directory = %s", second.tls.dir)
	}
}

func TestInitTLSIsOffByDefault(t *testing.T) {
	runner := &Runner{options: Options{}, scratch: t.TempDir()}
	if err := runner.initTLS(nil); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	if runner.tls != nil || len(runner.options.AddHosts) != 0 {
		t.Fatal("a run without --tls must not create a CA or a host entry")
	}
}

func TestInitTLSRefusesABadAuxName(t *testing.T) {
	runner := &Runner{
		options: Options{TLS: true, TLSHost: "app.localhost", TLSAuxHosts: []string{"example.com"}},
		scratch: t.TempDir(),
	}
	if err := runner.initTLS(nil); err == nil {
		t.Fatal("an auxiliary name outside *.localhost must be refused")
	}
}

func TestPublicURLsFollowTheOptIn(t *testing.T) {
	plain := &Runner{}
	if got := plain.publicURL(8123); got != "http://127.0.0.1:8123" {
		t.Fatalf("plain publicURL = %q", got)
	}
	if got := plain.tlsWebSocketURL(8123, "dev"); got != "ws://127.0.0.1:8123/dev" {
		t.Fatalf("plain WS URL = %q", got)
	}
	if plain.serverTLSConfig() != nil || plain.tlsTrustMounts() != nil {
		t.Fatal("a plain run must not configure TLS")
	}
	if _, err := plain.writeTLSTrustBundle(); err != nil {
		t.Fatalf("plain trust bundle: %v", err)
	}

	secure := &Runner{tls: &localTLS{host: "app.localhost", caPath: "/tmp/ca.pem"}, publicTLS: true}
	if got := secure.publicURL(8123); got != "https://app.localhost:8123" {
		t.Fatalf("TLS publicURL = %q", got)
	}
	if got := secure.tlsWebSocketURL(8123, "dev"); got != "wss://app.localhost:8123/dev" {
		t.Fatalf("TLS WS URL = %q", got)
	}
	config := secure.serverTLSConfig()
	if config == nil || len(config.Certificates) != 1 || config.MinVersion != tls.VersionTLS12 {
		t.Fatalf("TLS config = %+v", config)
	}
	if len(config.NextProtos) == 0 || config.NextProtos[0] != "h2" {
		t.Fatalf("TLS NextProtos = %v, want h2 first", config.NextProtos)
	}
	mounts := secure.tlsTrustMounts()
	if len(mounts) != 1 || mounts[0] != "/tmp/ca.pem:"+tlsTrustBundlePath+":ro" {
		t.Fatalf("trust mounts = %v", mounts)
	}
}

func TestStartPublicListenerServesHTTPS(t *testing.T) {
	state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	runner := &Runner{tls: state, publicTLS: true}
	server := &http.Server{
		Handler: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte("ok")) //nolint:errcheck // the test asserts the body below
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	port, err := runner.startPublicListener(context.Background(), 0, server, "test listener")
	if err != nil {
		t.Fatalf("startPublicListener: %v", err)
	}
	defer func() {
		for _, listener := range runner.listeners {
			_ = listener.Close() //nolint:errcheck // test cleanup
		}
		for _, started := range runner.servers {
			_ = started.Close() //nolint:errcheck // test cleanup
		}
	}()

	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(state.caPEM) {
		t.Fatal("the CA PEM did not load")
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "app.localhost", MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, fmt.Sprintf("127.0.0.1:%d", port))
		},
	}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	deadline := time.Now().Add(10 * time.Second)
	for {
		request, requestErr := http.NewRequestWithContext(context.Background(), http.MethodGet, fmt.Sprintf("https://app.localhost:%d/", port), nil)
		if requestErr != nil {
			t.Fatalf("build the request: %v", requestErr)
		}
		response, err := client.Do(request)
		if err == nil {
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close() //nolint:errcheck // test cleanup
			if readErr != nil {
				t.Fatalf("read the response: %v", readErr)
			}
			if string(body) != "ok" {
				t.Fatalf("body = %q", body)
			}
			if response.TLS == nil {
				t.Fatal("the response was not served over TLS")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the TLS listener never answered: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSecurityEnvironmentCarriesTheTLSTrust(t *testing.T) {
	plain := &Runner{profile: &Profile{}}
	for _, class := range []string{imageClassGo, imageClassNode, imageClassPython} {
		for _, name := range tlsTrustEnvironment(class) {
			if _, ok := plain.securityEnvironment(class)[name]; ok {
				t.Fatalf("a plain run set %s for the %s runtime", name, class)
			}
		}
	}
	secure := &Runner{tls: &localTLS{host: "app.localhost"}}
	for _, class := range []string{imageClassGo, imageClassNode, imageClassPython} {
		env := secure.securityEnvironment(class)
		for _, name := range tlsTrustEnvironment(class) {
			if env[name] != tlsTrustBundlePath {
				t.Fatalf("%s (%s) = %q, want %q", name, class, env[name], tlsTrustBundlePath)
			}
		}
	}
}

// TestTLSTrustEnvironmentIsPerRuntime pins which runtime reads which trust
// anchor. A Go container must never receive AWS_CA_BUNDLE: the AWS SDK for Go v2
// refuses to load a config that carries the bundle together with a
// caller-supplied *http.Client, which is the shape every table mapper uses.
func TestTLSTrustEnvironmentIsPerRuntime(t *testing.T) {
	want := map[string][]string{
		imageClassGo:     {"SSL_CERT_FILE", "CURL_CA_BUNDLE"},
		imageClassNode:   {"NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE"},
		imageClassPython: {"SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "AWS_CA_BUNDLE", "CURL_CA_BUNDLE"},
	}
	for class, names := range want {
		got := tlsTrustEnvironment(class)
		if strings.Join(got, ",") != strings.Join(names, ",") {
			t.Fatalf("%s trust environment = %v, want %v", class, got, names)
		}
	}
	for _, name := range tlsTrustEnvironment(imageClassGo) {
		if name == "AWS_CA_BUNDLE" {
			t.Fatal("the Go runtime must not receive AWS_CA_BUNDLE")
		}
	}
	if strings.Join(tlsTrustEnvironment(""), ",") != strings.Join(tlsTrustImageFunction, ",") {
		t.Fatal("a container-image function must get the union of every runtime's variables")
	}
	if !slices.Contains(tlsTrustEnvironment(""), "AWS_CA_BUNDLE") {
		t.Fatal("a container-image function has no runtime to special-case")
	}
}

// TestFunctionEnvironmentSelectsTheRuntimeTrust proves the class a function's
// template declares decides its trust variables, not the run alone.
func TestFunctionEnvironmentSelectsTheRuntimeTrust(t *testing.T) {
	runner := &Runner{
		profile:   &Profile{},
		tls:       &localTLS{host: "app.localhost"},
		endpoints: []Endpoint{{Service: backendDynamoDB, URL: "http://dynamodb-local:8000"}},
	}
	cases := map[string]struct {
		runtime string
		want    []string
		absent  []string
	}{
		"go":     {runtime: "provided.al2023", want: tlsTrustGo, absent: []string{"AWS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"}},
		"node":   {runtime: "nodejs24.x", want: tlsTrustNode, absent: []string{"AWS_CA_BUNDLE", "SSL_CERT_FILE"}},
		"python": {runtime: "python3.14", want: tlsTrustPython, absent: []string{"NODE_EXTRA_CA_CERTS"}},
	}
	for name, testCase := range cases {
		class, err := RuntimeClass(testCase.runtime)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		env, _ := runner.functionEnvironment(FunctionSpec{LogicalID: "Fn", Runtime: testCase.runtime}, nil, class)
		for _, variable := range testCase.want {
			if env[variable] != tlsTrustBundlePath {
				t.Fatalf("%s: %s = %q, want %q", name, variable, env[variable], tlsTrustBundlePath)
			}
		}
		for _, variable := range testCase.absent {
			if _, ok := env[variable]; ok {
				t.Fatalf("%s: %s must not be set", name, variable)
			}
		}
	}
}

func TestTLSCARequiresADataDir(t *testing.T) {
	if _, _, err := TLSCA(""); err == nil {
		t.Fatal("TLSCA without --data-dir must fail")
	}
	dataDir := testBase(t)
	certPath, keyPath, err := TLSCA(dataDir)
	if err != nil {
		t.Fatalf("TLSCA: %v", err)
	}
	if !strings.HasSuffix(certPath, filepath.Join(tlsCADirName, tlsCACertFile)) {
		t.Fatalf("CA certificate path = %s", certPath)
	}
	if !strings.HasSuffix(keyPath, filepath.Join(tlsCADirName, tlsCAKeyFile)) {
		t.Fatalf("CA key path = %s", keyPath)
	}
}

func TestTLSLeafIssuesAnAuxiliaryCertificate(t *testing.T) {
	dataDir := testBase(t)
	out := filepath.Join(testBase(t), "aux")
	certPath, keyPath, err := TLSLeaf(dataDir, []string{"idp.localhost", "idp.localhost"}, out)
	if err != nil {
		t.Fatalf("TLSLeaf: %v", err)
	}
	keyInfo, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("stat the leaf key: %v", err)
	}
	if keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("leaf key mode = %o, want 0600", keyInfo.Mode().Perm())
	}
	certPEM, err := os.ReadFile(certPath) //nolint:gosec // the test owns the path
	if err != nil {
		t.Fatalf("read the leaf certificate: %v", err)
	}
	state, err := openLocalCA(dataDir)
	if err != nil {
		t.Fatalf("openLocalCA: %v", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(state.caPEM) {
		t.Fatal("the CA PEM did not load")
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		t.Fatal("the issued certificate is not PEM")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse the issued certificate: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "idp.localhost"}); err != nil {
		t.Fatalf("the auxiliary certificate does not verify: %v", err)
	}

	for _, testCase := range []struct {
		name    string
		names   []string
		out     string
		wantErr bool
	}{
		{name: "no output", names: []string{"idp.localhost"}, wantErr: true},
		{name: "no names", names: nil, out: out, wantErr: true},
		{name: "bad name", names: []string{"example.com"}, out: out, wantErr: true},
	} {
		if _, _, err := TLSLeaf(dataDir, testCase.names, testCase.out); (err != nil) != testCase.wantErr {
			t.Fatalf("%s: TLSLeaf error = %v, wantErr %v", testCase.name, err, testCase.wantErr)
		}
	}
	if _, _, err := TLSLeaf("", []string{"idp.localhost"}, out); err == nil {
		t.Fatal("TLSLeaf without --data-dir must fail")
	}
}

func TestWithHostAddsTheAuthority(t *testing.T) {
	headers := withHost(map[string]string{}, "app.localhost:8123")
	if headers["host"] != "app.localhost:8123" {
		t.Fatalf("headers = %v", headers)
	}
	if headers := withHost(map[string]string{}, ""); len(headers) != 0 {
		t.Fatalf("an empty host added a header: %v", headers)
	}
}

func TestBuildEventCarriesTheHostHeader(t *testing.T) {
	request := InvokeRequest{
		API:    APISpec{Class: APIHTTPV2, LogicalID: "Api"},
		Route:  Route{Method: "GET", Path: "/health"},
		Method: "GET",
		Path:   "/health",
		Host:   "app.localhost:8123",
		Now:    time.Unix(0, 0),
	}
	encoded, err := BuildEvent(request)
	if err != nil {
		t.Fatalf("BuildEvent: %v", err)
	}
	event := map[string]any{}
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatalf("decode the event: %v", err)
	}
	headers, ok := event["headers"].(map[string]any)
	if !ok {
		t.Fatalf("the event carries no headers: %v", event)
	}
	if headers["host"] != "app.localhost:8123" {
		t.Fatalf("headers = %v", headers)
	}
}

func TestProfileTLSKeyIsTheCommittedOptIn(t *testing.T) {
	base := testBase(t)
	profilePath := filepath.Join(base, "tls-profile.json")
	document := map[string]any{
		"profile": map[string]any{
			"tls": map[string]any{"enabled": true, "host": "app.localhost"},
		},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode the profile: %v", err)
	}
	if writeErr := os.WriteFile(profilePath, encoded, 0o644); writeErr != nil { //nolint:gosec // a test fixture
		t.Fatalf("write the profile: %v", writeErr)
	}
	runner, err := NewRunner(Options{
		AppDir:         base,
		AssemblyDir:    testAssembly(t, base),
		ScratchDir:     filepath.Join(base, "scratch"),
		ProfilePath:    profilePath,
		MaxConcurrency: 2,
		NamePrefix:     "test-tls",
		Stdout:         &syncBuffer{},
	})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	if !runner.options.TLS || runner.options.TLSHost != "app.localhost" {
		t.Fatalf("profile opt-in = TLS %v host %q", runner.options.TLS, runner.options.TLSHost)
	}

	secondBase := testBase(t)
	override, err := NewRunner(Options{
		AppDir:         secondBase,
		AssemblyDir:    testAssembly(t, secondBase),
		ScratchDir:     filepath.Join(secondBase, "scratch"),
		ProfilePath:    profilePath,
		MaxConcurrency: 2,
		NamePrefix:     "test-tls-override",
		TLSHost:        "idp.localhost",
		Stdout:         &syncBuffer{},
	})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	if override.options.TLSHost != "idp.localhost" {
		t.Fatalf("--tls-host was overridden by the profile: %q", override.options.TLSHost)
	}
}

func TestTLSPathsFailClosed(t *testing.T) {
	base := testBase(t)

	filePath := filepath.Join(base, "not-a-directory")
	if err := os.WriteFile(filePath, []byte("x"), 0o600); err != nil { //nolint:gosec // a test fixture
		t.Fatalf("write the file: %v", err)
	}
	if _, _, err := TLSCA(filePath); err == nil {
		t.Fatal("a data directory that is a file must fail")
	}
	if _, err := newLocalCASigner(filePath); err == nil {
		t.Fatal("a TLS directory that is a file must fail")
	}

	certOnly, err := newLocalTLS(filepath.Join(base, "cert-only"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if removeErr := os.Remove(certOnly.caKeyPath); removeErr != nil {
		t.Fatalf("remove the CA key: %v", removeErr)
	}
	if _, lookupErr := newLocalTLS(filepath.Join(base, "cert-only"), "app.localhost"); lookupErr == nil {
		t.Fatal("a CA certificate without its key must fail")
	}

	keyOnly, err := newLocalTLS(filepath.Join(base, "key-only"), "app.localhost")
	if err != nil {
		t.Fatalf("newLocalTLS: %v", err)
	}
	if removeErr := os.Remove(keyOnly.caPath); removeErr != nil {
		t.Fatalf("remove the CA certificate: %v", removeErr)
	}
	if _, lookupErr := newLocalTLS(filepath.Join(base, "key-only"), "app.localhost"); lookupErr == nil {
		t.Fatal("a CA key without its certificate must fail")
	}

	if _, _, parseErr := parseCA([]byte("not pem"), []byte("not pem")); parseErr == nil {
		t.Fatal("a non-PEM CA must fail")
	}
	keyPEM := secondKeyPEM(t, keyOnly)
	if _, _, parseErr := parseCA(keyOnly.publicLeafPEM, keyPEM); parseErr == nil {
		t.Fatal("a server certificate must not be accepted as the CA")
	}
	certPEM, err := os.ReadFile(certOnly.caPath) //nolint:gosec // the test owns the path
	if err != nil {
		t.Fatalf("read the CA certificate: %v", err)
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		t.Fatal("the CA key is not PEM")
	}
	notAKey := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: keyBlock.Bytes})
	if _, _, err := parseCA(certPEM, notAKey); err == nil {
		t.Fatal("a non-key PEM block must fail")
	}

	runner := &Runner{tls: &localTLS{dir: filepath.Join(base, "missing"), caPEM: []byte("ca")}}
	if _, err := runner.writeTLSTrustBundle(); err == nil {
		t.Fatal("an unwritable trust-bundle directory must fail")
	}
	if writeErr := writePrivateFile(filepath.Join(base, "missing", "key.pem"), []byte("k")); writeErr == nil {
		t.Fatal("a key in a missing directory must fail")
	}
	if writeErr := writePrivateFile(filepath.Join(base, "key.pem"), []byte("k")); writeErr != nil {
		t.Fatalf("write a private file: %v", writeErr)
	}
}

func TestLockTLSDirectoryReclaimsAStaleLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, tlsLockFile)
	if err := os.WriteFile(path, nil, 0o600); err != nil { //nolint:gosec // a test fixture
		t.Fatalf("write the lock: %v", err)
	}
	stale := time.Now().Add(-5 * time.Minute)
	if err := os.Chtimes(path, stale, stale); err != nil {
		t.Fatalf("age the lock: %v", err)
	}
	unlock, err := lockTLSDirectory(dir)
	if err != nil {
		t.Fatalf("a stale lock must be reclaimed: %v", err)
	}
	unlock()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the lock was not released: %v", err)
	}
}

func TestTLSEdgeFailures(t *testing.T) {
	base := testBase(t)
	filePath := filepath.Join(base, "a-file")
	if err := os.WriteFile(filePath, []byte("x"), 0o600); err != nil { //nolint:gosec // a test fixture
		t.Fatalf("write the file: %v", err)
	}
	if _, err := newLocalTLS(filePath, "app.localhost"); err == nil {
		t.Fatal("newLocalTLS must fail when the directory cannot be created")
	}
	if _, _, err := TLSLeaf(base, []string{"idp.localhost"}, filePath); err == nil {
		t.Fatal("TLSLeaf must fail when --out is a file")
	}

	locked := filepath.Join(base, "locked")
	if err := os.MkdirAll(locked, 0o500); err != nil {
		t.Fatalf("create the locked directory: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) }) //nolint:errcheck,gosec // test cleanup restores the directory mode
	if _, err := lockTLSDirectory(locked); err == nil {
		t.Fatal("a lock file that cannot be created must fail")
	}
}

// TestFunctionRunOptionsKeepsAnImageFunctionTrusted pins the container-image
// case: such a function declares no Runtime, so the run must neither resolve a
// runtime class for it nor drop the trust bundle. It keeps every variable the
// pinned runtimes read, because the runner cannot know which runtime the image
// speaks.
func TestFunctionRunOptionsKeepsAnImageFunctionTrusted(t *testing.T) {
	runner := &Runner{
		profile:     &Profile{},
		options:     Options{TLS: true, TLSHost: "app.localhost"},
		scratch:     t.TempDir(),
		namePrefix:  "test",
		invokers:    map[string]*FunctionProcess{},
		builtImages: map[string]string{},
	}
	state, err := newLocalTLS(filepath.Join(runner.scratch, tlsCADirName), "app.localhost")
	if err != nil {
		t.Fatalf("create the run CA: %v", err)
	}
	runner.tls = state
	function := FunctionSpec{
		LogicalID:  "ImageFn",
		ImageAsset: &DockerImageAssetSpec{Directory: t.TempDir(), DockerFile: "Dockerfile"},
	}
	_, options, err := runner.functionRunOptions(context.Background(), function, "example/image:latest")
	if err != nil {
		t.Fatalf("a container-image function must start: %v", err)
	}
	for _, name := range tlsTrustImageFunction {
		if options.Env[name] != tlsTrustBundlePath {
			t.Fatalf("%s = %q, want %q", name, options.Env[name], tlsTrustBundlePath)
		}
	}
}
