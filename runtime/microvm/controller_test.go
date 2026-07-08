package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestDefaultControllerAndRegistryContractsValidate(t *testing.T) {
	require.NoError(t, ValidateControllerContract(DefaultControllerContract()))
	require.NoError(t, ValidateSessionRegistryContract(DefaultSessionRegistryContract()))
	require.NoError(t, ValidateEscapeHatches(EscapeHatches{}))
	require.EqualError(t, ValidateEscapeHatches(EscapeHatches{RawAWSSDK: true}), "apptheory: microvm contract forbids raw AWS SDK escape hatch")
}

func TestControllerRequiresAuthenticatedDeny(t *testing.T) {
	controller, err := NewController(&stubClient{})
	require.NoError(t, err)

	result, err := controller.Handle(context.Background(), ControllerRequest{
		Command:             CommandCreate,
		RequestID:           "req-1",
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		ImageRef:            "image-ref",
		NetworkConnectorRef: "network-ref",
	})

	require.Error(t, err)
	require.NotNil(t, result.Error)
	require.Equal(t, ErrorCodeUnauthenticatedController, result.Error.Code)
}

func TestControllerCreateAndStart(t *testing.T) {
	now := time.Unix(123, 0).UTC()
	client := &stubClient{}
	controller, err := NewController(
		client,
		WithControllerID("controller-1"),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-1"}),
	)
	require.NoError(t, err)

	create, err := controller.Handle(context.Background(), validControllerRequest(CommandCreate, "req-create", ""))
	require.NoError(t, err)
	require.Equal(t, "session-1", create.SessionID)
	require.Equal(t, StateRequested, create.State)
	require.Equal(t, int64(1), create.RegistryVersion)

	startReq := validControllerRequest(CommandStart, "req-start", create.SessionID)
	start, err := controller.Handle(context.Background(), startReq)
	require.NoError(t, err)
	require.Equal(t, StateStarting, start.State)
	require.Equal(t, StateStarted, start.DesiredState)
	require.Equal(t, CommandStart, client.lastCommand)
}

func TestControllerSanitizesClientErrors(t *testing.T) {
	controller, err := NewController(&stubClient{err: errors.New("raw bearer_token provider error")})
	require.NoError(t, err)

	result, err := controller.Handle(context.Background(), validControllerRequest(CommandCreate, "req-1", ""))

	require.Error(t, err)
	require.NotContains(t, err.Error(), "bearer_token")
	require.NotNil(t, result.Error)
	require.Equal(t, ErrorCodeControllerCommandFailed, result.Error.Code)
}

func TestControllerRejectsForbiddenSessionSpec(t *testing.T) {
	controller, err := NewController(&stubClient{})
	require.NoError(t, err)
	req := validControllerRequest(CommandCreate, "req-1", "")
	req.SessionSpec.Metadata = map[string]string{"raw_lifecycle_hook_payload": "payload"}

	result, err := controller.Handle(context.Background(), req)

	require.Error(t, err)
	require.NotNil(t, result.Error)
	require.Equal(t, ErrorCodeForbiddenField, result.Error.Code)
}

type fixedControllerClock struct{ now time.Time }

func (c fixedControllerClock) Now() time.Time { return c.now }

type fixedControllerIDs struct{ id string }

func (g fixedControllerIDs) NewID() string { return g.id }

type stubClient struct {
	err         error
	lastCommand Command
	record      SessionRecord
}

func (c *stubClient) Create(_ context.Context, input CreateSessionInput) (SessionRecord, error) {
	c.lastCommand = CommandCreate
	if c.err != nil {
		return SessionRecord{}, c.err
	}
	record := SessionRecord{
		TenantID:            input.TenantID,
		Namespace:           input.Namespace,
		SessionID:           input.SessionID,
		State:               StateRequested,
		DesiredState:        StateRequested,
		ProviderID:          DefaultSessionProviderID,
		ProviderMicroVMID:   input.SessionID,
		ProviderState:       string(StateRequested),
		AWSLifecycleState:   string(StateRequested),
		ImageRef:            input.ImageRef,
		NetworkConnectorRef: input.NetworkConnectorRef,
		ControllerID:        input.ControllerID,
		CreatedAt:           input.Now,
		UpdatedAt:           input.Now,
		LastObservedAt:      input.Now,
		ExpiresAt:           input.Now.Add(time.Hour),
		Generation:          1,
		LastAction:          CommandCreate,
		LastCommandID:       input.RequestID,
		AuthSubject:         input.AuthSubject,
		Metadata:            input.SessionSpec.Metadata,
	}
	c.record = record
	return record, nil
}

func (c *stubClient) Start(_ context.Context, input SessionCommandInput) (SessionRecord, error) {
	c.lastCommand = CommandStart
	if c.err != nil {
		return SessionRecord{}, c.err
	}
	record := c.record
	record.State = StateStarting
	record.DesiredState = input.DesiredState
	record.ProviderID = DefaultSessionProviderID
	record.ProviderMicroVMID = record.SessionID
	record.ProviderState = string(StateStarting)
	record.AWSLifecycleState = string(StateStarting)
	record.UpdatedAt = input.Now
	record.LastObservedAt = input.Now
	record.Generation++
	record.LastAction = CommandStart
	record.LastCommandID = input.RequestID
	record.AuthSubject = input.AuthSubject
	c.record = record
	return record, nil
}

func (c *stubClient) Stop(_ context.Context, input SessionCommandInput) (SessionRecord, error) {
	c.lastCommand = CommandStop
	if c.err != nil {
		return SessionRecord{}, c.err
	}
	record := c.record
	record.State = StateStopping
	record.DesiredState = input.DesiredState
	record.ProviderID = DefaultSessionProviderID
	record.ProviderMicroVMID = record.SessionID
	record.ProviderState = string(StateStopping)
	record.AWSLifecycleState = string(StateStopping)
	record.UpdatedAt = input.Now
	record.LastObservedAt = input.Now
	record.Generation++
	record.LastAction = CommandStop
	record.LastCommandID = input.RequestID
	record.AuthSubject = input.AuthSubject
	c.record = record
	return record, nil
}

