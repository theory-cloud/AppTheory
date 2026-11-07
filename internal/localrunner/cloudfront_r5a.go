package localrunner

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

// CloudFront caching, invalidation and external origin overrides.

// validateOriginOverrides refuses an origin mapping that is not loopback. A
// mapped origin's requests must never leave this machine. A `*.localhost` name
// is the other accepted form: RFC 6761 section 6.3 says resolvers should map
// it to loopback, and the run already uses that namespace for every public
// listener and certificate.
// https://www.rfc-editor.org/rfc/rfc6761#section-6.3
func validateOriginOverrides(origins map[string]string) error {
	for domain, raw := range origins {
		if strings.TrimSpace(domain) == "" {
			return errors.New("an --origin override names an empty domain")
		}
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || parsed.Host == "" {
			return fmt.Errorf("origin override %s=%s is not a URL", domain, raw)
		}
		if parsed.Scheme != schemeHTTP && parsed.Scheme != schemeHTTPS {
			return fmt.Errorf("origin override %s=%s is not an http(s) URL", domain, raw)
		}
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if host != tlsLocalhostHost && (ip == nil || !ip.IsLoopback()) && validateTLSHost(host) != nil {
			return fmt.Errorf(
				"origin override %s=%s is not a loopback URL; the local gateway must not reach the network (map it to 127.0.0.1, ::1, localhost or a *.localhost name)",
				domain, raw,
			)
		}
	}
	return nil
}

