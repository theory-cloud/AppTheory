package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	// ErrorCodeProviderRequestInvalid reports a malformed constrained provider request.
	ErrorCodeProviderRequestInvalid = "m16.microvm.provider_request_invalid"
	// ErrorCodeProviderOperationUnsupported reports an operation outside the M16 real provider vocabulary.
	ErrorCodeProviderOperationUnsupported = "m16.microvm.provider_operation_unsupported"
	// ErrorCodeProviderOperationFailed reports a sanitized provider call failure.
	ErrorCodeProviderOperationFailed = "m16.microvm.provider_operation_failed"
)

const (
	defaultProviderTokenTTLSeconds = int32(900)
	minProviderTokenTTLSeconds     = int32(1)
	maxProviderTokenTTLSeconds     = int32(900)
)

// Provider is the constrained M16 real MicroVM provider surface.
//
// It deliberately exposes only AppTheory request and response structs. Raw AWS SDK clients,
// credentials, provider payloads, bearer tokens, and plaintext session tokens are not part of
// this interface.
type Provider interface {
	Run(context.Context, ProviderRunInput) (ProviderSession, error)
	Get(context.Context, ProviderSessionInput) (ProviderSession, error)
	List(context.Context, ProviderListInput) (ProviderListOutput, error)
	Suspend(context.Context, ProviderSessionInput) (ProviderSession, error)
	Resume(context.Context, ProviderSessionInput) (ProviderSession, error)
	Terminate(context.Context, ProviderSessionInput) (ProviderSession, error)
	CreateAuthToken(context.Context, ProviderTokenInput) (ProviderToken, error)
	CreateShellToken(context.Context, ProviderTokenInput) (ProviderToken, error)
}

// ProviderIdlePolicy is the safe AppTheory representation of provider idle behavior.
type ProviderIdlePolicy struct {
	AutoResumeEnabled        bool  `json:"auto_resume_enabled"`
	MaxIdleDurationSeconds   int32 `json:"max_idle_duration_seconds"`
	SuspendedDurationSeconds int32 `json:"suspended_duration_seconds"`
}

// ProviderRunInput is the safe AppTheory request for the real run operation.
type ProviderRunInput struct {
	RequestID                   string              `json:"request_id"`
	TenantID                    string              `json:"tenant_id"`
	Namespace                   string              `json:"namespace"`
	SessionID                   string              `json:"session_id"`
	AuthContext                 AuthContext         `json:"auth_context"`
	ImageRef                    string              `json:"image_ref"`
	ImageVersion                string              `json:"image_version,omitempty"`
	NetworkConnectorRef         string              `json:"network_connector_ref,omitempty"`
	IngressNetworkConnectorRefs []string            `json:"ingress_network_connector_refs,omitempty"`
	EgressNetworkConnectorRefs  []string            `json:"egress_network_connector_refs,omitempty"`
	SessionSpec                 SessionSpec         `json:"session_spec,omitempty"`
	IdlePolicy                  *ProviderIdlePolicy `json:"idle_policy,omitempty"`
	MaximumDurationSeconds      int32               `json:"maximum_duration_seconds,omitempty"`
}

// ProviderSessionBinding binds an AppTheory session to a provider MicroVM identifier.
type ProviderSessionBinding struct {
	TenantID          string `json:"tenant_id"`
	Namespace         string `json:"namespace"`
	SessionID         string `json:"session_id"`
	ProviderMicroVMID string `json:"provider_microvm_id"`
	RegistryVersion   int64  `json:"registry_version,omitempty"`
}

// ProviderSessionInput is the safe AppTheory request for a bound session operation.
type ProviderSessionInput struct {
	RequestID   string                 `json:"request_id"`
	TenantID    string                 `json:"tenant_id"`
	Namespace   string                 `json:"namespace"`
	AuthContext AuthContext            `json:"auth_context"`
	Binding     ProviderSessionBinding `json:"binding"`
}

