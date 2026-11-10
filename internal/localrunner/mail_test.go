package localrunner

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMailHostName(t *testing.T) {
	runner := &Runner{options: Options{}}
	host, err := runner.mailHostName()
	if err != nil || host != mailDefaultHost {
		t.Fatalf("default mail host = %q, %v", host, err)
	}
	runner.options.MailHost = " Mail.Example " // upper case and a non-localhost name
	if _, err := runner.mailHostName(); err == nil {
		t.Fatal("a mail host outside *.localhost must be refused")
	}
	runner.options.MailHost = "smtp.localhost"
	if host, err := runner.mailHostName(); err != nil || host != "smtp.localhost" {
		t.Fatalf("custom mail host = %q, %v", host, err)
	}
}

func TestValidateMail(t *testing.T) {
	runner := &Runner{options: Options{MailHost: "mail.localhost"}}
	if err := runner.validateMail(); err == nil || !strings.Contains(err.Error(), "--mail") {
		t.Fatalf("a host without --mail = %v", err)
	}
	runner.options = Options{Mail: true, MailHost: "example.com"}
	if err := runner.validateMail(); err == nil {
		t.Fatal("an invalid mail host must be refused")
	}
	runner.options = Options{Mail: true}
	if err := runner.validateMail(); err != nil {
		t.Fatalf("valid mail options: %v", err)
	}
}

func TestMailPorts(t *testing.T) {
	runner := &Runner{options: Options{}}
	if smtp, api, err := runner.mailPorts(3); err != nil || smtp != 0 || api != 0 {
		t.Fatalf("ephemeral mail ports = %d, %d, %v", smtp, api, err)
	}
	runner.options.PortBase = 8270
	if smtp, api, err := runner.mailPorts(6); err != nil || smtp != 8276 || api != 8277 {
		t.Fatalf("based mail ports = %d, %d, %v", smtp, api, err)
	}
	runner.options.PortBase = 65533
	if _, _, err := runner.mailPorts(2); err == nil {
		t.Fatal("a mail surface past 65535 must be refused")
	}
}

func TestProfileMailContainer(t *testing.T) {
	image := "axllent/mailpit@sha256:" + strings.Repeat("a", 64)
	if _, err := (&Profile{}).MailContainer(); err == nil {
		t.Fatal("an empty profile must refuse a mail surface")
	}
	profile := &Profile{}
	profile.path = "profile.json"
	profile.Mail.Image = "axllent/mailpit:latest"
	profile.Mail.SMTPPort, profile.Mail.HTTPPort = 1025, 8025
	if _, err := profile.MailContainer(); err == nil {
		t.Fatal("a mail image without a digest must be refused")
	}
	profile.Mail.Image = image
	profile.Mail.SMTPPort = 0
	if _, err := profile.MailContainer(); err == nil {
		t.Fatal("a mail pin without ports must be refused")
	}
	profile.Mail.SMTPPort = 1025
	pin, err := profile.MailContainer()
	if err != nil || pin.Image != image || pin.ContainerPort != 1025 {
		t.Fatalf("mail pin = %+v, %v", pin, err)
	}
}

func TestContainerArgvPublishesEveryMailPort(t *testing.T) {
	argv := ContainerArgv(ContainerOptions{
		Name:         "run-mailpit",
		Image:        "mailpit",
		Publish:      1025,
		PublishPorts: []int{8025},
		Detach:       true,
	})
	joined := strings.Join(argv, " ")
	if strings.Count(joined, "-p 127.0.0.1::") != 2 ||
		!strings.Contains(joined, "127.0.0.1::1025") || !strings.Contains(joined, "127.0.0.1::8025") {
		t.Fatalf("argv = %v", argv)
	}
}

