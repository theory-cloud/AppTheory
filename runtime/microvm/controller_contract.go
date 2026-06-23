package microvm

import (
	"fmt"
	"strings"
)

const (
	// KindLifecycle is the lifecycle contract kind.
	KindLifecycle ContractKind = "lifecycle"
	// KindControllerSession is the controller/session contract kind.
	KindControllerSession ContractKind = "controller_session"

	// ControllerAuthDefaultDeny is the only controller auth default AppTheory accepts.
	ControllerAuthDefaultDeny = "deny"

	// ErrorCodeUnauthenticatedController reports a controller contract or request that does not fail closed.
	ErrorCodeUnauthenticatedController = "m15.microvm.unauthenticated_controller"
	// ErrorCodeControllerIncomplete reports an incomplete controller contract.
	ErrorCodeControllerIncomplete = "m15.microvm.controller_incomplete"
	// ErrorCodeSessionRegistryIncomplete reports an incomplete session registry contract.
	ErrorCodeSessionRegistryIncomplete = "m15.microvm.session_registry_incomplete"
)

// ContractKind identifies a MicroVM contract vocabulary kind.
type ContractKind string

// EscapeHatches captures forbidden extension points that must remain disabled.
type EscapeHatches struct {
	RawAWSSDK              bool `json:"raw_aws_sdk"`
	RawLifecycleHookBypass bool `json:"raw_lifecycle_hook_bypass"`
}

// ControllerAuthContract describes controller authentication requirements.
type ControllerAuthContract struct {
	Required bool   `json:"required"`
	Default  string `json:"default"`
}

// ControllerEnvelopeContract describes the safe controller envelope vocabulary.
type ControllerEnvelopeContract struct {
	RequiredFields  []string `json:"required_fields"`
	SafeErrorFields []string `json:"safe_error_fields"`
	ForbiddenFields []string `json:"forbidden_fields"`
}

// ControllerCommandContract describes a single controller command.
type ControllerCommandContract struct {
	Name           Command  `json:"name"`
	Method         string   `json:"method"`
	Path           string   `json:"path"`
	RequestFields  []string `json:"request_fields"`
	ResponseFields []string `json:"response_fields"`
}

// ControllerContract is the AppTheory MicroVM controller vocabulary.
type ControllerContract struct {
	Auth     ControllerAuthContract      `json:"auth"`
	Envelope ControllerEnvelopeContract  `json:"envelope"`
	Commands []ControllerCommandContract `json:"commands"`
}

// SessionRegistryContract is the TableTheory-patterned session record vocabulary.
type SessionRegistryContract struct {
	Pattern         string   `json:"pattern"`
	TenantBinding   []string `json:"tenant_binding"`
	RequiredFields  []string `json:"required_fields"`
	StateValues     []string `json:"state_values"`
	ForbiddenFields []string `json:"forbidden_fields"`
}

// ValidateEscapeHatches fails closed when a contract enables a raw SDK or lifecycle bypass.
func ValidateEscapeHatches(escapeHatches EscapeHatches) error {
	if escapeHatches.RawAWSSDK {
		return safeError(ErrorCodeRawSDKEscapeHatch, "apptheory: microvm contract forbids raw AWS SDK escape hatch", "")
	}
	if escapeHatches.RawLifecycleHookBypass {
		return safeError(ErrorCodeLifecycleBypass, "apptheory: microvm contract forbids raw lifecycle hook bypass", "")
	}
	return nil
}

// DefaultControllerContract returns the M15 controller command and envelope vocabulary.
func DefaultControllerContract() ControllerContract {
	return ControllerContract{
		Auth: ControllerAuthContract{Required: true, Default: ControllerAuthDefaultDeny},
		Envelope: ControllerEnvelopeContract{
			RequiredFields:  []string{"command", "request_id", "tenant_id", "auth_context"},
			SafeErrorFields: []string{"code", "message", "request_id"},
			ForbiddenFields: []string{"aws_access_key_id", "aws_secret_access_key", "raw_sdk_client", "bearer_token"}, //nolint:gosec // Contract field names, not credentials.
		},
		Commands: []ControllerCommandContract{
			{
				Name:           CommandCreate,
				Method:         "POST",
				Path:           "/microvms",
				RequestFields:  []string{"image_ref", "network_connector_ref", "session_spec"},
				ResponseFields: []string{"session_id", "state", "registry_version"},
			},
			{
				Name:           CommandStart,
				Method:         "POST",
				Path:           "/microvms/{session_id}/start",
				RequestFields:  []string{"session_id"},
				ResponseFields: []string{"session_id", "state", "desired_state"},
			},
			{
				Name:           CommandStop,
				Method:         "POST",
				Path:           "/microvms/{session_id}/stop",
				RequestFields:  []string{"session_id"},
				ResponseFields: []string{"session_id", "state", "desired_state"},
			},
			{
				Name:           CommandStatus,
				Method:         "GET",
				Path:           "/microvms/{session_id}/status",
				RequestFields:  []string{"session_id"},
				ResponseFields: []string{"session_id", "state", "lifecycle_state", "last_transition"},
			},
			{
				Name:           CommandSession,
				Method:         "GET",
				Path:           "/microvms/{session_id}",
				RequestFields:  []string{"session_id"},
				ResponseFields: []string{"session_id", "tenant_id", "namespace", "state", "registry_version"},
			},
		},
	}
}

