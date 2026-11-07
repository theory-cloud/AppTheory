package localrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// The runner-owned KMS front.
//
// The pinned moto 5.2.5 (and every moto release through master) ignores
// MessageType: Sign hashes the supplied message again even when the request
// names a digest, and Verify says so in its own docstring. AWS defines DIGEST
// as "the message is a digest, and KMS signs it as-is":
//
// https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
// https://docs.aws.amazon.com/kms/latest/APIReference/API_Verify.html
//
// The front therefore owns the key material for the key types the runner
// creates in practice -- symmetric AES-256 data keys and RSA/NIST ECC signing
// keys -- and serves their cryptographic operations itself. Every other
// operation, and every other key type, is proxied to moto unchanged. Owning
// the material is also what makes --data-dir keep key material across runs:
// moto is memory-only, so a key re-created from the CDK definition on the next
// start would otherwise have new material and could not decrypt data written
// under the previous key. Ciphertext is bound to the key that produced it:
//
// https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html
// https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#key-material
//
// Key material is persisted under <data-dir>/kms/keys.json. Without
// --data-dir the front keeps it in memory only, exactly as moto did.

const (
	kmsFrontIdentityTag = "apptheory-local:key-identity"
	kmsFrontTarget      = "TrentService"
	kmsFrontJSONType    = "application/x-amz-json-1.1"
	kmsFrontMaxBody     = 1 << 20
	kmsFrontTimeout     = 30 * time.Second
	kmsFrontKeyFile     = "keys.json"
	// The AWS key spec/usage names the front validates and defaults.
	kmsSpecSymmetricDefault = "SYMMETRIC_DEFAULT"
	kmsUsageEncryptDecrypt  = "ENCRYPT_DECRYPT"
	kmsUsageSignVerify      = "SIGN_VERIFY"
)

// kmsKeyRecord is one persisted key: a stable identity, the material, and the
// specification it was created for.
type kmsKeyRecord struct {
	Identity  string `json:"identity,omitempty"`
	StableID  string `json:"stableId"`
	KeySpec   string `json:"keySpec"`
	KeyUsage  string `json:"keyUsage"`
	CreatedAt string `json:"createdAt"`
	Material  string `json:"material"`
	// material is the parsed form; it is never serialized.
	material *kmsMaterial
}

// kmsRunKey maps one run's moto key to the material the front owns for it.
// moto re-creates the key on every start, so the mapping is per run; only the
// record behind it persists.
type kmsRunKey struct {
	record *kmsKeyRecord
	arn    string
}

// kmsKeyStore persists key records and indexes them by identity and by stable
// id. The maps are guarded by mu; a record is immutable once created.
type kmsKeyStore struct {
	mu         sync.RWMutex
	path       string
	records    []*kmsKeyRecord
	byIdentity map[string]*kmsKeyRecord
	byStable   map[string]*kmsKeyRecord
	byKeyID    map[string]*kmsRunKey
	byRecord   map[*kmsKeyRecord]*kmsRunKey
}

func newKMSKeyStore(dataDir string) (*kmsKeyStore, error) {
	store := &kmsKeyStore{
		byIdentity: map[string]*kmsKeyRecord{},
		byStable:   map[string]*kmsKeyRecord{},
		byKeyID:    map[string]*kmsRunKey{},
		byRecord:   map[*kmsKeyRecord]*kmsRunKey{},
	}
	if strings.TrimSpace(dataDir) == "" {
		return store, nil
	}
	dir := filepath.Join(dataDir, "kms")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create the KMS data directory %s: %w", dir, err)
	}
	store.path = filepath.Join(dir, kmsFrontKeyFile)
	payload, err := os.ReadFile(store.path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return nil, fmt.Errorf("read the persistent KMS keys %s: %w", store.path, err)
	}
	var file struct {
		Version int            `json:"version"`
		Keys    []kmsKeyRecord `json:"keys"`
	}
	if err := json.Unmarshal(payload, &file); err != nil {
		return nil, fmt.Errorf("parse the persistent KMS keys %s: %w", store.path, err)
	}
	if file.Version != 1 {
		return nil, fmt.Errorf("the persistent KMS keys %s use unsupported version %d", store.path, file.Version)
	}
	for index := range file.Keys {
		record := &file.Keys[index]
		if err := record.loadMaterial(); err != nil {
			return nil, fmt.Errorf("the persistent KMS key %s: %w", record.StableID, err)
		}
		store.records = append(store.records, record)
		store.byStable[record.StableID] = record
		if record.Identity != "" {
			store.byIdentity[record.Identity] = record
		}
	}
	sort.Slice(store.records, func(i, j int) bool { return store.records[i].StableID < store.records[j].StableID })
	return store, nil
}