func (c stubClient) Status(context.Context, SessionQueryInput) (SessionStatus, error) {
	if c.err != nil {
		return SessionStatus{}, c.err
	}
	return SessionStatus{
		TenantID:        c.record.TenantID,
		Namespace:       c.record.Namespace,
		SessionID:       c.record.SessionID,
		State:           c.record.State,
		DesiredState:    c.record.DesiredState,
		LifecycleState:  c.record.State,
		Endpoint:        c.record.Endpoint,
		MicroVMID:       c.record.MicroVMID,
		LastAction:      c.record.LastAction,
		LastTransition:  c.record.UpdatedAt,
		RegistryVersion: c.record.Generation,
	}, nil
}

func (c stubClient) Session(context.Context, SessionQueryInput) (SessionRecord, error) {
	if c.err != nil {
		return SessionRecord{}, c.err
	}
	return c.record, nil
}

func validControllerRequest(command Command, requestID string, sessionID string) ControllerRequest {
	req := ControllerRequest{
		Command:   command,
		RequestID: requestID,
		TenantID:  "tenant-1",
		Namespace: "namespace-1",
		AuthContext: AuthContext{
			Subject:  "subject-1",
			TenantID: "tenant-1",
		},
		SessionID: sessionID,
	}
	if command == CommandCreate {
		req.ImageRef = "image-ref"
		req.NetworkConnectorRef = "network-ref"
	}
	return req
}

func TestControllerStatusSessionAndStop(t *testing.T) {
	now := time.Unix(456, 0).UTC()
	client := &stubClient{}
	controller, err := NewController(
		client,
		WithControllerID("controller-1"),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-1"}),
	)
	require.NoError(t, err)

	create, err := controller.Handle(context.Background(), validControllerRequest(CommandCreate, "req-create", ""))
	require.NoError(t, err)
	_, err = controller.Handle(context.Background(), validControllerRequest(CommandStart, "req-start", create.SessionID))
	require.NoError(t, err)

	status, err := controller.Handle(context.Background(), validControllerRequest(CommandStatus, "req-status", create.SessionID))
	require.NoError(t, err)
	require.Equal(t, StateStarting, status.LifecycleState)
	require.Equal(t, int64(2), status.RegistryVersion)

	session, err := controller.Handle(context.Background(), validControllerRequest(CommandSession, "req-session", create.SessionID))
	require.NoError(t, err)
	require.Equal(t, "tenant-1", session.TenantID)

	stop, err := controller.Handle(context.Background(), validControllerRequest(CommandStop, "req-stop", create.SessionID))
	require.NoError(t, err)
	require.Equal(t, StateStopped, stop.DesiredState)
}

func TestControllerOptionsAndInvalidRequests(t *testing.T) {
	_, err := NewController(nil)
	require.Error(t, err)

	controller, err := NewController(&stubClient{}, WithControllerID(" "), WithControllerClock(nil), WithControllerIDGenerator(nil))
	require.NoError(t, err)

	cases := []ControllerRequest{
		{},
		func() ControllerRequest {
			req := validControllerRequest(CommandCreate, "req-1", "")
			req.AuthContext.TenantID = "other"
			return req
		}(),
		func() ControllerRequest {
			req := validControllerRequest(CommandCreate, "req-1", "")
			req.AuthContext.Namespace = "other"
			return req
		}(),
		func() ControllerRequest {
			req := validControllerRequest(Command("unknown"), "req-1", "")
			return req
		}(),
		validControllerRequest(CommandStart, "req-1", ""),
		func() ControllerRequest {
			req := validControllerRequest(CommandCreate, "req-1", "")
			req.ImageRef = ""
			return req
		}(),
	}
	for _, req := range cases {
		result, err := controller.Handle(context.Background(), req)
		require.Error(t, err)
		require.NotNil(t, result.Error)
	}
}

func TestControllerContractValidationFailures(t *testing.T) {
	contract := DefaultControllerContract()
	contract.Auth.Required = false
	require.Error(t, ValidateControllerContract(contract))

	contract = DefaultControllerContract()
	contract.Envelope.RequiredFields = nil
	require.Error(t, ValidateControllerContract(contract))

	contract = DefaultControllerContract()
	contract.Envelope.SafeErrorFields = nil
	require.Error(t, ValidateControllerContract(contract))

	contract = DefaultControllerContract()
	contract.Envelope.ForbiddenFields = nil
	require.Error(t, ValidateControllerContract(contract))

	contract = DefaultControllerContract()
	contract.Commands[0].Path = ""
	require.Error(t, ValidateControllerContract(contract))

	contract = DefaultControllerContract()
	contract.Commands[0].RequestFields = nil
	require.Error(t, ValidateControllerContract(contract))

	contract = DefaultControllerContract()
	contract.Commands = contract.Commands[:1]
	require.Error(t, ValidateControllerContract(contract))
}

func TestSessionRegistryValidationFailures(t *testing.T) {
	registry := DefaultSessionRegistryContract()
	registry.Pattern = "raw-table"
	require.Error(t, ValidateSessionRegistryContract(registry))

	registry = DefaultSessionRegistryContract()
	registry.TenantBinding = []string{"tenant_id"}
	require.Error(t, ValidateSessionRegistryContract(registry))

	registry = DefaultSessionRegistryContract()
	registry.RequiredFields = []string{"tenant_id"}
	require.Error(t, ValidateSessionRegistryContract(registry))

	registry = DefaultSessionRegistryContract()
	registry.StateValues = []string{"requested"}
	require.Error(t, ValidateSessionRegistryContract(registry))

	registry = DefaultSessionRegistryContract()
	registry.ForbiddenFields = []string{"bearer_token"}
	require.Error(t, ValidateSessionRegistryContract(registry))
}

