package localrunner

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Local TLS for the runner's public listeners.
//
// An opted-in run serves every public listener over HTTPS from a certificate
// that chains to a runner-generated local CA. The CA is an X.509 v3
// certificate with the basic constraints and key usage a CA needs
// (RFC 5280 section 4.2.1.9 and section 4.2.1.3):
// https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.9
// https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.3
//
// The public host name is a *.localhost name. OIDC issuers must use https
// (RFC 8414 section 2, https://www.rfc-editor.org/rfc/rfc8414#section-2), and a
// WebAuthn RP ID must be a valid domain that the caller origin is equal to or a
// registrable suffix of (https://www.w3.org/TR/webauthn-3/#rp-id). The
// `.localhost` name form is a secure context by definition:
// https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy
//
// The leaf validity stays below the 200-day cap the CA/Browser Forum Baseline
// Requirements put on subscriber certificates (section 6.3.2,
// https://cabforum.org/working-groups/server/baseline-requirements/requirements/),
// and the CA stays below the 825-day lifetime Apple documents for certificates
// it will trust (https://support.apple.com/en-us/103769). Neither limit is
// required for a locally trusted root; staying under both keeps the same CA
// acceptable to every browser that can install a local trust anchor.
const (
	// tlsDefaultHost is the public host every served listener answers at when
	// the run opts in. A client reaches it on the machine (macOS resolves the
	// whole *.localhost tree to loopback; systemd-resolved does the same on
	// Linux, RFC 6761 section 6.3) and inside a function container through the
	// runner's one add-host helper.
	// https://www.rfc-editor.org/rfc/rfc6761#section-6.3
	tlsDefaultHost = "app.localhost"

	// tlsLocalhostHost is the single-label secure-context name.
	tlsLocalhostHost = "localhost"

	// tlsTrustBundlePath is where every function container finds the run's
	// trust bundle. It is the same path the WebSocket management API's CA has
	// always used, so a run that serves both mounts one file.
	// https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html
	tlsTrustBundlePath = "/etc/apptheory-local/ca.pem"

	tlsCADirName  = "tls"
	tlsCACertFile = "ca.pem"
	tlsCAKeyFile  = "ca-key.pem"
	tlsLockFile   = "ca.lock"

	// tlsCAValidity and tlsLeafValidity are the documented lifetimes. The leaf
	// stays under the 200-day cap the CA/Browser Forum Baseline Requirements put
	// on subscriber certificates from 2026-03-15 (section 6.3.2), and the CA
	// stays under the 825-day lifetime Apple documents for TLS server
	// certificates. Neither limit binds a locally trusted root; staying under
	// both keeps the same CA acceptable to every browser that can install a
	// local trust anchor.
	// https://cabforum.org/working-groups/server/baseline-requirements/requirements/
	// https://support.apple.com/en-us/103769
	tlsCAValidity   = 825 * 24 * time.Hour
	tlsLeafValidity = 197 * 24 * time.Hour
)