// loadMaterial parses the record's serialized material.
func (r *kmsKeyRecord) loadMaterial() error {
	raw, err := base64.StdEncoding.DecodeString(r.Material)
	if err != nil {
		return fmt.Errorf("decode key material: %w", err)
	}
	material, err := parseKMSMaterial(r.KeySpec, r.KeyUsage, raw)
	if err != nil {
		return err
	}
	r.material = material
	return nil
}

// identify returns the record for an identity, if any.
func (s *kmsKeyStore) identify(identity string) *kmsKeyRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byIdentity[identity]
}

// stable returns the record with a stable id.
func (s *kmsKeyStore) stable(id string) *kmsKeyRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byStable[id]
}

// runKey returns the material mapped to one run's moto key.
func (s *kmsKeyStore) runKey(keyID string) *kmsRunKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byKeyID[keyID]
}

// add records a new key. It does not persist; create() does that after the
// upstream CreateKey succeeds.
func (s *kmsKeyStore) add(record *kmsKeyRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.byStable[record.StableID]; existing != nil {
		return fmt.Errorf("KMS stable id %s is already used by %s", record.StableID, existing.Identity)
	}
	s.byStable[record.StableID] = record
	if record.Identity != "" {
		s.byIdentity[record.Identity] = record
		// Only CDK-defined keys are re-created with the same identity on the
		// next start; runtime-created keys are the docs/125 memory-only state
		// and are deliberately not persisted.
		s.records = append(s.records, record)
	}
	return nil
}

// bind maps one run's moto key to a record.
func (s *kmsKeyStore) bind(motoKeyID, arn string, record *kmsKeyRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := &kmsRunKey{record: record, arn: arn}
	s.byKeyID[motoKeyID] = run
	s.byRecord[record] = run
}

// runFor returns the most recent run binding for a record.
func (s *kmsKeyStore) runFor(record *kmsKeyRecord) *kmsRunKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byRecord[record]
}

