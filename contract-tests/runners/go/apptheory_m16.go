package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

const (
	microVMContractVersionM16 = "m16.microvm/v1"
	microVMKindOperation      = "operation"
)

type microVMContractFixtureM16 struct {
	Contract          string                           `json:"contract"`
	Version           string                           `json:"version"`
	Kind              string                           `json:"kind"`
	EscapeHatches     microVMEscapeHatches             `json:"escape_hatches"`
	Lifecycle         microVMLifecycleContract         `json:"lifecycle"`
	OperationContract runtimemicrovm.OperationContract `json:"operation_contract"`
}

func runFixtureM16(f Fixture) error {
	if f.Expect.MicroVMControllerRoute != nil {
		return compareMicroVMControllerRouteFixtureM16(f)
	}

	actual := validateMicroVMContractFixtureM16(f.Setup.MicroVMContract)
	expected := f.Expect.MicroVMContractValidation
	if expected == nil {
		return fmt.Errorf("fixture missing expect.microvm_contract_validation")
	}
	if !reflect.DeepEqual(*expected, actual) {
		return fmt.Errorf("microvm_contract_validation mismatch: expected %+v, got %+v", *expected, actual)
	}
	return nil
}

func validateMicroVMContractFixtureM16(raw json.RawMessage) FixtureMicroVMContractValidation {
	if len(raw) == 0 {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract fixture missing")
	}

	var contract microVMContractFixtureM16
	if err := json.Unmarshal(raw, &contract); err != nil {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract fixture is not parseable")
	}

	actual := FixtureMicroVMContractValidation{
		Valid:   true,
		Kind:    strings.TrimSpace(contract.Kind),
		Version: strings.TrimSpace(contract.Version),
	}
	if strings.TrimSpace(contract.Contract) != microVMContractName || actual.Version != microVMContractVersionM16 {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract must be named and versioned")
	}
	if actual.Kind != microVMKindLifecycle && actual.Kind != microVMKindOperation {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract kind is unsupported")
	}
	if invalid := validateMicroVMEscapeHatches(actual, contract.EscapeHatches); invalid != nil {
		return *invalid
	}

	switch actual.Kind {
	case microVMKindLifecycle:
		if err := runtimemicrovm.ValidateRealLifecycleContract(runtimeLifecycleContract(contract.Lifecycle)); err != nil {
			return microVMContractValidationFromError(actual, runtimemicrovm.ErrorCodeRealLifecycleIncomplete, err)
		}
	case microVMKindOperation:
		if err := runtimemicrovm.ValidateOperationContract(contract.OperationContract); err != nil {
			return microVMContractValidationFromError(actual, runtimemicrovm.ErrorCodeOperationContractIncomplete, err)
		}
	}
	return actual
}

func microVMContractValidationFromError(
	actual FixtureMicroVMContractValidation,
	defaultCode string,
	err error,
) FixtureMicroVMContractValidation {
	var safe runtimemicrovm.SafeError
	if errors.As(err, &safe) {
		return FixtureMicroVMContractValidation{
			Valid:        false,
			Kind:         actual.Kind,
			Version:      actual.Version,
			ErrorCode:    safe.Code,
			ErrorMessage: safe.Message,
		}
	}
	return FixtureMicroVMContractValidation{
		Valid:        false,
		Kind:         actual.Kind,
		Version:      actual.Version,
		ErrorCode:    defaultCode,
		ErrorMessage: err.Error(),
	}
}

func compareMicroVMControllerRouteFixtureM16(f Fixture) error {
	expected := f.Expect.MicroVMControllerRoute
	if expected == nil {
		return fmt.Errorf("fixture missing expect.microvm_controller_route")
	}
	if f.Input.Request == nil {
		return fmt.Errorf("fixture missing input.request")
	}

	setup := normalizeMicroVMRouteSetup(f.Setup.MicroVMRoute)
	runtime, err := newMicroVMRouteFixtureRuntime(setup)
	if err != nil {
		return err
	}

	req, err := canonicalizeRequest(*f.Input.Request)
	if err != nil {
		return fmt.Errorf("canonicalize request: %w", err)
	}
	actual := runtime.app.Serve(context.Background(), apptheory.Request{
		Method:   req.Method,
		Path:     req.Path,
		Query:    req.Query,
		Headers:  req.Headers,
		Cookies:  req.Cookies,
		Body:     req.Body,
		IsBase64: req.IsBase64,
	})
	body, err := compareMicroVMRouteResponse(*expected, actual)
	if err != nil {
		return err
	}
	return compareMicroVMRouteRegistry(*expected, runtime.registry, body, setup)
}