func TestSessionValidationAndKeys(t *testing.T) {
	now := time.Unix(1, 0).UTC()
	record := SessionRecord{
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		SessionID:           "session-1",
		State:               StateRequested,
		DesiredState:        StateRequested,
		ProviderID:          DefaultSessionProviderID,
		ProviderMicroVMID:   "session-1",
		ProviderState:       string(StateRequested),
		AWSLifecycleState:   string(StateRequested),
		ImageRef:            "image-ref",
		NetworkConnectorRef: "network-ref",
		ControllerID:        "controller-1",
		CreatedAt:           now,
		UpdatedAt:           now,
		LastObservedAt:      now,
		ExpiresAt:           now.Add(time.Hour),
		Generation:          1,
		LastAction:          CommandCreate,
		LastCommandID:       "req-1",
		AuthSubject:         "subject-1",
	}
	require.NoError(t, ValidateSessionRecord(record))
	require.Equal(t, SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}, record.Key())

	bad := record
	bad.TenantID = ""
	require.Error(t, ValidateSessionRecord(bad))

	bad = record
	bad.CreatedAt = time.Time{}
	require.Error(t, ValidateSessionRecord(bad))

	bad = record
	bad.State = LifecycleState("unknown")
	require.Error(t, ValidateSessionRecord(bad))

	bad = record
	bad.Metadata = map[string]string{"bearer_token": "redacted"}
	require.Error(t, ValidateSessionRecord(bad))

	status := SessionStatus{
		TenantID:        "tenant-1",
		Namespace:       "namespace-1",
		SessionID:       "session-1",
		State:           StateStarting,
		DesiredState:    StateStarted,
		LifecycleState:  StateStarting,
		LastAction:      CommandStart,
		LastTransition:  now,
		RegistryVersion: 2,
	}
	require.NoError(t, ValidateSessionStatus(status))
	require.Equal(t, record.Key(), status.Key())

	status.LifecycleState = LifecycleState("unknown")
	require.Error(t, ValidateSessionStatus(status))
	status.LifecycleState = StateStarting
	status.LastTransition = time.Time{}
	require.Error(t, ValidateSessionStatus(status))
}

func TestRealControllerCommandsAndTokenSafety(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	registry := NewMemorySessionRegistry()
	provider := newRealControllerProvider(now)
	controller, err := NewRealController(
		provider,
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-1"}),
	)
	require.NoError(t, err)

	run, err := controller.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-run", ""))
	require.NoError(t, err)
	require.Equal(t, CommandRun, run.Command)
	require.Equal(t, StateRunning, run.State)
	require.Equal(t, "microvm-000001", run.ProviderMicroVMID)

	get, err := controller.Handle(context.Background(), validRealControllerRequest(CommandGet, "req-get", run.SessionID))
	require.NoError(t, err)
	require.Equal(t, CommandGet, get.Command)

	suspend, err := controller.Handle(context.Background(), validRealControllerRequest(CommandSuspend, "req-suspend", run.SessionID))
	require.NoError(t, err)
	require.Equal(t, StateSuspended, suspend.State)

	resume, err := controller.Handle(context.Background(), validRealControllerRequest(CommandResume, "req-resume", run.SessionID))
	require.NoError(t, err)
	require.Equal(t, StateReady, resume.State)

	list, err := controller.Handle(context.Background(), validRealControllerRequest(CommandList, "req-list", ""))
	require.NoError(t, err)
	require.Len(t, list.Sessions, 1)
	require.Equal(t, run.SessionID, list.Sessions[0].SessionID)

	tokenReq := validRealControllerRequest(CommandAuthToken, "req-token", run.SessionID)
	tokenReq.AllowedPortScope = []ProviderPortScope{{Port: 443}}
	token, err := controller.Handle(context.Background(), tokenReq)
	require.NoError(t, err)
	require.Equal(t, "auth", token.TokenType)
	require.NotContains(t, token.TokenID, "token_value")

	shellReq := validRealControllerRequest(CommandLegacyShellToken, "req-shell", run.SessionID)
	shell, err := controller.Handle(context.Background(), shellReq)
	require.NoError(t, err)
	require.Equal(t, CommandShellAuthToken, shell.Command)
	require.Equal(t, "shell", shell.TokenType)

	record, err := registry.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: run.SessionID})
	require.NoError(t, err)
	require.Len(t, record.TokenMetadata, 2)
	raw, err := json.Marshal(record)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "token_value")
	require.NotContains(t, string(raw), "bearer_token")
	require.NotContains(t, string(raw), "x-aws-proxy-auth")

	terminated, err := controller.Handle(context.Background(), validRealControllerRequest(CommandTerminate, "req-term", run.SessionID))
	require.NoError(t, err)
	require.Equal(t, StateTerminated, terminated.State)
}

