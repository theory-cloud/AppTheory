package microvm

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func newOwnershipController(t *testing.T, now time.Time, registry SessionRegistry) (*Controller, *recordingControllerProvider) {
	t.Helper()
	provider := &recordingControllerProvider{realControllerProvider: newRealControllerProvider(now)}
	controller, err := NewRealController(
		provider,
		registry,
		withDisabledControllerLogging(),
		WithControllerClock(fixedControllerClock{now: now}),
		WithControllerIDGenerator(fixedControllerIDs{id: "session-owner"}),
	)
	require.NoError(t, err)
	return controller, provider
}

func ownerControllerRequest(command Command, requestID string, sessionID string, subject string) ControllerRequest {
	request := validRealControllerRequest(command, requestID, sessionID)
	request.AuthContext.Subject = subject
	return request
}

func TestRealControllerEnforcesSessionOwnership(t *testing.T) {
	now := time.Unix(1400, 0).UTC()
	registry := NewMemorySessionRegistry()
	controller, provider := newOwnershipController(t, now, registry)

	run, err := controller.Handle(context.Background(), ownerControllerRequest(CommandRun, "req-owner-run", "", "subject-1"))
	require.NoError(t, err)
	require.Nil(t, run.Error)

	key := SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: run.SessionID}
	created, err := registry.Get(context.Background(), key)
	require.NoError(t, err)
	require.Equal(t, "subject-1", created.AuthSubject)

	type rejectedCase struct {
		name    string
		request ControllerRequest
	}
	authToken := ownerControllerRequest(CommandAuthToken, "req-owner-token-2", run.SessionID, "subject-2")
	authToken.AllowedPortScope = []ProviderPortScope{{Port: 443}}
	rejected := []rejectedCase{
		{"get", ownerControllerRequest(CommandGet, "req-owner-get-2", run.SessionID, "subject-2")},
		{"suspend", ownerControllerRequest(CommandSuspend, "req-owner-suspend-2", run.SessionID, "subject-2")},
		{"resume", ownerControllerRequest(CommandResume, "req-owner-resume-2", run.SessionID, "subject-2")},
		{"terminate", ownerControllerRequest(CommandTerminate, "req-owner-terminate-2", run.SessionID, "subject-2")},
		{"auth-token", authToken},
		{"shell-auth-token", ownerControllerRequest(CommandShellAuthToken, "req-owner-shell-2", run.SessionID, "subject-2")},
	}

	for _, testCase := range rejected {
		t.Run(testCase.name, func(t *testing.T) {
			callsBefore := provider.calls
			response, handleErr := controller.Handle(context.Background(), testCase.request)
			requireSafeError(t, handleErr, ErrorCodeSessionOwnerMismatch)
			require.NotNil(t, response.Error)
			require.Equal(t, ErrorCodeSessionOwnerMismatch, response.Error.Code)
			require.Equal(t, callsBefore, provider.calls, "a non-owner session load must not reach the provider")
		})
	}

	invokeCalls := provider.calls
	_, err = controller.Invoke(context.Background(), ControllerInvokeRequest{
		RequestID:   "req-owner-invoke-2",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: AuthContext{Subject: "subject-2", TenantID: "tenant-1", Namespace: "namespace-1"},
		SessionID:   run.SessionID,
		Method:      "GET",
		Path:        "/",
	})
	requireSafeError(t, err, ErrorCodeSessionOwnerMismatch)
	require.Equal(t, invokeCalls, provider.calls, "a non-owner invoke must not reach the provider")

	stored, err := registry.Get(context.Background(), key)
	require.NoError(t, err)
	require.Equal(t, "subject-1", stored.AuthSubject)
	require.Equal(t, StateRunning, stored.State)
	require.Equal(t, created.Generation, stored.Generation)

	// The owner keeps full access to the same operations.
	get, err := controller.Handle(context.Background(), ownerControllerRequest(CommandGet, "req-owner-get-1", run.SessionID, "subject-1"))
	require.NoError(t, err)
	require.Nil(t, get.Error)

	suspend, err := controller.Handle(context.Background(), ownerControllerRequest(CommandSuspend, "req-owner-suspend-1", run.SessionID, "subject-1"))
	require.NoError(t, err)
	require.Equal(t, StateSuspended, suspend.State)

	resume, err := controller.Handle(context.Background(), ownerControllerRequest(CommandResume, "req-owner-resume-1", run.SessionID, "subject-1"))
	require.NoError(t, err)
	require.Equal(t, StateReady, resume.State)

	ownerToken := ownerControllerRequest(CommandAuthToken, "req-owner-token-1", run.SessionID, "subject-1")
	ownerToken.AllowedPortScope = []ProviderPortScope{{Port: 443}}
	token, err := controller.Handle(context.Background(), ownerToken)
	require.NoError(t, err)
	require.Nil(t, token.Error)

	output, err := controller.Invoke(context.Background(), ControllerInvokeRequest{
		RequestID:   "req-owner-invoke-1",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: AuthContext{Subject: "subject-1", TenantID: "tenant-1", Namespace: "namespace-1"},
		SessionID:   run.SessionID,
		Method:      "GET",
		Path:        "/",
	})
	require.NoError(t, err)
	require.Equal(t, 200, output.Status)

	terminate, err := controller.Handle(context.Background(), ownerControllerRequest(CommandTerminate, "req-owner-terminate-1", run.SessionID, "subject-1"))
	require.NoError(t, err)
	require.Equal(t, StateTerminated, terminate.State)

	// Ownership survives every owner-side refresh: the token refresh and the
	// provider-session put preserve the stored subject.
	updated, err := registry.Get(context.Background(), key)
	require.NoError(t, err)
	require.Equal(t, "subject-1", updated.AuthSubject)
	require.Len(t, updated.TokenMetadata, 1)

	// List semantics are unchanged: a different subject in the same tenant still
	// lists the session, and listing does not rewrite its owner.
	list, err := controller.Handle(context.Background(), ownerControllerRequest(CommandList, "req-owner-list-2", "", "subject-2"))
	require.NoError(t, err)
	require.Len(t, list.Sessions, 1)
	require.Equal(t, run.SessionID, list.Sessions[0].SessionID)

	listed, err := registry.Get(context.Background(), key)
	require.NoError(t, err)
	require.Equal(t, "subject-1", listed.AuthSubject)
}

