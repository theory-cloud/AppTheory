package main

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

const (
	microVMContractName    = "apptheory.lambda_microvm"
	microVMContractVersion = "m15.microvm/v1"
	microVMKindLifecycle   = "lifecycle"
	microVMKindController  = "controller_session"

	microVMErrInvalidContract           = "m15.microvm.invalid_contract"
	microVMErrRawSDKEscapeHatch         = "m15.microvm.raw_sdk_escape_hatch"
	microVMErrLifecycleBypass           = "m15.microvm.lifecycle_bypass" //nolint:gosec // Contract error code, not a credential.
	microVMErrUnauthenticatedController = "m15.microvm.unauthenticated_controller"
	microVMErrLifecycleIncomplete       = "m15.microvm.lifecycle_incomplete"
	microVMErrControllerIncomplete      = "m15.microvm.controller_incomplete"
	microVMErrSessionRegistryIncomplete = "m15.microvm.session_registry_incomplete"
)

var (
	requiredMicroVMLifecycleStates = []string{
		"requested",
		"image_preparing",
		"image_prepared",
		"starting",
		"started",
		"readiness_probing",
		"ready",
		"stopping",
		"stopped",
		"tearing_down",
		"terminated",
		"failed",
	}
	requiredMicroVMControllerCommands = []string{"create", "start", "stop", "status", "session"}
	requiredMicroVMEnvelopeFields     = []string{"command", "request_id", "tenant_id", "auth_context"}
	requiredMicroVMSessionFields      = []string{
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
	}
)

type microVMContractFixture struct {
	Contract        string                     `json:"contract"`
	Version         string                     `json:"version"`
	Kind            string                     `json:"kind"`
	EscapeHatches   microVMEscapeHatches       `json:"escape_hatches"`
	Lifecycle       microVMLifecycleContract   `json:"lifecycle"`
	Controller      microVMControllerContract  `json:"controller"`
	SessionRegistry microVMSessionRegistrySpec `json:"session_registry"`
}

type microVMEscapeHatches struct {
	RawAWSSDK              bool `json:"raw_aws_sdk"`
	RawLifecycleHookBypass bool `json:"raw_lifecycle_hook_bypass"`
}

type microVMLifecycleContract struct {
	Hooks          []microVMLifecycleHook       `json:"hooks"`
	States         []string                     `json:"states"`
	TerminalStates []string                     `json:"terminal_states"`
	Transitions    []microVMLifecycleTransition `json:"transitions"`
}

type microVMLifecycleHook struct {
	Name         string `json:"name"`
	Phase        string `json:"phase"`
	State        string `json:"state"`
	SuccessState string `json:"success_state"`
	FailureState string `json:"failure_state"`
}

type microVMLifecycleTransition struct {
	From string `json:"from"`
	Hook string `json:"hook"`
	To   string `json:"to"`
}

type microVMControllerContract struct {
	Auth     microVMControllerAuth      `json:"auth"`
	Envelope microVMControllerEnvelope  `json:"envelope"`
	Commands []microVMControllerCommand `json:"commands"`
}

type microVMControllerAuth struct {
	Required bool   `json:"required"`
	Default  string `json:"default"`
}

type microVMControllerEnvelope struct {
	RequiredFields  []string `json:"required_fields"`
	SafeErrorFields []string `json:"safe_error_fields"`
	ForbiddenFields []string `json:"forbidden_fields"`
}

type microVMControllerCommand struct {
	Name           string   `json:"name"`
	Method         string   `json:"method"`
	Path           string   `json:"path"`
	RequestFields  []string `json:"request_fields"`
	ResponseFields []string `json:"response_fields"`
}

type microVMSessionRegistrySpec struct {
	Pattern         string   `json:"pattern"`
	TenantBinding   []string `json:"tenant_binding"`
	RequiredFields  []string `json:"required_fields"`
	StateValues     []string `json:"state_values"`
	ForbiddenFields []string `json:"forbidden_fields"`
}

func runFixtureM15(f Fixture) error {
	actual := validateMicroVMContractFixture(f.Setup.MicroVMContract)
	expected := f.Expect.MicroVMContractValidation
	if expected == nil {
		return fmt.Errorf("fixture missing expect.microvm_contract_validation")
	}
	if !reflect.DeepEqual(*expected, actual) {
		return fmt.Errorf("microvm_contract_validation mismatch: expected %+v, got %+v", *expected, actual)
	}
	return nil
}