// save writes the records atomically. The file contains key material, so it is
// private to the user and replaced in one rename.
func (s *kmsKeyStore) save() error {
	if s.path == "" {
		return nil
	}
	s.mu.RLock()
	records := append([]*kmsKeyRecord(nil), s.records...)
	s.mu.RUnlock()
	sort.Slice(records, func(i, j int) bool { return records[i].StableID < records[j].StableID })
	file := struct {
		Version int             `json:"version"`
		Keys    []*kmsKeyRecord `json:"keys"`
	}{Version: 1, Keys: records}
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the persistent KMS keys: %w", err)
	}
	payload = append(payload, '\n')
	dir := filepath.Dir(s.path)
	temp, err := os.CreateTemp(dir, kmsFrontKeyFile+".tmp-*")
	if err != nil {
		return fmt.Errorf("create the persistent KMS keys: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }() //nolint:errcheck // the rename removes it on success
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close() //nolint:errcheck // the create failure is reported below
		return fmt.Errorf("make the persistent KMS keys private: %w", err)
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close() //nolint:errcheck // the write failure is reported below
		return fmt.Errorf("write the persistent KMS keys: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close() //nolint:errcheck // the sync failure is reported below
		return fmt.Errorf("sync the persistent KMS keys: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close the persistent KMS keys: %w", err)
	}
	if err := os.Rename(tempName, s.path); err != nil {
		return fmt.Errorf("replace the persistent KMS keys: %w", err)
	}
	return nil
}

// kmsFront serves the KMS JSON protocol and owns the key material it created.
type kmsFront struct {
	upstream    *url.URL
	client      *http.Client
	store       *kmsKeyStore
	logf        func(string, ...any)
	signer      *v4.Signer
	credentials aws.Credentials
	// hostURL and containerURL are filled by startKMSFront once the listener
	// exists; tests call ServeHTTP directly and leave them empty.
	hostURL      string
	containerURL string
}

func newKMSFront(dataDir, upstream string, logf func(string, ...any)) (*kmsFront, error) {
	parsed, err := url.Parse(strings.TrimSpace(upstream))
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("the KMS front has no upstream endpoint: %q", upstream)
	}
	store, err := newKMSKeyStore(dataDir)
	if err != nil {
		return nil, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &kmsFront{
		upstream: parsed,
		client: &http.Client{
			Timeout: kmsFrontTimeout,
			Transport: &http.Transport{
				Proxy:               nil,
				MaxIdleConnsPerHost: 16,
				IdleConnTimeout:     kmsFrontTimeout,
			},
		},
		store:       store,
		logf:        logf,
		signer:      v4.NewSigner(),
		credentials: aws.Credentials{AccessKeyID: "dummy", SecretAccessKey: "dummy"},
	}, nil
}

// ServeHTTP dispatches one KMS operation.
func (f *kmsFront) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeKMSError(writer, http.StatusBadRequest, "UnknownOperationException", "the local KMS front accepts the KMS JSON protocol")
		return
	}
	target := strings.TrimSpace(request.Header.Get("X-Amz-Target"))
	operation := target
	if prefix, name, ok := strings.Cut(target, "."); ok && prefix == kmsFrontTarget {
		operation = name
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, kmsFrontMaxBody))
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "read the KMS request: "+err.Error())
		return
	}
	ctx := request.Context()
	switch operation {
	case "CreateKey":
		f.handleCreateKey(ctx, writer, body)
	case "Sign":
		f.handleSign(ctx, writer, body)
	case "Verify":
		f.handleVerify(ctx, writer, body)
	case "GetPublicKey":
		f.handleGetPublicKey(ctx, writer, body)
	case "Encrypt":
		f.handleEncrypt(ctx, writer, body)
	case "Decrypt":
		f.handleDecrypt(ctx, writer, body)
	case "GenerateDataKey":
		f.handleGenerateDataKey(ctx, writer, body, true)
	case "GenerateDataKeyWithoutPlaintext":
		f.handleGenerateDataKey(ctx, writer, body, false)
	case "ReEncrypt":
		f.handleReEncrypt(ctx, writer, body)
	default:
		f.forward(ctx, writer, target, body)
	}
}

