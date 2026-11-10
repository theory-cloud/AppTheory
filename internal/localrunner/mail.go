package localrunner

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The local mail surface.
//
// --mail starts the profile's digest-pinned SMTP sink (Mailpit) on the run
// network and exposes it the way a co-resident app uses mail:
//
//   - an SMTP ingress on <mail-host>:<smtp-port> that relays every accepted
//     message to the sink, so a Migadu-shaped sender's mail is stored and can
//     be read back;
//   - the same ingress runs the app's derived AWS::SES::ReceiptRule actions
//     with SES's received-message record, so a message sent to a rule's
//     recipient reaches its Lambda action without an injection operation;
//   - the sink's HTTP read API (GET /api/v1/messages, GET /api/v1/message/{id})
//     over HTTPS from an auxiliary leaf the run (or shared) CA signs.
//
// The sink is a real image pinned by digest in the local profile, not a
// stand-in. The SMTP ingress is the runner's own listener because it must reach
// both the sink and the app's receipt rules; it is an aux-service listener in
// the same sense as the OIDC test IdP's certificate.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html
// https://mailpit.axllent.org/docs/api-v1/

const (
	// mailDefaultHost is the public host of the mail surface. It is a
	// single-label *.localhost name like every co-resident run host.
	mailDefaultHost = "mail.localhost"
	// mailAlias is the sink's network name on the run network.
	mailAlias = "mailpit"
	// mailSMTPEnv and mailAPIEnv carry the surface's endpoints to every
	// function container, so an app's mail configuration can point at them.
	mailSMTPEnv = "APPTHEORY_LOCAL_SMTP_URL"
	mailAPIEnv  = "APPTHEORY_LOCAL_MAIL_API_URL"
	// mailMaxMessageBytes bounds one message the ingress accepts. The sink's
	// default maximum is larger; a local test message is far smaller.
	mailMaxMessageBytes = 10 << 20
	// mailReadyTimeout bounds the wait for the sink's SMTP and HTTP ports.
	mailReadyTimeout = 60 * time.Second
	// mailReadHeaderTimeout and mailIdleTimeout bound the read API's server.
	mailReadHeaderTimeout = 10 * time.Second
	mailIdleTimeout       = 60 * time.Second
	// mailSessionTimeout bounds one SMTP client's connection.
	mailSessionTimeout = 120 * time.Second
)

// mailSurface is one run's started mail sink and its listeners.
type mailSurface struct {
	host      string
	container string
	image     string
	// relayAddr is the loopback address of the sink's SMTP port.
	relayAddr string
	// readAddr is the loopback address of the sink's HTTP API.
	readAddr string
	// smtpPort and httpPort are the ports the ingress and the read API serve.
	smtpPort int
	httpPort int
	// smtpURL and apiURL are the addresses a person, an app or a row uses.
	smtpURL string
	apiURL  string
	leaf    *tls.Certificate
}

// mailHostName returns the validated public host of the mail surface.
func (r *Runner) mailHostName() (string, error) {
	host := strings.ToLower(strings.TrimSpace(r.options.MailHost))
	if host == "" {
		host = mailDefaultHost
	}
	if err := validateTLSHost(host); err != nil {
		return "", fmt.Errorf("--mail-host %q: %w", r.options.MailHost, err)
	}
	return host, nil
}

// validateMail rejects a mail host without the mail surface.
func (r *Runner) validateMail() error {
	if strings.TrimSpace(r.options.MailHost) != "" && !r.options.Mail {
		return errors.New("--mail-host needs --mail: the host names the local mail surface")
	}
	if !r.options.Mail {
		return nil
	}
	_, err := r.mailHostName()
	return err
}

// mailPorts returns the ingress and read-API ports. A run with a port base
// places them in the first two slots after its public surfaces, which keeps a
// co-resident app's committed mail configuration stable; a run with no base
// keeps the ephemeral default.
func (r *Runner) mailPorts(surfaceCount int) (int, int, error) {
	if r.options.PortBase <= 0 {
		return 0, 0, nil
	}
	smtpPort := r.options.PortBase + surfaceCount
	httpPort := smtpPort + 1
	if httpPort > 65535 {
		return 0, 0, fmt.Errorf(
			"--port-base %d with %d public surface(s) leaves no slot for the mail surface (would bind %d-%d)",
			r.options.PortBase, surfaceCount, smtpPort, httpPort)
	}
	return smtpPort, httpPort, nil
}