type microVMRouteFixtureRuntime struct {
	app      *apptheory.App
	registry *runtimemicrovm.MemorySessionRegistry
}

func newMicroVMRouteFixtureRuntime(setup FixtureMicroVMRouteSetup) (microVMRouteFixtureRuntime, error) {
	now := time.Unix(1700000000, 0).UTC()
	registry := runtimemicrovm.NewMemorySessionRegistry()
	provider := newMicroVMRouteFixtureProvider(now)
	controller, controllerErr := runtimemicrovm.NewRealController(
		provider,
		registry,
		runtimemicrovm.WithControllerClock(microVMRouteFixtureClock{now: now}),
		runtimemicrovm.WithControllerIDGenerator(microVMRouteFixtureIDs{id: setup.SessionID}),
	)
	if controllerErr != nil {
		return microVMRouteFixtureRuntime{}, fmt.Errorf("setup microvm controller: %w", controllerErr)
	}
	if setup.SeedSession {
		if _, seedErr := controller.Handle(context.Background(), microVMRouteFixtureRunRequest(setup)); seedErr != nil {
			return microVMRouteFixtureRuntime{}, fmt.Errorf("seed microvm route session: %w", seedErr)
		}
	}

	appOpts := []apptheory.Option{
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(microVMRouteFixtureClock{now: now}),
		apptheory.WithIDGenerator(microVMRouteFixtureIDs{id: "req-m16-route-fallback"}),
	}
	if setup.Authenticated {
		appOpts = append(appOpts, apptheory.WithAuthHook(func(*apptheory.Context) (string, error) {
			return "subject-1", nil
		}))
	}
	app := apptheory.New(appOpts...)
	if _, registerErr := runtimemicrovm.RegisterMicroVMControllerRoutes(app, controller); registerErr != nil {
		return microVMRouteFixtureRuntime{}, fmt.Errorf("register microvm controller routes: %w", registerErr)
	}
	return microVMRouteFixtureRuntime{app: app, registry: registry}, nil
}

func compareMicroVMRouteResponse(expected FixtureMicroVMControllerRoute, actual apptheory.Response) (map[string]any, error) {
	if expected.Status != actual.Status {
		return nil, fmt.Errorf("microvm_controller_route status: expected %d, got %d", expected.Status, actual.Status)
	}

	bodyText := string(actual.Body)
	for _, forbidden := range expected.ForbiddenBodySubstrings {
		if forbidden != "" && strings.Contains(bodyText, forbidden) {
			return nil, fmt.Errorf("microvm_controller_route body contains forbidden substring %q", forbidden)
		}
	}

	var body map[string]any
	if len(actual.Body) > 0 {
		if err := json.Unmarshal(actual.Body, &body); err != nil {
			return nil, fmt.Errorf("parse microvm_controller_route response json: %w", err)
		}
	}
	if err := compareMicroVMRouteFields(expected, body); err != nil {
		return nil, err
	}
	return body, nil
}

func compareMicroVMRouteFields(expected FixtureMicroVMControllerRoute, body map[string]any) error {
	expectedFields := map[string]string{
		"command":    expected.Command,
		"tenant_id":  expected.TenantID,
		"namespace":  expected.Namespace,
		"session_id": expected.SessionID,
		"state":      expected.State,
		"token_type": expected.TokenType,
	}
	for field, value := range expectedFields {
		if value != "" && stringValue(body[field]) != value {
			return fmt.Errorf("microvm_controller_route %s: expected %q, got %q", field, value, stringValue(body[field]))
		}
	}
	if len(expected.Scope) > 0 {
		actualScope := stringSliceValue(body["scope"])
		if !reflect.DeepEqual(expected.Scope, actualScope) {
			return fmt.Errorf("microvm_controller_route scope: expected %+v, got %+v", expected.Scope, actualScope)
		}
	}
	if expected.ErrorCode != "" && microVMRouteErrorCode(body) != expected.ErrorCode {
		return fmt.Errorf("microvm_controller_route error_code: expected %q, got %q", expected.ErrorCode, microVMRouteErrorCode(body))
	}
	return nil
}