// handleCreateKey owns the material for the key types the runner serves and
// proxies the metadata creation to moto, whose KeyMetadata stays byte-for-byte
// what v7.0.0 returned.
//
//nolint:gocyclo // one branch per key form, identity and persistence error path
func (f *kmsFront) handleCreateKey(ctx context.Context, writer http.ResponseWriter, body []byte) {
	var request struct {
		KeySpec     string `json:"KeySpec"`
		KeyUsage    string `json:"KeyUsage"`
		Origin      string `json:"Origin"`
		MultiRegion bool   `json:"MultiRegion"`
	}
	_ = json.Unmarshal(body, &request) //nolint:errcheck // a malformed body is rejected by moto
	keySpec := strings.TrimSpace(request.KeySpec)
	if keySpec == "" {
		keySpec = kmsSpecSymmetricDefault
	}
	keyUsage := strings.TrimSpace(request.KeyUsage)
	if keyUsage == "" {
		keyUsage = kmsUsageEncryptDecrypt
	}
	identity, stripped := stripKMSIdentityTag(body)
	owned := kmsSupportedKey(keySpec, keyUsage) && strings.TrimSpace(request.Origin) == "" && !request.MultiRegion
	if !owned {
		f.forward(ctx, writer, kmsFrontTarget+".CreateKey", stripped)
		return
	}
	// moto stores a missing KeySpec/KeyUsage as null; AWS defaults them, so
	// send the defaults the front validated against.
	stripped = withKMSKeyDefaults(stripped, keySpec, keyUsage)
	record := f.store.identify(identity)
	if record != nil {
		if record.KeySpec != keySpec || record.KeyUsage != keyUsage {
			writeKMSError(writer, http.StatusBadRequest, "ValidationException", fmt.Sprintf(
				"the persistent local KMS key %s is %s/%s, but the definition asks for %s/%s; delete the --data-dir KMS state to start over",
				identity, record.KeySpec, record.KeyUsage, keySpec, keyUsage))
			return
		}
	} else {
		created, err := newKMSKeyRecord(identity, keySpec, keyUsage)
		if err != nil {
			writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
			return
		}
		if err := f.store.add(created); err != nil {
			writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
			return
		}
		record = created
	}
	status, headers, payload, err := f.proxy(ctx, kmsFrontTarget+".CreateKey", stripped)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	if status < http.StatusMultipleChoices {
		var response struct {
			KeyMetadata struct {
				KeyID string `json:"KeyId"`
				ARN   string `json:"Arn"`
			} `json:"KeyMetadata"`
		}
		if parseErr := json.Unmarshal(payload, &response); parseErr == nil && response.KeyMetadata.KeyID != "" {
			f.store.bind(response.KeyMetadata.KeyID, response.KeyMetadata.ARN, record)
			if record.Identity != "" {
				if saveErr := f.store.save(); saveErr != nil {
					writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", saveErr.Error())
					return
				}
			}
			f.logf("local KMS key %s for %s (%s/%s)", response.KeyMetadata.KeyID, recordLabel(record), record.KeySpec, record.KeyUsage)
		}
	}
	writeRawResponse(writer, status, headers, payload)
}

// proxy forwards one operation to moto and returns its response.
func (f *kmsFront) proxy(ctx context.Context, target string, body []byte) (int, http.Header, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.upstream.Scheme+"://"+f.upstream.Host+"/", bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("build the %s request: %w", target, err)
	}
	request.Header.Set("Content-Type", kmsFrontJSONType)
	request.Header.Set("X-Amz-Target", target)
	// moto's server mode dispatches on the SigV4 credential scope, not on the
	// X-Amz-Target header, so the upstream call must be signed as KMS exactly
	// as the runner's own SDK client signed it in v7.0.0.
	sum := sha256.Sum256(body)
	if signErr := f.signer.SignHTTP(ctx, f.credentials, request, hex.EncodeToString(sum[:]), "kms", LocalRegion, time.Now().UTC()); signErr != nil {
		return 0, nil, nil, fmt.Errorf("sign the %s request: %w", target, signErr)
	}
	response, err := f.client.Do(request) //nolint:gosec // the upstream is the runner's loopback emulator
	if err != nil {
		return 0, nil, nil, fmt.Errorf("%s: %w", target, err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the body is fully read below
	payload, err := io.ReadAll(io.LimitReader(response.Body, kmsFrontMaxBody))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("read the %s response: %w", target, err)
	}
	return response.StatusCode, response.Header.Clone(), payload, nil
}

// forward proxies an operation and streams its answer to the caller.
func (f *kmsFront) forward(ctx context.Context, writer http.ResponseWriter, target string, body []byte) {
	status, headers, payload, err := f.proxy(ctx, target, body)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	writeRawResponse(writer, status, headers, payload)
}