// startMailSurface starts the sink container, the SMTP ingress and the HTTPS
// read API. It runs before function containers so their environment carries the
// surface's endpoint and their /etc/hosts maps its host.
func (r *Runner) startMailSurface(ctx context.Context, spec *Spec) error {
	if !r.options.Mail {
		return nil
	}
	if r.profile == nil {
		return errors.New("--mail needs --profile: the sink image is digest-pinned in the local profile")
	}
	pin, err := r.profile.MailContainer()
	if err != nil {
		return err
	}
	if r.tls == nil {
		return errors.New("the mail surface needs the run CA for its auxiliary leaf")
	}
	host, err := r.mailHostName()
	if err != nil {
		return err
	}
	smtpPort, httpPort, err := r.mailPorts(len(servedPublicSurfaces(spec)))
	if err != nil {
		return err
	}
	name := r.namePrefix + "-" + mailAlias
	alias := r.sharedAlias(mailAlias)
	options := ContainerOptions{
		Name:         name,
		Network:      r.network,
		Aliases:      []string{alias},
		Image:        pin.Image,
		PublishPorts: []int{r.profile.Mail.SMTPPort, r.profile.Mail.HTTPPort},
		Labels:       r.labels(),
		Detach:       true,
	}
	if _, startErr := r.docker.StartContainer(ctx, options); startErr != nil {
		return fmt.Errorf("start the local mail sink: %w", startErr)
	}
	relayPort, err := r.docker.PublishedPort(ctx, name, r.profile.Mail.SMTPPort)
	if err != nil {
		return err
	}
	readPort, err := r.docker.PublishedPort(ctx, name, r.profile.Mail.HTTPPort)
	if err != nil {
		return err
	}
	if relayPort == 0 || readPort == 0 {
		return errors.New("the local mail sink published no loopback port")
	}
	surface := &mailSurface{
		host:      host,
		container: name,
		image:     pin.Image,
		relayAddr: net.JoinHostPort("127.0.0.1", strconv.Itoa(relayPort)),
		readAddr:  net.JoinHostPort("127.0.0.1", strconv.Itoa(readPort)),
	}
	leaf, err := r.tls.issueCertificate(
		[]string{host},
		[]net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	)
	if err != nil {
		return fmt.Errorf("issue the mail surface certificate: %w", err)
	}
	surface.leaf = &leaf
	if err := r.startMailListeners(ctx, surface, smtpPort, httpPort); err != nil {
		return err
	}
	if err := waitForMailSink(ctx, surface.relayAddr, surface.readAddr); err != nil {
		return err
	}
	r.addHostEntry(host)
	r.logf("local mail: SMTP %s (read API %s); sink %s", surface.smtpURL, surface.apiURL, surface.image)
	return nil
}

// startMailListeners starts the SMTP ingress and the HTTPS read API on loopback
// and, when the host owns the run network's gateway, that address too.
func (r *Runner) startMailListeners(ctx context.Context, surface *mailSurface, smtpPort, httpPort int) error {
	smtpLoopback, smtpGateway, actualSMTP, err := r.listenHostPair(ctx, smtpPort)
	if err != nil {
		return fmt.Errorf("bind the local mail SMTP listener: %w", err)
	}
	surface.smtpPort = actualSMTP
	surface.smtpURL = fmt.Sprintf("smtp://%s:%d", surface.host, actualSMTP)
	serve := func(listener net.Listener) {
		go r.serveSMTP(ctx, listener)
	}
	serve(smtpLoopback)
	if smtpGateway != nil {
		serve(smtpGateway)
	}

	httpLoopback, httpGateway, actualHTTP, err := r.listenHostPair(ctx, httpPort)
	if err != nil {
		return fmt.Errorf("bind the local mail read API: %w", err)
	}
	surface.httpPort = actualHTTP
	surface.apiURL = fmt.Sprintf("https://%s:%d/api/v1/", surface.host, actualHTTP)
	// The SMTP handler reads r.mail, so publish the surface before either
	// listener starts serving.
	r.mail = surface
	proxy := newMailReadProxy(surface.readAddr, r.logf)
	server := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: mailReadHeaderTimeout,
		IdleTimeout:       mailIdleTimeout,
		TLSConfig: &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{*surface.leaf},
			NextProtos:   []string{"http/1.1"},
		},
	}
	r.servers = append(r.servers, server)
	serveTLS := func(listener net.Listener) {
		go func() {
			if serveErr := server.ServeTLS(listener, "", ""); serveErr != nil &&
				!errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("local mail read API stopped: %v", serveErr)
			}
		}()
	}
	serveTLS(httpLoopback)
	if httpGateway != nil {
		serveTLS(httpGateway)
	}
	return nil
}

