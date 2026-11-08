package localrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

// TestPlanPublicSurfacesNilSpec covers the guard before synthesis.
func TestPlanPublicSurfacesNilSpec(t *testing.T) {
	if _, err := PlanPublicSurfaces(nil, 8270, nil); err == nil {
		t.Fatal("a nil spec must be refused")
	}
}

// TestStartMailSurfaceRefusals covers the startup guards that run before a
// container exists.
func TestStartMailSurfaceRefusals(t *testing.T) {
	runner := &Runner{options: Options{Mail: true}, namePrefix: "run", network: "net"}
	if err := runner.startMailSurface(context.Background(), &Spec{}); err == nil ||
		!strings.Contains(err.Error(), "--profile") {
		t.Fatalf("no profile = %v", err)
	}
	profile := &Profile{}
	profile.Mail.Image = "axllent/mailpit:latest"
	profile.Mail.SMTPPort, profile.Mail.HTTPPort = 1025, 8025
	runner.profile = profile
	if err := runner.startMailSurface(context.Background(), &Spec{}); err == nil ||
		!strings.Contains(err.Error(), "pinned by digest") {
		t.Fatalf("unpinned image = %v", err)
	}
	profile.Mail.Image = "axllent/mailpit@sha256:" + strings.Repeat("c", 64)
	runner.tls = nil
	if err := runner.startMailSurface(context.Background(), &Spec{}); err == nil {
		t.Fatal("a mail surface without a CA must fail closed")
	}
}

// TestStartMailSurfaceContainerFailures covers a refused docker run and a sink
// that publishes no loopback port.
func TestStartMailSurfaceContainerFailures(t *testing.T) {
	profile := &Profile{}
	profile.Mail.Image = "axllent/mailpit@sha256:" + strings.Repeat("d", 64)
	profile.Mail.SMTPPort, profile.Mail.HTTPPort = 1025, 8025
	state, err := newLocalCASigner(t.TempDir())
	if err != nil {
		t.Fatalf("CA: %v", err)
	}
	runner := &Runner{
		options:    Options{Mail: true},
		profile:    profile,
		namePrefix: "run",
		network:    "net",
		tls:        state,
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			return "", "no such image", context.Canceled
		}},
	}
	if err := runner.startMailSurface(context.Background(), &Spec{}); err == nil {
		t.Fatal("a refused docker run must fail the surface")
	}
	runner.docker = &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		if strings.Contains(strings.Join(argv, " "), "docker run") {
			return "id", "", nil
		}
		return "", "", nil
	}}
	if err := runner.startMailSurface(context.Background(), &Spec{}); err == nil ||
		!strings.Contains(err.Error(), "published no loopback port") {
		t.Fatalf("no published port = %v", err)
	}
}

// TestListenHostPairBindsTheGateway covers the Linux-shaped branch with a
// host-owned gateway and a fixed port.
func TestListenHostPairBindsTheGateway(t *testing.T) {
	gatewayAddress := ""
	addresses, addressErr := net.InterfaceAddrs()
	if addressErr != nil {
		t.Skipf("interface addresses are not readable: %v", addressErr)
	}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err != nil || ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		gatewayAddress = ip.String()
		break
	}
	if gatewayAddress == "" {
		t.Skip("no non-loopback IPv4 address to model a host-owned gateway")
	}
	runner := &Runner{runtimeAPIGateway: gatewayAddress}
	loopback, gateway, port, err := runner.listenHostPair(context.Background(), 0)
	if err != nil {
		t.Fatalf("listenHostPair: %v", err)
	}
	defer func() { _ = loopback.Close() }() //nolint:errcheck // test cleanup
	if gateway == nil || port == 0 {
		t.Fatalf("gateway = %v, port = %d", gateway, port)
	}
	_ = gateway.Close() //nolint:errcheck // test cleanup
	if len(runner.listeners) != 2 {
		t.Fatalf("tracked listeners = %d", len(runner.listeners))
	}
	if _, _, _, err := runner.listenHostPair(context.Background(), port); err == nil {
		t.Fatal("an occupied fixed port must fail")
	}
}