func TestRealControllerRejectsStoredOwnerChangedByCaller(t *testing.T) {
	now := time.Unix(1450, 0).UTC()
	registry := NewMemorySessionRegistry()
	controller, provider := newOwnershipController(t, now, registry)

	record := realSessionRecord("tenant-1", "namespace-1", "session-stored", now)
	record.AuthSubject = "subject-owner"
	record.ProviderMicroVMID = "microvm-000001"
	record.Endpoint = "https://microvm-000001.microvm.us-east-1.amazonaws.com"
	_, err := registry.Put(context.Background(), record)
	require.NoError(t, err)
	provider.sessions[record.Key()] = ProviderSession{
		TenantID:          record.TenantID,
		Namespace:         record.Namespace,
		SessionID:         record.SessionID,
		ProviderMicroVMID: record.ProviderMicroVMID,
		State:             StateRunning,
		ProviderState:     "running",
		Endpoint:          record.Endpoint,
		RegistryVersion:   record.Generation,
	}

	token := ownerControllerRequest(CommandAuthToken, "req-stored-token", record.SessionID, "subject-1")
	token.AllowedPortScope = []ProviderPortScope{{Port: 443}}
	_, err = controller.Handle(context.Background(), token)
	requireSafeError(t, err, ErrorCodeSessionOwnerMismatch)

	// A rejected refresh must not have appended token metadata or bumped the record.
	stored, err := registry.Get(context.Background(), record.Key())
	require.NoError(t, err)
	require.Equal(t, "subject-owner", stored.AuthSubject)
	require.Empty(t, stored.TokenMetadata)
	require.Equal(t, record.Generation, stored.Generation)

	// The stored owner can refresh the token and stays the owner.
	ownerToken := ownerControllerRequest(CommandAuthToken, "req-stored-token-owner", record.SessionID, "subject-owner")
	ownerToken.AllowedPortScope = []ProviderPortScope{{Port: 443}}
	_, err = controller.Handle(context.Background(), ownerToken)
	require.NoError(t, err)

	refreshed, err := registry.Get(context.Background(), record.Key())
	require.NoError(t, err)
	require.Equal(t, "subject-owner", refreshed.AuthSubject)
	require.Len(t, refreshed.TokenMetadata, 1)
}
