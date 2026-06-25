package microvm

import (
	"strings"
	"time"
)

const (
	// DefaultSessionProviderID is the provider id used by deterministic AppTheory registry clients.
	DefaultSessionProviderID = "apptheory.microvm.registry"
	// AWSLambdaMicroVMProviderID is the provider id for the official AWS Lambda MicroVM provider.
	AWSLambdaMicroVMProviderID = "aws.lambda.microvm"
)

// SessionKey identifies a MicroVM session by tenant, namespace, and session_id.
type SessionKey struct {
	TenantID  string `json:"tenant_id"`
	Namespace string `json:"namespace"`
	SessionID string `json:"session_id"`
}

// SessionTokenMetadata is the only token information a MicroVM registry record may persist.
//
// It deliberately contains no plaintext token, bearer token, X-aws-proxy-auth header value,
// provider credential, raw SDK object, or provider pagination token.
type SessionTokenMetadata struct {
	TokenID   string    `json:"token_id"`
	TokenType string    `json:"token_type"`
	ExpiresAt time.Time `json:"expires_at"`
	Scope     []string  `json:"scope"`
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
	TenantID                    string                 `json:"tenant_id"`
	Namespace                   string                 `json:"namespace"`
	SessionID                   string                 `json:"session_id"`
	State                       LifecycleState         `json:"state"`
	DesiredState                LifecycleState         `json:"desired_state"`
	Endpoint                    string                 `json:"endpoint,omitempty"`
	MicroVMID                   string                 `json:"microvm_id,omitempty"`
	ProviderID                  string                 `json:"provider_id"`
	ProviderMicroVMID           string                 `json:"provider_microvm_id,omitempty"`
	ProviderState               string                 `json:"provider_state"`
	AWSLifecycleState           string                 `json:"aws_lifecycle_state"`
	ImageRef                    string                 `json:"image_ref"`
	ImageVersion                string                 `json:"image_version,omitempty"`
	NetworkConnectorRef         string                 `json:"network_connector_ref"`
	IngressNetworkConnectorRefs []string               `json:"ingress_network_connector_refs,omitempty"`
	EgressNetworkConnectorRefs  []string               `json:"egress_network_connector_refs,omitempty"`
	ControllerID                string                 `json:"controller_id"`
	CreatedAt                   time.Time              `json:"created_at"`
	UpdatedAt                   time.Time              `json:"updated_at"`
	LastObservedAt              time.Time              `json:"last_observed_at"`
	ProviderStartedAt           time.Time              `json:"provider_started_at,omitempty"`
	ProviderTerminatedAt        time.Time              `json:"provider_terminated_at,omitempty"`
	ExpiresAt                   time.Time              `json:"expires_at"`
	Generation                  int64                  `json:"generation"`
	LastAction                  Command                `json:"last_action"`
	LastCommandID               string                 `json:"last_command_id"`
	AuthSubject                 string                 `json:"auth_subject"`
	ReasonMetadata              map[string]string      `json:"reason_metadata,omitempty"`
	StatusMetadata              map[string]string      `json:"status_metadata,omitempty"`
	TokenMetadata               []SessionTokenMetadata `json:"token_metadata,omitempty"`
	Metadata                    map[string]string      `json:"metadata,omitempty"`
}

// SessionStatus is the safe controller status response from a constrained client.
type SessionStatus struct {
	TenantID        string         `json:"tenant_id"`
	Namespace       string         `json:"namespace"`
	SessionID       string         `json:"session_id"`
	State           LifecycleState `json:"state"`
	DesiredState    LifecycleState `json:"desired_state"`
	LifecycleState  LifecycleState `json:"lifecycle_state"`
	Endpoint        string         `json:"endpoint,omitempty"`
	MicroVMID       string         `json:"microvm_id,omitempty"`
	LastAction      Command        `json:"last_action"`
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
	if err := validateSessionRecordProviderFields(record); err != nil {
		return err
	}
	if !validLifecycleState(record.State) || !validLifecycleState(record.DesiredState) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record state is unsupported", record.LastCommandID)
	}
	if err := validateSafeMetadata(record.Metadata, record.LastCommandID); err != nil {
		return err
	}
	if err := validateSafeMetadata(record.ReasonMetadata, record.LastCommandID); err != nil {
		return err
	}
	return validateSafeMetadata(record.StatusMetadata, record.LastCommandID)
}

func validateSessionRecordIdentity(record SessionRecord) error {
	if record.TenantID == "" || record.Namespace == "" || record.SessionID == "" || record.State == "" || record.DesiredState == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record is incomplete", record.LastCommandID)
	}
	if record.ImageRef == "" || record.NetworkConnectorRef == "" || record.ControllerID == "" || record.LastCommandID == "" || record.AuthSubject == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record is incomplete", record.LastCommandID)
	}
	if !validCommand(record.LastAction) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record last action is unsupported", record.LastCommandID)
	}
	return nil
}

func validateSessionRecordRegistryFields(record SessionRecord) error {
	if record.CreatedAt.IsZero() || record.UpdatedAt.IsZero() || record.ExpiresAt.IsZero() || record.LastObservedAt.IsZero() || record.Generation <= 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record registry fields are incomplete", record.LastCommandID)
	}
	return nil
}

