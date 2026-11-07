package localrunner

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// Auxiliary-service certificates.
//
// An app-supplied auxiliary service (the first consumer is a local OIDC test
// IdP) can get a server certificate from the same CA an opted-in run uses, so a
// browser and a function container reach it over HTTPS and verify it with the
// run's trust bundle. `apptheory-local tls leaf` is the documented command; it
// requires --data-dir because the CA must outlive a single run and be the same
// CA `apptheory-local run --tls --data-dir ...` loads.
//
// The command prints file paths, never key material.

// TLSCA creates or loads the local CA under dataDir and returns the
// certificate and key paths.
func TLSCA(dataDir string) (string, string, error) {
	state, err := openLocalCA(dataDir)
	if err != nil {
		return "", "", err
	}
	return state.caPath, state.caKeyPath, nil
}

// TLSLeaf issues a server certificate for the given `*.localhost` names from
// the CA under dataDir. It writes cert.pem and key.pem into outDir and returns
// their paths.
func TLSLeaf(dataDir string, names []string, outDir string) (string, string, error) {
	if strings.TrimSpace(outDir) == "" {
		return "", "", errors.New("an output directory is required (--out)")
	}
	normalized := make([]string, 0, len(names))
	seen := map[string]struct{}{}
	for _, name := range names {
		name = strings.ToLower(strings.TrimSpace(name))
		if err := validateTLSHost(name); err != nil {
			return "", "", err
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	if len(normalized) == 0 {
		return "", "", errors.New("at least one --name is required")
	}
	state, err := openLocalCA(dataDir)
	if err != nil {
		return "", "", err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate the auxiliary certificate key: %w", err)
	}
	certPEM, keyPEM, err := state.issueLeaf(key, normalized, []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")})
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return "", "", fmt.Errorf("create the certificate directory %s: %w", outDir, err)
	}
	certPath := filepath.Join(outDir, "cert.pem")
	keyPath := filepath.Join(outDir, "key.pem")
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil { //nolint:gosec // a server certificate is public
		return "", "", fmt.Errorf("write %s: %w", certPath, err)
	}
	if err := writePrivateFile(keyPath, keyPEM); err != nil {
		return "", "", err
	}
	return certPath, keyPath, nil
}

// openLocalCA resolves the data directory and opens the CA under it.
func openLocalCA(dataDir string) (*localTLS, error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("--data-dir is required: the local CA must persist so a run and an auxiliary service share it")
	}
	dir, err := normalizeDataDir(dataDir)
	if err != nil {
		return nil, err
	}
	return newLocalCASigner(filepath.Join(dir, tlsCADirName))
}