func TestRealControllerInvokeAndRoutesProxyWorkload(t *testing.T) {
	now := time.Unix(1250, 0).UTC()
	registry := NewMemorySessionRegistry()
	provider := newRealControllerProvider(now)
	controller, err := NewRealController(
		provider,
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-invoke"}),
	)
	require.NoError(t, err)

	run, err := controller.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-invoke-run", ""))
	require.NoError(t, err)
	output, err := controller.Invoke(context.Background(), ControllerInvokeRequest{
		RequestID:   "req-direct-invoke",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: AuthContext{Subject: "subject-1", TenantID: "tenant-1", Namespace: "namespace-1"},
		SessionID:   run.SessionID,
		Method:      "get",
		Path:        "direct",
		Headers:     map[string][]string{"Authorization": {"Bearer caller"}, "X-Workload": {" yes "}},
		Port:        8081,
		TTLSeconds:  30,
	})
	require.NoError(t, err)
	require.Equal(t, 200, output.Status)
	require.Contains(t, string(output.Body), `"path":"/direct"`)
	require.Equal(t, int32(8081), provider.lastInvokeInput.Port)
	require.Equal(t, int32(30), provider.lastInvokeInput.TTLSeconds)
	require.NotContains(t, provider.lastInvokeInput.Headers, "authorization")
	require.Equal(t, []string{"yes"}, provider.lastInvokeInput.Headers["x-workload"])

	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(fixedControllerClock{now: now}),
		apptheory.WithIDGenerator(fixedControllerIDs{id: "req-route-invoke"}),
		apptheory.WithAuthHook(func(*apptheory.Context) (string, error) {
			return "subject-1", nil
		}),
	)
	_, err = RegisterControllerRoutes(app, controller)
	require.NoError(t, err)

	resp := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms/session-invoke/invoke/hello",
		Query:  map[string][]string{"namespace": {"namespace-1"}, "tenant_id": {"tenant-1"}, "name": {"apptheory"}},
		Headers: map[string][]string{
			"authorization":                 {"Bearer caller"},
			"x-aws-proxy-auth":              {"caller-token"},
			"x-tenant-id":                   {"tenant-1"},
			"x-namespace-id":                {"namespace-1"},
			"x-request-id":                  {"req-http-invoke"},
			"x-apptheory-microvm-port":      {"9090"},
			"x-apptheory-microvm-token-ttl": {"45"},
			"x-workload":                    {" route "},
			"content-type":                  {"application/json"},
		},
		Body: []byte(`{"ok":true}`),
	})
	require.Equal(t, 200, resp.Status)
	require.Contains(t, string(resp.Body), `"path":"/hello"`)
	require.Equal(t, "/hello", provider.lastInvokeInput.Path)
	require.Equal(t, map[string][]string{"name": {"apptheory"}}, provider.lastInvokeInput.Query)
	require.Equal(t, int32(9090), provider.lastInvokeInput.Port)
	require.Equal(t, int32(45), provider.lastInvokeInput.TTLSeconds)
	require.NotContains(t, provider.lastInvokeInput.Headers, "authorization")
	require.NotContains(t, provider.lastInvokeInput.Headers, "x-aws-proxy-auth")
	require.NotContains(t, provider.lastInvokeInput.Headers, "x-tenant-id")
	require.Equal(t, []string{"route"}, provider.lastInvokeInput.Headers["x-workload"])

	root := app.Serve(context.Background(), apptheory.Request{
		Method: "GET",
		Path:   "/microvms/session-invoke/invoke",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-http-invoke-root"},
		},
	})
	require.Equal(t, 200, root.Status)
	require.Contains(t, string(root.Body), `"path":"/"`)

	mismatch := app.Serve(context.Background(), apptheory.Request{
		Method: "GET",
		Path:   "/microvms/session-invoke/invoke/hello",
		Query:  map[string][]string{"tenant_id": {"tenant-2"}},
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-http-invoke-mismatch"},
		},
	})
	require.Equal(t, 403, mismatch.Status)
	require.Contains(t, string(mismatch.Body), ErrorCodeTenantBindingViolation)
}

func TestRealControllerCarriesExecutionRoleFromEnvironment(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	t.Setenv(EnvExecutionRoleArn, "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole")
	provider := newRealControllerProvider(now)
	controller, err := NewRealController(
		provider,
		NewMemorySessionRegistry(),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-role"}),
	)
	require.NoError(t, err)

	run, err := controller.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-role", ""))
	require.NoError(t, err)
	require.Nil(t, run.Error)
	require.Equal(t, "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole", provider.lastRunExecutionRoleArn)
}

func TestRealControllerAppliesDeploymentPinnedDefaults(t *testing.T) {
	now := time.Unix(1500, 0).UTC()
	t.Setenv(EnvImageRef, "env-image-ref")
	t.Setenv(EnvIngressNetworkConnectorRefs, "ingress-ref,shell-ingress-ref")
	t.Setenv(EnvEgressNetworkConnectorRefs, "egress-ref")
	provider := newRealControllerProvider(now)
	controller, err := NewRealController(
		provider,
		NewMemorySessionRegistry(),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-defaults"}),
	)
	require.NoError(t, err)

	request := validRealControllerRequest(CommandRun, "req-defaults", "")
	request.ImageRef = ""
	request.NetworkConnectorRef = ""
	request.IngressNetworkConnectorRefs = nil
	request.EgressNetworkConnectorRefs = nil
	run, err := controller.Handle(context.Background(), request)
	require.NoError(t, err)
	require.Nil(t, run.Error)
	require.Equal(t, "env-image-ref", provider.lastRunInput.ImageRef)
	require.Equal(t, "egress-ref", provider.lastRunInput.NetworkConnectorRef)
	require.Equal(t, []string{"ingress-ref", "shell-ingress-ref"}, provider.lastRunInput.IngressNetworkConnectorRefs)
	require.Equal(t, []string{"egress-ref"}, provider.lastRunInput.EgressNetworkConnectorRefs)

	override := validRealControllerRequest(CommandRun, "req-defaults-override", "")
	override.ImageRef = "other-image-ref"
	override.NetworkConnectorRef = "egress-ref"
	rejected, err := controller.Handle(context.Background(), override)
	require.Error(t, err)
	require.NotNil(t, rejected.Error)
	require.Equal(t, ErrorCodeInvalidControllerRequest, rejected.Error.Code)
}