func validateSessionRecordProviderFields(record SessionRecord) error {
	if record.ProviderID == "" || record.ProviderState == "" || record.AWSLifecycleState == "" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session record provider fields are incomplete", record.LastCommandID)
	}
	for _, field := range append([]string{
		record.Endpoint,
		record.MicroVMID,
		record.ProviderID,
		record.ProviderMicroVMID,
		record.ProviderState,
		record.AWSLifecycleState,
		record.ImageRef,
		record.ImageVersion,
		record.NetworkConnectorRef,
	}, append(append([]string{}, record.IngressNetworkConnectorRefs...), record.EgressNetworkConnectorRefs...)...) {
		if err := validateSafeFieldValue(field, record.LastCommandID); err != nil {
			return err
		}
	}
	for _, token := range record.TokenMetadata {
		if err := ValidateSessionTokenMetadata(token, record.LastCommandID); err != nil {
			return err
		}
	}
	return nil
}

// ValidateSessionTokenMetadata fails closed if token metadata is incomplete or carries token plaintext.
func ValidateSessionTokenMetadata(token SessionTokenMetadata, requestID string) error {
	token = normalizeSessionTokenMetadata(token)
	if token.TokenID == "" || token.TokenType == "" || token.ExpiresAt.IsZero() || len(token.Scope) == 0 {
		return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm session token metadata is incomplete", requestID)
	}
	if err := validateSafeFieldValue(token.TokenID, requestID); err != nil {
		return err
	}
	if err := validateSafeFieldValue(token.TokenType, requestID); err != nil {
		return err
	}
	for _, scope := range token.Scope {
		if err := validateSafeFieldValue(scope, requestID); err != nil {
			return err
		}
	}
	return nil
}

// SessionTokenMetadataFromProviderToken converts sanitized provider token output into registry-safe metadata.
func SessionTokenMetadataFromProviderToken(token ProviderToken) (SessionTokenMetadata, error) {
	token = normalizeProviderToken(token)
	if err := ValidateProviderToken(token); err != nil {
		return SessionTokenMetadata{}, err
	}
	metadata := SessionTokenMetadata{
		TokenID:   token.TokenID,
		TokenType: token.TokenType,
		ExpiresAt: token.ExpiresAt,
		Scope:     append([]string(nil), token.Scope...),
	}
	if err := ValidateSessionTokenMetadata(metadata, ""); err != nil {
		return SessionTokenMetadata{}, err
	}
	return metadata, nil
}

// ValidateSessionStatus fails closed when a status response is incomplete.
func ValidateSessionStatus(status SessionStatus) error {
	status = normalizeSessionStatus(status)
	if status.TenantID == "" || status.Namespace == "" || status.SessionID == "" || status.State == "" || status.DesiredState == "" || status.LifecycleState == "" || status.LastAction == "" || status.LastTransition.IsZero() || status.RegistryVersion <= 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session status is incomplete", "")
	}
	if !validLifecycleState(status.State) || !validLifecycleState(status.DesiredState) || !validLifecycleState(status.LifecycleState) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session status state is unsupported", "")
	}
	if !validCommand(status.LastAction) {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session status last action is unsupported", "")
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

func normalizeSessionStatus(status SessionStatus) SessionStatus {
	status.TenantID = strings.TrimSpace(status.TenantID)
	status.Namespace = strings.TrimSpace(status.Namespace)
	status.SessionID = strings.TrimSpace(status.SessionID)
	status.State = LifecycleState(strings.TrimSpace(string(status.State)))
	status.DesiredState = LifecycleState(strings.TrimSpace(string(status.DesiredState)))
	status.LifecycleState = LifecycleState(strings.TrimSpace(string(status.LifecycleState)))
	status.Endpoint = strings.TrimSpace(status.Endpoint)
	status.MicroVMID = strings.TrimSpace(status.MicroVMID)
	status.LastAction = normalizeCommand(status.LastAction)
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

func validCommand(command Command) bool {
	command = normalizeCommand(command)
	switch command {
	case CommandCreate, CommandStart, CommandStop, CommandStatus, CommandSession:
		return true
	default:
		return false
	}
}

func normalizeSessionTokenMetadata(token SessionTokenMetadata) SessionTokenMetadata {
	token.TokenID = strings.TrimSpace(token.TokenID)
	token.TokenType = strings.TrimSpace(token.TokenType)
	token.ExpiresAt = token.ExpiresAt.UTC()
	token.Scope = normalizeStringSlice(token.Scope)
	return token
}

func cloneSessionTokenMetadata(tokens []SessionTokenMetadata) []SessionTokenMetadata {
	if len(tokens) == 0 {
		return nil
	}
	out := make([]SessionTokenMetadata, 0, len(tokens))
	for _, token := range tokens {
		normalized := normalizeSessionTokenMetadata(token)
		if normalized.TokenID != "" || normalized.TokenType != "" || !normalized.ExpiresAt.IsZero() || len(normalized.Scope) > 0 {
			out = append(out, normalized)
		}
	}
	return out
}