// resolveOwned maps any accepted KeyId form to the material the front owns. A
// key the front does not own returns false, and the caller proxies.
func (f *kmsFront) resolveOwned(ctx context.Context, keyID string) (*kmsRunKey, bool, error) {
	trimmed := strings.TrimSpace(keyID)
	if trimmed == "" {
		return nil, false, nil
	}
	if run := f.store.runKey(kmsRawKeyID(trimmed)); run != nil {
		return run, true, nil
	}
	// A stable id is the id the front persists across runs; a caller that
	// stored a previous run's key ARN still names the same material.
	if record := f.store.stable(kmsRawKeyID(trimmed)); record != nil {
		return &kmsRunKey{record: record, arn: stableARN(record)}, true, nil
	}
	if strings.HasPrefix(trimmed, "alias/") || strings.Contains(trimmed, ":alias/") {
		metadata, err := f.describeKey(ctx, trimmed)
		if err != nil {
			return nil, false, err
		}
		if run := f.store.runKey(metadata.KeyID); run != nil {
			return run, true, nil
		}
	}
	return nil, false, nil
}

type kmsKeyMetadata struct {
	KeyID string
	ARN   string
}

// describeKey asks moto to resolve alias, raw id and ARN forms, as KMS accepts
// all of them: https://docs.aws.amazon.com/kms/latest/developerguide/find-cmk-id-arn.html
func (f *kmsFront) describeKey(ctx context.Context, keyID string) (kmsKeyMetadata, error) {
	body, err := json.Marshal(map[string]string{"KeyId": keyID})
	if err != nil {
		return kmsKeyMetadata{}, err
	}
	status, _, payload, err := f.proxy(ctx, kmsFrontTarget+".DescribeKey", body)
	if err != nil {
		return kmsKeyMetadata{}, err
	}
	if status >= http.StatusMultipleChoices {
		return kmsKeyMetadata{}, &kmsServiceError{status: status, payload: payload}
	}
	var response struct {
		KeyMetadata struct {
			KeyID string `json:"KeyId"`
			ARN   string `json:"Arn"`
		} `json:"KeyMetadata"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return kmsKeyMetadata{}, fmt.Errorf("decode the DescribeKey response: %w", err)
	}
	return kmsKeyMetadata{KeyID: response.KeyMetadata.KeyID, ARN: response.KeyMetadata.ARN}, nil
}

// kmsServiceError carries an upstream error body so the front can return it
// unchanged instead of inventing an error.
type kmsServiceError struct {
	status  int
	payload []byte
}

func (e *kmsServiceError) Error() string { return strings.TrimSpace(string(e.payload)) }

// writeServiceError returns an upstream error body, or a plain error when it
// cannot be decoded.
func writeServiceError(writer http.ResponseWriter, err error) {
	var serviceErr *kmsServiceError
	if ok := asKMSServiceError(err, &serviceErr); ok {
		writer.Header().Set("Content-Type", kmsFrontJSONType)
		writer.WriteHeader(serviceErr.status)
		_, _ = writer.Write(serviceErr.payload) //nolint:errcheck // the response is already committed
		return
	}
	writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
}

func asKMSServiceError(err error, target **kmsServiceError) bool {
	serviceErr, ok := err.(*kmsServiceError)
	if ok {
		*target = serviceErr
	}
	return ok
}

// stripKMSIdentityTag removes the runner-owned identity tag before moto sees
// the request, so ListResourceTags and DescribeKey report exactly what v7.0.0
// reported. The tag is how a re-created key finds the material persisted for
// the same stack/logical id.
func stripKMSIdentityTag(body []byte) (string, []byte) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return "", body
	}
	rawTags, ok := fields["Tags"]
	if !ok {
		return "", body
	}
	var tags []map[string]string
	if err := json.Unmarshal(rawTags, &tags); err != nil {
		return "", body
	}
	identity := ""
	stripped := tags[:0]
	for _, tag := range tags {
		if tag["TagKey"] == kmsFrontIdentityTag {
			identity = strings.TrimSpace(tag["TagValue"])
			continue
		}
		stripped = append(stripped, tag)
	}
	if identity == "" {
		return "", body
	}
	encoded, err := json.Marshal(stripped)
	if err != nil {
		return "", body
	}
	fields["Tags"] = encoded
	updated, err := json.Marshal(fields)
	if err != nil {
		return "", body
	}
	return identity, updated
}

// withKMSKeyDefaults adds the AWS default KeySpec/KeyUsage when a CreateKey
// request omitted them, so moto stores the values AWS would, not null.
func withKMSKeyDefaults(body []byte, keySpec, keyUsage string) []byte {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return body
	}
	if _, exists := fields["KeySpec"]; !exists {
		encoded, err := json.Marshal(keySpec)
		if err != nil {
			return body
		}
		fields["KeySpec"] = encoded
	}
	if _, exists := fields["KeyUsage"]; !exists {
		encoded, err := json.Marshal(keyUsage)
		if err != nil {
			return body
		}
		fields["KeyUsage"] = encoded
	}
	updated, err := json.Marshal(fields)
	if err != nil {
		return body
	}
	return updated
}

// kmsRawKeyID extracts the raw key id from a raw id or an key ARN.
func kmsRawKeyID(keyID string) string {
	trimmed := strings.TrimSpace(keyID)
	if index := strings.Index(trimmed, ":key/"); index >= 0 {
		return trimmed[index+len(":key/"):]
	}
	return trimmed
}

func recordLabel(record *kmsKeyRecord) string {
	if record.Identity != "" {
		return record.Identity
	}
	return record.StableID
}

func writeKMSError(writer http.ResponseWriter, status int, code, message string) {
	payload, _ := json.Marshal(map[string]string{"__type": code, "message": message}) //nolint:errcheck // a fixed shape
	writer.Header().Set("Content-Type", kmsFrontJSONType)
	writer.WriteHeader(status)
	_, _ = writer.Write(payload) //nolint:errcheck // the response is already committed
}

func writeRawResponse(writer http.ResponseWriter, status int, headers http.Header, payload []byte) {
	if contentType := headers.Get("Content-Type"); contentType != "" {
		writer.Header().Set("Content-Type", contentType)
	} else {
		writer.Header().Set("Content-Type", kmsFrontJSONType)
	}
	writer.WriteHeader(status)
	_, _ = writer.Write(payload) //nolint:errcheck // the response is already committed
}

// kmsFrontHostURL is the loopback URL the runner's own provisioning client
// uses. Empty when the front is not running.
func (r *Runner) kmsFrontHostURL() string {
	if r.kmsFront == nil {
		return ""
	}
	return r.kmsFront.hostURL
}

// startKMSFront starts the front when the run's KMS endpoint is the profile's
// moto container. A caller-supplied --endpoint kms=... is left alone.
func (r *Runner) startKMSFront(ctx context.Context) error {
	backend, ok := r.backendForService("kms")
	if !ok || backend.HostURL == "" {
		return nil
	}
	// A caller-supplied --endpoint kms=... wins over the profile, and is never
	// fronted.
	if !r.profileEndpointServices["kms"] {
		return nil
	}
	front, err := newKMSFront(r.dataDir, backend.HostURL, r.logf)
	if err != nil {
		return err
	}
	listeners, err := r.listenControl(ctx, "KMS")
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           front,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("local KMS front stopped: %v", serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	front.hostURL = listeners.HostURL
	front.containerURL = listeners.ContainerURL
	r.kmsFront = front
	r.replaceEndpoint("kms", listeners.ContainerURL)
	r.logf("local KMS front at %s (containers: %s; moto upstream %s; ephemeral)", listeners.HostURL, listeners.ContainerURL, backend.HostURL)
	return nil
}

// replaceEndpoint updates one service's injected endpoint.
func (r *Runner) replaceEndpoint(service, url string) {
	for index := range r.endpoints {
		if r.endpoints[index].Service == service {
			r.endpoints[index].URL = url
			return
		}
	}
	r.endpoints = append(r.endpoints, Endpoint{Service: service, URL: url})
}