func compareMicroVMRouteRegistry(
	expected FixtureMicroVMControllerRoute,
	registry *runtimemicrovm.MemorySessionRegistry,
	_ map[string]any,
	setup FixtureMicroVMRouteSetup,
) error {
	if expected.RegistryTokenMetadataCount != nil {
		record, err := registry.Get(context.Background(), runtimemicrovm.SessionKey{
			TenantID:  setup.TenantID,
			Namespace: setup.Namespace,
			SessionID: setup.SessionID,
		})
		if err != nil {
			return fmt.Errorf("read microvm route registry record: %w", err)
		}
		if got := len(record.TokenMetadata); got != *expected.RegistryTokenMetadataCount {
			return fmt.Errorf("microvm_controller_route registry_token_metadata_count: expected %d, got %d", *expected.RegistryTokenMetadataCount, got)
		}
		raw, err := json.Marshal(record)
		if err != nil {
			return fmt.Errorf("marshal microvm route registry record: %w", err)
		}
		for _, forbidden := range expected.ForbiddenBodySubstrings {
			if forbidden != "" && strings.Contains(string(raw), forbidden) {
				return fmt.Errorf("microvm_controller_route registry record contains forbidden substring %q", forbidden)
			}
		}
	}
	return nil
}

func normalizeMicroVMRouteSetup(setup FixtureMicroVMRouteSetup) FixtureMicroVMRouteSetup {
	setup.TenantID = strings.TrimSpace(setup.TenantID)
	if setup.TenantID == "" {
		setup.TenantID = "tenant-1"
	}
	setup.Namespace = strings.TrimSpace(setup.Namespace)
	if setup.Namespace == "" {
		setup.Namespace = "namespace-1"
	}
	setup.SessionID = strings.TrimSpace(setup.SessionID)
	if setup.SessionID == "" {
		setup.SessionID = "fixture-session"
	}
	return setup
}

func microVMRouteFixtureRunRequest(setup FixtureMicroVMRouteSetup) runtimemicrovm.ControllerRequest {
	return runtimemicrovm.ControllerRequest{
		Command:             runtimemicrovm.CommandRun,
		RequestID:           "req-m16-route-seed",
		TenantID:            setup.TenantID,
		Namespace:           setup.Namespace,
		AuthContext:         runtimemicrovm.AuthContext{Subject: "subject-1", TenantID: setup.TenantID, Namespace: setup.Namespace},
		ImageRef:            "image-ref",
		ImageVersion:        "1",
		NetworkConnectorRef: "network-ref",
		SessionSpec:         runtimemicrovm.SessionSpec{Metadata: map[string]string{"safe": "ok"}},
	}
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return ""
	}
}

func stringSliceValue(value any) []string {
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if s := stringValue(value); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func microVMRouteErrorCode(body map[string]any) string {
	errBody, ok := body["error"].(map[string]any)
	if !ok {
		return ""
	}
	return stringValue(errBody["code"])
}

type microVMRouteFixtureClock struct{ now time.Time }

func (c microVMRouteFixtureClock) Now() time.Time {
	if c.now.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return c.now.UTC()
}

type microVMRouteFixtureIDs struct{ id string }

func (g microVMRouteFixtureIDs) NewID() string {
	if strings.TrimSpace(g.id) == "" {
		return "fixture-session"
	}
	return strings.TrimSpace(g.id)
}

type microVMRouteFixtureProvider struct {
	now      time.Time
	next     int64
	tokens   int64
	sessions map[runtimemicrovm.SessionKey]runtimemicrovm.ProviderSession
}

func newMicroVMRouteFixtureProvider(now time.Time) *microVMRouteFixtureProvider {
	return &microVMRouteFixtureProvider{
		now:      now.UTC(),
		sessions: map[runtimemicrovm.SessionKey]runtimemicrovm.ProviderSession{},
	}
}

func (p *microVMRouteFixtureProvider) Run(_ context.Context, input runtimemicrovm.ProviderRunInput) (runtimemicrovm.ProviderSession, error) {
	if err := runtimemicrovm.ValidateProviderRunInput(input); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.next++
	session := runtimemicrovm.ProviderSession{
		TenantID:          input.TenantID,
		Namespace:         input.Namespace,
		SessionID:         input.SessionID,
		ProviderMicroVMID: fmt.Sprintf("microvm-%06d", p.next),
		State:             runtimemicrovm.StateRunning,
		ProviderState:     "running",
		ImageRef:          input.ImageRef,
		ImageVersion:      input.ImageVersion,
		StartedAt:         p.now,
		RegistryVersion:   p.next,
	}
	if err := runtimemicrovm.ValidateProviderSession(session); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.sessions[session.Key()] = session
	return session, nil
}

func (p *microVMRouteFixtureProvider) Get(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.lookup(runtimemicrovm.OperationGet, input)
}

func (p *microVMRouteFixtureProvider) List(_ context.Context, input runtimemicrovm.ProviderListInput) (runtimemicrovm.ProviderListOutput, error) {
	if err := runtimemicrovm.ValidateProviderListInput(input); err != nil {
		return runtimemicrovm.ProviderListOutput{}, err
	}
	sessions := make([]runtimemicrovm.ProviderSession, 0, len(p.sessions))
	for _, session := range p.sessions {
		if session.TenantID != input.TenantID || session.Namespace != input.Namespace {
			continue
		}
		if input.ImageRef != "" && session.ImageRef != input.ImageRef {
			continue
		}
		if input.ImageVersion != "" && session.ImageVersion != input.ImageVersion {
			continue
		}
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].SessionID < sessions[j].SessionID })
	return runtimemicrovm.ProviderListOutput{Sessions: sessions}, nil
}

