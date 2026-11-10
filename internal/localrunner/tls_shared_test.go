package localrunner

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestInitTLSSharedDirSharesOneCA proves the co-residence contract: two runs
// with different host names and one --shared-dir reuse one CA, and each run's
// leaf verifies against it, so a function in either run trusts the other's
// HTTPS listener.
func TestInitTLSSharedDirSharesOneCA(t *testing.T) {
	shared := t.TempDir()
	first := &Runner{
		options: Options{TLS: true, TLSHost: "auth.localhost", SharedDir: shared},
		scratch: t.TempDir(),
	}
	if err := first.initTLS(nil); err != nil {
		t.Fatalf("initTLS (auth): %v", err)
	}
	second := &Runner{
		options: Options{TLS: true, TLSHost: "mcp.localhost", SharedDir: shared},
		scratch: t.TempDir(),
	}
	if err := second.initTLS(nil); err != nil {
		t.Fatalf("initTLS (mcp): %v", err)
	}
	wantDir := filepath.Join(shared, sharedCADirName)
	if first.tls.dir != wantDir || second.tls.dir != wantDir {
		t.Fatalf("CA directories = %s and %s, want %s", first.tls.dir, second.tls.dir, wantDir)
	}
	if string(first.tls.caPEM) != string(second.tls.caPEM) {
		t.Fatal("--shared-dir did not share one CA across runs")
	}
	info, err := os.Stat(wantDir)
	if err != nil {
		t.Fatalf("stat the shared CA directory: %v", err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("shared CA directory mode = %o, want 0700", info.Mode().Perm())
	}
	keyInfo, err := os.Stat(first.tls.caKeyPath)
	if err != nil {
		t.Fatalf("stat the shared CA key: %v", err)
	}
	if keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("shared CA key mode = %o, want 0600", keyInfo.Mode().Perm())
	}
	// Each run's public leaf carries its own host and verifies against the one
	// shared CA.
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(first.tls.caPEM) {
		t.Fatal("the shared CA is not a PEM certificate")
	}
	for host, state := range map[string]*localTLS{"auth.localhost": first.tls, "mcp.localhost": second.tls} {
		leaf, parseErr := x509.ParseCertificate(state.publicLeaf.Certificate[0])
		if parseErr != nil {
			t.Fatalf("parse %s leaf: %v", host, parseErr)
		}
		if len(leaf.DNSNames) == 0 || leaf.DNSNames[0] != host {
			t.Fatalf("%s leaf names %v", host, leaf.DNSNames)
		}
		if _, verifyErr := leaf.Verify(x509.VerifyOptions{
			DNSName: host,
			Roots:   roots,
		}); verifyErr != nil {
			t.Fatalf("%s leaf does not verify against the shared CA: %v", host, verifyErr)
		}
	}
}

// TestInitTLSWithoutSharedDirKeepsTodaysLocation pins that a run with no
// --shared-dir behaves exactly as before: the CA stays in the run scratch.
func TestInitTLSWithoutSharedDirKeepsTodaysLocation(t *testing.T) {
	runner := &Runner{
		options: Options{TLS: true, TLSHost: "app.localhost"},
		scratch: t.TempDir(),
	}
	if err := runner.initTLS(nil); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	if runner.tls.dir != filepath.Join(runner.scratch, tlsCADirName) {
		t.Fatalf("CA directory = %s, want the run scratch", runner.tls.dir)
	}
}

// TestSharedCAFailsClosedOnAPartialPair covers an interrupted first creation: a
// co-resident run that finds only one of the two files refuses by name instead
// of replacing a CA someone may already trust.
func TestSharedCAFailsClosedOnAPartialPair(t *testing.T) {
	dir := filepath.Join(t.TempDir(), sharedCADirName)
	state, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("create the CA: %v", err)
	}
	// Remove the key, as an interrupted first creation would leave it.
	if removeErr := os.Remove(state.caKeyPath); removeErr != nil {
		t.Fatalf("remove the CA key: %v", removeErr)
	}
	_, recoveryErr := newLocalCASigner(dir)
	if recoveryErr == nil {
		t.Fatal("a shared CA with no key must fail closed")
	}
	if !strings.Contains(recoveryErr.Error(), "missing") {
		t.Fatalf("the refusal does not name the missing file: %v", recoveryErr)
	}
	// The certificate is still the original one: nothing was replaced.
	contents, readErr := os.ReadFile(state.caPath)
	if readErr != nil {
		t.Fatalf("read the CA certificate: %v", readErr)
	}
	if string(contents) != string(state.caPEM) {
		t.Fatal("the refusal replaced the CA certificate")
	}
}
