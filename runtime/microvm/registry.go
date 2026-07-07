package microvm

import (
	"context"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/v2/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/v2/pkg/errors"
)

const (
	// EnvSessionRegistryTableName names the TableTheory table used for durable MicroVM session records.
	EnvSessionRegistryTableName = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE"
	// DefaultSessionRegistryTableName is the default durable MicroVM session registry table name.
	DefaultSessionRegistryTableName = "apptheory-microvm-sessions"
)

// SessionRegistryRecord is the canonical TableTheory/DynamoDB-shaped durable MicroVM session item.
//
// PK and SK are derived from tenant_id/namespace/session_id. ValidateSessionRegistryRecord fails closed
// if those keys do not match the bound tenant/session identity or if metadata contains forbidden fields.
type SessionRegistryRecord struct {
	PK                          string                 `theorydb:"pk,attr:pk" json:"pk"`
	SK                          string                 `theorydb:"sk,attr:sk" json:"sk"`
	TenantID                    string                 `theorydb:"attr:tenant_id" json:"tenant_id"`
	Namespace                   string                 `theorydb:"attr:namespace" json:"namespace"`
	SessionID                   string                 `theorydb:"attr:session_id" json:"session_id"`
	State                       LifecycleState         `theorydb:"attr:state" json:"state"`
	DesiredState                LifecycleState         `theorydb:"attr:desired_state" json:"desired_state"`
	Endpoint                    string                 `theorydb:"attr:endpoint,omitempty" json:"endpoint,omitempty"`
	MicroVMID                   string                 `theorydb:"attr:microvm_id,omitempty" json:"microvm_id,omitempty"`
	ProviderID                  string                 `theorydb:"attr:provider_id" json:"provider_id"`
	ProviderMicroVMID           string                 `theorydb:"attr:provider_microvm_id,omitempty" json:"provider_microvm_id,omitempty"`
	ProviderState               string                 `theorydb:"attr:provider_state" json:"provider_state"`
	AWSLifecycleState           string                 `theorydb:"attr:aws_lifecycle_state" json:"aws_lifecycle_state"`
	ImageRef                    string                 `theorydb:"attr:image_ref" json:"image_ref"`
	ImageVersion                string                 `theorydb:"attr:image_version,omitempty" json:"image_version,omitempty"`
	NetworkConnectorRef         string                 `theorydb:"attr:network_connector_ref" json:"network_connector_ref"`
	IngressNetworkConnectorRefs []string               `theorydb:"attr:ingress_network_connector_refs,omitempty" json:"ingress_network_connector_refs,omitempty"`
	EgressNetworkConnectorRefs  []string               `theorydb:"attr:egress_network_connector_refs,omitempty" json:"egress_network_connector_refs,omitempty"`
	ControllerID                string                 `theorydb:"attr:controller_id" json:"controller_id"`
	CreatedAt                   time.Time              `theorydb:"attr:created_at" json:"created_at"`
	UpdatedAt                   time.Time              `theorydb:"attr:updated_at" json:"updated_at"`
	LastObservedAt              time.Time              `theorydb:"attr:last_observed_at" json:"last_observed_at"`
	ProviderStartedAt           time.Time              `theorydb:"attr:provider_started_at,omitempty" json:"provider_started_at,omitempty"`
	ProviderTerminatedAt        time.Time              `theorydb:"attr:provider_terminated_at,omitempty" json:"provider_terminated_at,omitempty"`
	ExpiresAt                   time.Time              `theorydb:"attr:expires_at" json:"expires_at"`
	TTL                         int64                  `theorydb:"ttl,attr:ttl" json:"ttl"`
	Generation                  int64                  `theorydb:"attr:generation" json:"generation"`
	Version                     int64                  `theorydb:"version,attr:version" json:"version"`
	LastAction                  Command                `theorydb:"attr:last_action" json:"last_action"`
	LastCommandID               string                 `theorydb:"attr:last_command_id" json:"last_command_id"`
	AuthSubject                 string                 `theorydb:"attr:auth_subject" json:"auth_subject"`
	ReasonMetadata              map[string]string      `theorydb:"attr:reason_metadata,omitempty" json:"reason_metadata,omitempty"`
	StatusMetadata              map[string]string      `theorydb:"attr:status_metadata,omitempty" json:"status_metadata,omitempty"`
	TokenMetadata               []SessionTokenMetadata `theorydb:"attr:token_metadata,omitempty" json:"token_metadata,omitempty"`
	Metadata                    map[string]string      `theorydb:"attr:metadata,omitempty" json:"metadata,omitempty"`
}