// tlsOriginNames is every custom-origin domain name a distribution declares,
// mapped to a loopback URL and valid as a local TLS name. The run certificate
// names them so the origin hop can verify the declared origin domain, which is
// the name CloudFront's certificate rule compares against:
// "one of the domain names in the certificate must match the domain name that
// you specify for Origin Domain Name".
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesOriginProtocolPolicy
func tlsOriginNames(spec *Spec) []string {
	if spec == nil {
		return nil
	}
	seen := map[string]bool{}
	var names []string
	for _, distribution := range spec.CloudFront {
		for _, origin := range distribution.Origins {
			if origin.Kind != localcloudfront.OriginCustom || origin.LocalURL == "" {
				continue
			}
			name := strings.ToLower(strings.TrimSpace(origin.DomainName))
			if name == "" || seen[name] || validateTLSHost(name) != nil {
				continue
			}
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// originServerName is the TLS name the origin hop verifies. CloudFront
// requires the certificate to name the origin's declared domain, so a local
// origin whose declared domain is a local name is verified against it. Any
// other declared domain (a real host name the local branch kept) falls back to
// the mapped host, which is the only name a local certificate can carry.
func originServerName(origin *localcloudfront.DistributionOrigin, base *url.URL) string {
	if name := strings.ToLower(strings.TrimSpace(origin.DomainName)); name != "" && validateTLSHost(name) == nil {
		return name
	}
	return base.Hostname()
}

// applyOriginOverrides maps every external custom origin to its loopback URL
// and refuses a distribution whose external origin has no mapping. It runs at
// plan time, before any listener or container starts.
func (r *Runner) applyOriginOverrides(spec *Spec) error {
	for _, distribution := range spec.CloudFront {
		servableBefore := distribution.Servable()
		for _, origin := range distribution.Origins {
			// An S3 bucket or a Function URL is a resource in the assembly even
			// when CloudFormation models it as a custom origin.
			if origin.Kind != localcloudfront.OriginCustom || origin.FunctionURL != "" || origin.Bucket != "" {
				continue
			}
			mapped, ok := r.options.Origins[origin.DomainName]
			if !ok {
				distribution.Refusals = append(distribution.Refusals, fmt.Sprintf(
					"origin %q (%s) is outside this machine; map it with --origin %s=<local url>",
					origin.ID, origin.DomainName, origin.DomainName,
				))
				continue
			}
			origin.LocalURL = strings.TrimSuffix(mapped, "/")
		}
		if servableBefore && !distribution.Servable() {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: distribution.LogicalID,
				Kind:      "cloudfront distribution",
				Reason:    strings.Join(distribution.Refusals, "; "),
			})
		}
	}
	// An --origin mapping for a domain no distribution declares has no effect;
	// say so at plan time instead of ignoring it silently.
	declared := map[string]bool{}
	for _, distribution := range spec.CloudFront {
		for _, origin := range distribution.Origins {
			declared[origin.DomainName] = true
		}
	}
	for _, domain := range sortedKeys(r.options.Origins) {
		if !declared[domain] {
			r.logf("origin override %s is not declared by any distribution; it has no effect", domain)
		}
	}
	return nil
}

// startCloudFrontControl serves the local CreateInvalidation/GetInvalidation API
// when the run serves a distribution, and injects its URL into every function as
// AWS_ENDPOINT_URL_CLOUDFRONT.
//
// https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CreateInvalidation.html
func (r *Runner) startCloudFrontControl(ctx context.Context, spec *Spec) error {
	if len(spec.ServableCloudFront()) == 0 || r.cloudFrontAPI == nil {
		return nil
	}
	listeners, err := r.listenControl(ctx, "CloudFront")
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           r.cloudFrontAPI,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	r.cloudFrontAPIURL = listeners.HostURL
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				r.logf("cloudfront API listener stopped: %v", serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	r.endpoints = append(r.endpoints, Endpoint{Service: "cloudfront", URL: listeners.ContainerURL})
	r.logf("cloudfront API at %s (containers: %s)", listeners.HostURL, listeners.ContainerURL)
	return nil
}

// httpOrigin reaches an external custom origin through its loopback mapping.
// It sends the documented origin-request shape and never uses a proxy.
type httpOrigin struct {
	originID      string
	base          *url.URL
	host          string
	serverName    string
	client        *http.Client
	customHeaders map[string]string
}

// newHTTPOrigin builds the client one mapped origin is fetched with. A plain
// http mapping keeps the historical client byte for byte. An https mapping
// verifies the origin certificate: against the run's CA when the run opted in
// to local TLS (the runner's own listeners and an auxiliary service both chain
// to it), and against the declared origin domain name when that name is a
// local name, which is the comparison CloudFront documents.
func newHTTPOrigin(origin *localcloudfront.DistributionOrigin, tlsState *localTLS) (*httpOrigin, error) {
	base, err := url.Parse(origin.LocalURL)
	if err != nil || base.Host == "" {
		return nil, fmt.Errorf("origin %q has no usable local URL (%q)", origin.ID, origin.LocalURL)
	}
	if base.Scheme != schemeHTTP && base.Scheme != schemeHTTPS {
		return nil, fmt.Errorf("origin %q local URL %q is not http(s)", origin.ID, origin.LocalURL)
	}
	transport := &http.Transport{Proxy: nil}
	serverName := ""
	if base.Scheme == schemeHTTPS {
		serverName = originServerName(origin, base)
		tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName}
		if tlsState != nil {
			pool, poolErr := x509.SystemCertPool()
			if poolErr != nil || pool == nil {
				pool = x509.NewCertPool()
			}
			if !pool.AppendCertsFromPEM(tlsState.caPEM) {
				return nil, fmt.Errorf("origin %q: the run CA is not a PEM certificate", origin.ID)
			}
			tlsConfig.RootCAs = pool
		}
		transport.TLSClientConfig = tlsConfig
	}
	return &httpOrigin{
		originID:      origin.ID,
		base:          base,
		host:          origin.DomainName,
		serverName:    serverName,
		client:        &http.Client{Timeout: 30 * time.Second, Transport: transport},
		customHeaders: origin.CustomHeaders,
	}, nil
}

// Fetch sends one origin request to the mapped local URL.
func (o *httpOrigin) Fetch(ctx context.Context, request localcloudfront.OriginRequest) (localcloudfront.OriginResponse, error) {
	target := *o.base
	target.Path = joinOriginPath(o.base.Path, request.Path())
	target.RawQuery = request.Query
	body := io.Reader(http.NoBody)
	if len(request.Body) > 0 {
		body = bytes.NewReader(request.Body)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Method, target.String(), body)
	if err != nil {
		return localcloudfront.OriginResponse{}, fmt.Errorf("origin %q: %w", o.originID, err)
	}
	for name, values := range request.Header {
		if strings.EqualFold(name, "Host") {
			continue
		}
		for _, value := range values {
			httpRequest.Header.Add(name, value)
		}
	}
	for name, value := range o.customHeaders {
		httpRequest.Header.Set(name, value)
	}
	host := request.Host
	if host == "" {
		host = o.host
	}
	if host != "" {
		httpRequest.Host = host
	}
	client := o.client
	response, err := client.Do(httpRequest) //nolint:gosec // the URL is a validated loopback override
	if err != nil {
		return localcloudfront.OriginResponse{}, &localcloudfront.OriginUnavailableError{
			OriginID: o.originID,
			Reason:   fmt.Sprintf("the mapped local origin %s did not answer: %v", target.String(), err),
		}
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the body is fully read before close
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, 10<<20))
	if readErr != nil {
		return localcloudfront.OriginResponse{}, fmt.Errorf("read the mapped origin response: %w", readErr)
	}
	// A plain-HTTP request to a TLS listener is answered by Go's own server
	// with this 400. Report the mismatch as a configuration error instead of
	// passing a bare 400 to the viewer.
	if response.StatusCode == http.StatusBadRequest && isPlainRequestToTLSListener(payload) {
		return localcloudfront.OriginResponse{}, &localcloudfront.OriginUnavailableError{
			OriginID: o.originID,
			Reason: fmt.Sprintf(
				"the mapped local origin %s answered %q: that listener is served over https, but this origin is mapped with plain http. %s",
				target.Host, plainRequestToTLSMessage, originTLSMappingHint(o.host),
			),
		}
	}
	return localcloudfront.OriginResponse{
		StatusCode:        response.StatusCode,
		StatusDescription: response.Status,
		Header:            response.Header,
		Body:              payload,
	}, nil
}

