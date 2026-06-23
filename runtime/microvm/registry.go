package microvm

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
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
	PK                  string            `theorydb:"pk,attr:pk" json:"pk"`
	SK                  string            `theorydb:"sk,attr:sk" json:"sk"`
	TenantID            string            `theorydb:"attr:tenant_id" json:"tenant_id"`
	Namespace           string            `theorydb:"attr:namespace" json:"namespace"`
	SessionID           string            `theorydb:"attr:session_id" json:"session_id"`
	State               LifecycleState    `theorydb:"attr:state" json:"state"`
	DesiredState        LifecycleState    `theorydb:"attr:desired_state" json:"desired_state"`
	Endpoint            string            `theorydb:"attr:endpoint,omitempty" json:"endpoint,omitempty"`
	MicroVMID           string            `theorydb:"attr:microvm_id,omitempty" json:"microvm_id,omitempty"`
	ImageRef            string            `theorydb:"attr:image_ref" json:"image_ref"`
	NetworkConnectorRef string            `theorydb:"attr:network_connector_ref" json:"network_connector_ref"`
	ControllerID        string            `theorydb:"attr:controller_id" json:"controller_id"`
	CreatedAt           time.Time         `theorydb:"attr:created_at" json:"created_at"`
	UpdatedAt           time.Time         `theorydb:"attr:updated_at" json:"updated_at"`
	ExpiresAt           time.Time         `theorydb:"attr:expires_at" json:"expires_at"`
	TTL                 int64             `theorydb:"ttl,attr:ttl" json:"ttl"`
	Generation          int64             `theorydb:"attr:generation" json:"generation"`
	Version             int64             `theorydb:"version,attr:version" json:"version"`
	LastAction          Command           `theorydb:"attr:last_action" json:"last_action"`
	LastCommandID       string            `theorydb:"attr:last_command_id" json:"last_command_id"`
	AuthSubject         string            `theorydb:"attr:auth_subject" json:"auth_subject"`
	Metadata            map[string]string `theorydb:"attr:metadata,omitempty" json:"metadata,omitempty"`
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
	return validateSafeMetadata(record.Metadata, record.LastCommandID)
}

// SessionRecordToRegistryRecord converts a safe session record into the canonical durable registry item.
func SessionRecordToRegistryRecord(record SessionRecord) (SessionRegistryRecord, error) {
	record = normalizeSessionRecord(record)
	if err := ValidateSessionRecord(record); err != nil {
		return SessionRegistryRecord{}, err
	}
	registry := SessionRegistryRecord{
		PK:                  SessionRegistryPartitionKey(record.TenantID, record.Namespace),
		SK:                  SessionRegistrySortKey(record.SessionID),
		TenantID:            record.TenantID,
		Namespace:           record.Namespace,
		SessionID:           record.SessionID,
		State:               record.State,
		DesiredState:        record.DesiredState,
		Endpoint:            record.Endpoint,
		MicroVMID:           record.MicroVMID,
		ImageRef:            record.ImageRef,
		NetworkConnectorRef: record.NetworkConnectorRef,
		ControllerID:        record.ControllerID,
		CreatedAt:           record.CreatedAt.UTC(),
		UpdatedAt:           record.UpdatedAt.UTC(),
		ExpiresAt:           record.ExpiresAt.UTC(),
		TTL:                 record.ExpiresAt.UTC().Unix(),
		Generation:          record.Generation,
		Version:             record.Generation,
		LastAction:          record.LastAction,
		LastCommandID:       record.LastCommandID,
		AuthSubject:         record.AuthSubject,
		Metadata:            cloneStringMap(record.Metadata),
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
	record.ImageRef = strings.TrimSpace(record.ImageRef)
	record.NetworkConnectorRef = strings.TrimSpace(record.NetworkConnectorRef)
	record.ControllerID = strings.TrimSpace(record.ControllerID)
	record.CreatedAt = record.CreatedAt.UTC()
	record.UpdatedAt = record.UpdatedAt.UTC()
	record.ExpiresAt = record.ExpiresAt.UTC()
	record.LastAction = normalizeCommand(record.LastAction)
	record.LastCommandID = strings.TrimSpace(record.LastCommandID)
	record.AuthSubject = strings.TrimSpace(record.AuthSubject)
	record.Metadata = cloneStringMap(record.Metadata)
	return record
}

func sessionRecordFromRegistryNoValidate(record SessionRegistryRecord) SessionRecord {
	return SessionRecord{
		TenantID:            record.TenantID,
		Namespace:           record.Namespace,
		SessionID:           record.SessionID,
		State:               record.State,
		DesiredState:        record.DesiredState,
		Endpoint:            record.Endpoint,
		MicroVMID:           record.MicroVMID,
		ImageRef:            record.ImageRef,
		NetworkConnectorRef: record.NetworkConnectorRef,
		ControllerID:        record.ControllerID,
		CreatedAt:           record.CreatedAt,
		UpdatedAt:           record.UpdatedAt,
		ExpiresAt:           record.ExpiresAt,
		Generation:          record.Generation,
		LastAction:          record.LastAction,
		LastCommandID:       record.LastCommandID,
		AuthSubject:         record.AuthSubject,
		Metadata:            cloneStringMap(record.Metadata),
	}
}

func normalizeSessionKey(key SessionKey) SessionKey {
	return SessionKey{
		TenantID:  strings.TrimSpace(key.TenantID),
		Namespace: strings.TrimSpace(key.Namespace),
		SessionID: strings.TrimSpace(key.SessionID),
	}
}

func validateSessionKey(key SessionKey, requestID string) error {
	if key.TenantID == "" || key.Namespace == "" || key.SessionID == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session key is incomplete", requestID)
	}
	return nil
}

func registryRecordKey(record SessionRegistryRecord) string {
	return record.PK + "\x00" + record.SK
}

func registryRecordKeyFromKey(key SessionKey) string {
	return SessionRegistryPartitionKey(key.TenantID, key.Namespace) + "\x00" + SessionRegistrySortKey(key.SessionID)
}

func cloneSessionRegistryRecord(record SessionRegistryRecord) SessionRegistryRecord {
	record.Metadata = cloneStringMap(record.Metadata)
	return record
}

func sessionRegistryOperationError(requestID string) SafeError {
	return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry operation failed", requestID)
}