// TableName returns the configured durable MicroVM session registry table name.
func (SessionRegistryRecord) TableName() string {
	return SessionRegistryTableName()
}

// SessionRegistry stores canonical durable MicroVM session records.
type SessionRegistry interface {
	Put(context.Context, SessionRecord) (SessionRecord, error)
	Get(context.Context, SessionKey) (SessionRecord, error)
	Delete(context.Context, SessionKey) error
}

// SessionListInput identifies a tenant-bound registry list operation.
type SessionListInput struct {
	RequestID   string `json:"request_id"`
	TenantID    string `json:"tenant_id"`
	Namespace   string `json:"namespace"`
	AuthSubject string `json:"auth_subject,omitempty"`
}

// SessionRegistryLister is the optional tenant-bound list surface required by real controller list routes.
type SessionRegistryLister interface {
	List(context.Context, SessionListInput) ([]SessionRecord, error)
}

// SessionReconstructionRequest is the fail-closed request sent to product-owned registry truth.
type SessionReconstructionRequest struct {
	RequestID   string         `json:"request_id"`
	TenantID    string         `json:"tenant_id"`
	Namespace   string         `json:"namespace"`
	SessionID   string         `json:"session_id"`
	AuthSubject string         `json:"auth_subject,omitempty"`
	Now         time.Time      `json:"now"`
	Existing    *SessionRecord `json:"existing,omitempty"`
}

// SessionReconstructionHook reconstructs operational MicroVM registry state from product truth.
//
// The hook is caller-owned. AppTheory never infers unknown account-wide AWS MicroVM state and
// never passes raw SDK clients, credentials, provider errors, pagination tokens, or token values.
type SessionReconstructionHook func(context.Context, SessionReconstructionRequest) (SessionRecord, error)

// ReconstructingSessionRegistry wraps a registry with a product-owned reconstruction hook.
type ReconstructingSessionRegistry struct {
	registry   SessionRegistry
	hook       SessionReconstructionHook
	staleAfter time.Duration
	clock      Clock
}

var _ SessionRegistry = (*ReconstructingSessionRegistry)(nil)

// SessionReconstructionOption configures a reconstructing registry wrapper.
type SessionReconstructionOption func(*ReconstructingSessionRegistry)

// WithSessionReconstructionStaleAfter reconstructs records older than the configured observation window.
func WithSessionReconstructionStaleAfter(staleAfter time.Duration) SessionReconstructionOption {
	return func(registry *ReconstructingSessionRegistry) {
		if staleAfter > 0 {
			registry.staleAfter = staleAfter
		}
	}
}

// WithSessionReconstructionClock sets the clock used for stale-record checks.
func WithSessionReconstructionClock(clock Clock) SessionReconstructionOption {
	return func(registry *ReconstructingSessionRegistry) {
		if clock == nil {
			registry.clock = realClock{}
			return
		}
		registry.clock = clock
	}
}

// NewReconstructingSessionRegistry creates a registry wrapper that fails closed without a hook.
func NewReconstructingSessionRegistry(registry SessionRegistry, hook SessionReconstructionHook, opts ...SessionReconstructionOption) (*ReconstructingSessionRegistry, error) {
	if registry == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a session registry", "")
	}
	if hook == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a product hook", "")
	}
	wrapped := &ReconstructingSessionRegistry{registry: registry, hook: hook, clock: realClock{}}
	for _, opt := range opts {
		if opt != nil {
			opt(wrapped)
		}
	}
	return wrapped, nil
}

// Put validates and stores a reconstructed or caller-supplied session record.
func (r *ReconstructingSessionRegistry) Put(ctx context.Context, record SessionRecord) (SessionRecord, error) {
	if r == nil || r.registry == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a session registry", record.LastCommandID)
	}
	return r.registry.Put(ctx, record)
}

