package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

func TestFakeProviderCoversAllM16Operations(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	provider := NewFakeProviderWithTime(now)

	run, err := provider.Run(context.Background(), fakeRunInput("req-run", "session-1", "image-ref"))
	require.NoError(t, err)
	require.Equal(t, runtimemicrovm.StateRunning, run.State)
	require.Equal(t, "running", run.ProviderState)

	binding := run.Binding()
	got, err := provider.Get(context.Background(), fakeSessionInput("req-get", binding))
	require.NoError(t, err)
	require.Equal(t, binding, got.Binding())

	list, err := provider.List(context.Background(), runtimemicrovm.ProviderListInput{
		RequestID:   "req-list",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: fakeAuth(),
	})
	require.NoError(t, err)
	require.Len(t, list.Sessions, 1)

	suspended, err := provider.Suspend(context.Background(), fakeSessionInput("req-suspend", binding))
	require.NoError(t, err)
	require.Equal(t, runtimemicrovm.StateSuspended, suspended.State)

	resumed, err := provider.Resume(context.Background(), fakeSessionInput("req-resume", suspended.Binding()))
	require.NoError(t, err)
	require.Equal(t, runtimemicrovm.StateReady, resumed.State)
	require.Equal(t, "ready", resumed.ProviderState)

	authToken, err := provider.CreateAuthToken(context.Background(), fakeTokenInput("req-auth", resumed.Binding()))
	require.NoError(t, err)
	require.Equal(t, "auth", authToken.TokenType)
	require.Equal(t, []string{"ports:443"}, authToken.Scope)

	shellToken, err := provider.CreateShellToken(context.Background(), fakeTokenInput("req-shell", resumed.Binding()))
	require.NoError(t, err)
	require.Equal(t, "shell", shellToken.TokenType)
	require.Equal(t, []string{"shell"}, shellToken.Scope)

	terminated, err := provider.Terminate(context.Background(), fakeSessionInput("req-terminate", resumed.Binding()))
	require.NoError(t, err)
	require.Equal(t, runtimemicrovm.StateTerminated, terminated.State)
	require.True(t, terminated.Terminal)

	calls := provider.Calls()
	require.Len(t, calls, 8)
	require.Equal(t, runtimemicrovm.OperationRun, calls[0].Operation)
	require.Equal(t, runtimemicrovm.OperationTerminate, calls[7].Operation)
}

func TestFakeProviderTenantBindingTokenSafetyAndSanitizedErrors(t *testing.T) {
	provider := NewFakeProviderWithTime(time.Unix(1100, 0).UTC())
	run, err := provider.Run(context.Background(), fakeRunInput("req-run", "session-1", "image-ref"))
	require.NoError(t, err)

	crossTenant := fakeSessionInput("req-cross", run.Binding())
	crossTenant.TenantID = "tenant-2"
	_, err = provider.Get(context.Background(), crossTenant)
	requireRuntimeSafeError(t, err, runtimemicrovm.ErrorCodeTenantBindingViolation)

	_, err = provider.List(context.Background(), runtimemicrovm.ProviderListInput{
		RequestID:   "req-list-cross",
		TenantID:    "tenant-2",
		Namespace:   "namespace-1",
		AuthContext: runtimemicrovm.AuthContext{Subject: "subject-2", TenantID: "tenant-2", Namespace: "namespace-1"},
		KnownSessions: []runtimemicrovm.ProviderSessionBinding{
			run.Binding(),
		},
	})
	requireRuntimeSafeError(t, err, runtimemicrovm.ErrorCodeTenantBindingViolation)

	token, err := provider.CreateAuthToken(context.Background(), fakeTokenInput("req-auth", run.Binding()))
	require.NoError(t, err)
	encoded, err := json.Marshal(token)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "plaintext_token")
	require.NotContains(t, string(encoded), "bearer_token")
	require.NotContains(t, string(encoded), "X-aws-proxy-auth")

	provider.SetOperationError(runtimemicrovm.OperationGet, errors.New("provider leaked bearer_token raw_sdk_client"))
	_, err = provider.Get(context.Background(), fakeSessionInput("req-raw", run.Binding()))
	requireRuntimeSafeError(t, err, runtimemicrovm.ErrorCodeProviderOperationFailed)
	require.NotContains(t, err.Error(), "bearer_token")
	require.NotContains(t, err.Error(), "raw_sdk_client")
}