// listenHostPair binds one port on loopback and, when the host owns the run
// network's gateway (the Linux bridge case), the same port on that address.
// A zero port asks the OS for one on loopback and reuses it for the gateway.
func (r *Runner) listenHostPair(ctx context.Context, port int) (net.Listener, net.Listener, int, error) {
	var listenConfig net.ListenConfig
	address := "127.0.0.1:0"
	if port > 0 {
		address = net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	}
	loopback, err := listenConfig.Listen(ctx, "tcp", address)
	if err != nil {
		return nil, nil, 0, err
	}
	tcpAddr, ok := loopback.Addr().(*net.TCPAddr)
	if !ok {
		_ = loopback.Close() //nolint:errcheck // the listener cannot be used without a TCP address
		return nil, nil, 0, errors.New("the mail listener has no TCP address")
	}
	actual := tcpAddr.Port
	r.listeners = append(r.listeners, loopback)
	var gateway net.Listener
	if r.runtimeAPIGateway != "" {
		if listener, listenErr := listenConfig.Listen(ctx, "tcp", net.JoinHostPort(r.runtimeAPIGateway, strconv.Itoa(actual))); listenErr == nil {
			gateway = listener
			r.listeners = append(r.listeners, gateway)
		} else {
			r.logf("local mail: the run network gateway %s is not host-owned (%v); loopback only", r.runtimeAPIGateway, listenErr)
		}
	}
	return loopback, gateway, actual, nil
}

// newMailReadProxy forwards the sink's read API. The sink stays on the run
// network; the proxy is what an aux leaf makes reachable over verified HTTPS.
func newMailReadProxy(readAddr string, logf func(string, ...any)) *httputil.ReverseProxy {
	target := &url.URL{Scheme: "http", Host: readAddr}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.Host = readAddr
		},
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, err error) {
		if logf != nil {
			logf("local mail read API: %v", err)
		}
		http.Error(writer, `{"error":"the local mail sink is not reachable"}`, http.StatusBadGateway)
	}
	return proxy
}

// waitForMailSink waits until both the sink's SMTP and HTTP ports answer.
func waitForMailSink(ctx context.Context, relayAddr, readAddr string) error {
	deadline := time.Now().Add(mailReadyTimeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		smtpOK := false
		dialer := &net.Dialer{Timeout: time.Second}
		if conn, err := dialer.DialContext(ctx, "tcp", relayAddr); err == nil {
			smtpOK = true
			_ = conn.Close() //nolint:errcheck // readiness probe only
		}
		httpOK := false
		if request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+readAddr+"/api/v1/messages", nil); err == nil {
			if response, requestErr := client.Do(request); requestErr == nil {
				httpOK = response.StatusCode == http.StatusOK
				_ = response.Body.Close() //nolint:errcheck // readiness probe only
			}
		}
		if smtpOK && httpOK {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the local mail sink did not answer on %s (SMTP ready=%v) and %s (HTTP ready=%v)", relayAddr, smtpOK, readAddr, httpOK)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// mailEnvironment is what every function container receives when the surface
// is on.
func (r *Runner) mailEnvironment() map[string]string {
	if r.mail == nil {
		return nil
	}
	return map[string]string{
		mailSMTPEnv: r.mail.smtpURL,
		mailAPIEnv:  r.mail.apiURL,
	}
}

// mailDescription is the session's report of the surface.
func (r *Runner) mailDescription() map[string]any {
	if r.mail == nil {
		return nil
	}
	return map[string]any{
		"host":        r.mail.host,
		"smtpUrl":     r.mail.smtpURL,
		"apiUrl":      r.mail.apiURL,
		"container":   r.mail.container,
		"image":       r.mail.image,
		"smtpPort":    r.mail.smtpPort,
		"apiPort":     r.mail.httpPort,
		"readApiBase": r.mail.apiURL,
	}
}