// Get returns a fresh tenant-bound record, reconstructing from product truth only when needed.
func (r *ReconstructingSessionRegistry) Get(ctx context.Context, key SessionKey) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if r == nil || r.registry == nil || r.hook == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a product hook", "")
	}
	key = normalizeSessionKey(key)
	if err := validateSessionKey(key, ""); err != nil {
		return SessionRecord{}, err
	}
	now := reconstructionNow(r.clock)
	record, err := r.registry.Get(ctx, key)
	if err == nil && !sessionRecordIsStale(record, now, r.staleAfter) {
		return record, nil
	}
	var existing *SessionRecord
	if err == nil {
		existingRecord := record
		existing = &existingRecord
	}
	reconstructed, err := ReconstructSessionRecord(ctx, SessionReconstructionRequest{
		TenantID:  key.TenantID,
		Namespace: key.Namespace,
		SessionID: key.SessionID,
		Now:       now,
		Existing:  existing,
	}, r.hook)
	if err != nil {
		return SessionRecord{}, err
	}
	return r.registry.Put(ctx, reconstructed)
}

// Delete delegates tenant-bound deletion to the wrapped registry.
func (r *ReconstructingSessionRegistry) Delete(ctx context.Context, key SessionKey) error {
	if r == nil || r.registry == nil {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a session registry", "")
	}
	return r.registry.Delete(ctx, key)
}

// List delegates tenant-bound listing when the wrapped registry exposes a list surface.
func (r *ReconstructingSessionRegistry) List(ctx context.Context, input SessionListInput) ([]SessionRecord, error) {
	if r == nil || r.registry == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a session registry", input.RequestID)
	}
	lister, ok := r.registry.(SessionRegistryLister)
	if !ok {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires tenant-bound list support", input.RequestID)
	}
	return lister.List(ctx, input)
}

// ReconstructSessionRecord invokes a product-owned hook and validates the returned operational state.
func ReconstructSessionRecord(ctx context.Context, request SessionReconstructionRequest, hook SessionReconstructionHook) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	request = normalizeSessionReconstructionRequest(request)
	key := SessionKey{TenantID: request.TenantID, Namespace: request.Namespace, SessionID: request.SessionID}
	if err := validateSessionKey(key, request.RequestID); err != nil {
		return SessionRecord{}, err
	}
	if hook == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction requires a product hook", request.RequestID)
	}
	record, err := hook(ctx, request)
	if err != nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction hook failed", request.RequestID)
	}
	record = normalizeSessionRecord(record)
	if record.TenantID != request.TenantID || record.Namespace != request.Namespace || record.SessionID != request.SessionID {
		return SessionRecord{}, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm registry reconstruction tenant/session mismatch", request.RequestID)
	}
	if err := ValidateSessionRecord(record); err != nil {
		return SessionRecord{}, err
	}
	if !request.Now.IsZero() && !record.ExpiresAt.After(request.Now) {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry reconstruction returned stale state", request.RequestID)
	}
	return record, nil
}

// SessionRegistryTableName returns the configured registry table name.
func SessionRegistryTableName() string {
	if name := strings.TrimSpace(os.Getenv(EnvSessionRegistryTableName)); name != "" {
		return name
	}
	return DefaultSessionRegistryTableName
}

// SessionRegistryPartitionKey derives the TableTheory partition key for a tenant-bound namespace.
func SessionRegistryPartitionKey(tenantID, namespace string) string {
	tenantID = strings.TrimSpace(tenantID)
	namespace = strings.TrimSpace(namespace)
	if tenantID == "" || namespace == "" {
		return ""
	}
	return "TENANT#" + tenantID + "#NAMESPACE#" + namespace
}

// SessionRegistrySortKey derives the TableTheory sort key for a session.
func SessionRegistrySortKey(sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ""
	}
	return "SESSION#" + sessionID
}

// ValidateSessionRegistryRecord fails closed when a durable registry item is incomplete, unsafe,
// or its derived TableTheory keys do not match its tenant/session identity.
func ValidateSessionRegistryRecord(record SessionRegistryRecord) error {
	record = normalizeSessionRegistryRecord(record)
	session := sessionRecordFromRegistryNoValidate(record)
	if err := validateSessionRecordIdentity(session); err != nil {
		return err
	}
	if err := validateSessionRecordRegistryFields(session); err != nil {
		return err
	}
	if !validCommand(record.LastAction) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry last action is unsupported", record.LastCommandID)
	}
	if record.PK == "" || record.SK == "" || record.TTL <= 0 || record.Version <= 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry keys are incomplete", record.LastCommandID)
	}
	if record.PK != SessionRegistryPartitionKey(record.TenantID, record.Namespace) || record.SK != SessionRegistrySortKey(record.SessionID) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry tenant/session key mismatch", record.LastCommandID)
	}
	if record.TTL != record.ExpiresAt.UTC().Unix() {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry ttl mismatch", record.LastCommandID)
	}
	if err := validateSafeMetadata(record.ReasonMetadata, record.LastCommandID); err != nil {
		return err
	}
	if err := validateSafeMetadata(record.StatusMetadata, record.LastCommandID); err != nil {
		return err
	}
	for _, token := range record.TokenMetadata {
		if err := ValidateSessionTokenMetadata(token, record.LastCommandID); err != nil {
			return err
		}
	}
	return validateSafeMetadata(record.Metadata, record.LastCommandID)
}

