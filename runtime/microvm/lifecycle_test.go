package microvm

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDefaultLifecycleContractValidates(t *testing.T) {
	require.NoError(t, ValidateLifecycleContract(DefaultLifecycleContract()))
}

func TestLifecycleAdapterAdvancesCanonicalPath(t *testing.T) {
	calls := make([]LifecycleEvent, 0, 5)
	adapter, err := NewLifecycleAdapter(
		WithLifecycleHandler(HookPrepareImage, recordLifecycleCall(&calls)),
		WithLifecycleHandler(HookStart, recordLifecycleCall(&calls)),
		WithLifecycleHandler(HookReadiness, recordLifecycleCall(&calls)),
		WithLifecycleHandler(HookStop, recordLifecycleCall(&calls)),
		WithLifecycleHandler(HookTeardown, recordLifecycleCall(&calls)),
	)
	require.NoError(t, err)

	state := StateRequested
	for _, hook := range []LifecycleHook{HookPrepareImage, HookStart, HookReadiness, HookStop, HookTeardown} {
		result, err := adapter.Handle(context.Background(), LifecycleEvent{
			RequestID: "req-1",
			TenantID:  "tenant-1",
			Namespace: "ns-1",
			SessionID: "session-1",
			Hook:      hook,
			State:     state,
			Metadata:  map[string]string{"safe": "value"},
		})
		require.NoError(t, err)
		require.Nil(t, result.Error)
		state = result.State
	}

	require.Equal(t, StateTerminated, state)
	require.Len(t, calls, 5)
	require.Equal(t, StateImagePreparing, calls[0].State)
	require.Equal(t, StateStarting, calls[1].State)
	require.Equal(t, StateReadinessProbing, calls[2].State)
	require.Equal(t, StateStopping, calls[3].State)
	require.Equal(t, StateTearingDown, calls[4].State)
}

func TestLifecycleAdapterSanitizesHandlerErrors(t *testing.T) {
	adapter, err := NewLifecycleAdapter(WithLifecycleHandler(HookStart, func(context.Context, LifecycleEvent) error {
		return errors.New("raw provider failure with bearer_token")
	}))
	require.NoError(t, err)

	result, err := adapter.Handle(context.Background(), LifecycleEvent{
		RequestID: "req-1",
		TenantID:  "tenant-1",
		Namespace: "ns-1",
		SessionID: "session-1",
		Hook:      HookStart,
		State:     StateImagePrepared,
	})

	require.Error(t, err)
	require.Equal(t, StateFailed, result.State)
	require.NotNil(t, result.Error)
	require.Equal(t, ErrorCodeLifecycleHookFailed, result.Error.Code)
	require.NotContains(t, err.Error(), "bearer_token")
}

func TestLifecycleAdapterRejectsForbiddenMetadata(t *testing.T) {
	adapter, err := NewLifecycleAdapter(WithLifecycleHandler(HookStart, func(context.Context, LifecycleEvent) error { return nil }))
	require.NoError(t, err)

	result, err := adapter.Handle(context.Background(), LifecycleEvent{
		RequestID: "req-1",
		TenantID:  "tenant-1",
		Namespace: "ns-1",
		SessionID: "session-1",
		Hook:      HookStart,
		State:     StateImagePrepared,
		Metadata:  map[string]string{"aws_secret_access_key": "do-not-persist"},
	})

	require.Error(t, err)
	require.Equal(t, ErrorCodeForbiddenField, result.Error.Code)
	require.Equal(t, StateFailed, result.State)
}

func TestLifecycleAdapterRunsFailureHook(t *testing.T) {
	adapter, err := NewLifecycleAdapter(WithLifecycleHandler(HookFailure, func(context.Context, LifecycleEvent) error { return nil }))
	require.NoError(t, err)

	result, err := adapter.Handle(context.Background(), LifecycleEvent{
		RequestID: "req-1",
		TenantID:  "tenant-1",
		Namespace: "ns-1",
		SessionID: "session-1",
		Hook:      HookFailure,
		State:     StateStarting,
	})

	require.NoError(t, err)
	require.Equal(t, StateFailed, result.State)
	require.True(t, IsTerminalState(result.State))
}

func recordLifecycleCall(calls *[]LifecycleEvent) LifecycleHandler {
	return func(_ context.Context, event LifecycleEvent) error {
		*calls = append(*calls, event)
		return nil
	}
}