// ProviderListInput is the safe AppTheory request for tenant-bound provider list/recovery.
//
// KnownSessions is the safe registry-derived allowlist used by provider adapters to avoid
// leaking account-wide provider list results across tenants.
type ProviderListInput struct {
	RequestID     string                   `json:"request_id"`
	TenantID      string                   `json:"tenant_id"`
	Namespace     string                   `json:"namespace"`
	AuthContext   AuthContext              `json:"auth_context"`
	ImageRef      string                   `json:"image_ref,omitempty"`
	ImageVersion  string                   `json:"image_version,omitempty"`
	MaxResults    int32                    `json:"max_results,omitempty"`
	KnownSessions []ProviderSessionBinding `json:"known_sessions,omitempty"`
}

// ProviderPortScope describes the allowed port scope for sanitized auth-token issuance.
type ProviderPortScope struct {
	AllPorts  bool  `json:"all_ports,omitempty"`
	Port      int32 `json:"port,omitempty"`
	StartPort int32 `json:"start_port,omitempty"`
	EndPort   int32 `json:"end_port,omitempty"`
}

// ProviderTokenInput is the safe AppTheory request for auth-token and shell-token operations.
type ProviderTokenInput struct {
	RequestID        string                 `json:"request_id"`
	TenantID         string                 `json:"tenant_id"`
	Namespace        string                 `json:"namespace"`
	AuthContext      AuthContext            `json:"auth_context"`
	Binding          ProviderSessionBinding `json:"binding"`
	TTLSeconds       int32                  `json:"ttl_seconds,omitempty"`
	AllowedPortScope []ProviderPortScope    `json:"allowed_port_scope,omitempty"`
}

// ProviderSession is the sanitized provider session shape emitted by AppTheory.
type ProviderSession struct {
	TenantID          string         `json:"tenant_id"`
	Namespace         string         `json:"namespace"`
	SessionID         string         `json:"session_id"`
	ProviderMicroVMID string         `json:"provider_microvm_id"`
	State             LifecycleState `json:"state"`
	ProviderState     string         `json:"provider_state"`
	ImageRef          string         `json:"image_ref,omitempty"`
	ImageVersion      string         `json:"image_version,omitempty"`
	StartedAt         time.Time      `json:"started_at,omitempty"`
	TerminatedAt      time.Time      `json:"terminated_at,omitempty"`
	RegistryVersion   int64          `json:"registry_version,omitempty"`
	Terminal          bool           `json:"terminal,omitempty"`
}

// ProviderListOutput is the sanitized tenant-bound list/recovery result.
type ProviderListOutput struct {
	Sessions       []ProviderSession `json:"sessions"`
	RecoveryCursor string            `json:"recovery_cursor,omitempty"`
}

// ProviderToken is the sanitized token issuance metadata AppTheory may expose.
//
// It never contains provider auth header values, bearer tokens, or session token plaintext.
type ProviderToken struct {
	TenantID          string    `json:"tenant_id"`
	Namespace         string    `json:"namespace"`
	SessionID         string    `json:"session_id"`
	ProviderMicroVMID string    `json:"provider_microvm_id"`
	TokenID           string    `json:"token_id"`
	TokenType         string    `json:"token_type"`
	ExpiresAt         time.Time `json:"expires_at"`
	Scope             []string  `json:"scope"`
}

// Key returns the tenant/namespace/session key for a provider session binding.
func (b ProviderSessionBinding) Key() SessionKey {
	return SessionKey{TenantID: strings.TrimSpace(b.TenantID), Namespace: strings.TrimSpace(b.Namespace), SessionID: strings.TrimSpace(b.SessionID)}
}

// Key returns the tenant/namespace/session key for a provider session.
func (s ProviderSession) Key() SessionKey {
	return SessionKey{TenantID: strings.TrimSpace(s.TenantID), Namespace: strings.TrimSpace(s.Namespace), SessionID: strings.TrimSpace(s.SessionID)}
}

// Binding returns the safe provider binding for a provider session.
func (s ProviderSession) Binding() ProviderSessionBinding {
	return ProviderSessionBinding{
		TenantID:          strings.TrimSpace(s.TenantID),
		Namespace:         strings.TrimSpace(s.Namespace),
		SessionID:         strings.TrimSpace(s.SessionID),
		ProviderMicroVMID: strings.TrimSpace(s.ProviderMicroVMID),
		RegistryVersion:   s.RegistryVersion,
	}
}