func TestRealControllerRoutesEnforceAuthAndBindings(t *testing.T) {
	now := time.Unix(2000, 0).UTC()
	registry := NewMemorySessionRegistry()
	provider := newRealControllerProvider(now)
	controller, err := NewRealController(
		provider,
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-route"}),
	)
	require.NoError(t, err)
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(fixedControllerClock{now: now}),
		apptheory.WithIDGenerator(fixedControllerIDs{id: "req-route"}),
		apptheory.WithAuthHook(func(*apptheory.Context) (string, error) {
			return "subject-1", nil
		}),
	)
	_, err = RegisterControllerRoutes(app, controller)
	require.NoError(t, err)

	runResp := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-http-run"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`{"tenant_id":"tenant-1","namespace":"namespace-1","image_ref":"image-ref","network_connector_ref":"network-ref"}`),
	})
	require.Equal(t, 200, runResp.Status)
	var run ControllerResponse
	require.NoError(t, json.Unmarshal(runResp.Body, &run))
	require.Equal(t, CommandRun, run.Command)
	require.Equal(t, "session-route", run.SessionID)

	tokenResp := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms/session-route/auth-token",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-http-token"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`{"allowed_port_scope":[{"port":443}]}`),
	})
	require.Equal(t, 200, tokenResp.Status)
	require.NotContains(t, string(tokenResp.Body), "token_value")
	require.NotContains(t, string(tokenResp.Body), "bearer_token")

	crossTenant := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-http-cross"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`{"tenant_id":"tenant-2","namespace":"namespace-1","image_ref":"image-ref","network_connector_ref":"network-ref"}`),
	})
	require.Equal(t, 403, crossTenant.Status)
	require.Contains(t, string(crossTenant.Body), ErrorCodeTenantBindingViolation)
}

func TestRealControllerOptionsAndFailureBranches(t *testing.T) {
	now := time.Unix(3000, 0).UTC()
	registry := NewMemorySessionRegistry()
	provider := newRealControllerProvider(now)

	_, err := NewRealController(nil, registry)
	require.Error(t, err)
	_, err = NewRealController(provider, nil)
	require.Error(t, err)

	controller, err := NewRealController(
		provider,
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-options"}),
		WithControllerProviderID("custom-provider"),
		WithControllerSessionTTL(2*time.Hour),
	)
	require.NoError(t, err)

	run, err := controller.Handle(context.TODO(), validRealControllerRequest(CommandRun, "req-options-run", ""))
	require.NoError(t, err)
	record, err := registry.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: run.SessionID})
	require.NoError(t, err)
	require.Equal(t, "custom-provider", record.ProviderID)
	require.Equal(t, now.Add(2*time.Hour), record.ExpiresAt)

	var nilController *Controller
	nilResult, err := nilController.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-nil-controller", ""))
	require.Error(t, err)
	require.Equal(t, ErrorCodeControllerIncomplete, nilResult.Error.Code)

	cases := []struct {
		name string
		req  ControllerRequest
		code string
	}{
		{"empty envelope", ControllerRequest{}, ErrorCodeInvalidControllerRequest},
		{"missing auth", func() ControllerRequest {
			req := validRealControllerRequest(CommandRun, "req-missing-auth", "")
			req.AuthContext = AuthContext{}
			return req
		}(), ErrorCodeUnauthenticatedController},
		{"tenant mismatch", func() ControllerRequest {
			req := validRealControllerRequest(CommandRun, "req-tenant-mismatch", "")
			req.AuthContext.TenantID = "tenant-2"
			return req
		}(), ErrorCodeUnauthenticatedController},
		{"namespace mismatch", func() ControllerRequest {
			req := validRealControllerRequest(CommandRun, "req-namespace-mismatch", "")
			req.AuthContext.Namespace = "namespace-2"
			return req
		}(), ErrorCodeUnauthenticatedController},
		{"unsafe field", func() ControllerRequest {
			req := validRealControllerRequest(CommandRun, "req-unsafe-field", "")
			req.ImageRef = "bearer_token"
			return req
		}(), ErrorCodeForbiddenField},
		{"run missing image", func() ControllerRequest {
			req := validRealControllerRequest(CommandRun, "req-missing-image", "")
			req.ImageRef = ""
			return req
		}(), ErrorCodeInvalidControllerRequest},
		{"session missing id", validRealControllerRequest(CommandGet, "req-missing-session", ""), ErrorCodeInvalidControllerRequest},
		{"unknown command", validRealControllerRequest(Command("unknown"), "req-unknown", ""), ErrorCodeInvalidControllerRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := controller.Handle(context.Background(), tc.req)
			require.Error(t, err)
			require.NotNil(t, result.Error)
			require.Equal(t, tc.code, result.Error.Code)
		})
	}
}

func TestRealControllerListRequiresTenantBoundRegistryLister(t *testing.T) {
	now := time.Unix(4000, 0).UTC()
	controller, err := NewRealController(newRealControllerProvider(now), noListSessionRegistry{})
	require.NoError(t, err)

	result, err := controller.Handle(context.Background(), validRealControllerRequest(CommandList, "req-list-no-lister", ""))
	require.Error(t, err)
	require.NotNil(t, result.Error)
	require.Equal(t, ErrorCodeSessionRegistryIncomplete, result.Error.Code)

	wrapped, err := NewReconstructingSessionRegistry(noListSessionRegistry{}, func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
		return SessionRecord{}, nil
	})
	require.NoError(t, err)
	_, err = wrapped.List(context.Background(), SessionListInput{RequestID: "req-wrapped-list", TenantID: "tenant-1", Namespace: "namespace-1"})
	require.Error(t, err)

	var nilWrapped *ReconstructingSessionRegistry
	_, err = nilWrapped.List(context.Background(), SessionListInput{RequestID: "req-nil-list", TenantID: "tenant-1", Namespace: "namespace-1"})
	require.Error(t, err)
}

