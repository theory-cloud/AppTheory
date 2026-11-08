package localrunner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The shared IAM plane.
//
// The three applications the runner serves each run their own `apptheory local`
// process, and one run's function assumes a role another run's stack defined.
// The IAM state therefore lives in one directory every co-resident run
// consults, beside the CA directory the co-residence work shares (docs/127
// W3-D1, "Cross-run IAM plane").
//
// Layout under <shared-dir>/iam:
//
//	runs/<run-id>.json        one run's role definitions and identity policies
//	credentials/<key-id>.json one issued credential or assumed session
//	sts/<run-id>.json         the STS endpoint the run serves
//
// Every file is written to a temporary name in the same directory and renamed
// into place, so a reader never sees a partial document. A run removes its own
// files when it stops; a file left by a killed run is ignored once its
// heartbeat is stale, and its credentials are refused at their expiry.
//
// A run with no --shared-dir keeps the whole plane under its own run scratch, so
// one run behaves exactly as before and only co-resident runs opt into sharing.

const (
	// iamPlaneDirName is the plane's directory inside the shared directory.
	iamPlaneDirName = "iam"
	// iamRunsDirName, iamCredentialsDirName and iamSTSDirName are the plane's
	// three subdirectories.
	iamRunsDirName        = "runs"
	iamCredentialsDirName = "credentials"
	iamSTSDirName         = "sts"
	// iamRunFileSuffix and iamCredentialFileSuffix keep the file families apart.
	iamRunFileSuffix      = ".json"
	iamCredentialFileType = "credential"
	// iamRunLease bounds how long a run's published definitions are trusted
	// without a heartbeat. A killed run stops refreshing and its definitions
	// lapse; a co-resident run refreshes every iamHeartbeatInterval.
	iamRunLease          = 10 * time.Minute
	iamHeartbeatInterval = 2 * time.Minute
	// iamSessionMaxDuration is the longest session the local STS mints.
	// AWS caps AssumeRole at 12 hours and defaults to one hour.
	// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
	iamSessionMaxDuration     = 12 * time.Hour
	iamSessionDefaultDuration = time.Hour
)

// iamPlane is one process's handle on the shared IAM state.
type iamPlane struct {
	dir string
	// runID identifies this run's published definitions.
	runID string
	// shared is true when the plane lives in a --shared-dir, so a diagnostic can
	// say whether a run can see another run's roles.
	shared bool
}

// iamRunDocument is one run's published IAM state.
type iamRunDocument struct {
	RunID     string        `json:"runId"`
	PID       int           `json:"pid"`
	StartedAt time.Time     `json:"startedAt"`
	Heartbeat time.Time     `json:"heartbeat"`
	Roles     []iamRoleSpec `json:"roles"`
	// STSURL is the STS endpoint this run serves, when it serves one.
	STSURL string `json:"stsUrl,omitempty"`
}