// MapProviderState maps a provider state string into the AppTheory M16 lifecycle contract.
func MapProviderState(providerState string) (LifecycleState, bool, error) {
	normalized := normalizeProviderState(providerState)
	if normalized == "" {
		return "", false, safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider state is required", "")
	}
	for _, mapping := range DefaultProviderStateMappings() {
		if normalized == normalizeProviderState(mapping.ProviderState) {
			return mapping.State, mapping.Terminal, nil
		}
	}
	return "", false, safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider state is unsupported", "")
}

// ValidateProviderSession validates a sanitized provider session response.
func ValidateProviderSession(session ProviderSession) error {
	session = normalizeProviderSession(session)
	if session.TenantID == "" || session.Namespace == "" || session.SessionID == "" || session.ProviderMicroVMID == "" {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider session is incomplete", "")
	}
	state, terminal, err := MapProviderState(session.ProviderState)
	if err != nil {
		return err
	}
	if session.State != state || session.Terminal != terminal {
		return safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider session state mapping mismatch", "")
	}
	if forbiddenFieldName(session.ProviderMicroVMID) || forbiddenFieldName(session.ImageRef) || forbiddenFieldName(session.ImageVersion) {
		return safeError(ErrorCodeForbiddenField, "apptheory: microvm provider session exposes forbidden field", "")
	}
	return nil
}

// ValidateProviderRunInput validates a safe AppTheory run request.
func ValidateProviderRunInput(input ProviderRunInput) error {
	_, err := validateProviderRunInput(input)
	return err
}

// ValidateProviderSessionInput validates a safe AppTheory bound-session provider request.
func ValidateProviderSessionInput(operation Operation, input ProviderSessionInput) error {
	_, err := validateProviderSessionInput(operation, input)
	return err
}

// ValidateProviderListInput validates a safe AppTheory list/recovery provider request.
func ValidateProviderListInput(input ProviderListInput) error {
	_, err := validateProviderListInput(input)
	return err
}

// ValidateProviderTokenInput validates a safe AppTheory token provider request.
func ValidateProviderTokenInput(operation Operation, input ProviderTokenInput) error {
	_, err := validateProviderTokenInput(operation, input)
	return err
}

// ValidateProviderToken validates sanitized token issuance metadata.
func ValidateProviderToken(token ProviderToken) error {
	token = normalizeProviderToken(token)
	if token.TenantID == "" || token.Namespace == "" || token.SessionID == "" || token.ProviderMicroVMID == "" ||
		token.TokenID == "" || token.TokenType == "" || token.ExpiresAt.IsZero() || len(token.Scope) == 0 {
		return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider token metadata is incomplete", "")
	}
	fields := make([]string, 0, 3+len(token.Scope))
	fields = append(fields, token.TokenID, token.TokenType, token.ProviderMicroVMID)
	fields = append(fields, token.Scope...)
	for _, field := range fields {
		if forbiddenFieldName(field) {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider token metadata exposes forbidden field", "")
		}
	}
	return nil
}

func validateProviderOperation(operation Operation, requestID string) error {
	if !requiredOperation(operation) {
		return safeError(ErrorCodeProviderOperationUnsupported, "apptheory: microvm provider operation is unsupported", requestID)
	}
	return nil
}

func validateProviderRunInput(input ProviderRunInput) (ProviderRunInput, error) {
	input = normalizeProviderRunInput(input)
	if err := validateProviderOperation(OperationRun, input.RequestID); err != nil {
		return ProviderRunInput{}, err
	}
	if err := validateProviderAccess(input.RequestID, input.TenantID, input.Namespace, input.AuthContext); err != nil {
		return ProviderRunInput{}, err
	}
	if err := validateProviderRunIdentity(input); err != nil {
		return ProviderRunInput{}, err
	}
	if err := validateProviderRunSafeFields(input); err != nil {
		return ProviderRunInput{}, err
	}
	if err := validateProviderIdlePolicy(input.RequestID, input.IdlePolicy); err != nil {
		return ProviderRunInput{}, err
	}
	if input.MaximumDurationSeconds < 0 {
		return ProviderRunInput{}, safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider maximum duration is invalid", input.RequestID)
	}
	return input, nil
}