func TestMemorySessionRegistryListIsTenantBoundAndSorted(t *testing.T) {
	now := time.Unix(5000, 0).UTC()
	var nilRegistry *MemorySessionRegistry
	_, err := nilRegistry.List(context.Background(), SessionListInput{RequestID: "req-nil-list", TenantID: "tenant-1", Namespace: "namespace-1"})
	require.Error(t, err)

	registry := NewMemorySessionRegistry()
	_, err = registry.List(context.Background(), SessionListInput{RequestID: "req-incomplete-list", TenantID: "tenant-1"})
	require.Error(t, err)

	for _, record := range []SessionRecord{
		realSessionRecord("tenant-1", "namespace-1", "session-b", now),
		realSessionRecord("tenant-1", "namespace-1", "session-a", now),
		realSessionRecord("tenant-2", "namespace-1", "session-c", now),
	} {
		_, err = registry.Put(context.Background(), record)
		require.NoError(t, err)
	}

	records, err := registry.List(context.Background(), SessionListInput{TenantID: "tenant-1", Namespace: "namespace-1"})
	require.NoError(t, err)
	require.Equal(t, []string{"session-a", "session-b"}, []string{records[0].SessionID, records[1].SessionID})
}

func TestRealControllerRoutesCoverCanonicalAliasesAndSafeStatuses(t *testing.T) {
	now := time.Unix(6000, 0).UTC()
	registry := NewMemorySessionRegistry()
	controller, err := NewRealController(
		newRealControllerProvider(now),
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-route-alias"}),
	)
	require.NoError(t, err)

	_, err = RegisterMicroVMControllerRoutes(nil, controller)
	require.Error(t, err)
	_, err = RegisterMicroVMControllerRoutes(apptheory.New(), nil)
	require.Error(t, err)

	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(fixedControllerClock{now: now}),
		apptheory.WithIDGenerator(fixedControllerIDs{id: "req-route-alias"}),
		apptheory.WithAuthHook(func(*apptheory.Context) (string, error) {
			return "subject-1", nil
		}),
	)
	_, err = RegisterControllerRoutes(app, controller)
	require.NoError(t, err)

	malformed := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-malformed"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`not-json`),
	})
	require.Equal(t, 400, malformed.Status)

	sessionMismatch := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms/session-route-alias/auth-token",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-session-mismatch"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`{"session_id":"other-session"}`),
	})
	require.Equal(t, 403, sessionMismatch.Status)

	queryTenantMismatch := app.Serve(context.Background(), apptheory.Request{
		Method: "GET",
		Path:   "/microvms",
		Query:  map[string][]string{"tenant_id": {"tenant-2"}},
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-query-mismatch"},
		},
	})
	require.Equal(t, 403, queryTenantMismatch.Status)

	runResp := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-route-alias-run"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`{"image_ref":"image-ref","network_connector_ref":"network-ref"}`),
	})
	require.Equal(t, 200, runResp.Status)

	shellAlias := app.Serve(context.Background(), apptheory.Request{
		Method: "POST",
		Path:   "/microvms/session-route-alias/shell-token",
		Headers: map[string][]string{
			"x-tenant-id":    {"tenant-1"},
			"x-namespace-id": {"namespace-1"},
			"x-request-id":   {"req-shell-alias"},
			"content-type":   {"application/json"},
		},
		Body: []byte(`{"ttl_seconds":60}`),
	})
	require.Equal(t, 200, shellAlias.Status)
	require.Contains(t, string(shellAlias.Body), string(CommandShellAuthToken))
	require.NotContains(t, string(shellAlias.Body), "token_value")

	statusCases := map[string]int{
		"":                                 200,
		ErrorCodeUnauthenticatedController: 401,
		ErrorCodeTenantBindingViolation:    403,
		ErrorCodeSessionRegistryIncomplete: 404,
		ErrorCodeControllerIncomplete:      500,
		ErrorCodeControllerCommandFailed:   502,
		ErrorCodeProviderOperationFailed:   502,
		ErrorCodeInvalidControllerRequest:  400,
	}
	for code, want := range statusCases {
		var safe *SafeError
		if code != "" {
			safe = &SafeError{Code: code, Message: "safe", RequestID: "req-status"}
		}
		require.Equal(t, want, controllerHTTPStatus(safe))
	}
}

func TestLegacyControllerErrorBranchesAndRegistryListFailures(t *testing.T) {
	now := time.Unix(7000, 0).UTC()
	controller, err := NewController(
		&stubClient{},
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{}),
	)
	require.NoError(t, err)
	result, err := controller.Handle(context.Background(), validControllerRequest(CommandCreate, "req-empty-id", ""))
	require.Error(t, err)
	require.Equal(t, ErrorCodeInvalidControllerRequest, result.Error.Code)

	record := realSessionRecord("tenant-1", "namespace-1", "session-legacy", now)
	record.LastAction = CommandCreate
	client := &stubClient{err: errors.New("raw x-aws-proxy-auth failure"), record: record}
	controller, err = NewController(client, WithControllerClock(fixedControllerClock{now: now}))
	require.NoError(t, err)
	for _, command := range []Command{CommandStart, CommandStop, CommandStatus, CommandSession} {
		result, handleErr := controller.Handle(context.Background(), validControllerRequest(command, "req-"+string(command), "session-legacy"))
		err = handleErr
		require.Error(t, err)
		require.NotNil(t, result.Error)
		require.Equal(t, ErrorCodeControllerCommandFailed, result.Error.Code)
		require.NotContains(t, result.Error.Message, "x-aws-proxy-auth")
	}

	var tableRegistry *TableTheorySessionRegistry
	_, err = tableRegistry.List(context.TODO(), SessionListInput{RequestID: "req-table-nil", TenantID: "tenant-1", Namespace: "namespace-1"})
	require.Error(t, err)
	tableRegistry = &TableTheorySessionRegistry{}
	_, err = tableRegistry.List(context.TODO(), SessionListInput{RequestID: "req-table-empty", TenantID: "tenant-1"})
	require.Error(t, err)
	_, err = tableRegistry.List(context.TODO(), SessionListInput{RequestID: "req-table-db", TenantID: "tenant-1", Namespace: "namespace-1"})
	require.Error(t, err)
}