// iamCredentialRecord is one issued credential or assumed session.
type iamCredentialRecord struct {
	Kind         string `json:"kind"`
	RunID        string `json:"runId"`
	AccessKeyID  string `json:"accessKeyId"`
	Secret       string `json:"secret"`
	SessionToken string `json:"sessionToken,omitempty"`
	// PrincipalARN is the caller ARN: a role ARN for issued credentials, or the
	// assumed-role ARN for a session.
	PrincipalARN string `json:"principalArn"`
	// BaseARN is the base role or user ARN aws:PrincipalArn is compared with.
	BaseARN string `json:"baseArn"`
	Account string `json:"account"`
	// Function names the function the credential was issued to, when it was
	// issued to a function container.
	Function  string    `json:"function,omitempty"`
	IssuedAt  time.Time `json:"issuedAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// startIAMPlane creates or attaches to the plane and publishes this run's role
// definitions.
func (r *Runner) startIAMPlane(spec *Spec) error {
	dir := r.options.SharedDir
	shared := strings.TrimSpace(dir) != ""
	if shared {
		dir = filepath.Join(dir, iamPlaneDirName)
	} else {
		dir = filepath.Join(r.scratch, iamPlaneDirName)
	}
	for _, sub := range []string{iamRunsDirName, iamCredentialsDirName, iamSTSDirName} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			return fmt.Errorf("create the local IAM plane directory %s: %w", filepath.Join(dir, sub), err)
		}
	}
	r.iam = &iamPlane{dir: dir, runID: r.runID, shared: shared}
	r.iamStartedAt = time.Now().UTC()
	if err := r.publishIAMRun(spec); err != nil {
		return err
	}
	visibility := "this run only"
	if shared {
		visibility = "shared with every co-resident run"
	}
	r.logf("local IAM plane at %s (%s; %d role(s), %d issued credential(s))",
		dir, visibility, len(spec.IAMRoles), len(r.iamCredentials))
	return nil
}

// publishIAMRun writes this run's definitions and refreshes them periodically so
// a co-resident run can see the roles this run defines.
func (r *Runner) publishIAMRun(spec *Spec) error {
	document := iamRunDocument{
		RunID:     r.runID,
		PID:       os.Getpid(),
		StartedAt: r.iamStartedAt,
		Heartbeat: time.Now().UTC(),
		Roles:     spec.IAMRoles,
		STSURL:    r.iamSTSURL,
	}
	path := filepath.Join(r.iam.dir, iamRunsDirName, r.runID+iamRunFileSuffix)
	if err := writeJSONAtomic(path, document); err != nil {
		return err
	}
	if r.iamSTSURL != "" {
		stsPath := filepath.Join(r.iam.dir, iamSTSDirName, r.runID+iamRunFileSuffix)
		if err := writeJSONAtomic(stsPath, map[string]string{"runId": r.runID, "url": r.iamSTSURL}); err != nil {
			return err
		}
	}
	return nil
}

// refreshIAMRun rewrites this run's heartbeat. It runs until the context ends.
func (r *Runner) refreshIAMRun(ctx context.Context, spec *Spec) {
	ticker := time.NewTicker(iamHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.publishIAMRun(spec); err != nil {
				r.logf("local IAM plane: could not refresh this run's definitions: %v", err)
			}
		}
	}
}

// stopIAMPlane removes this run's own files. A run that crashes leaves them;
// iamRunLease bounds how long another run trusts them.
func (r *Runner) stopIAMPlane() {
	if r.iam == nil {
		return
	}
	for _, path := range []string{
		filepath.Join(r.iam.dir, iamRunsDirName, r.runID+iamRunFileSuffix),
		filepath.Join(r.iam.dir, iamSTSDirName, r.runID+iamRunFileSuffix),
	} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			r.logf("local IAM plane: could not remove %s: %v", path, err)
		}
	}
	r.iamMu.RLock()
	keys := make([]string, 0, len(r.iamCredentials))
	for keyID := range r.iamCredentials {
		keys = append(keys, keyID)
	}
	r.iamMu.RUnlock()
	for _, keyID := range keys {
		r.forgetIAMCredential(keyID)
	}
}

// addIAMCredential registers one issued credential in the plane and in this
// run's own map.
func (r *Runner) addIAMCredential(record iamCredentialRecord) error {
	record.Kind = iamCredentialFileType
	record.RunID = r.runID
	path := filepath.Join(r.iam.dir, iamCredentialsDirName, record.AccessKeyID+iamRunFileSuffix)
	if err := writeJSONAtomic(path, record); err != nil {
		return err
	}
	r.iamMu.Lock()
	if r.iamCredentials == nil {
		r.iamCredentials = map[string]iamCredentialRecord{}
	}
	if r.iamFunctionCredentials == nil {
		r.iamFunctionCredentials = map[string]iamCredentialRecord{}
	}
	r.iamCredentials[record.AccessKeyID] = record
	if record.Function != "" {
		r.iamFunctionCredentials[record.Function] = record
	}
	r.iamMu.Unlock()
	return nil
}

// forgetIAMCredential removes one credential from the plane and the run.
func (r *Runner) forgetIAMCredential(accessKeyID string) {
	if r.iam == nil {
		return
	}
	path := filepath.Join(r.iam.dir, iamCredentialsDirName, accessKeyID+iamRunFileSuffix)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		r.logf("local IAM plane: could not remove credential %s: %v", accessKeyID, err)
	}
	r.iamMu.Lock()
	if record, ok := r.iamCredentials[accessKeyID]; ok && record.Function != "" {
		delete(r.iamFunctionCredentials, record.Function)
	}
	delete(r.iamCredentials, accessKeyID)
	r.iamMu.Unlock()
}

// iamCredential looks up one access key in the plane. A record whose expiry has
// passed is refused by name, exactly as AWS refuses an expired session.
func (r *Runner) iamCredential(accessKeyID string) (iamCredentialRecord, bool) {
	if r.iam == nil {
		return iamCredentialRecord{}, false
	}
	r.iamMu.RLock()
	record, ok := r.iamCredentials[accessKeyID]
	r.iamMu.RUnlock()
	if ok {
		if record.ExpiresAt.IsZero() || time.Now().Before(record.ExpiresAt) {
			return record, true
		}
		return record, false
	}
	path := filepath.Join(r.iam.dir, iamCredentialsDirName, accessKeyID+iamRunFileSuffix)
	raw, err := os.ReadFile(path) //nolint:gosec // the plane is the run's own directory
	if err != nil {
		return iamCredentialRecord{}, false
	}
	var stored iamCredentialRecord
	if err := json.Unmarshal(raw, &stored); err != nil {
		return iamCredentialRecord{}, false
	}
	if stored.Kind != iamCredentialFileType || !stored.ExpiresAt.IsZero() && time.Now().After(stored.ExpiresAt) {
		return iamCredentialRecord{}, false
	}
	return stored, true
}

// iamRoles returns every role a co-resident run published, plus this run's own.
// A run whose heartbeat is older than iamRunLease is ignored.
func (r *Runner) iamRoles(spec *Spec) []iamRoleSpec {
	roles := append([]iamRoleSpec(nil), spec.IAMRoles...)
	if r.iam == nil {
		return roles
	}
	seen := map[string]struct{}{}
	for _, role := range roles {
		seen[role.ARN] = struct{}{}
	}
	dir := filepath.Join(r.iam.dir, iamRunsDirName)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return roles
	}
	now := time.Now()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), iamRunFileSuffix) {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		raw, readErr := os.ReadFile(path) //nolint:gosec // the plane is the run's own directory
		if readErr != nil {
			continue
		}
		var document iamRunDocument
		if json.Unmarshal(raw, &document) != nil || document.RunID == r.runID {
			continue
		}
		if now.Sub(document.Heartbeat) > iamRunLease {
			continue
		}
		for _, role := range document.Roles {
			if _, ok := seen[role.ARN]; ok {
				continue
			}
			seen[role.ARN] = struct{}{}
			roles = append(roles, role)
		}
	}
	sort.SliceStable(roles, func(i, j int) bool { return roles[i].ARN < roles[j].ARN })
	return roles
}

// iamRole looks up a role ARN across every co-resident run.
func (r *Runner) iamRole(spec *Spec, arn string) (iamRoleSpec, bool) {
	for _, role := range r.iamRoles(spec) {
		if role.ARN == arn {
			return role, true
		}
	}
	return iamRoleSpec{}, false
}

// writeJSONAtomic writes a document to a temporary file in the same directory
// and renames it into place, so a concurrent reader never sees a partial file.
func writeJSONAtomic(path string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create a temporary file in %s: %w", dir, err)
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }() //nolint:errcheck // best effort after a failed rename
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close() //nolint:errcheck // the write already failed
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close %s: %w", name, err)
	}
	if err := os.Chmod(name, 0o600); err != nil {
		return fmt.Errorf("restrict %s: %w", name, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("publish %s: %w", path, err)
	}
	return nil
}

// newAccessKeyID mints one credential identity. The prefix makes a leaked local
// key obvious in a log; the random half makes two runs' keys distinct.
func newAccessKeyID() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "LOCAL" + strings.ToUpper(shortID())
	}
	return "LOCAL" + strings.ToUpper(hex.EncodeToString(buffer))
}

// newSecretKey mints one secret key.
func newSecretKey() (string, error) {
	buffer := make([]byte, 30)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate a local IAM secret key: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

// iamSessionARN is the ARN STS reports for an assumed-role session.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_variables.html
func iamSessionARN(roleARN, sessionName string) string {
	account := ""
	name := ""
	if index := strings.LastIndex(roleARN, ":role/"); index >= 0 {
		account = roleARN[:index]
		account = account[strings.LastIndex(account, ":")+1:]
		name = roleARN[index+len(":role/"):]
	}
	return "arn:" + LocalPartition + ":sts::" + account + ":assumed-role/" + name + "/" + sessionName
}

// iamSessionName sanitizes a caller-supplied session name. AWS allows
// [\w+=,.@-]{2,64}.
// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
func iamSessionName(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "apptheory-local"
	}
	var builder strings.Builder
	for _, char := range trimmed {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9':
			builder.WriteRune(char)
		case strings.ContainsRune("+=,.@-_", char):
			builder.WriteRune(char)
		}
		if builder.Len() >= 64 {
			break
		}
	}
	if builder.Len() < 2 {
		return "apptheory-local"
	}
	return builder.String()
}

// errIAMPlaneUnavailable is returned when a run has no plane yet.
var errIAMPlaneUnavailable = errors.New("the run has no local IAM plane")