func validateMicroVMContractFixture(raw json.RawMessage) FixtureMicroVMContractValidation {
	if len(raw) == 0 {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract fixture missing")
	}

	var contract microVMContractFixture
	if err := json.Unmarshal(raw, &contract); err != nil {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract fixture is not parseable")
	}

	actual := FixtureMicroVMContractValidation{
		Valid:   true,
		Kind:    strings.TrimSpace(contract.Kind),
		Version: strings.TrimSpace(contract.Version),
	}

	if strings.TrimSpace(contract.Contract) != microVMContractName || actual.Version != microVMContractVersion {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract must be named and versioned")
	}
	if actual.Kind != microVMKindLifecycle && actual.Kind != microVMKindController {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract kind is unsupported")
	}
	if invalid := validateMicroVMEscapeHatches(actual, contract.EscapeHatches); invalid != nil {
		return *invalid
	}
	if actual.Kind == microVMKindController && !controllerAuthDefaultsDeny(contract.Controller.Auth) {
		return FixtureMicroVMContractValidation{
			Valid:        false,
			Kind:         actual.Kind,
			Version:      actual.Version,
			ErrorCode:    microVMErrUnauthenticatedController,
			ErrorMessage: "apptheory: microvm controller must default to authenticated deny",
		}
	}

	switch actual.Kind {
	case microVMKindLifecycle:
		if err := validateMicroVMLifecycle(contract.Lifecycle); err != nil {
			return invalidMicroVMContract(microVMErrLifecycleIncomplete, err.Error())
		}
	case microVMKindController:
		if err := validateMicroVMController(contract.Controller); err != nil {
			return invalidMicroVMContract(microVMErrControllerIncomplete, err.Error())
		}
		if err := validateMicroVMSessionRegistry(contract.SessionRegistry); err != nil {
			return invalidMicroVMContract(microVMErrSessionRegistryIncomplete, err.Error())
		}
	}

	return actual
}

func validateMicroVMEscapeHatches(
	actual FixtureMicroVMContractValidation,
	escapeHatches microVMEscapeHatches,
) *FixtureMicroVMContractValidation {
	if escapeHatches.RawAWSSDK {
		return &FixtureMicroVMContractValidation{
			Valid:        false,
			Kind:         actual.Kind,
			Version:      actual.Version,
			ErrorCode:    microVMErrRawSDKEscapeHatch,
			ErrorMessage: "apptheory: microvm contract forbids raw AWS SDK escape hatch",
		}
	}
	if escapeHatches.RawLifecycleHookBypass {
		return &FixtureMicroVMContractValidation{
			Valid:        false,
			Kind:         actual.Kind,
			Version:      actual.Version,
			ErrorCode:    microVMErrLifecycleBypass,
			ErrorMessage: "apptheory: microvm contract forbids raw lifecycle hook bypass",
		}
	}
	return nil
}

func invalidMicroVMContract(code, message string) FixtureMicroVMContractValidation {
	return FixtureMicroVMContractValidation{Valid: false, ErrorCode: code, ErrorMessage: message}
}

func controllerAuthDefaultsDeny(auth microVMControllerAuth) bool {
	return auth.Required && strings.EqualFold(strings.TrimSpace(auth.Default), "deny")
}

func validateMicroVMLifecycle(lifecycle microVMLifecycleContract) error {
	contract := runtimeLifecycleContract(lifecycle)
	if err := runtimemicrovm.ValidateLifecycleContract(contract); err != nil {
		return err
	}

	adapter, err := runtimemicrovm.NewLifecycleAdapter(
		runtimemicrovm.WithLifecycleContract(contract),
		runtimemicrovm.WithLifecycleHandler(runtimemicrovm.HookPrepareImage, noopRuntimeLifecycleHandler),
		runtimemicrovm.WithLifecycleHandler(runtimemicrovm.HookStart, noopRuntimeLifecycleHandler),
		runtimemicrovm.WithLifecycleHandler(runtimemicrovm.HookReadiness, noopRuntimeLifecycleHandler),
		runtimemicrovm.WithLifecycleHandler(runtimemicrovm.HookStop, noopRuntimeLifecycleHandler),
		runtimemicrovm.WithLifecycleHandler(runtimemicrovm.HookTeardown, noopRuntimeLifecycleHandler),
		runtimemicrovm.WithLifecycleHandler(runtimemicrovm.HookFailure, noopRuntimeLifecycleHandler),
	)
	if err != nil {
		return err
	}

	state := runtimemicrovm.StateRequested
	for _, hook := range []runtimemicrovm.LifecycleHook{
		runtimemicrovm.HookPrepareImage,
		runtimemicrovm.HookStart,
		runtimemicrovm.HookReadiness,
		runtimemicrovm.HookStop,
		runtimemicrovm.HookTeardown,
	} {
		result, handleErr := adapter.Handle(context.Background(), runtimemicrovm.LifecycleEvent{
			RequestID: "m15-lifecycle-fixture",
			TenantID:  "tenant-fixture",
			Namespace: "namespace-fixture",
			SessionID: "session-fixture",
			Hook:      hook,
			State:     state,
		})
		if handleErr != nil {
			return handleErr
		}
		state = result.State
	}
	if state != runtimemicrovm.StateTerminated {
		return fmt.Errorf("apptheory: microvm lifecycle adapter terminated at %s", state)
	}

	failure, err := adapter.Handle(context.Background(), runtimemicrovm.LifecycleEvent{
		RequestID: "m15-lifecycle-fixture-failure",
		TenantID:  "tenant-fixture",
		Namespace: "namespace-fixture",
		SessionID: "session-fixture",
		Hook:      runtimemicrovm.HookFailure,
		State:     runtimemicrovm.StateStarting,
	})
	if err != nil {
		return err
	}
	if failure.State != runtimemicrovm.StateFailed {
		return fmt.Errorf("apptheory: microvm lifecycle failure hook produced %s", failure.State)
	}
	return nil
}