// SessionRecordToRegistryRecord converts a safe session record into the canonical durable registry item.
func SessionRecordToRegistryRecord(record SessionRecord) (SessionRegistryRecord, error) {
	record = normalizeSessionRecord(record)
	if err := ValidateSessionRecord(record); err != nil {
		return SessionRegistryRecord{}, err
	}
	registry := SessionRegistryRecord{
		PK:                          SessionRegistryPartitionKey(record.TenantID, record.Namespace),
		SK:                          SessionRegistrySortKey(record.SessionID),
		TenantID:                    record.TenantID,
		Namespace:                   record.Namespace,
		SessionID:                   record.SessionID,
		State:                       record.State,
		DesiredState:                record.DesiredState,
		Endpoint:                    record.Endpoint,
		MicroVMID:                   record.MicroVMID,
		ProviderID:                  record.ProviderID,
		ProviderMicroVMID:           record.ProviderMicroVMID,
		ProviderState:               record.ProviderState,
		AWSLifecycleState:           record.AWSLifecycleState,
		ImageRef:                    record.ImageRef,
		ImageVersion:                record.ImageVersion,
		NetworkConnectorRef:         record.NetworkConnectorRef,
		IngressNetworkConnectorRefs: append([]string(nil), record.IngressNetworkConnectorRefs...),
		EgressNetworkConnectorRefs:  append([]string(nil), record.EgressNetworkConnectorRefs...),
		ControllerID:                record.ControllerID,
		CreatedAt:                   record.CreatedAt.UTC(),
		UpdatedAt:                   record.UpdatedAt.UTC(),
		LastObservedAt:              record.LastObservedAt.UTC(),
		ProviderStartedAt:           record.ProviderStartedAt.UTC(),
		ProviderTerminatedAt:        record.ProviderTerminatedAt.UTC(),
		ExpiresAt:                   record.ExpiresAt.UTC(),
		TTL:                         record.ExpiresAt.UTC().Unix(),
		Generation:                  record.Generation,
		Version:                     record.Generation,
		LastAction:                  record.LastAction,
		LastCommandID:               record.LastCommandID,
		AuthSubject:                 record.AuthSubject,
		ReasonMetadata:              cloneStringMap(record.ReasonMetadata),
		StatusMetadata:              cloneStringMap(record.StatusMetadata),
		TokenMetadata:               cloneSessionTokenMetadata(record.TokenMetadata),
		Metadata:                    cloneStringMap(record.Metadata),
	}
	if err := ValidateSessionRegistryRecord(registry); err != nil {
		return SessionRegistryRecord{}, err
	}
	return registry, nil
}

// SessionRecordFromRegistryRecord converts a durable registry item into the safe session record shape.
func SessionRecordFromRegistryRecord(record SessionRegistryRecord) (SessionRecord, error) {
	record = normalizeSessionRegistryRecord(record)
	if err := ValidateSessionRegistryRecord(record); err != nil {
		return SessionRecord{}, err
	}
	out := sessionRecordFromRegistryNoValidate(record)
	if err := ValidateSessionRecord(out); err != nil {
		return SessionRecord{}, err
	}
	return out, nil
}

// TableTheorySessionRegistry stores MicroVM session registry records through the blessed TableTheory DB path.
type TableTheorySessionRegistry struct {
	db tablecore.DB
}

var _ SessionRegistry = (*TableTheorySessionRegistry)(nil)

// NewTableTheorySessionRegistry creates a TableTheory-backed durable MicroVM session registry.
func NewTableTheorySessionRegistry(db tablecore.DB) (*TableTheorySessionRegistry, error) {
	if db == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry requires TableTheory DB", "")
	}
	return &TableTheorySessionRegistry{db: db}, nil
}