func validateProviderRunIdentity(input ProviderRunInput) error {
	if input.RequestID == "" {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider request_id is required", "")
	}
	if input.SessionID == "" || input.ImageRef == "" {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider run requires session_id and image_ref", input.RequestID)
	}
	return nil
}

func validateProviderRunSafeFields(input ProviderRunInput) error {
	if forbiddenFieldName(input.ImageRef) || forbiddenFieldName(input.ImageVersion) {
		return safeError(ErrorCodeForbiddenField, "apptheory: microvm provider run exposes forbidden field", input.RequestID)
	}
	if err := validateSafeMetadata(input.SessionSpec.Metadata, input.RequestID); err != nil {
		return err
	}
	if err := validateSafeConnectorRefs(input.RequestID, append(append([]string{}, input.IngressNetworkConnectorRefs...), input.EgressNetworkConnectorRefs...)); err != nil {
		return err
	}
	if input.NetworkConnectorRef != "" {
		if err := validateSafeConnectorRefs(input.RequestID, []string{input.NetworkConnectorRef}); err != nil {
			return err
		}
	}
	return nil
}

func validateProviderIdlePolicy(requestID string, policy *ProviderIdlePolicy) error {
	if policy == nil {
		return nil
	}
	if policy.MaxIdleDurationSeconds <= 0 || policy.SuspendedDurationSeconds <= 0 {
		return safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider idle policy is incomplete", requestID)
	}
	return nil
}

func validateProviderSessionInput(operation Operation, input ProviderSessionInput) (ProviderSessionInput, error) {
	input = normalizeProviderSessionInput(input)
	if err := validateProviderOperation(operation, input.RequestID); err != nil {
		return ProviderSessionInput{}, err
	}
	if input.RequestID == "" {
		return ProviderSessionInput{}, safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider request_id is required", "")
	}
	if err := validateProviderAccess(input.RequestID, input.TenantID, input.Namespace, input.AuthContext); err != nil {
		return ProviderSessionInput{}, err
	}
	binding, err := validateProviderBinding(input.RequestID, input.TenantID, input.Namespace, input.Binding)
	if err != nil {
		return ProviderSessionInput{}, err
	}
	input.Binding = binding
	return input, nil
}

func validateProviderListInput(input ProviderListInput) (ProviderListInput, error) {
	input = normalizeProviderListInput(input)
	if err := validateProviderOperation(OperationList, input.RequestID); err != nil {
		return ProviderListInput{}, err
	}
	if input.RequestID == "" {
		return ProviderListInput{}, safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider request_id is required", "")
	}
	if err := validateProviderAccess(input.RequestID, input.TenantID, input.Namespace, input.AuthContext); err != nil {
		return ProviderListInput{}, err
	}
	if forbiddenFieldName(input.ImageRef) || forbiddenFieldName(input.ImageVersion) {
		return ProviderListInput{}, safeError(ErrorCodeForbiddenField, "apptheory: microvm provider list exposes forbidden field", input.RequestID)
	}
	for i, binding := range input.KnownSessions {
		normalized, err := validateProviderBinding(input.RequestID, input.TenantID, input.Namespace, binding)
		if err != nil {
			return ProviderListInput{}, err
		}
		input.KnownSessions[i] = normalized
	}
	if input.MaxResults < 0 {
		return ProviderListInput{}, safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider list max_results is invalid", input.RequestID)
	}
	return input, nil
}