// tlsTrustEnvironment is the trust-anchor variables one runtime reads, chosen
// per runtime instead of handed to every container. The set matters: the AWS
// SDK for Go v2 reads AWS_CA_BUNDLE during config loading and applies it only
// through its own buildable client, so a handler that supplies its own
// *http.Client (the shape a table mapper such as DynamORM uses) fails to load
// its config at all:
//
//	unable to add custom RootCAs HTTPClient, has no WithTransportOptions, *http.Client
//
// See resolveCustomCABundle in the pinned SDK:
// https://github.com/aws/aws-sdk-go-v2/blob/config/v1.33.13/config/resolve.go
//
// Go does not need that variable. crypto/x509 loads SSL_CERT_FILE into the
// system pool, which is what a default transport (and therefore a
// caller-supplied &http.Client{}) verifies against:
// https://pkg.go.dev/crypto/x509#SystemCertPool
//
// Node reads NODE_EXTRA_CA_CERTS, which the process adds to its default trust
// store at startup; the AWS SDK for JavaScript v3 uses Node's TLS stack and
// reads no CA-bundle variable of its own.
// https://nodejs.org/api/cli.html#node_extra_ca_certsfile
//
// Python's boto3/botocore read AWS_CA_BUNDLE and apply it through their own
// HTTP session (there is no caller-supplied-client failure path), requests
// reads REQUESTS_CA_BUNDLE, and ssl.create_default_context reads SSL_CERT_FILE
// through OpenSSL.
// https://docs.aws.amazon.com/sdkref/latest/guide/feature-custom-trust-store.html
// https://requests.readthedocs.io/en/latest/user/advanced/#ssl-cert-verification
// https://docs.python.org/3/library/ssl.html#ssl.create_default_context
//
// CURL_CA_BUNDLE is in every set because curl is a subprocess a handler can
// start on any runtime. https://curl.se/docs/manpage.html#--cacert
var (
	tlsTrustGo     = []string{"SSL_CERT_FILE", "CURL_CA_BUNDLE"}
	tlsTrustNode   = []string{"NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE"}
	tlsTrustPython = []string{"SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "AWS_CA_BUNDLE", "CURL_CA_BUNDLE"}
)

// tlsTrustEnvironment returns the variables one image class receives. An
// unknown class gets the Python set, which is the preflight image's class;
// RuntimeClass refuses an unknown runtime before a container starts.
func tlsTrustEnvironment(class string) []string {
	switch class {
	case imageClassGo:
		return tlsTrustGo
	case imageClassNode:
		return tlsTrustNode
	default:
		return tlsTrustPython
	}
}

// localTLS is one run's certificate authority and the leaf certificates the
// public listeners present.
type localTLS struct {
	// dir holds the CA. It is 0700; the key inside it is 0600.
	dir       string
	caPath    string
	caKeyPath string
	host      string

	caPEM  []byte
	caKey  *ecdsa.PrivateKey
	caCert *x509.Certificate

	// publicLeaf is the certificate every public listener presents. One leaf
	// covers the run host plus loopback addresses, so a client that connects by
	// name or by IP verifies the same chain.
	publicLeaf    tls.Certificate
	publicLeafPEM []byte
	leafKey       *ecdsa.PrivateKey
}

// validateTLSHost rejects a public host that cannot be an OIDC issuer and a
// WebAuthn RP ID. It must be `localhost` or a `*.localhost` DNS name: no port,
// no scheme, no IP literal, no other domain.
func validateTLSHost(host string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return errors.New("the local TLS host must not be empty")
	}
	if host != strings.ToLower(host) {
		return fmt.Errorf("the local TLS host %q must be lower case", host)
	}
	if host == tlsLocalhostHost {
		return nil
	}
	if !strings.HasSuffix(host, ".localhost") {
		return fmt.Errorf("the local TLS host %q must be localhost or a *.localhost name", host)
	}
	label := strings.TrimSuffix(host, ".localhost")
	if label == "" || strings.Contains(label, ".") {
		return fmt.Errorf("the local TLS host %q must be a single *.localhost label", host)
	}
	for _, char := range label {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9', char == '-':
		default:
			return fmt.Errorf("the local TLS host %q has an invalid character %q", host, char)
		}
	}
	if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
		return fmt.Errorf("the local TLS host %q has a leading or trailing hyphen", host)
	}
	return nil
}

// newLocalTLS loads the CA in dir, creating it on first use, and issues the
// public leaf. A CA that exists is reused byte for byte, so a browser or an
// identity provider that trusted run 1 still trusts run 2. originNames are the
// distribution origins a CloudFront hop has to verify against the declared
// origin domain name, which is the name CloudFront's certificate rule uses.
func newLocalTLS(dir, host string, originNames ...string) (*localTLS, error) {
	if err := validateTLSHost(host); err != nil {
		return nil, err
	}
	state, err := newLocalCASigner(dir)
	if err != nil {
		return nil, err
	}
	state.host = host
	if err := state.issuePublicLeaf(originNames); err != nil {
		return nil, err
	}
	return state, nil
}

// newLocalCASigner loads or creates the CA in dir and returns the signer. It
// issues no leaf; the `tls ca` command and an auxiliary-service leaf both use
// it.
func newLocalCASigner(dir string) (*localTLS, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create the local TLS directory %s: %w", dir, err)
	}
	// MkdirAll leaves an existing directory's mode alone.
	if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // the CA key lives here
		return nil, fmt.Errorf("make the local TLS directory %s private: %w", dir, err)
	}
	state := &localTLS{
		dir:       dir,
		caPath:    filepath.Join(dir, tlsCACertFile),
		caKeyPath: filepath.Join(dir, tlsCAKeyFile),
	}
	if err := state.loadOrCreateCA(); err != nil {
		return nil, err
	}
	return state, nil
}

// loadOrCreateCA reuses an existing CA or creates one. A malformed or expired
// CA fails closed: regenerating silently would invalidate a trust decision the
// caller already made.
func (s *localTLS) loadOrCreateCA() error {
	certPEM, certErr := os.ReadFile(s.caPath) //nolint:gosec // the caller owns the run directory
	keyPEM, keyErr := os.ReadFile(s.caKeyPath)
	switch {
	case certErr == nil && keyErr == nil:
		caCert, caKey, err := parseCA(certPEM, keyPEM)
		if err != nil {
			return fmt.Errorf("load the local CA in %s: %w", s.dir, err)
		}
		if time.Now().After(caCert.NotAfter) {
			return fmt.Errorf("the local CA in %s expired on %s; remove %s to create a new one", s.dir, caCert.NotAfter.UTC().Format(time.RFC3339), s.dir)
		}
		s.caPEM, s.caCert, s.caKey = certPEM, caCert, caKey
		return nil
	case os.IsNotExist(certErr) && os.IsNotExist(keyErr):
		return s.createCA()
	case certErr != nil:
		return fmt.Errorf("read the local CA certificate %s: %w", s.caPath, certErr)
	default:
		return fmt.Errorf("read the local CA key %s: %w", s.caKeyPath, keyErr)
	}
}