// Put validates and upserts a session record through TableTheory.
func (r *TableTheorySessionRegistry) Put(ctx context.Context, record SessionRecord) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if r == nil || r.db == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry requires TableTheory DB", record.LastCommandID)
	}
	registry, err := SessionRecordToRegistryRecord(record)
	if err != nil {
		return SessionRecord{}, err
	}
	if err := r.db.Model(&registry).WithContext(ctx).CreateOrUpdate(); err != nil {
		return SessionRecord{}, sessionRegistryOperationError(record.LastCommandID)
	}
	return SessionRecordFromRegistryRecord(registry)
}

// Get retrieves a tenant-bound session record through TableTheory.
func (r *TableTheorySessionRegistry) Get(ctx context.Context, key SessionKey) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	key = normalizeSessionKey(key)
	if err := validateSessionKey(key, ""); err != nil {
		return SessionRecord{}, err
	}
	if r == nil || r.db == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry requires TableTheory DB", "")
	}
	var record SessionRegistryRecord
	err := r.db.Model(&SessionRegistryRecord{}).
		WithContext(ctx).
		Where("PK", "=", SessionRegistryPartitionKey(key.TenantID, key.Namespace)).
		Where("SK", "=", SessionRegistrySortKey(key.SessionID)).
		First(&record)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry record not found", "")
		}
		return SessionRecord{}, sessionRegistryOperationError("")
	}
	return SessionRecordFromRegistryRecord(record)
}

// Delete removes a tenant-bound session record through TableTheory.
func (r *TableTheorySessionRegistry) Delete(ctx context.Context, key SessionKey) error {
	if ctx == nil {
		ctx = context.Background()
	}
	key = normalizeSessionKey(key)
	if err := validateSessionKey(key, ""); err != nil {
		return err
	}
	if r == nil || r.db == nil {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry requires TableTheory DB", "")
	}
	if err := r.db.Model(&SessionRegistryRecord{}).
		WithContext(ctx).
		Where("PK", "=", SessionRegistryPartitionKey(key.TenantID, key.Namespace)).
		Where("SK", "=", SessionRegistrySortKey(key.SessionID)).
		Delete(); err != nil {
		return sessionRegistryOperationError("")
	}
	return nil
}

// List retrieves tenant-bound session records through TableTheory.
func (r *TableTheorySessionRegistry) List(ctx context.Context, input SessionListInput) ([]SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	input = normalizeSessionListInput(input)
	if input.TenantID == "" || input.Namespace == "" {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session list is incomplete", input.RequestID)
	}
	if r == nil || r.db == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry requires TableTheory DB", input.RequestID)
	}
	var records []SessionRegistryRecord
	if err := r.db.Model(&SessionRegistryRecord{}).
		WithContext(ctx).
		Where("PK", "=", SessionRegistryPartitionKey(input.TenantID, input.Namespace)).
		All(&records); err != nil {
		return nil, sessionRegistryOperationError(input.RequestID)
	}
	out := make([]SessionRecord, 0, len(records))
	for _, record := range records {
		session, err := SessionRecordFromRegistryRecord(record)
		if err != nil {
			return nil, err
		}
		out = append(out, session)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].SessionID < out[j].SessionID
	})
	return out, nil
}

// MemorySessionRegistry is a deterministic in-memory SessionRegistry for tests and local contract runners.
type MemorySessionRegistry struct {
	mu      sync.Mutex
	records map[string]SessionRegistryRecord
}

var _ SessionRegistry = (*MemorySessionRegistry)(nil)

// NewMemorySessionRegistry creates an empty deterministic session registry.
func NewMemorySessionRegistry() *MemorySessionRegistry {
	return &MemorySessionRegistry{records: map[string]SessionRegistryRecord{}}
}