func TestMailReadProxyForwards(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/messages" {
			t.Errorf("path = %q", request.URL.Path)
		}
		_, _ = io.WriteString(writer, `{"total":1}`) //nolint:errcheck // the test server writes
	}))
	defer backend.Close()
	readAddr := strings.TrimPrefix(backend.URL, "http://")
	proxy := newMailReadProxy(readAddr, t.Logf)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://mail.localhost/api/v1/messages", nil)
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"total":1`) {
		t.Fatalf("proxy = %d %q", recorder.Code, recorder.Body.String())
	}
	dead := httptest.NewServer(http.NotFoundHandler())
	deadAddr := strings.TrimPrefix(dead.URL, "http://")
	dead.Close()
	broken := newMailReadProxy(deadAddr, t.Logf)
	recorder = httptest.NewRecorder()
	broken.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://mail.localhost/api/v1/messages", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("unreachable sink = %d", recorder.Code)
	}
}

func TestMailEnvironmentAndDescription(t *testing.T) {
	runner := &Runner{}
	if runner.mailEnvironment() != nil || runner.mailDescription() != nil {
		t.Fatal("a run without the mail surface reports no mail")
	}
	runner.mail = &mailSurface{
		host:      "mail.localhost",
		smtpURL:   "smtp://mail.localhost:8276",
		apiURL:    "https://mail.localhost:8277/api/v1/",
		container: "run-mailpit",
		image:     "mailpit",
		smtpPort:  8276,
		httpPort:  8277,
	}
	env := runner.mailEnvironment()
	if env[mailSMTPEnv] != runner.mail.smtpURL || env[mailAPIEnv] != runner.mail.apiURL {
		t.Fatalf("mail env = %v", env)
	}
	description := runner.mailDescription()
	if description["host"] != "mail.localhost" || description["smtpPort"] != 8276 {
		t.Fatalf("mail description = %v", description)
	}
}

// mailSinkFixture is an in-process stand-in for the sink's two ports.
type mailSinkFixture struct {
	smtp net.Listener
	http *httptest.Server
}

func startMailSinkFixture(t *testing.T) *mailSinkFixture {
	t.Helper()
	var listenConfig net.ListenConfig
	smtpListener, err := listenConfig.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("smtp listener: %v", err)
	}
	go func() {
		for {
			conn, acceptErr := smtpListener.Accept()
			if acceptErr != nil {
				return
			}
			_ = conn.Close() //nolint:errcheck // the readiness probe only needs the port open
		}
	}()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/messages" {
			http.NotFound(writer, request)
			return
		}
		_, _ = io.WriteString(writer, `{"total":0,"messages":[]}`) //nolint:errcheck // the fixture writes
	}))
	t.Cleanup(func() {
		_ = smtpListener.Close() //nolint:errcheck // test cleanup
		server.Close()
	})
	return &mailSinkFixture{smtp: smtpListener, http: server}
}

func (f *mailSinkFixture) smtpPort() int {
	address, ok := f.smtp.Addr().(*net.TCPAddr)
	if !ok {
		panic("the fixture SMTP listener has no TCP address")
	}
	return address.Port
}

func (f *mailSinkFixture) httpPort() int {
	parsed, err := strconv.Atoi(strings.TrimPrefix(f.http.URL, "http://127.0.0.1:"))
	if err != nil {
		panic(err)
	}
	return parsed
}

// TestStartMailSurfaceStartsBothListeners covers the startup path with a fake
// Docker CLI and an in-process sink: the container starts, both published
// ports are resolved, the SMTP ingress and the HTTPS read API bind, and the
// readiness probe passes.
func TestStartMailSurfaceStartsBothListeners(t *testing.T) {
	sink := startMailSinkFixture(t)
	profile := &Profile{}
	profile.Mail.Image = "axllent/mailpit@sha256:" + strings.Repeat("b", 64)
	profile.Mail.SMTPPort, profile.Mail.HTTPPort = 1025, 8025
	var started []string
	runner := &Runner{
		options:    Options{Mail: true},
		profile:    profile,
		docker:     fakeMailDocker(t, sink, &started),
		namePrefix: "test-run",
		network:    "test-net",
	}
	tlsState, err := newLocalCASigner(t.TempDir())
	if err != nil {
		t.Fatalf("CA: %v", err)
	}
	runner.tls = tlsState
	if startErr := runner.startMailSurface(context.Background(), &Spec{}); startErr != nil {
		t.Fatalf("startMailSurface: %v", startErr)
	}
	if runner.mail == nil {
		t.Fatal("startMailSurface left no surface")
	}
	if runner.mail.smtpPort == 0 || runner.mail.httpPort == 0 || runner.mail.smtpPort == runner.mail.httpPort {
		t.Fatalf("mail ports = %d/%d", runner.mail.smtpPort, runner.mail.httpPort)
	}
	if !strings.HasPrefix(runner.mail.smtpURL, "smtp://mail.localhost:") ||
		!strings.HasPrefix(runner.mail.apiURL, "https://mail.localhost:") {
		t.Fatalf("mail URLs = %s / %s", runner.mail.smtpURL, runner.mail.apiURL)
	}
	if len(started) != 1 || !strings.Contains(started[0], "-p 127.0.0.1::1025") ||
		!strings.Contains(started[0], "-p 127.0.0.1::8025") {
		t.Fatalf("docker run calls = %v", started)
	}
	// The read API answers over HTTPS with the aux leaf from the run CA.
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(tlsState.caPEM) {
		t.Fatal("the CA is not a PEM certificate")
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig}, Timeout: 5 * time.Second}
	url := "https://mail.localhost:" + strconv.Itoa(runner.mail.httpPort) + "/api/v1/messages"
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("mail read API request: %v", err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("mail read API: %v", err)
	}
	_ = response.Body.Close() //nolint:errcheck // the status is the assertion
	if response.StatusCode != http.StatusOK {
		t.Fatalf("mail read API status = %d", response.StatusCode)
	}
}

func fakeMailDocker(t *testing.T, sink *mailSinkFixture, started *[]string) *Docker {
	t.Helper()
	return &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		joined := strings.Join(argv, " ")
		switch {
		case strings.Contains(joined, "docker run"):
			*started = append(*started, joined)
			return "container-id", "", nil
		case strings.Contains(joined, "docker port") && strings.HasSuffix(joined, " 1025"):
			return "127.0.0.1:" + strconv.Itoa(sink.smtpPort()), "", nil
		case strings.Contains(joined, "docker port") && strings.HasSuffix(joined, " 8025"):
			return "127.0.0.1:" + strconv.Itoa(sink.httpPort()), "", nil
		default:
			t.Fatalf("unexpected docker call: %v", argv)
			return "", "", nil
		}
	}}
}
