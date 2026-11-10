package localrunner

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The @connections management API.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
//
// The runner serves PostToConnection, GetConnection and DeleteConnection on a
// TLS listener that binds loopback and, when the host owns the run network's
// gateway, that address too; a function container reaches it through
// host.docker.internal. It never binds the unspecified address. It is injected
// as the API Gateway Management API endpoint. The listener is TLS because every
// SDK builds the endpoint from the event's requestContext.domainName as
// https://<domainName>, and because the documented deployed management endpoint
// is HTTPS.
//
// A connection that has closed is reported with the documented 410 GONE.

const (
	webSocketManagementCACertPath  = "/etc/apptheory-local/ca.pem"
	webSocketManagementEndpointEnv = "AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI"
	// webSocketManagementCertDNS is the host a function container uses to reach
	// the host, and the certificate must name it.
	webSocketManagementCertDNS = "host.docker.internal"
)

// webSocketManagement is the run's connection registry and management server.
type webSocketManagement struct {
	mu          sync.RWMutex
	connections map[string]*webSocketConnection
	server      *http.Server
	// URL is the loopback URL the runner and the harness use; ContainerURL is
	// the URL a function container uses.
	URL          string
	ContainerURL string
	// certificate is the TLS key pair the management listener presents.
	certificate tls.Certificate
	// certificatePEM is the self-signed certificate every container must trust
	// when the run did not opt in to local TLS. It is nil when the run's CA
	// signs the management certificate instead.
	certificatePEM []byte
	// certificatePath is where the self-signed PEM is written for the container
	// mount. It is empty when the run's CA issues the certificate and the
	// shared trust bundle covers it.
	certificatePath string
	logf            func(format string, args ...any)
}

// newWebSocketManagement builds the registry and a certificate for the
// management endpoint. An opted-in run issues the certificate from the run's
// CA, so the one mounted trust bundle covers both the app's public URL and the
// management endpoint; a run without the opt-in keeps the self-signed
// certificate.
func newWebSocketManagement(scratch string, state *localTLS, logf func(format string, args ...any)) (*webSocketManagement, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if state != nil {
		certificate, err := state.issueCertificate(
			[]string{webSocketManagementCertDNS, tlsLocalhostHost},
			[]net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		)
		if err != nil {
			return nil, fmt.Errorf("issue the management certificate: %w", err)
		}
		return &webSocketManagement{
			connections: map[string]*webSocketConnection{},
			certificate: certificate,
			logf:        logf,
		}, nil
	}
	certificatePEM, err := selfSignedManagementCertificate()
	if err != nil {
		return nil, err
	}
	certificate, err := tls.X509KeyPair(certificatePEM, certificatePEM)
	if err != nil {
		return nil, fmt.Errorf("load the management certificate: %w", err)
	}
	path := filepath.Join(scratch, "websocket-management-ca.pem")
	if err := os.WriteFile(path, certificatePEM, 0o600); err != nil {
		return nil, fmt.Errorf("write the management CA: %w", err)
	}
	return &webSocketManagement{
		connections:     map[string]*webSocketConnection{},
		certificate:     certificate,
		certificatePEM:  certificatePEM,
		certificatePath: path,
		logf:            logf,
	}, nil
}

// startLoopback is the test/simple form: bind loopback only.
func (m *webSocketManagement) startLoopback(ctx context.Context) error {
	runner := &Runner{}
	listeners, err := runner.listenControl(ctx, "WebSocket management")
	if err != nil {
		return err
	}
	return m.start(ctx, listeners)
}