func TestRealControllerProviderFailureBranches(t *testing.T) {
	now := time.Unix(8000, 0).UTC()

	emptyIDController, err := NewRealController(
		newRealControllerProvider(now),
		NewMemorySessionRegistry(),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{}),
	)
	require.NoError(t, err)
	result, err := emptyIDController.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-real-empty-id", ""))
	require.Error(t, err)
	require.Equal(t, ErrorCodeInvalidControllerRequest, result.Error.Code)

	runErrController, err := NewRealController(
		errorRunProvider{realControllerProvider: newRealControllerProvider(now)},
		NewMemorySessionRegistry(),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-run-err"}),
	)
	require.NoError(t, err)
	result, err = runErrController.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-real-run-err", ""))
	require.Error(t, err)
	require.NotNil(t, result.Error)
	require.NotContains(t, result.Error.Message, "bearer_token")

	invalidRunController, err := NewRealController(
		invalidRunProvider{realControllerProvider: newRealControllerProvider(now)},
		NewMemorySessionRegistry(),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-invalid-run"}),
	)
	require.NoError(t, err)
	result, err = invalidRunController.Handle(context.Background(), validRealControllerRequest(CommandRun, "req-real-invalid-run", ""))
	require.Error(t, err)
	require.NotNil(t, result.Error)

	registry := NewMemorySessionRegistry()
	_, err = registry.Put(context.Background(), realSessionRecord("tenant-1", "namespace-1", "session-provider-err", now))
	require.NoError(t, err)
	sessionErrController, err := NewRealController(
		errorGetProvider{realControllerProvider: newRealControllerProvider(now)},
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
	)
	require.NoError(t, err)
	result, err = sessionErrController.Handle(context.Background(), validRealControllerRequest(CommandGet, "req-real-get-err", "session-provider-err"))
	require.Error(t, err)
	require.NotNil(t, result.Error)

	listErrController, err := NewRealController(
		errorListProvider{realControllerProvider: newRealControllerProvider(now)},
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
	)
	require.NoError(t, err)
	result, err = listErrController.Handle(context.Background(), validRealControllerRequest(CommandList, "req-real-list-err", ""))
	require.Error(t, err)
	require.NotNil(t, result.Error)

	tokenErrController, err := NewRealController(
		invalidTokenProvider{realControllerProvider: newRealControllerProvider(now)},
		registry,
		WithControllerClock(fixedControllerClock{now: now}),
	)
	require.NoError(t, err)
	result, err = tokenErrController.Handle(context.Background(), validRealControllerRequest(CommandAuthToken, "req-real-token-err", "session-provider-err"))
	require.Error(t, err)
	require.NotNil(t, result.Error)

	fallback := providerSessionFromRecord(func() SessionRecord {
		record := realSessionRecord("tenant-1", "namespace-1", "session-legacy-provider-state", now)
		record.State = StateFailed
		record.ProviderState = "legacy-provider-state"
		return record
	}())
	require.Equal(t, StateFailed, fallback.State)

	require.Equal(t, CommandRun, commandFromOperation(OperationRun))
	require.Equal(t, Command("custom-op"), commandFromOperation(Operation("custom-op")))
}

type noListSessionRegistry struct{}

func (noListSessionRegistry) Put(context.Context, SessionRecord) (SessionRecord, error) {
	return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm test registry does not store sessions", "")
}

func (noListSessionRegistry) Get(context.Context, SessionKey) (SessionRecord, error) {
	return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm test registry cannot load sessions", "")
}

func (noListSessionRegistry) Delete(context.Context, SessionKey) error {
	return nil
}

func realSessionRecord(tenantID, namespace, sessionID string, now time.Time) SessionRecord {
	return SessionRecord{
		TenantID:            tenantID,
		Namespace:           namespace,
		SessionID:           sessionID,
		State:               StateRunning,
		DesiredState:        StateRunning,
		ProviderID:          AWSLambdaMicroVMProviderID,
		ProviderMicroVMID:   "provider-" + sessionID,
		ProviderState:       "running",
		AWSLifecycleState:   "running",
		ImageRef:            "image-ref",
		NetworkConnectorRef: "network-ref",
		ControllerID:        "controller-1",
		CreatedAt:           now,
		UpdatedAt:           now,
		LastObservedAt:      now,
		ExpiresAt:           now.Add(time.Hour),
		Generation:          1,
		LastAction:          CommandRun,
		LastCommandID:       "req-" + sessionID,
		AuthSubject:         "subject-1",
	}
}

type errorRunProvider struct{ *realControllerProvider }

func (p errorRunProvider) Run(context.Context, ProviderRunInput) (ProviderSession, error) {
	return ProviderSession{}, errors.New("raw bearer_token provider failure")
}

type invalidRunProvider struct{ *realControllerProvider }

func (p invalidRunProvider) Run(context.Context, ProviderRunInput) (ProviderSession, error) {
	return ProviderSession{}, nil
}

type errorGetProvider struct{ *realControllerProvider }

func (p errorGetProvider) Get(context.Context, ProviderSessionInput) (ProviderSession, error) {
	return ProviderSession{}, errors.New("raw bearer_token get failure")
}

type errorListProvider struct{ *realControllerProvider }

func (p errorListProvider) List(context.Context, ProviderListInput) (ProviderListOutput, error) {
	return ProviderListOutput{}, errors.New("raw bearer_token list failure")
}

type invalidTokenProvider struct{ *realControllerProvider }

func (p invalidTokenProvider) CreateAuthToken(context.Context, ProviderTokenInput) (ProviderToken, error) {
	return ProviderToken{}, nil
}

type realControllerProvider struct {
	now                     time.Time
	next                    int64
	tokens                  int64
	lastRunExecutionRoleArn string
	lastRunInput            ProviderRunInput
	lastInvokeInput         ProviderInvokeInput
	sessions                map[SessionKey]ProviderSession
}

func newRealControllerProvider(now time.Time) *realControllerProvider {
	return &realControllerProvider{now: now.UTC(), sessions: map[SessionKey]ProviderSession{}}
}