func validateProviderTokenInput(operation Operation, input ProviderTokenInput) (ProviderTokenInput, error) {
	input = normalizeProviderTokenInput(input)
	if err := validateProviderOperation(operation, input.RequestID); err != nil {
		return ProviderTokenInput{}, err
	}
	if input.RequestID == "" {
		return ProviderTokenInput{}, safeError(ErrorCodeProviderRequestInvalid, "apptheory: microvm provider request_id is required", "")
	}
	if operation != OperationAuthToken && operation != OperationShellToken {
		return ProviderTokenInput{}, safeError(ErrorCodeProviderOperationUnsupported, "apptheory: microvm provider token operation is unsupported", input.RequestID)
	}
	if err := validateProviderAccess(input.RequestID, input.TenantID, input.Namespace, input.AuthContext); err != nil {
		return ProviderTokenInput{}, err
	}
	binding, err := validateProviderBinding(input.RequestID, input.TenantID, input.Namespace, input.Binding)
	if err != nil {
		return ProviderTokenInput{}, err
	}
	input.Binding = binding
	if input.TTLSeconds == 0 {
		input.TTLSeconds = defaultProviderTokenTTLSeconds
	}
	if input.TTLSeconds < minProviderTokenTTLSeconds || input.TTLSeconds > maxProviderTokenTTLSeconds {
		return ProviderTokenInput{}, safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider token ttl exceeds contract bounds", input.RequestID)
	}
	if operation == OperationAuthToken && len(input.AllowedPortScope) == 0 {
		return ProviderTokenInput{}, safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm auth token requires an explicit allowed port scope", input.RequestID)
	}
	for _, scope := range input.AllowedPortScope {
		if err := validateProviderPortScope(scope, input.RequestID); err != nil {
			return ProviderTokenInput{}, err
		}
	}
	return input, nil
}

func validateProviderAccess(requestID, tenantID, namespace string, auth AuthContext) error {
	auth = normalizeProviderAuthContext(auth)
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(namespace) == "" {
		return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider request requires tenant and namespace", requestID)
	}
	if auth.Subject == "" || auth.TenantID == "" {
		return safeError(ErrorCodeUnauthenticatedController, "apptheory: microvm provider request requires authenticated context", requestID)
	}
	if auth.TenantID != strings.TrimSpace(tenantID) {
		return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider auth context is cross-tenant", requestID)
	}
	if auth.Namespace != "" && auth.Namespace != strings.TrimSpace(namespace) {
		return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider auth context is cross-namespace", requestID)
	}
	return validateSafeMetadata(auth.Metadata, requestID)
}

func validateProviderBinding(requestID, tenantID, namespace string, binding ProviderSessionBinding) (ProviderSessionBinding, error) {
	binding = normalizeProviderBinding(binding)
	if binding.TenantID == "" || binding.Namespace == "" || binding.SessionID == "" || binding.ProviderMicroVMID == "" {
		return ProviderSessionBinding{}, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider binding is incomplete", requestID)
	}
	if binding.TenantID != strings.TrimSpace(tenantID) || binding.Namespace != strings.TrimSpace(namespace) {
		return ProviderSessionBinding{}, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider binding is cross-tenant", requestID)
	}
	if forbiddenFieldName(binding.ProviderMicroVMID) {
		return ProviderSessionBinding{}, safeError(ErrorCodeForbiddenField, "apptheory: microvm provider binding exposes forbidden field", requestID)
	}
	return binding, nil
}

func validateProviderPortScope(scope ProviderPortScope, requestID string) error {
	options := 0
	if scope.AllPorts {
		options++
	}
	if scope.Port > 0 {
		options++
	}
	if scope.StartPort > 0 || scope.EndPort > 0 {
		options++
		if scope.StartPort <= 0 || scope.EndPort <= 0 || scope.StartPort > scope.EndPort {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider token port range is invalid", requestID)
		}
	}
	if options != 1 {
		return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider token port scope must specify exactly one scope", requestID)
	}
	return nil
}

func validateSafeConnectorRefs(requestID string, refs []string) error {
	for _, ref := range refs {
		if forbiddenFieldName(ref) {
			return safeError(ErrorCodeForbiddenField, "apptheory: microvm provider connector exposes forbidden field", requestID)
		}
	}
	return nil
}

