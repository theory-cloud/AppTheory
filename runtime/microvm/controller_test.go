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
		ImageRef:            input.ImageRef,
		NetworkConnectorRef: input.NetworkConnectorRef,
		ControllerID:        input.ControllerID,
		CreatedAt:           input.Now,
		UpdatedAt:           input.Now,
		ExpiresAt:           input.Now.Add(time.Hour),
		Generation:          1,
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
	record.UpdatedAt = input.Now
	record.Generation++
	record.LastCommandID = input.RequestID
	record.AuthSubject = input.AuthSubject
	return record, nil
}

func (c stubClient) Stop(context.Context, SessionCommandInput) (SessionRecord, error) {
	if c.err != nil {
		return SessionRecord{}, c.err
	}
	return c.record, nil
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