// start serves the management API over TLS on the control listeners the
// runner bound: loopback and, when the host owns it, the run network gateway.
func (m *webSocketManagement) start(_ context.Context, listeners *controlListeners) error {
	m.URL = "https://" + strings.TrimPrefix(listeners.HostURL, "http://")
	m.ContainerURL = "https://" + strings.TrimPrefix(listeners.ContainerURL, "http://")
	m.server = &http.Server{
		Handler:           m,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{m.certificate}, MinVersion: tls.VersionTLS12},
	}
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := m.server.ServeTLS(listener, "", ""); serveErr != nil &&
				serveErr != http.ErrServerClosed && !strings.Contains(serveErr.Error(), "use of closed network connection") {
				m.logf("WebSocket management API stopped: %v", serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	m.logf("serving the WebSocket management API at %s (containers: %s)", m.URL, m.ContainerURL)
	return nil
}

// certificateMounts is the CA bundle a container mounts when the management
// endpoint uses its own self-signed certificate. An opted-in run's CA signs the
// management certificate instead, and the run's trust bundle covers it.
func (m *webSocketManagement) certificateMounts() []string {
	if m == nil || m.certificatePath == "" {
		return nil
	}
	return []string{m.certificatePath + ":" + webSocketManagementCACertPath + ":ro"}
}

// ServeHTTP serves the three documented operations on /{connectionId}.
func (m *webSocketManagement) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	connectionID, ok := managementConnectionID(request.URL.Path)
	if !ok {
		http.Error(writer, "the management API needs /@connections/{connectionId}", http.StatusBadRequest)
		return
	}
	connection, ok := m.lookup(connectionID)
	if !ok {
		m.logf("websocket management: %s %s -> 410 (no such connection)", request.Method, connectionID)
		webSocketGone(writer)
		return
	}
	m.logf("websocket management: %s %s", request.Method, connectionID)
	switch request.Method {
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(request.Body, maxWebSocketMessageBytes+1))
		if err != nil {
			http.Error(writer, "read the payload", http.StatusBadRequest)
			return
		}
		if len(body) > maxWebSocketMessageBytes {
			http.Error(writer, "the payload exceeds the documented 128 KB limit", http.StatusRequestEntityTooLarge)
			return
		}
		opcode := byte(wsOpcodeText)
		if !isValidUTF8(body) {
			opcode = wsOpcodeBinary
		}
		if err := connection.conn.writeFrame(opcode, body); err != nil {
			webSocketGone(writer)
			return
		}
		writer.WriteHeader(http.StatusOK)
	case http.MethodGet:
		writer.Header().Set("Content-Type", "application/json")
		// The GetConnection response models connectedAt and lastActiveAt as
		// ISO-8601 timestamps, not epoch values:
		// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
		encoded, err := json.Marshal(map[string]any{
			"connectedAt":  connection.connectedAt.UTC().Format(time.RFC3339Nano),
			"lastActiveAt": connection.lastActiveAt.UTC().Format(time.RFC3339Nano),
			"identity": map[string]any{
				"sourceIp":  connection.sourceIP,
				"userAgent": connection.userAgent,
			},
		})
		if err != nil {
			http.Error(writer, "encode the connection", http.StatusInternalServerError)
			return
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(encoded) //nolint:errcheck // response already committed
	case http.MethodDelete:
		m.unregister(connectionID)
		connection.requestClose()
		_ = connection.conn.closeWithCode(wsCloseGoingAway, "") //nolint:errcheck // closing anyway
		writer.WriteHeader(http.StatusNoContent)
	default:
		writer.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// managementConnectionID parses the documented
// /{stage}/@connections/{connectionId} path. The endpoint the runner injects
// carries no stage, so the usual form is /@connections/{connectionId}.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
func managementConnectionID(path string) (string, bool) {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return "", false
	}
	segments := strings.Split(trimmed, "/")
	for index, segment := range segments {
		if segment != "@connections" {
			continue
		}
		// Exactly one id follows the @connections segment.
		if index+2 != len(segments) {
			continue
		}
		id := strings.TrimSpace(segments[index+1])
		if id == "" {
			return "", false
		}
		return id, true
	}
	return "", false
}

// webSocketGone is the documented 410 for a connection that has closed.
func webSocketGone(writer http.ResponseWriter) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusGone)
	_, _ = writer.Write([]byte(`{"message":"Gone"}`)) //nolint:errcheck // response already committed
}

func (m *webSocketManagement) register(connection *webSocketConnection) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.connections[connection.id] = connection
}

func (m *webSocketManagement) unregister(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.connections, id)
}

func (m *webSocketManagement) lookup(id string) (*webSocketConnection, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	connection, ok := m.connections[id]
	return connection, ok
}

// connectionCount reports the live connections; the tests and describe use it.
func (m *webSocketManagement) connectionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.connections)
}

// close stops the listener.
func (m *webSocketManagement) close() {
	if m.server != nil {
		_ = m.server.Close() //nolint:errcheck // shutting down the run's own server
	}
}

// selfSignedManagementCertificate builds a self-signed certificate for the
// container-facing host name and the loopback address. The PEM doubles as the
// CA bundle a container trusts through AWS_CA_BUNDLE/NODE_EXTRA_CA_CERTS.
func selfSignedManagementCertificate() ([]byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate the management key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("generate the management serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "apptheory-local WebSocket management"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
		DNSNames:              []string{webSocketManagementCertDNS, tlsLocalhostHost},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create the management certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("marshal the management key: %w", err)
	}
	certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	// tls.X509KeyPair accepts a combined PEM (certificate then key).
	return append(certificatePEM, keyPEM...), nil
}

func isValidUTF8(payload []byte) bool {
	return utf8.Valid(payload)
}