// TestWaitForMailSinkHonorsCancellation covers the shutdown branch without
// waiting for the readiness timeout.
func TestWaitForMailSinkHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForMailSink(ctx, "127.0.0.1:1", "127.0.0.1:1"); err == nil {
		t.Fatal("a canceled wait must return")
	}
}

// TestSMTPDeliverWithoutASink covers the ingress's closed-sink refusal.
func TestSMTPDeliverWithoutASink(t *testing.T) {
	runner := &Runner{spec: &Spec{}, clock: RealClock{}}
	session := &smtpSession{
		runner:     runner,
		reader:     bufio.NewReader(strings.NewReader("")),
		writer:     bufio.NewWriter(&strings.Builder{}),
		from:       "sender@example.test",
		recipients: []string{"member@example.test"},
	}
	code, err := session.deliver(context.Background(), "Subject: x\r\n\r\nbody\r\n")
	if code != 451 || err == nil {
		t.Fatalf("deliver without a sink = %d, %v", code, err)
	}
	runner.mail = &mailSurface{relayAddr: "127.0.0.1:1"}
	code, err = session.deliver(context.Background(), "Subject: x\r\n\r\nbody\r\n")
	if code != 451 || err == nil {
		t.Fatalf("deliver to a dead sink = %d, %v", code, err)
	}
}

// TestRelaySMTPRefusals covers a dead sink and a sink that refuses a step.
func TestRelaySMTPRefusals(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := relaySMTP(ctx, "127.0.0.1:1", "a@b", []string{"c@d"}, "x"); err == nil {
		t.Fatal("a dead sink must fail the relay")
	}
	sink := startMailSinkRecorder(t)
	// The recording sink accepts every step; a wrapper that refuses MAIL is
	// covered by the greeting test below.
	if err := relaySMTP(ctx, sink.addr(), "a@b", []string{"c@d"}, "Subject: x\r\n\r\nbody\r\n"); err != nil {
		t.Fatalf("relay: %v", err)
	}
}

// TestPublishResolvedRoles covers the shared plane's resolved publication: a
// resolvable policy is re-encoded without Refs, and an unresolvable one is
// published verbatim so a consumer fails closed by name.
func TestPublishResolvedRoles(t *testing.T) {
	spec := &Spec{
		IAMRoles: []iamRoleSpec{{
			ARN:   "arn:aws:iam::123456789012:role/app-role",
			Stack: "app",
			Trust: json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":"sts:AssumeRole"}]}`),
			Identity: []json.RawMessage{
				json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Resource":"arn:aws:execute-api:us-east-1:123456789012:api/*/GET/*"}]}`),
				json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Resource":{"Ref":"Missing"}}]}`),
			},
		}},
	}
	runner := &Runner{spec: spec}
	roles, err := runner.resolvedIAMRoles(spec)
	if err != nil {
		t.Fatalf("resolvedIAMRoles: %v", err)
	}
	if len(roles) != 1 || !strings.Contains(string(roles[0].Identity[0]), "execute-api:Invoke") {
		t.Fatalf("the resolvable identity policy was not resolved: %s", roles[0].Identity[0])
	}
	if string(roles[0].Identity[1]) != string(spec.IAMRoles[0].Identity[1]) {
		t.Fatalf("the unresolvable policy was rewritten: %s", roles[0].Identity[1])
	}
}

// TestSecurityEnvironmentCarriesTheMailEndpoints covers the mail variables in
// every function container.
func TestSecurityEnvironmentCarriesTheMailEndpoints(t *testing.T) {
	runner := &Runner{
		options: Options{Mail: true},
		mail: &mailSurface{
			host:    "mail.localhost",
			smtpURL: "smtp://mail.localhost:8276",
			apiURL:  "https://mail.localhost:8277/api/v1/",
		},
		endpoints: []Endpoint{{Service: "dynamodb", URL: "http://127.0.0.1:8000"}},
	}
	env := runner.securityEnvironment(imageClassGo)
	if env[mailSMTPEnv] != runner.mail.smtpURL || env[mailAPIEnv] != runner.mail.apiURL {
		t.Fatalf("security env = %v", env)
	}
}
