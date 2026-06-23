package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
	microvmtest "github.com/theory-cloud/apptheory/testkit/microvm"
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
	err := runtimemicrovm.ValidateEscapeHatches(runtimemicrovm.EscapeHatches{
		RawAWSSDK:              escapeHatches.RawAWSSDK,
		RawLifecycleHookBypass: escapeHatches.RawLifecycleHookBypass,
	})
	if err == nil {
		return nil
	}
	var safe runtimemicrovm.SafeError
	if !errors.As(err, &safe) {
		return fixtureMicroVMValidationRef(invalidMicroVMContract(microVMErrInvalidContract, err.Error()))
	}
	return &FixtureMicroVMContractValidation{
		Valid:        false,
		Kind:         actual.Kind,
		Version:      actual.Version,
		ErrorCode:    safe.Code,
		ErrorMessage: safe.Message,
	}
}

func fixtureMicroVMValidationRef(validation FixtureMicroVMContractValidation) *FixtureMicroVMContractValidation {
	return &validation
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
	contract := runtimeControllerContract(controller)
	if err := runtimemicrovm.ValidateControllerContract(contract); err != nil {
		return err
	}
	return exerciseRuntimeController()
}

func runtimeControllerContract(controller microVMControllerContract) runtimemicrovm.ControllerContract {
	commands := make([]runtimemicrovm.ControllerCommandContract, 0, len(controller.Commands))
	for _, command := range controller.Commands {
		commands = append(commands, runtimemicrovm.ControllerCommandContract{
			Name:           runtimemicrovm.Command(command.Name),
			Method:         command.Method,
			Path:           command.Path,
			RequestFields:  append([]string(nil), command.RequestFields...),
			ResponseFields: append([]string(nil), command.ResponseFields...),
		})
	}
	return runtimemicrovm.ControllerContract{
		Auth: runtimemicrovm.ControllerAuthContract{
			Required: controller.Auth.Required,
			Default:  controller.Auth.Default,
		},
		Envelope: runtimemicrovm.ControllerEnvelopeContract{
			RequiredFields:  append([]string(nil), controller.Envelope.RequiredFields...),
			SafeErrorFields: append([]string(nil), controller.Envelope.SafeErrorFields...),
			ForbiddenFields: append([]string(nil), controller.Envelope.ForbiddenFields...),
		},
		Commands: commands,
	}
}

func exerciseRuntimeController() error {
	client := microvmtest.NewFakeClient()
	controller, err := runtimemicrovm.NewController(
		client,
		runtimemicrovm.WithControllerID("controller-fixture"),
		runtimemicrovm.WithControllerIDGenerator(microVMFixtureIDs{}),
	)
	if err != nil {
		return err
	}

	create, err := controller.Handle(context.Background(), runtimeControllerRequest(runtimemicrovm.CommandCreate, "m15-create", ""))
	if err != nil {
		return err
	}
	if err := requireCreateResponse(create); err != nil {
		return err
	}
	return exerciseRuntimeControllerCommands(controller, create.SessionID)
}

func exerciseRuntimeControllerCommands(controller *runtimemicrovm.Controller, sessionID string) error {
	start, err := controller.Handle(context.Background(), runtimeControllerRequest(runtimemicrovm.CommandStart, "m15-start", sessionID))
	if err != nil {
		return err
	}
	if validationErr := requireStartStopResponse("start", start, sessionID, runtimemicrovm.StateStarted); validationErr != nil {
		return validationErr
	}

	status, err := controller.Handle(context.Background(), runtimeControllerRequest(runtimemicrovm.CommandStatus, "m15-status", sessionID))
	if err != nil {
		return err
	}
	if validationErr := requireStatusResponse(status, sessionID); validationErr != nil {
		return validationErr
	}

	session, err := controller.Handle(context.Background(), runtimeControllerRequest(runtimemicrovm.CommandSession, "m15-session", sessionID))
	if err != nil {
		return err
	}
	if validationErr := requireSessionResponse(session, sessionID); validationErr != nil {
		return validationErr
	}

	stop, err := controller.Handle(context.Background(), runtimeControllerRequest(runtimemicrovm.CommandStop, "m15-stop", sessionID))
	if err != nil {
		return err
	}
	return requireStartStopResponse("stop", stop, sessionID, runtimemicrovm.StateStopped)
}