// DefaultSessionRegistryContract returns the M15 session registry vocabulary.
func DefaultSessionRegistryContract() SessionRegistryContract {
	states := requiredLifecycleStates()
	stateValues := make([]string, 0, len(states))
	for _, state := range states {
		stateValues = append(stateValues, string(state))
	}
	return SessionRegistryContract{
		Pattern:       "tabletheory-single-table",
		TenantBinding: []string{"tenant_id", "namespace"},
		RequiredFields: []string{
			"tenant_id",
			"namespace",
			"session_id",
			"state",
			"desired_state",
			"image_ref",
			"controller_id",
			"created_at",
			"updated_at",
			"expires_at",
			"generation",
			"last_command_id",
			"auth_subject",
		},
		StateValues:     stateValues,
		ForbiddenFields: []string{"raw_aws_credentials", "raw_lifecycle_hook_payload", "bearer_token", "session_token_plaintext"},
	}
}

// ValidateControllerContract validates the controller contract vocabulary.
func ValidateControllerContract(contract ControllerContract) error {
	if !controllerAuthDefaultsDeny(contract.Auth) {
		return safeError(ErrorCodeUnauthenticatedController, "apptheory: microvm controller must default to authenticated deny", "")
	}
	if missing := missingStrings([]string{"command", "request_id", "tenant_id", "auth_context"}, contract.Envelope.RequiredFields); len(missing) > 0 {
		return safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller envelope missing fields: "+strings.Join(missing, ","), "")
	}
	if missing := missingStrings([]string{"code", "message", "request_id"}, contract.Envelope.SafeErrorFields); len(missing) > 0 {
		return safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller safe error missing fields: "+strings.Join(missing, ","), "")
	}
	if missing := missingStrings([]string{"raw_sdk_client", "bearer_token"}, contract.Envelope.ForbiddenFields); len(missing) > 0 {
		return safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller envelope missing forbidden fields: "+strings.Join(missing, ","), "")
	}
	commands := map[Command]ControllerCommandContract{}
	for _, command := range contract.Commands {
		name := normalizeCommand(command.Name)
		if name == "" || strings.TrimSpace(command.Method) == "" || strings.TrimSpace(command.Path) == "" {
			return safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller commands must define name, method, and path", "")
		}
		if len(command.RequestFields) == 0 || len(command.ResponseFields) == 0 {
			return safeError(ErrorCodeControllerIncomplete, fmt.Sprintf("apptheory: microvm controller command %s must define request and response fields", name), "")
		}
		commands[name] = command
	}
	for _, required := range []Command{CommandCreate, CommandStart, CommandStop, CommandStatus, CommandSession} {
		if _, ok := commands[required]; !ok {
			return safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller missing command: "+string(required), "")
		}
	}
	return nil
}

// ValidateSessionRegistryContract validates the session registry contract vocabulary.
func ValidateSessionRegistryContract(registry SessionRegistryContract) error {
	if strings.TrimSpace(registry.Pattern) != "tabletheory-single-table" {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry must use tabletheory-single-table guidance", "")
	}
	if missing := missingStrings([]string{"tenant_id", "namespace"}, registry.TenantBinding); len(missing) > 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry missing tenant binding: "+strings.Join(missing, ","), "")
	}
	if missing := missingStrings(DefaultSessionRegistryContract().RequiredFields, registry.RequiredFields); len(missing) > 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry missing fields: "+strings.Join(missing, ","), "")
	}
	stateValues := make([]string, 0, len(requiredLifecycleStates()))
	for _, state := range requiredLifecycleStates() {
		stateValues = append(stateValues, string(state))
	}
	if missing := missingStrings(stateValues, registry.StateValues); len(missing) > 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry missing states: "+strings.Join(missing, ","), "")
	}
	if missing := missingStrings([]string{"raw_aws_credentials", "raw_lifecycle_hook_payload", "bearer_token"}, registry.ForbiddenFields); len(missing) > 0 {
		return safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm session registry missing forbidden fields: "+strings.Join(missing, ","), "")
	}
	return nil
}

func controllerAuthDefaultsDeny(auth ControllerAuthContract) bool {
	return auth.Required && strings.EqualFold(strings.TrimSpace(auth.Default), ControllerAuthDefaultDeny)
}

func missingStrings(required []string, got []string) []string {
	seen := make(map[string]struct{}, len(got))
	for _, value := range got {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			seen[trimmed] = struct{}{}
		}
	}
	missing := make([]string, 0)
	for _, value := range required {
		if _, ok := seen[value]; !ok {
			missing = append(missing, value)
		}
	}
	return missing
}