// Put validates and stores a record in memory.
func (r *MemorySessionRegistry) Put(_ context.Context, record SessionRecord) (SessionRecord, error) {
	if r == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry is not configured", record.LastCommandID)
	}
	registry, err := SessionRecordToRegistryRecord(record)
	if err != nil {
		return SessionRecord{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.records == nil {
		r.records = map[string]SessionRegistryRecord{}
	}
	r.records[registryRecordKey(registry)] = cloneSessionRegistryRecord(registry)
	return SessionRecordFromRegistryRecord(registry)
}

// Get loads a record from memory by its tenant-bound key.
func (r *MemorySessionRegistry) Get(_ context.Context, key SessionKey) (SessionRecord, error) {
	if r == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry is not configured", "")
	}
	key = normalizeSessionKey(key)
	if err := validateSessionKey(key, ""); err != nil {
		return SessionRecord{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.records[registryRecordKeyFromKey(key)]
	if !ok {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry record not found", "")
	}
	return SessionRecordFromRegistryRecord(cloneSessionRegistryRecord(record))
}

// Delete removes a record from memory by its tenant-bound key.
func (r *MemorySessionRegistry) Delete(_ context.Context, key SessionKey) error {
	if r == nil {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry is not configured", "")
	}
	key = normalizeSessionKey(key)
	if err := validateSessionKey(key, ""); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.records, registryRecordKeyFromKey(key))
	return nil
}

// List returns records for exactly one tenant and namespace.
func (r *MemorySessionRegistry) List(_ context.Context, input SessionListInput) ([]SessionRecord, error) {
	if r == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry is not configured", input.RequestID)
	}
	input = normalizeSessionListInput(input)
	if input.TenantID == "" || input.Namespace == "" {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session list is incomplete", input.RequestID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]SessionRecord, 0)
	for _, record := range r.records {
		if record.TenantID != input.TenantID || record.Namespace != input.Namespace {
			continue
		}
		session, err := SessionRecordFromRegistryRecord(cloneSessionRegistryRecord(record))
		if err != nil {
			return nil, err
		}
		out = append(out, session)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].SessionID < out[j].SessionID
	})
	return out, nil
}

func normalizeSessionRegistryRecord(record SessionRegistryRecord) SessionRegistryRecord {
	record.PK = strings.TrimSpace(record.PK)
	record.SK = strings.TrimSpace(record.SK)
	record.TenantID = strings.TrimSpace(record.TenantID)
	record.Namespace = strings.TrimSpace(record.Namespace)
	record.SessionID = strings.TrimSpace(record.SessionID)
	record.State = LifecycleState(strings.TrimSpace(string(record.State)))
	record.DesiredState = LifecycleState(strings.TrimSpace(string(record.DesiredState)))
	record.Endpoint = strings.TrimSpace(record.Endpoint)
	record.MicroVMID = strings.TrimSpace(record.MicroVMID)
	record.ProviderID = strings.TrimSpace(record.ProviderID)
	record.ProviderMicroVMID = strings.TrimSpace(record.ProviderMicroVMID)
	record.ProviderState = strings.TrimSpace(record.ProviderState)
	record.AWSLifecycleState = strings.TrimSpace(record.AWSLifecycleState)
	record.ImageRef = strings.TrimSpace(record.ImageRef)
	record.ImageVersion = strings.TrimSpace(record.ImageVersion)
	record.NetworkConnectorRef = strings.TrimSpace(record.NetworkConnectorRef)
	record.IngressNetworkConnectorRefs = normalizeStringSlice(record.IngressNetworkConnectorRefs)
	record.EgressNetworkConnectorRefs = normalizeStringSlice(record.EgressNetworkConnectorRefs)
	record.ControllerID = strings.TrimSpace(record.ControllerID)
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	record.LastObservedAt = record.LastObservedAt.UTC()
	record.ProviderStartedAt = record.ProviderStartedAt.UTC()
	record.ProviderTerminatedAt = record.ProviderTerminatedAt.UTC()
	record.ExpiresAt = record.ExpiresAt.UTC()
	record.LastAction = normalizeCommand(record.LastAction)
	record.LastCommandID = strings.TrimSpace(record.LastCommandID)
	record.AuthSubject = strings.TrimSpace(record.AuthSubject)
	record.ReasonMetadata = cloneStringMap(record.ReasonMetadata)
	record.StatusMetadata = cloneStringMap(record.StatusMetadata)
	record.TokenMetadata = cloneSessionTokenMetadata(record.TokenMetadata)
	record.Metadata = cloneStringMap(record.Metadata)
	return record
}