func normalizeProviderRunInput(input ProviderRunInput) ProviderRunInput {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TenantID = strings.TrimSpace(input.TenantID)
	input.Namespace = strings.TrimSpace(input.Namespace)
	input.SessionID = strings.TrimSpace(input.SessionID)
	input.AuthContext = normalizeProviderAuthContext(input.AuthContext)
	input.ImageRef = strings.TrimSpace(input.ImageRef)
	input.ImageVersion = strings.TrimSpace(input.ImageVersion)
	input.NetworkConnectorRef = strings.TrimSpace(input.NetworkConnectorRef)
	input.IngressNetworkConnectorRefs = normalizeStringSlice(input.IngressNetworkConnectorRefs)
	input.EgressNetworkConnectorRefs = normalizeStringSlice(input.EgressNetworkConnectorRefs)
	input.SessionSpec.Metadata = cloneStringMap(input.SessionSpec.Metadata)
	return input
}

func normalizeProviderSessionInput(input ProviderSessionInput) ProviderSessionInput {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TenantID = strings.TrimSpace(input.TenantID)
	input.Namespace = strings.TrimSpace(input.Namespace)
	input.AuthContext = normalizeProviderAuthContext(input.AuthContext)
	input.Binding = normalizeProviderBinding(input.Binding)
	return input
}

func normalizeProviderListInput(input ProviderListInput) ProviderListInput {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TenantID = strings.TrimSpace(input.TenantID)
	input.Namespace = strings.TrimSpace(input.Namespace)
	input.AuthContext = normalizeProviderAuthContext(input.AuthContext)
	input.ImageRef = strings.TrimSpace(input.ImageRef)
	input.ImageVersion = strings.TrimSpace(input.ImageVersion)
	if len(input.KnownSessions) > 0 {
		bindings := make([]ProviderSessionBinding, 0, len(input.KnownSessions))
		for _, binding := range input.KnownSessions {
			bindings = append(bindings, normalizeProviderBinding(binding))
		}
		input.KnownSessions = bindings
	}
	return input
}

func normalizeProviderTokenInput(input ProviderTokenInput) ProviderTokenInput {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TenantID = strings.TrimSpace(input.TenantID)
	input.Namespace = strings.TrimSpace(input.Namespace)
	input.AuthContext = normalizeProviderAuthContext(input.AuthContext)
	input.Binding = normalizeProviderBinding(input.Binding)
	return input
}

func normalizeProviderAuthContext(auth AuthContext) AuthContext {
	auth.Subject = strings.TrimSpace(auth.Subject)
	auth.TenantID = strings.TrimSpace(auth.TenantID)
	auth.Namespace = strings.TrimSpace(auth.Namespace)
	auth.Metadata = cloneStringMap(auth.Metadata)
	if len(auth.Entitlements) > 0 {
		auth.Entitlements = normalizeStringSlice(auth.Entitlements)
	}
	return auth
}

func normalizeProviderBinding(binding ProviderSessionBinding) ProviderSessionBinding {
	binding.TenantID = strings.TrimSpace(binding.TenantID)
	binding.Namespace = strings.TrimSpace(binding.Namespace)
	binding.SessionID = strings.TrimSpace(binding.SessionID)
	binding.ProviderMicroVMID = strings.TrimSpace(binding.ProviderMicroVMID)
	return binding
}

func normalizeProviderSession(session ProviderSession) ProviderSession {
	session.TenantID = strings.TrimSpace(session.TenantID)
	session.Namespace = strings.TrimSpace(session.Namespace)
	session.SessionID = strings.TrimSpace(session.SessionID)
	session.ProviderMicroVMID = strings.TrimSpace(session.ProviderMicroVMID)
	session.State = LifecycleState(strings.TrimSpace(string(session.State)))
	session.ProviderState = normalizeProviderState(session.ProviderState)
	session.ImageRef = strings.TrimSpace(session.ImageRef)
	session.ImageVersion = strings.TrimSpace(session.ImageVersion)
	return session
}