func (p *microVMRouteFixtureProvider) Suspend(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.transition(runtimemicrovm.OperationSuspend, input, "suspended")
}

func (p *microVMRouteFixtureProvider) Resume(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.transition(runtimemicrovm.OperationResume, input, "ready")
}

func (p *microVMRouteFixtureProvider) Terminate(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.transition(runtimemicrovm.OperationTerminate, input, "terminated")
}

func (p *microVMRouteFixtureProvider) CreateAuthToken(_ context.Context, input runtimemicrovm.ProviderTokenInput) (runtimemicrovm.ProviderToken, error) {
	return p.token(runtimemicrovm.OperationAuthToken, input)
}

func (p *microVMRouteFixtureProvider) CreateShellToken(_ context.Context, input runtimemicrovm.ProviderTokenInput) (runtimemicrovm.ProviderToken, error) {
	return p.token(runtimemicrovm.OperationShellAuthToken, input)
}

func (p *microVMRouteFixtureProvider) lookup(operation runtimemicrovm.Operation, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	if err := runtimemicrovm.ValidateProviderSessionInput(operation, input); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	session, ok := p.sessions[input.Binding.Key()]
	if !ok || session.ProviderMicroVMID != input.Binding.ProviderMicroVMID {
		return runtimemicrovm.ProviderSession{}, runtimemicrovm.SafeError{
			Code:      runtimemicrovm.ErrorCodeTenantBindingViolation,
			Message:   "apptheory: microvm provider binding is not available",
			RequestID: input.RequestID,
		}
	}
	return session, nil
}

func (p *microVMRouteFixtureProvider) transition(operation runtimemicrovm.Operation, input runtimemicrovm.ProviderSessionInput, providerState string) (runtimemicrovm.ProviderSession, error) {
	session, err := p.lookup(operation, input)
	if err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	state, terminal, err := runtimemicrovm.MapProviderState(providerState)
	if err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	session.ProviderState = providerState
	session.State = state
	session.Terminal = terminal
	session.RegistryVersion++
	if providerState == "terminated" {
		session.TerminatedAt = p.now
	}
	if err := runtimemicrovm.ValidateProviderSession(session); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.sessions[session.Key()] = session
	return session, nil
}

func (p *microVMRouteFixtureProvider) token(operation runtimemicrovm.Operation, input runtimemicrovm.ProviderTokenInput) (runtimemicrovm.ProviderToken, error) {
	if err := runtimemicrovm.ValidateProviderTokenInput(operation, input); err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	session, err := p.lookup(commandOperationInput(operation), runtimemicrovm.ProviderSessionInput{
		RequestID:   input.RequestID,
		TenantID:    input.TenantID,
		Namespace:   input.Namespace,
		AuthContext: input.AuthContext,
		Binding:     input.Binding,
	})
	if err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	p.tokens++
	tokenType := "auth"
	if operation == runtimemicrovm.OperationShellAuthToken {
		tokenType = "shell"
	}
	ttl := input.TTLSeconds
	if ttl <= 0 {
		ttl = 900
	}
	token := runtimemicrovm.ProviderToken{
		TenantID:          session.TenantID,
		Namespace:         session.Namespace,
		SessionID:         session.SessionID,
		ProviderMicroVMID: session.ProviderMicroVMID,
		TokenID:           fmt.Sprintf("%s-%06d", tokenType, p.tokens),
		TokenType:         tokenType,
		ExpiresAt:         p.now.Add(time.Duration(ttl) * time.Second).UTC(),
		Scope:             microVMRouteTokenScope(operation, input.AllowedPortScope),
	}
	if err := runtimemicrovm.ValidateProviderToken(token); err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	return token, nil
}

func commandOperationInput(operation runtimemicrovm.Operation) runtimemicrovm.Operation {
	if operation == runtimemicrovm.OperationAuthToken || operation == runtimemicrovm.OperationShellAuthToken {
		return runtimemicrovm.OperationGet
	}
	return operation
}

func microVMRouteTokenScope(operation runtimemicrovm.Operation, scopes []runtimemicrovm.ProviderPortScope) []string {
	if operation == runtimemicrovm.OperationShellAuthToken {
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