func runtimeLifecycleContract(lifecycle microVMLifecycleContract) runtimemicrovm.LifecycleContract {
	hooks := make([]runtimemicrovm.LifecycleHookSpec, 0, len(lifecycle.Hooks))
	for _, hook := range lifecycle.Hooks {
		hooks = append(hooks, runtimemicrovm.LifecycleHookSpec{
			Name:         runtimemicrovm.LifecycleHook(hook.Name),
			Phase:        hook.Phase,
			State:        runtimemicrovm.LifecycleState(hook.State),
			SuccessState: runtimemicrovm.LifecycleState(hook.SuccessState),
			FailureState: runtimemicrovm.LifecycleState(hook.FailureState),
		})
	}
	states := make([]runtimemicrovm.LifecycleState, 0, len(lifecycle.States))
	for _, state := range lifecycle.States {
		states = append(states, runtimemicrovm.LifecycleState(state))
	}
	terminalStates := make([]runtimemicrovm.LifecycleState, 0, len(lifecycle.TerminalStates))
	for _, state := range lifecycle.TerminalStates {
		terminalStates = append(terminalStates, runtimemicrovm.LifecycleState(state))
	}
	transitions := make([]runtimemicrovm.LifecycleTransition, 0, len(lifecycle.Transitions))
	for _, transition := range lifecycle.Transitions {
		transitions = append(transitions, runtimemicrovm.LifecycleTransition{
			From: runtimemicrovm.LifecycleState(transition.From),
			Hook: runtimemicrovm.LifecycleHook(transition.Hook),
			To:   runtimemicrovm.LifecycleState(transition.To),
		})
	}
	return runtimemicrovm.LifecycleContract{
		Hooks:          hooks,
		States:         states,
		TerminalStates: terminalStates,
		Transitions:    transitions,
	}
}

func noopRuntimeLifecycleHandler(context.Context, runtimemicrovm.LifecycleEvent) error { return nil }

func validateMicroVMController(controller microVMControllerContract) error {
	if !controllerAuthDefaultsDeny(controller.Auth) {
		return fmt.Errorf("apptheory: microvm controller must default to authenticated deny")
	}
	if missing := missingStrings(requiredMicroVMEnvelopeFields, controller.Envelope.RequiredFields); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm controller envelope missing fields: %s", strings.Join(missing, ","))
	}
	if missing := missingStrings([]string{"raw_sdk_client", "bearer_token"}, controller.Envelope.ForbiddenFields); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm controller envelope missing forbidden fields: %s", strings.Join(missing, ","))
	}
	if missing := missingStrings(requiredMicroVMControllerCommands, controllerCommandNames(controller.Commands)); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm controller missing commands: %s", strings.Join(missing, ","))
	}
	for _, command := range controller.Commands {
		if strings.TrimSpace(command.Name) == "" || strings.TrimSpace(command.Method) == "" || strings.TrimSpace(command.Path) == "" {
			return fmt.Errorf("apptheory: microvm controller commands must define name, method, and path")
		}
		if len(command.RequestFields) == 0 || len(command.ResponseFields) == 0 {
			return fmt.Errorf("apptheory: microvm controller command %s must define request and response fields", command.Name)
		}
	}
	return nil
}

func validateMicroVMSessionRegistry(registry microVMSessionRegistrySpec) error {
	if strings.TrimSpace(registry.Pattern) != "tabletheory-single-table" {
		return fmt.Errorf("apptheory: microvm session registry must use tabletheory-single-table guidance")
	}
	if missing := missingStrings([]string{"tenant_id", "namespace"}, registry.TenantBinding); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm session registry missing tenant binding: %s", strings.Join(missing, ","))
	}
	if missing := missingStrings(requiredMicroVMSessionFields, registry.RequiredFields); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm session registry missing fields: %s", strings.Join(missing, ","))
	}
	if missing := missingStrings(requiredMicroVMLifecycleStates, registry.StateValues); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm session registry missing states: %s", strings.Join(missing, ","))
	}
	if missing := missingStrings([]string{"raw_aws_credentials", "raw_lifecycle_hook_payload", "bearer_token"}, registry.ForbiddenFields); len(missing) > 0 {
		return fmt.Errorf("apptheory: microvm session registry missing forbidden fields: %s", strings.Join(missing, ","))
	}
	return nil
}

func controllerCommandNames(commands []microVMControllerCommand) []string {
	out := make([]string, 0, len(commands))
	for _, command := range commands {
		out = append(out, command.Name)
	}
	return out
}

func missingStrings(required []string, got []string) []string {
	seen := make(map[string]struct{}, len(got))
	for _, value := range got {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			seen[trimmed] = struct{}{}
		}
	}
	var missing []string
	for _, value := range required {
		if _, ok := seen[value]; !ok {
			missing = append(missing, value)
		}
	}
	sort.Strings(missing)
	return missing
}