// parseCA parses the certificate and key and proves they belong together.
func parseCA(certPEM, keyPEM []byte) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, nil, errors.New("the CA certificate is not a PEM certificate")
	}
	caCert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse the CA certificate: %w", err)
	}
	if !caCert.IsCA {
		return nil, nil, errors.New("the CA certificate does not set the CA basic constraint")
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil || keyBlock.Type != "EC PRIVATE KEY" {
		return nil, nil, errors.New("the CA key is not a PEM EC private key")
	}
	caKey, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse the CA key: %w", err)
	}
	if !caKey.PublicKey.Equal(caCert.PublicKey) {
		return nil, nil, errors.New("the CA key does not match the CA certificate")
	}
	return caCert, caKey, nil
}

// createCA generates the run's CA once and writes it with the documented
// permissions. A lock file serializes two runs that share one --data-dir.
func (s *localTLS) createCA() error {
	unlock, err := lockTLSDirectory(s.dir)
	if err != nil {
		return err
	}
	defer unlock()
	// Another run may have created the CA while this one waited.
	certPEM, certErr := os.ReadFile(s.caPath) //nolint:gosec // the caller owns the run directory
	keyPEM, keyErr := os.ReadFile(s.caKeyPath)
	if certErr == nil && keyErr == nil {
		caCert, caKey, parseErr := parseCA(certPEM, keyPEM)
		if parseErr != nil {
			return fmt.Errorf("load the local CA in %s: %w", s.dir, parseErr)
		}
		s.caPEM, s.caCert, s.caKey = certPEM, caCert, caKey
		return nil
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate the local CA key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("generate the local CA serial: %w", err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "AppTheory Local Development CA",
			Organization: []string{"AppTheory local runner"},
		},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(tlsCAValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		SubjectKeyId:          publicKeyID(&key.PublicKey),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("create the local CA certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("marshal the local CA key: %w", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	caCert, err := x509.ParseCertificate(der)
	if err != nil {
		return fmt.Errorf("parse the created CA certificate: %w", err)
	}
	if err := writePrivateFile(s.caKeyPath, keyPEM); err != nil {
		return err
	}
	if err := os.WriteFile(s.caPath, certPEM, 0o644); err != nil { //nolint:gosec // a CA certificate is public
		return fmt.Errorf("write the local CA certificate %s: %w", s.caPath, err)
	}
	s.caPEM, s.caCert, s.caKey = certPEM, caCert, key
	return nil
}

// lockTLSDirectory takes an exclusive lock file next to the CA. It is released
// when the returned function runs. A lock left by a crashed run is removed once
// it is older than two minutes.
func lockTLSDirectory(dir string) (func(), error) {
	path := filepath.Join(dir, tlsLockFile)
	deadline := time.Now().Add(10 * time.Second)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // the lock file holds no secret
		if err == nil {
			_ = file.Close()                           //nolint:errcheck // the lock is the file's existence
			return func() { _ = os.Remove(path) }, nil //nolint:errcheck // best-effort unlock
		}
		if !os.IsExist(err) {
			return nil, fmt.Errorf("lock the local TLS directory %s: %w", dir, err)
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > 2*time.Minute {
			_ = os.Remove(path) //nolint:errcheck // a crashed run left the lock
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("the local TLS directory %s is locked by another run (%s exists)", dir, path)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// issuePublicLeaf issues the certificate the run's public listeners present.
// It names the run host, every declared CloudFront origin domain that is a
// local name, and both loopback addresses, so a browser, curl, a Go, Node or
// Python client, and the runner's own CloudFront origin hop all verify the
// same chain.
func (s *localTLS) issuePublicLeaf(originNames []string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate the local TLS leaf key: %w", err)
	}
	names := []string{s.host}
	seen := map[string]bool{s.host: true}
	for _, name := range originNames {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || seen[name] {
			continue
		}
		if nameErr := validateTLSHost(name); nameErr != nil {
			// An origin domain outside the local name space keeps the run
			// certificate it has; the origin hop verifies the mapped host
			// instead. Signing an arbitrary public name with a local CA is not
			// something this runner does.
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	certPEM, keyPEM, err := s.issueLeaf(key, names, []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")})
	if err != nil {
		return err
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("load the local TLS leaf: %w", err)
	}
	s.publicLeaf, s.publicLeafPEM, s.leafKey = pair, certPEM, key
	return nil
}

// issueCertificate issues one leaf for an explicit set of names. The WebSocket
// management API and an auxiliary service use it.
func (s *localTLS) issueCertificate(names []string, ips []net.IP) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate a local TLS key: %w", err)
	}
	certPEM, keyPEM, err := s.issueLeaf(key, names, ips)
	if err != nil {
		return tls.Certificate{}, err
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("load a local TLS certificate: %w", err)
	}
	return pair, nil
}

// issueLeaf signs one server certificate with the CA key.
func (s *localTLS) issueLeaf(key *ecdsa.PrivateKey, names []string, ips []net.IP) ([]byte, []byte, error) {
	if len(names) == 0 {
		return nil, nil, errors.New("a local TLS certificate needs at least one DNS name")
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, fmt.Errorf("generate a local TLS serial: %w", err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   names[0],
			Organization: []string{"AppTheory local runner"},
		},
		NotBefore:      now.Add(-time.Hour),
		NotAfter:       now.Add(tlsLeafValidity),
		KeyUsage:       x509.KeyUsageDigitalSignature,
		ExtKeyUsage:    []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:       append([]string(nil), names...),
		IPAddresses:    append([]net.IP(nil), ips...),
		SubjectKeyId:   publicKeyID(&key.PublicKey),
		AuthorityKeyId: s.caCert.SubjectKeyId,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, s.caCert, &key.PublicKey, s.caKey)
	if err != nil {
		return nil, nil, fmt.Errorf("create a local TLS certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal a local TLS key: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

// publicURL is the URL a person or a browser uses for one served listener.
func (r *Runner) publicURL(port int) string {
	if r.tls == nil {
		return fmt.Sprintf("http://127.0.0.1:%d", port)
	}
	return fmt.Sprintf("https://%s:%d", r.tls.host, port)
}

// tlsWebSocketURL is the ws/wss URL of one WebSocket API.
func (r *Runner) tlsWebSocketURL(port int, stage string) string {
	if r.tls == nil {
		return fmt.Sprintf("ws://127.0.0.1:%d/%s", port, stage)
	}
	return fmt.Sprintf("wss://%s:%d/%s", r.tls.host, port, stage)
}

// serverTLSConfig is the TLS configuration one public listener serves. It is
// nil when the run did not opt in, which keeps the plain-HTTP listener
// byte-for-byte identical.
func (r *Runner) serverTLSConfig() *tls.Config {
	if r.tls == nil {
		return nil
	}
	return &tls.Config{
		Certificates: []tls.Certificate{r.tls.publicLeaf},
		MinVersion:   tls.VersionTLS12,
		// HTTP/2 is negotiated when the client offers it; ServeTLS adds h2 to
		// NextProtos. An explicit list documents the intent and keeps an
		// intervening TLS config from dropping it.
		NextProtos: []string{"h2", "http/1.1"},
	}
}

// tlsTrustMounts mounts the run's CA into a function container. The path is the
// one every tlsTrustEnvironment variable points at.
func (r *Runner) tlsTrustMounts() []string {
	if r.tls == nil {
		return nil
	}
	return []string{r.tls.caPath + ":" + tlsTrustBundlePath + ":ro"}
}

// writeTLSTrustBundle copies the CA certificate to a stable, world-readable
// path under the run directory. The session reports it, and docs explain how a
// host client (curl, Go, Node, Python) points at it.
func (r *Runner) writeTLSTrustBundle() (string, error) {
	if r.tls == nil {
		return "", nil
	}
	path := filepath.Join(r.tls.dir, "trust-bundle.pem")
	if err := os.WriteFile(path, r.tls.caPEM, 0o644); err != nil { //nolint:gosec // a CA certificate is public
		return "", fmt.Errorf("write the local TLS trust bundle %s: %w", path, err)
	}
	return path, nil
}

// publicKeyID is the RFC 5280 section 4.2.1.2 method 1 key identifier: the
// SHA-256 of the subject public key bits.
// https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.2
func publicKeyID(public *ecdsa.PublicKey) []byte {
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		return nil
	}
	sum := sha256.Sum256(der)
	return sum[:]
}

// writePrivateFile writes a key with 0600.
func writePrivateFile(path string, contents []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600) //nolint:gosec // a private key file
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := file.Write(contents); err != nil {
		_ = file.Close() //nolint:errcheck // the write error is what matters
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return os.Chmod(path, 0o600) //nolint:gosec // an existing file keeps its older mode without this
}