func sessionRecordFromRegistryNoValidate(record SessionRegistryRecord) SessionRecord {
	return SessionRecord{
		TenantID:                    record.TenantID,
		Namespace:                   record.Namespace,
		SessionID:                   record.SessionID,
		State:                       record.State,
		DesiredState:                record.DesiredState,
		Endpoint:                    record.Endpoint,
		MicroVMID:                   record.MicroVMID,
		ProviderID:                  record.ProviderID,
		ProviderMicroVMID:           record.ProviderMicroVMID,
		ProviderState:               record.ProviderState,
		AWSLifecycleState:           record.AWSLifecycleState,
		ImageRef:                    record.ImageRef,
		ImageVersion:                record.ImageVersion,
		NetworkConnectorRef:         record.NetworkConnectorRef,
		IngressNetworkConnectorRefs: append([]string(nil), record.IngressNetworkConnectorRefs...),
		EgressNetworkConnectorRefs:  append([]string(nil), record.EgressNetworkConnectorRefs...),
		ControllerID:                record.ControllerID,
		CreatedAt:                   record.CreatedAt,
		UpdatedAt:                   record.UpdatedAt,
		LastObservedAt:              record.LastObservedAt,
		ProviderStartedAt:           record.ProviderStartedAt,
		ProviderTerminatedAt:        record.ProviderTerminatedAt,
		ExpiresAt:                   record.ExpiresAt,
		Generation:                  record.Generation,
		LastAction:                  record.LastAction,
		LastCommandID:               record.LastCommandID,
		AuthSubject:                 record.AuthSubject,
		ReasonMetadata:              cloneStringMap(record.ReasonMetadata),
		StatusMetadata:              cloneStringMap(record.StatusMetadata),
		TokenMetadata:               cloneSessionTokenMetadata(record.TokenMetadata),
		Metadata:                    cloneStringMap(record.Metadata),
	}
}

func normalizeSessionKey(key SessionKey) SessionKey {
	return SessionKey{
		TenantID:  strings.TrimSpace(key.TenantID),
		Namespace: strings.TrimSpace(key.Namespace),
		SessionID: strings.TrimSpace(key.SessionID),
	}
}

func normalizeSessionListInput(input SessionListInput) SessionListInput {
	return SessionListInput{
		RequestID:   strings.TrimSpace(input.RequestID),
		TenantID:    strings.TrimSpace(input.TenantID),
		Namespace:   strings.TrimSpace(input.Namespace),
		AuthSubject: strings.TrimSpace(input.AuthSubject),
	}
}

func validateSessionKey(key SessionKey, requestID string) error {
	if key.TenantID == "" || key.Namespace == "" || key.SessionID == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session key is incomplete", requestID)
	}
	return nil
}

func normalizeSessionReconstructionRequest(request SessionReconstructionRequest) SessionReconstructionRequest {
	request.RequestID = strings.TrimSpace(request.RequestID)
	request.TenantID = strings.TrimSpace(request.TenantID)
	request.Namespace = strings.TrimSpace(request.Namespace)
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.AuthSubject = strings.TrimSpace(request.AuthSubject)
	request.Now = request.Now.UTC()
	if request.Existing != nil {
		existingRecord := normalizeSessionRecord(*request.Existing)
		request.Existing = &existingRecord
	}
	return request
}

func reconstructionNow(clock Clock) time.Time {
	if clock == nil {
		return time.Time{}
	}
	now := clock.Now()
	if now.IsZero() {
		return time.Time{}
	}
	return now.UTC()
}

func sessionRecordIsStale(record SessionRecord, now time.Time, staleAfter time.Duration) bool {
	if staleAfter <= 0 || now.IsZero() {
		return false
	}
	record = normalizeSessionRecord(record)
	if record.LastObservedAt.IsZero() {
		return true
	}
	return record.LastObservedAt.Add(staleAfter).Before(now) || !record.ExpiresAt.After(now)
}

func registryRecordKey(record SessionRegistryRecord) string {
	return record.PK + "\x00" + record.SK
}

func registryRecordKeyFromKey(key SessionKey) string {
	return SessionRegistryPartitionKey(key.TenantID, key.Namespace) + "\x00" + SessionRegistrySortKey(key.SessionID)
}

func cloneSessionRegistryRecord(record SessionRegistryRecord) SessionRegistryRecord {
	record.IngressNetworkConnectorRefs = append([]string(nil), record.IngressNetworkConnectorRefs...)
	record.EgressNetworkConnectorRefs = append([]string(nil), record.EgressNetworkConnectorRefs...)
	record.ReasonMetadata = cloneStringMap(record.ReasonMetadata)
	record.StatusMetadata = cloneStringMap(record.StatusMetadata)
	record.TokenMetadata = cloneSessionTokenMetadata(record.TokenMetadata)
	record.Metadata = cloneStringMap(record.Metadata)
	return record
}

func sessionRegistryOperationError(requestID string) SafeError {
	return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry operation failed", requestID)
}
