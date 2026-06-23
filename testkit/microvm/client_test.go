package microvm

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

func TestFakeClientControllerFlow(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	client := NewFakeClientWithTime(now)
	controller, err := runtimemicrovm.NewController(
		client,
		runtimemicrovm.WithControllerID("controller-1"),
		runtimemicrovm.WithControllerClock(fixedClock{now: now}),
		runtimemicrovm.WithControllerIDGenerator(fixedIDs{id: "session-1"}),
	)
	require.NoError(t, err)

	create, err := controller.Handle(context.Background(), request(runtimemicrovm.CommandCreate, "req-create", ""))
	require.NoError(t, err)
	require.Equal(t, "session-1", create.SessionID)
	require.Equal(t, runtimemicrovm.StateRequested, create.State)
	require.Equal(t, int64(1), create.RegistryVersion)

	start, err := controller.Handle(context.Background(), request(runtimemicrovm.CommandStart, "req-start", create.SessionID))
	require.NoError(t, err)
	require.Equal(t, runtimemicrovm.StateStarting, start.State)
	require.Equal(t, runtimemicrovm.StateStarted, start.DesiredState)

	status, err := controller.Handle(context.Background(), request(runtimemicrovm.CommandStatus, "req-status", create.SessionID))
	require.NoError(t, err)
	require.Equal(t, runtimemicrovm.StateStarting, status.LifecycleState)

	session, err := controller.Handle(context.Background(), request(runtimemicrovm.CommandSession, "req-session", create.SessionID))
	require.NoError(t, err)
	require.Equal(t, "tenant-1", session.TenantID)
	require.Equal(t, "namespace-1", session.Namespace)

	calls := client.Calls()
	require.Len(t, calls, 4)
	require.Equal(t, runtimemicrovm.CommandCreate, calls[0].Command)
	require.Equal(t, runtimemicrovm.CommandSession, calls[3].Command)
}

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }

type fixedIDs struct{ id string }

func (g fixedIDs) NewID() string { return g.id }

func request(command runtimemicrovm.Command, requestID string, sessionID string) runtimemicrovm.ControllerRequest {
	req := runtimemicrovm.ControllerRequest{
		Command:   command,
		RequestID: requestID,
		TenantID:  "tenant-1",
		Namespace: "namespace-1",
		AuthContext: runtimemicrovm.AuthContext{
			Subject:  "subject-1",
			TenantID: "tenant-1",
		},
		SessionID: sessionID,
	}
	if command == runtimemicrovm.CommandCreate {
		req.ImageRef = "image-ref"
		req.NetworkConnectorRef = "network-ref"
	}
	return req
}