func normalizeProviderToken(token ProviderToken) ProviderToken {
	token.TenantID = strings.TrimSpace(token.TenantID)
	token.Namespace = strings.TrimSpace(token.Namespace)
	token.SessionID = strings.TrimSpace(token.SessionID)
	token.ProviderMicroVMID = strings.TrimSpace(token.ProviderMicroVMID)
	token.TokenID = strings.TrimSpace(token.TokenID)
	token.TokenType = strings.TrimSpace(token.TokenType)
	token.Scope = normalizeStringSlice(token.Scope)
	return token
}

func normalizeStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func sessionFromProviderState(binding ProviderSessionBinding, providerState string, imageRef string, imageVersion string, startedAt time.Time, terminatedAt time.Time) (ProviderSession, error) {
	state, terminal, err := MapProviderState(providerState)
	if err != nil {
		return ProviderSession{}, err
	}
	session := ProviderSession{
		TenantID:          binding.TenantID,
		Namespace:         binding.Namespace,
		SessionID:         binding.SessionID,
		ProviderMicroVMID: binding.ProviderMicroVMID,
		State:             state,
		ProviderState:     normalizeProviderState(providerState),
		ImageRef:          strings.TrimSpace(imageRef),
		ImageVersion:      strings.TrimSpace(imageVersion),
		StartedAt:         startedAt,
		TerminatedAt:      terminatedAt,
		RegistryVersion:   binding.RegistryVersion,
		Terminal:          terminal,
	}
	if err := ValidateProviderSession(session); err != nil {
		return ProviderSession{}, err
	}
	return session, nil
}

func providerTokenMetadata(operation Operation, input ProviderTokenInput, now time.Time) (ProviderToken, error) {
	tokenType := "auth"
	if operation == OperationShellToken {
		tokenType = "shell"
	}
	if now.IsZero() {
		now = time.Unix(0, 0).UTC()
	}
	now = now.UTC()
	scope := providerTokenScope(operation, input.AllowedPortScope)
	expiresAt := now.Add(time.Duration(input.TTLSeconds) * time.Second).UTC()
	token := ProviderToken{
		TenantID:          input.Binding.TenantID,
		Namespace:         input.Binding.Namespace,
		SessionID:         input.Binding.SessionID,
		ProviderMicroVMID: input.Binding.ProviderMicroVMID,
		TokenID:           safeProviderTokenID(input.Binding, tokenType, expiresAt, scope),
		TokenType:         tokenType,
		ExpiresAt:         expiresAt,
		Scope:             scope,
	}
	if err := ValidateProviderToken(token); err != nil {
		return ProviderToken{}, err
	}
	return token, nil
}

func providerTokenScope(operation Operation, scopes []ProviderPortScope) []string {
	if operation == OperationShellToken {
		return []string{"shell"}
	}
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		switch {
		case scope.AllPorts:
			out = append(out, "ports:*")
		case scope.Port > 0:
			out = append(out, fmt.Sprintf("ports:%d", scope.Port))
		default:
			out = append(out, fmt.Sprintf("ports:%d-%d", scope.StartPort, scope.EndPort))
		}
	}
	sort.Strings(out)
	return out
}

func safeProviderTokenID(binding ProviderSessionBinding, tokenType string, expiresAt time.Time, scope []string) string {
	parts := make([]string, 0, 6+len(scope))
	parts = append(parts,
		binding.TenantID,
		binding.Namespace,
		binding.SessionID,
		binding.ProviderMicroVMID,
		tokenType,
		expiresAt.UTC().Format(time.RFC3339Nano),
	)
	parts = append(parts, scope...)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return tokenType + "-" + hex.EncodeToString(sum[:8])
}

func sanitizeProviderError(err error, requestID string) error {
	if err == nil {
		return nil
	}
	var safe SafeError
	if errors.As(err, &safe) {
		if safe.RequestID == "" {
			safe.RequestID = strings.TrimSpace(requestID)
		}
		return safe
	}
	return safeError(ErrorCodeProviderOperationFailed, "apptheory: microvm provider operation failed", requestID)
}