func (p *realControllerProvider) Run(_ context.Context, input ProviderRunInput) (ProviderSession, error) {
	if err := ValidateProviderRunInput(input); err != nil {
		return ProviderSession{}, err
	}
	p.lastRunExecutionRoleArn = input.ExecutionRoleArn
	p.lastRunInput = input
	p.next++
	session := ProviderSession{
		TenantID:          input.TenantID,
		Namespace:         input.Namespace,
		SessionID:         input.SessionID,
		ProviderMicroVMID: "microvm-000001",
		State:             StateRunning,
		ProviderState:     "running",
		Endpoint:          "https://microvm-000001.example.test",
		ImageRef:          input.ImageRef,
		ImageVersion:      input.ImageVersion,
		StartedAt:         p.now,
		RegistryVersion:   p.next,
	}
	p.sessions[session.Key()] = session
	return session, nil
}

func (p *realControllerProvider) Get(_ context.Context, input ProviderSessionInput) (ProviderSession, error) {
	if err := ValidateProviderSessionInput(OperationGet, input); err != nil {
		return ProviderSession{}, err
	}
	return p.bound(input.Binding, input.RequestID)
}

func (p *realControllerProvider) List(_ context.Context, input ProviderListInput) (ProviderListOutput, error) {
	if err := ValidateProviderListInput(input); err != nil {
		return ProviderListOutput{}, err
	}
	sessions := make([]ProviderSession, 0, len(input.KnownSessions))
	for _, binding := range input.KnownSessions {
		session, err := p.bound(binding, input.RequestID)
		if err == nil {
			sessions = append(sessions, session)
		}
	}
	return ProviderListOutput{Sessions: sessions}, nil
}

func (p *realControllerProvider) Suspend(_ context.Context, input ProviderSessionInput) (ProviderSession, error) {
	if err := ValidateProviderSessionInput(OperationSuspend, input); err != nil {
		return ProviderSession{}, err
	}
	return p.transition(input.Binding, "suspended", input.RequestID)
}

func (p *realControllerProvider) Resume(_ context.Context, input ProviderSessionInput) (ProviderSession, error) {
	if err := ValidateProviderSessionInput(OperationResume, input); err != nil {
		return ProviderSession{}, err
	}
	return p.transition(input.Binding, "ready", input.RequestID)
}

func (p *realControllerProvider) Terminate(_ context.Context, input ProviderSessionInput) (ProviderSession, error) {
	if err := ValidateProviderSessionInput(OperationTerminate, input); err != nil {
		return ProviderSession{}, err
	}
	return p.transition(input.Binding, "terminated", input.RequestID)
}

func (p *realControllerProvider) Invoke(_ context.Context, input ProviderInvokeInput) (ProviderInvokeOutput, error) {
	if err := ValidateProviderInvokeInput(input); err != nil {
		return ProviderInvokeOutput{}, err
	}
	p.lastInvokeInput = input
	if _, err := p.bound(input.Binding, input.RequestID); err != nil {
		return ProviderInvokeOutput{}, err
	}
	return ProviderInvokeOutput{
		Status:  200,
		Headers: map[string][]string{"content-type": {"application/json"}},
		Body:    []byte(`{"runtime":"fake-microvm","path":"` + input.Path + `"}`),
	}, nil
}

func (p *realControllerProvider) CreateAuthToken(_ context.Context, input ProviderTokenInput) (ProviderToken, error) {
	if err := ValidateProviderTokenInput(OperationAuthToken, input); err != nil {
		return ProviderToken{}, err
	}
	return p.token(input, "auth", []string{"ports:443"}), nil
}

func (p *realControllerProvider) CreateShellToken(_ context.Context, input ProviderTokenInput) (ProviderToken, error) {
	if err := ValidateProviderTokenInput(OperationShellAuthToken, input); err != nil {
		return ProviderToken{}, err
	}
	return p.token(input, "shell", []string{"shell"}), nil
}

func (p *realControllerProvider) bound(binding ProviderSessionBinding, requestID string) (ProviderSession, error) {
	session, ok := p.sessions[binding.Key()]
	if !ok || session.ProviderMicroVMID != binding.ProviderMicroVMID {
		return ProviderSession{}, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider binding is not available", requestID)
	}
	return session, nil
}

func (p *realControllerProvider) transition(binding ProviderSessionBinding, providerState string, requestID string) (ProviderSession, error) {
	session, err := p.bound(binding, requestID)
	if err != nil {
		return ProviderSession{}, err
	}
	state, terminal, err := MapProviderState(providerState)
	if err != nil {
		return ProviderSession{}, err
	}
	p.next++
	session.ProviderState = providerState
	session.State = state
	session.Terminal = terminal
	session.RegistryVersion = p.next
	if providerState == "terminated" {
		session.TerminatedAt = p.now
	}
	p.sessions[session.Key()] = session
	return session, nil
}

func (p *realControllerProvider) token(input ProviderTokenInput, tokenType string, scope []string) ProviderToken {
	p.tokens++
	return ProviderToken{
		TenantID:          input.TenantID,
		Namespace:         input.Namespace,
		SessionID:         input.Binding.SessionID,
		ProviderMicroVMID: input.Binding.ProviderMicroVMID,
		TokenID:           tokenType + "-000001",
		TokenType:         tokenType,
		ExpiresAt:         p.now.Add(time.Minute),
		Scope:             scope,
	}
}

func validRealControllerRequest(command Command, requestID string, sessionID string) ControllerRequest {
	req := ControllerRequest{
		Command:   command,
		RequestID: requestID,
		TenantID:  "tenant-1",
		Namespace: "namespace-1",
		AuthContext: AuthContext{
			Subject:   "subject-1",
			TenantID:  "tenant-1",
			Namespace: "namespace-1",
		},
		SessionID: sessionID,
	}
	if normalizeCommand(command) == CommandRun {
		req.ImageRef = "image-ref"
		req.NetworkConnectorRef = "network-ref"
	}
	return req
}