// plainRequestToTLSMessage is what Go's http.Server writes when a plain HTTP
// request reaches a TLS listener: "Client sent an HTTP request to an HTTPS
// server." It is the signal that an origin mapping points at a TLS-only
// listener over http.
const plainRequestToTLSMessage = "Client sent an HTTP request to an HTTPS server."

// isPlainRequestToTLSListener reports whether a response body is Go's
// plain-request-to-a-TLS-listener refusal.
func isPlainRequestToTLSListener(payload []byte) bool {
	return strings.HasPrefix(strings.TrimSpace(string(payload)), plainRequestToTLSMessage)
}

// originTLSMappingHint is the recovery text for an origin mapped with plain
// http to a TLS listener.
func originTLSMappingHint(domain string) string {
	return fmt.Sprintf(
		"Declare OriginProtocolPolicy HTTPS_ONLY in the app's local CDK branch and map the origin with --origin %s=https://<run host>:<port> (for example https://%s:<port>).",
		domain, tlsDefaultHost,
	)
}

// validateOriginMapping refuses an origin mapping that cannot work: a plain
// http mapping to one of the run's own listeners, which an opted-in run serves
// over https only. The check runs once every public listener before the
// distribution has started, so the failure names the origin and the fix
// instead of leaving a 400 for the first viewer request.
func (r *Runner) validateOriginMapping(origin *localcloudfront.DistributionOrigin) error {
	if r.tls == nil || origin.LocalURL == "" {
		return nil
	}
	parsed, err := url.Parse(origin.LocalURL)
	if err != nil || parsed.Scheme != schemeHTTP {
		return nil
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || !r.tlsListenerPort(port) {
		return nil
	}
	declared := ""
	if origin.Custom != nil && origin.Custom.ProtocolPolicy != "" {
		declared = fmt.Sprintf(" The distribution declares OriginProtocolPolicy %q.", origin.Custom.ProtocolPolicy)
	}
	return fmt.Errorf(
		"origin %q (%s) is mapped to %s, but this run serves every public listener over https (local TLS is on) and port %d is one of them.%s %s",
		origin.ID, origin.DomainName, origin.LocalURL, port, declared, originTLSMappingHint(origin.DomainName),
	)
}

// tlsListenerPort reports whether port is one of the run's own public
// listeners.
func (r *Runner) tlsListenerPort(port int) bool {
	return r.publicPorts[port]
}

func containsAddHost(hosts []string, wanted string) bool {
	for _, host := range hosts {
		if host == wanted {
			return true
		}
	}
	return false
}

// hasAddHostName reports whether an add-host entry names host, whatever address
// it carries.
func hasAddHostName(hosts []string, host string) bool {
	prefix := host + ":"
	for _, entry := range hosts {
		if strings.HasPrefix(entry, prefix) {
			return true
		}
	}
	return false
}

func joinOriginPath(base, path string) string {
	if base == "" || base == "/" {
		if strings.HasPrefix(path, "/") {
			return path
		}
		return "/" + path
	}
	trimmedBase := strings.TrimSuffix(base, "/")
	if strings.HasPrefix(path, "/") {
		return trimmedBase + path
	}
	return trimmedBase + "/" + path
}