func TestFakeProviderRejectsInvalidTokenAndForbiddenRunMetadata(t *testing.T) {
	provider := NewFakeProvider()
	provider.SetNow(time.Unix(1200, 0).UTC())
	input := fakeRunInput("req-run", "session-1", "image-ref")
	input.SessionSpec.Metadata = map[string]string{"raw_aws_credentials": "value"}
	_, err := provider.Run(context.Background(), input)
	requireRuntimeSafeError(t, err, runtimemicrovm.ErrorCodeForbiddenField)

	run, err := provider.Run(context.Background(), fakeRunInput("req-run-2", "session-2", "image-ref"))
	require.NoError(t, err)
	token := fakeTokenInput("req-token", run.Binding())
	token.AllowedPortScope = nil
	_, err = provider.CreateAuthToken(context.Background(), token)
	requireRuntimeSafeError(t, err, runtimemicrovm.ErrorCodeTokenSafetyViolation)

	_, err = provider.Run(context.Background(), fakeRunInput("req-run-2", "session-2", "image-ref"))
	requireRuntimeSafeError(t, err, runtimemicrovm.ErrorCodeProviderOperationFailed)
	provider.SetOperationError(runtimemicrovm.OperationRun, nil)

	filtered, err := provider.List(context.Background(), runtimemicrovm.ProviderListInput{
		RequestID:   "req-list-filter",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: fakeAuth(),
		ImageRef:    "does-not-match",
	})
	require.NoError(t, err)
	require.Empty(t, filtered.Sessions)

	allPortsToken := fakeTokenInput("req-all-ports", run.Binding())
	allPortsToken.AllowedPortScope = []runtimemicrovm.ProviderPortScope{{AllPorts: true}, {StartPort: 8000, EndPort: 8001}}
	tokenOut, err := provider.CreateAuthToken(context.Background(), allPortsToken)
	require.NoError(t, err)
	require.Equal(t, []string{"ports:*", "ports:8000-8001"}, tokenOut.Scope)

	zero := NewFakeProviderWithTime(time.Time{})
	require.False(t, zero.now.IsZero())
}

func fakeRunInput(requestID, sessionID, imageRef string) runtimemicrovm.ProviderRunInput {
	return runtimemicrovm.ProviderRunInput{
		RequestID:           requestID,
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		SessionID:           sessionID,
		AuthContext:         fakeAuth(),
		ImageRef:            imageRef,
		NetworkConnectorRef: "network-ref",
		SessionSpec:         runtimemicrovm.SessionSpec{Metadata: map[string]string{"purpose": "test"}},
	}
}

func fakeSessionInput(requestID string, binding runtimemicrovm.ProviderSessionBinding) runtimemicrovm.ProviderSessionInput {
	return runtimemicrovm.ProviderSessionInput{
		RequestID:   requestID,
		TenantID:    binding.TenantID,
		Namespace:   binding.Namespace,
		AuthContext: fakeAuth(),
		Binding:     binding,
	}
}

func fakeTokenInput(requestID string, binding runtimemicrovm.ProviderSessionBinding) runtimemicrovm.ProviderTokenInput {
	return runtimemicrovm.ProviderTokenInput{
		RequestID:   requestID,
		TenantID:    binding.TenantID,
		Namespace:   binding.Namespace,
		AuthContext: fakeAuth(),
		Binding:     binding,
		TTLSeconds:  120,
		AllowedPortScope: []runtimemicrovm.ProviderPortScope{
			{Port: 443},
		},
	}
}

func fakeAuth() runtimemicrovm.AuthContext {
	return runtimemicrovm.AuthContext{Subject: "subject-1", TenantID: "tenant-1", Namespace: "namespace-1"}
}

func requireRuntimeSafeError(t *testing.T, err error, code string) {
	t.Helper()
	require.Error(t, err)
	var safe runtimemicrovm.SafeError
	require.ErrorAs(t, err, &safe)
	require.Equal(t, code, safe.Code)
}