func requireCreateResponse(response runtimemicrovm.ControllerResponse) error {
	if response.SessionID == "" || response.State != runtimemicrovm.StateRequested || response.RegistryVersion == 0 {
		return fmt.Errorf("apptheory: microvm controller create response incomplete")
	}
	return nil
}

func requireStartStopResponse(name string, response runtimemicrovm.ControllerResponse, sessionID string, desired runtimemicrovm.LifecycleState) error {
	if response.SessionID != sessionID || response.State == "" || response.DesiredState != desired {
		return fmt.Errorf("apptheory: microvm controller %s response incomplete", name)
	}
	return nil
}

func requireStatusResponse(response runtimemicrovm.ControllerResponse, sessionID string) error {
	if response.SessionID != sessionID || response.LifecycleState == "" || response.LastTransition.IsZero() {
		return fmt.Errorf("apptheory: microvm controller status response incomplete")
	}
	return nil
}

func requireSessionResponse(response runtimemicrovm.ControllerResponse, sessionID string) error {
	if response.SessionID != sessionID || response.TenantID == "" || response.Namespace == "" || response.RegistryVersion == 0 {
		return fmt.Errorf("apptheory: microvm controller session response incomplete")
	}
	return nil
}

func runtimeControllerRequest(command runtimemicrovm.Command, requestID string, sessionID string) runtimemicrovm.ControllerRequest {
	request := runtimemicrovm.ControllerRequest{
		Command:   command,
		RequestID: requestID,
		TenantID:  "tenant-fixture",
		Namespace: "namespace-fixture",
		AuthContext: runtimemicrovm.AuthContext{
			Subject:  "subject-fixture",
			TenantID: "tenant-fixture",
		},
		SessionID: sessionID,
	}
	if command == runtimemicrovm.CommandCreate {
		request.ImageRef = "image-fixture"
		request.NetworkConnectorRef = "network-fixture"
	}
	return request
}

type microVMFixtureIDs struct{}

func (microVMFixtureIDs) NewID() string { return "session-fixture" }

func validateMicroVMSessionRegistry(registry microVMSessionRegistrySpec) error {
	if err := runtimemicrovm.ValidateSessionRegistryContract(runtimemicrovm.SessionRegistryContract{
		Pattern:         registry.Pattern,
		TenantBinding:   append([]string(nil), registry.TenantBinding...),
		RequiredFields:  append([]string(nil), registry.RequiredFields...),
		StateValues:     append([]string(nil), registry.StateValues...),
		ForbiddenFields: append([]string(nil), registry.ForbiddenFields...),
	}); err != nil {
		return err
	}
	return exerciseRuntimeSessionRegistry()
}

func exerciseRuntimeSessionRegistry() error {
	record := runtimeRegistryFixtureRecord()
	if err := validateRuntimeSessionRegistryRecord(record); err != nil {
		return err
	}
	store := runtimemicrovm.NewMemorySessionRegistry()
	if err := exerciseRuntimeMemoryRegistry(store, record); err != nil {
		return err
	}
	return exerciseRuntimeRegistryClient(store, record.CreatedAt)
}

