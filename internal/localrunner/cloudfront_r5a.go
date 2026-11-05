package localrunner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// CloudFront caching, invalidation and external origin overrides.

// validateOriginOverrides refuses an origin mapping that is not loopback. A
// mapped origin's requests must never leave this machine.
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
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return fmt.Errorf(
				"origin override %s=%s is not a loopback URL; the local gateway must not reach the network",
				domain, raw,
			)
		}
	}
	return nil
}

// applyOriginOverrides maps every external custom origin to its loopback URL and
// refuses a distribution whose external origin has no mapping. It runs at plan
// time, before any listener or container starts.
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
	var listenConfig net.ListenConfig
	// The listener binds every interface so a function container reaches it
	// through host.docker.internal, like the @connections management listener.
	listener, err := listenConfig.Listen(ctx, "tcp", "0.0.0.0:0")
	if err != nil {
		return fmt.Errorf("bind the local CloudFront API listener: %w", err)
	}
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close() //nolint:errcheck // the listener cannot be used without a TCP address
		return fmt.Errorf("the CloudFront API listener has no TCP address")
	}
	port := tcpAddr.Port
	hostURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	containerURL := fmt.Sprintf("http://host.docker.internal:%d", port)
	server := &http.Server{
		Handler:           r.cloudFrontAPI,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.listeners = append(r.listeners, listener)
	r.servers = append(r.servers, server)
	r.cloudFrontAPIURL = hostURL
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			r.logf("cloudfront API listener stopped: %v", serveErr)
		}
	}()
	r.endpoints = append(r.endpoints, Endpoint{Service: "cloudfront", URL: containerURL})
	r.addRuntimeHostEntry()
	r.logf("cloudfront API at %s (containers: %s)", hostURL, containerURL)
	return nil
}

// httpOrigin reaches an external custom origin through its loopback mapping.
// It sends the documented origin-request shape and never uses a proxy.
type httpOrigin struct {
	originID      string
	base          *url.URL
	host          string
	customHeaders map[string]string
	logf          func(format string, args ...any)
}

func newHTTPOrigin(origin *localcloudfront.DistributionOrigin, logf func(string, ...any)) (*httpOrigin, error) {
	base, err := url.Parse(origin.LocalURL)
	if err != nil || base.Host == "" {
		return nil, fmt.Errorf("origin %q has no usable local URL (%q)", origin.ID, origin.LocalURL)
	}
	if base.Scheme != schemeHTTP && base.Scheme != schemeHTTPS {
		return nil, fmt.Errorf("origin %q local URL %q is not http(s)", origin.ID, origin.LocalURL)
	}
	return &httpOrigin{
		originID:      origin.ID,
		base:          base,
		host:          origin.DomainName,
		customHeaders: origin.CustomHeaders,
		logf:          logf,
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
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{Proxy: nil},
	}
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
	return localcloudfront.OriginResponse{
		StatusCode:        response.StatusCode,
		StatusDescription: response.Status,
		Header:            response.Header,
		Body:              payload,
	}, nil
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
