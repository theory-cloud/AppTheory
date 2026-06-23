package microvm

import (
	"strings"
	"time"
)

// SessionKey identifies a MicroVM session by tenant, namespace, and session_id.
type SessionKey struct {
	TenantID  string `json:"tenant_id"`
	Namespace string `json:"namespace"`
	SessionID string `json:"session_id"`
}

// CreateSessionInput is the safe client input for creating a session.
type CreateSessionInput struct {
	RequestID           string      `json:"request_id"`
	TenantID            string      `json:"tenant_id"`
	Namespace           string      `json:"namespace"`
	SessionID           string      `json:"session_id"`
	ImageRef            string      `json:"image_ref"`
	NetworkConnectorRef string      `json:"network_connector_ref"`
	SessionSpec         SessionSpec `json:"session_spec"`
	ControllerID        string      `json:"controller_id"`
	AuthSubject         string      `json:"auth_subject"`
	Now                 time.Time   `json:"now"`
}

// SessionCommandInput is the safe client input for start/stop commands.
type SessionCommandInput struct {
	RequestID    string         `json:"request_id"`
	TenantID     string         `json:"tenant_id"`
	Namespace    string         `json:"namespace"`
	SessionID    string         `json:"session_id"`
	ControllerID string         `json:"controller_id"`
	AuthSubject  string         `json:"auth_subject"`
	DesiredState LifecycleState `json:"desired_state"`
	Now          time.Time      `json:"now"`
}

// SessionQueryInput is the safe client input for status/session queries.
type SessionQueryInput struct {
	RequestID   string `json:"request_id"`
	TenantID    string `json:"tenant_id"`
	Namespace   string `json:"namespace"`
	SessionID   string `json:"session_id"`
	AuthSubject string `json:"auth_subject"`
}

// SessionRecord is the safe durable-session shape AppTheory exposes to clients and registries.
type SessionRecord struct {
	TenantID            string            `json:"tenant_id"`
	Namespace           string            `json:"namespace"`
	SessionID           string            `json:"session_id"`
	State               LifecycleState    `json:"state"`
	DesiredState        LifecycleState    `json:"desired_state"`
	ImageRef            string            `json:"image_ref"`
	NetworkConnectorRef string            `json:"network_connector_ref,omitempty"`
	ControllerID        string            `json:"controller_id"`
	CreatedAt           time.Time         `json:"created_at"`
	UpdatedAt           time.Time         `json:"updated_at"`
	ExpiresAt           time.Time         `json:"expires_at"`
	Generation          int64             `json:"generation"`
	LastCommandID       string            `json:"last_command_id"`
	AuthSubject         string            `json:"auth_subject"`
	Metadata            map[string]string `json:"metadata,omitempty"`
}

// SessionStatus is the safe controller status response from a constrained client.
type SessionStatus struct {
	TenantID        string         `json:"tenant_id"`
	Namespace       string         `json:"namespace"`
	SessionID       string         `json:"session_id"`
	State           LifecycleState `json:"state"`
	DesiredState    LifecycleState `json:"desired_state"`
	LifecycleState  LifecycleState `json:"lifecycle_state"`
	LastTransition  time.Time      `json:"last_transition"`
	RegistryVersion int64          `json:"registry_version"`
}

// ValidateSessionRecord fails closed when a session record is incomplete or contains forbidden metadata.
func ValidateSessionRecord(record SessionRecord) error {
	record = normalizeSessionRecord(record)
	if err := validateSessionRecordIdentity(record); err != nil {
		return err
	}
	if err := validateSessionRecordRegistryFields(record); err != nil {
		return err
	}
	if !validLifecycleState(record.State) || !validLifecycleState(record.DesiredState) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record state is unsupported", record.LastCommandID)
	}
	return validateSafeMetadata(record.Metadata, record.LastCommandID)
}

func validateSessionRecordIdentity(record SessionRecord) error {
	if record.TenantID == "" || record.Namespace == "" || record.SessionID == "" || record.State == "" || record.DesiredState == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record is incomplete", record.LastCommandID)
	}
	if record.ImageRef == "" || record.ControllerID == "" || record.LastCommandID == "" || record.AuthSubject == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record is incomplete", record.LastCommandID)
	}
	return nil
}

func validateSessionRecordRegistryFields(record SessionRecord) error {
	if record.CreatedAt.IsZero() || record.UpdatedAt.IsZero() || record.ExpiresAt.IsZero() || record.Generation <= 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record registry fields are incomplete", record.LastCommandID)
	}
	return nil
}

// ValidateSessionStatus fails closed when a status response is incomplete.
func ValidateSessionStatus(status SessionStatus) error {
	status = normalizeSessionStatus(status)
	if status.TenantID == "" || status.Namespace == "" || status.SessionID == "" || status.State == "" || status.DesiredState == "" || status.LifecycleState == "" || status.LastTransition.IsZero() || status.RegistryVersion <= 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session status is incomplete", "")
	}
	if !validLifecycleState(status.State) || !validLifecycleState(status.DesiredState) || !validLifecycleState(status.LifecycleState) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session status state is unsupported", "")
	}
	return nil
}

// Key returns the tenant/namespace/session key for a session record.
func (r SessionRecord) Key() SessionKey {
	return SessionKey{TenantID: strings.TrimSpace(r.TenantID), Namespace: strings.TrimSpace(r.Namespace), SessionID: strings.TrimSpace(r.SessionID)}
}

// Key returns the tenant/namespace/session key for a status record.
func (s SessionStatus) Key() SessionKey {
	return SessionKey{TenantID: strings.TrimSpace(s.TenantID), Namespace: strings.TrimSpace(s.Namespace), SessionID: strings.TrimSpace(s.SessionID)}
}

func normalizeSessionRecord(record SessionRecord) SessionRecord {
	record.TenantID = strings.TrimSpace(record.TenantID)
	record.Namespace = strings.TrimSpace(record.Namespace)
	record.SessionID = strings.TrimSpace(record.SessionID)
	record.State = LifecycleState(strings.TrimSpace(string(record.State)))
	record.DesiredState = LifecycleState(strings.TrimSpace(string(record.DesiredState)))
	record.ImageRef = strings.TrimSpace(record.ImageRef)
	record.NetworkConnectorRef = strings.TrimSpace(record.NetworkConnectorRef)
	record.ControllerID = strings.TrimSpace(record.ControllerID)
	record.LastCommandID = strings.TrimSpace(record.LastCommandID)
	record.AuthSubject = strings.TrimSpace(record.AuthSubject)
	record.Metadata = cloneStringMap(record.Metadata)
	return record
}

func normalizeSessionStatus(status SessionStatus) SessionStatus {
	status.TenantID = strings.TrimSpace(status.TenantID)
	status.Namespace = strings.TrimSpace(status.Namespace)
	status.SessionID = strings.TrimSpace(status.SessionID)
	status.State = LifecycleState(strings.TrimSpace(string(status.State)))
	status.DesiredState = LifecycleState(strings.TrimSpace(string(status.DesiredState)))
	status.LifecycleState = LifecycleState(strings.TrimSpace(string(status.LifecycleState)))
	return status
}

func validLifecycleState(state LifecycleState) bool {
	state = LifecycleState(strings.TrimSpace(string(state)))
	for _, valid := range requiredLifecycleStates() {
		if state == valid {
			return true
		}
	}
	return false
}