func runtimeRegistryFixtureRecord() runtimemicrovm.SessionRecord {
	now := time.Unix(100, 0).UTC()
	return runtimemicrovm.SessionRecord{
		TenantID:            "tenant-fixture",
		Namespace:           "namespace-fixture",
		SessionID:           "session-fixture",
		State:               runtimemicrovm.StateStarting,
		DesiredState:        runtimemicrovm.StateStarted,
		Endpoint:            "https://microvm.example.test/session-fixture",
		MicroVMID:           "microvm-fixture",
		ImageRef:            "image-fixture",
		NetworkConnectorRef: "network-fixture",
		ControllerID:        "controller-fixture",
		CreatedAt:           now,
		UpdatedAt:           now.Add(time.Minute),
		ExpiresAt:           now.Add(time.Hour),
		Generation:          3,
		LastAction:          runtimemicrovm.CommandStart,
		LastCommandID:       "m15-registry",
		AuthSubject:         "subject-fixture",
		Metadata:            map[string]string{"safe": "ok"},
	}
}

func validateRuntimeSessionRegistryRecord(record runtimemicrovm.SessionRecord) error {
	registryRecord, err := runtimemicrovm.SessionRecordToRegistryRecord(record)
	if err != nil {
		return err
	}
	if registryRecord.PK != runtimemicrovm.SessionRegistryPartitionKey(record.TenantID, record.Namespace) ||
		registryRecord.SK != runtimemicrovm.SessionRegistrySortKey(record.SessionID) ||
		registryRecord.TTL != record.ExpiresAt.Unix() ||
		registryRecord.Endpoint != record.Endpoint ||
		registryRecord.MicroVMID != record.MicroVMID ||
		registryRecord.LastAction != runtimemicrovm.CommandStart {
		return fmt.Errorf("apptheory: microvm session registry canonical record incomplete")
	}
	roundTrip, err := runtimemicrovm.SessionRecordFromRegistryRecord(registryRecord)
	if err != nil {
		return err
	}
	if roundTrip.Endpoint != record.Endpoint || roundTrip.MicroVMID != record.MicroVMID || roundTrip.LastAction != record.LastAction {
		return fmt.Errorf("apptheory: microvm session registry round trip incomplete")
	}
	return nil
}

func exerciseRuntimeMemoryRegistry(store runtimemicrovm.SessionRegistry, record runtimemicrovm.SessionRecord) error {
	stored, err := store.Put(context.Background(), record)
	if err != nil {
		return err
	}
	if stored.LastAction != runtimemicrovm.CommandStart {
		return fmt.Errorf("apptheory: microvm memory registry lost last action")
	}
	return nil
}

func exerciseRuntimeRegistryClient(store runtimemicrovm.SessionRegistry, now time.Time) error {
	client, err := runtimemicrovm.NewRegistryClient(store, runtimemicrovm.WithRegistryClientTTL(30*time.Minute))
	if err != nil {
		return err
	}
	created, err := client.Create(context.Background(), runtimemicrovm.CreateSessionInput{
		RequestID:           "m15-registry-create",
		TenantID:            "tenant-fixture",
		Namespace:           "namespace-fixture",
		SessionID:           "session-registry-client",
		ImageRef:            "image-fixture",
		NetworkConnectorRef: "network-fixture",
		SessionSpec:         runtimemicrovm.SessionSpec{Metadata: map[string]string{"safe": "ok"}},
		ControllerID:        "controller-fixture",
		AuthSubject:         "subject-fixture",
		Now:                 now,
	})
	if err != nil {
		return err
	}
	if created.LastAction != runtimemicrovm.CommandCreate || created.ExpiresAt.Sub(created.CreatedAt) != 30*time.Minute {
		return fmt.Errorf("apptheory: microvm registry client create record incomplete")
	}
	status, err := client.Status(context.Background(), runtimemicrovm.SessionQueryInput{
		RequestID:   "m15-registry-status",
		TenantID:    created.TenantID,
		Namespace:   created.Namespace,
		SessionID:   created.SessionID,
		AuthSubject: created.AuthSubject,
	})
	if err != nil {
		return err
	}
	if status.LastAction != runtimemicrovm.CommandCreate || status.RegistryVersion != created.Generation {
		return fmt.Errorf("apptheory: microvm registry client status incomplete")
	}
	return nil
}
