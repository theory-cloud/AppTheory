package microvm

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
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
