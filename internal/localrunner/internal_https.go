package localrunner

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

// Runner-internal HTTPS endpoints.
//
// Some code the runner must run is a real AWS provider handler: a CloudFormation
// custom-resource handler reports its result by sending a PUT to the request's
// ResponseURL, and the pinned CDK provider framework always uses
// `https.request` for that PUT regardless of the URL's scheme:
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
// The runner therefore serves its internal control endpoints over HTTPS from a
// certificate the run CA signs, and mounts that CA into every function
// container, exactly as the public TLS opt-in already does. A run that only
// needs these internal endpoints keeps its public listeners on plain HTTP.

const (
	// controlLeafName is the name a function container reaches the runner's
	// internal HTTPS endpoints at. Docker adds the host-gateway entry for it,
	// and the runner adds the run network's own gateway entry, the same helper
	// the runtime API uses.
	controlLeafName = "host.docker.internal"
)

// internalHTTPS is the run's certificate for the internal control endpoints.
type internalHTTPS struct {
	mu       sync.Mutex
	cert     *tls.Certificate
	issuedAt time.Time
}

// internalControlCertificate returns the leaf the internal control endpoints
// present, issuing it from the run CA on first use.
func (r *Runner) internalControlCertificate() (*tls.Certificate, error) {
	if r.tls == nil {
		return nil, errors.New("the run has no local CA for an internal HTTPS endpoint")
	}
	r.internalTLS.mu.Lock()
	defer r.internalTLS.mu.Unlock()
	if r.internalTLS.cert != nil {
		return r.internalTLS.cert, nil
	}
	pair, err := r.tls.issueCertificate(
		[]string{controlLeafName, tlsLocalhostHost},
		[]net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	)
	if err != nil {
		return nil, fmt.Errorf("issue the internal control certificate: %w", err)
	}
	r.internalTLS.cert = &pair
	r.internalTLS.issuedAt = time.Now()
	return r.internalTLS.cert, nil
}

// startInternalHTTPS starts one runner-internal HTTPS endpoint on loopback and,
// when the host owns the run network's gateway, that address too. The returned
// container URL is what a function container reaches it at.
//
//nolint:goconst // the service names are the runner's own labels.
func (r *Runner) startInternalHTTPS(ctx context.Context, service string, handler http.Handler) (string, error) {
	certificate, err := r.internalControlCertificate()
	if err != nil {
		return "", err
	}
	listeners, err := r.listenControl(ctx, service)
	if err != nil {
		return "", err
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		// NoTLSConfig: ServeTLS below installs the certificate per listener.
	}
	server.TLSConfig = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{*certificate},
		NextProtos:   []string{"http/1.1"},
	}
	r.servers = append(r.servers, server)
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := server.ServeTLS(listener, "", ""); serveErr != nil &&
				!errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("local %s endpoint stopped: %v", service, serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	containerURL := fmt.Sprintf("https://%s:%d", controlLeafName, listeners.Port)
	r.logf("local %s endpoint for functions: %s", service, containerURL)
	return containerURL, nil
}

// specNeedsInternalHTTPS reports whether a run must serve an internal HTTPS
// endpoint, which is what makes it create the run CA even without --tls.
func specNeedsInternalHTTPS(spec *Spec) bool {
	if spec == nil {
		return false
	}
	for _, resource := range spec.CustomResources {
		if resource.Function != "" && resource.Refusal == "" && resource.ServedBy == "" {
			return true
		}
	}
	return false
}
