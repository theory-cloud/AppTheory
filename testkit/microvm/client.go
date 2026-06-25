// Package microvm provides deterministic test doubles for AppTheory MicroVM controllers.
package microvm

import (
	"context"
	"fmt"
	"sync"
	"time"

	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

// Call records one fake client operation.
type Call struct {
	Command   runtimemicrovm.Command
	RequestID string
	TenantID  string
	Namespace string
	SessionID string
}

// FakeClient is an in-memory constrained MicroVM client for tests.
type FakeClient struct {
	mu       sync.Mutex
	now      time.Time
	sessions map[runtimemicrovm.SessionKey]runtimemicrovm.SessionRecord
	calls    []Call
}

var _ runtimemicrovm.Client = (*FakeClient)(nil)

// NewFakeClient creates a fake client with a deterministic starting clock.
func NewFakeClient() *FakeClient {
	return NewFakeClientWithTime(time.Unix(0, 0).UTC())
}

// NewFakeClientWithTime creates a fake client with the provided current time.
func NewFakeClientWithTime(now time.Time) *FakeClient {
	if now.IsZero() {
		now = time.Unix(0, 0).UTC()
	}
	return &FakeClient{now: now.UTC(), sessions: map[runtimemicrovm.SessionKey]runtimemicrovm.SessionRecord{}}
}

// SetNow sets the fake client's current time.
func (c *FakeClient) SetNow(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !now.IsZero() {
		c.now = now.UTC()
	}
}

// Calls returns a copy of recorded calls.
func (c *FakeClient) Calls() []Call {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Call(nil), c.calls...)
}

// Create creates a fake session record.
func (c *FakeClient) Create(_ context.Context, input runtimemicrovm.CreateSessionInput) (runtimemicrovm.SessionRecord, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recordCall(runtimemicrovm.CommandCreate, input.RequestID, input.TenantID, input.Namespace, input.SessionID)
	now := coalesceTime(input.Now, c.now)
	record := runtimemicrovm.SessionRecord{
		TenantID:            input.TenantID,
		Namespace:           input.Namespace,
		SessionID:           input.SessionID,
		State:               runtimemicrovm.StateRequested,
		DesiredState:        runtimemicrovm.StateRequested,
		ProviderID:          runtimemicrovm.DefaultSessionProviderID,
		ProviderMicroVMID:   input.SessionID,
		ProviderState:       string(runtimemicrovm.StateRequested),
		AWSLifecycleState:   string(runtimemicrovm.StateRequested),
		ImageRef:            input.ImageRef,
		NetworkConnectorRef: input.NetworkConnectorRef,
		ControllerID:        input.ControllerID,
		CreatedAt:           now,
		UpdatedAt:           now,
		LastObservedAt:      now,
		ExpiresAt:           now.Add(time.Hour),
		Generation:          1,
		LastAction:          runtimemicrovm.CommandCreate,
		LastCommandID:       input.RequestID,
		AuthSubject:         input.AuthSubject,
		Metadata:            input.SessionSpec.Metadata,
	}
	if err := runtimemicrovm.ValidateSessionRecord(record); err != nil {
		return runtimemicrovm.SessionRecord{}, err
	}
	key := record.Key()
	if _, exists := c.sessions[key]; exists {
		return runtimemicrovm.SessionRecord{}, fmt.Errorf("session already exists")
	}
	c.sessions[key] = record
	return cloneRecord(record), nil
}

// Start marks a fake session as starting toward started.
func (c *FakeClient) Start(_ context.Context, input runtimemicrovm.SessionCommandInput) (runtimemicrovm.SessionRecord, error) {
	return c.transition(input, runtimemicrovm.CommandStart, runtimemicrovm.StateStarting, runtimemicrovm.StateStarted)
}

// Stop marks a fake session as stopping toward stopped.
func (c *FakeClient) Stop(_ context.Context, input runtimemicrovm.SessionCommandInput) (runtimemicrovm.SessionRecord, error) {
	return c.transition(input, runtimemicrovm.CommandStop, runtimemicrovm.StateStopping, runtimemicrovm.StateStopped)
}

// Status returns fake session status.
func (c *FakeClient) Status(_ context.Context, input runtimemicrovm.SessionQueryInput) (runtimemicrovm.SessionStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recordCall(runtimemicrovm.CommandStatus, input.RequestID, input.TenantID, input.Namespace, input.SessionID)
	record, err := c.lookup(input.TenantID, input.Namespace, input.SessionID)
	if err != nil {
		return runtimemicrovm.SessionStatus{}, err
	}
	return runtimemicrovm.SessionStatus{
		TenantID:        record.TenantID,
		Namespace:       record.Namespace,
		SessionID:       record.SessionID,
		State:           record.State,
		DesiredState:    record.DesiredState,
		LifecycleState:  record.State,
		Endpoint:        record.Endpoint,
		MicroVMID:       record.MicroVMID,
		LastAction:      record.LastAction,
		LastTransition:  record.UpdatedAt,
		RegistryVersion: record.Generation,
	}, nil
}

// Session returns a fake session record.
func (c *FakeClient) Session(_ context.Context, input runtimemicrovm.SessionQueryInput) (runtimemicrovm.SessionRecord, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recordCall(runtimemicrovm.CommandSession, input.RequestID, input.TenantID, input.Namespace, input.SessionID)
	record, err := c.lookup(input.TenantID, input.Namespace, input.SessionID)
	if err != nil {
		return runtimemicrovm.SessionRecord{}, err
	}
	return cloneRecord(record), nil
}

func (c *FakeClient) transition(
	input runtimemicrovm.SessionCommandInput,
	command runtimemicrovm.Command,
	state runtimemicrovm.LifecycleState,
	desired runtimemicrovm.LifecycleState,
) (runtimemicrovm.SessionRecord, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recordCall(command, input.RequestID, input.TenantID, input.Namespace, input.SessionID)
	record, err := c.lookup(input.TenantID, input.Namespace, input.SessionID)
	if err != nil {
		return runtimemicrovm.SessionRecord{}, err
	}
	record.State = state
	record.DesiredState = desired
	if record.ProviderID == "" {
		record.ProviderID = runtimemicrovm.DefaultSessionProviderID
	}
	if record.ProviderMicroVMID == "" {
		record.ProviderMicroVMID = record.SessionID
	}
	record.ProviderState = string(state)
	record.AWSLifecycleState = string(state)
	record.ControllerID = input.ControllerID
	record.AuthSubject = input.AuthSubject
	record.LastAction = command
	record.LastCommandID = input.RequestID
	record.UpdatedAt = coalesceTime(input.Now, c.now)
	record.LastObservedAt = record.UpdatedAt
	record.Generation++
	if err := runtimemicrovm.ValidateSessionRecord(record); err != nil {
		return runtimemicrovm.SessionRecord{}, err
	}
	c.sessions[record.Key()] = record
	return cloneRecord(record), nil
}

func (c *FakeClient) lookup(tenantID, namespace, sessionID string) (runtimemicrovm.SessionRecord, error) {
	key := runtimemicrovm.SessionKey{TenantID: tenantID, Namespace: namespace, SessionID: sessionID}
	record, ok := c.sessions[key]
	if !ok {
		return runtimemicrovm.SessionRecord{}, fmt.Errorf("session not found")
	}
	return record, nil
}

func (c *FakeClient) recordCall(command runtimemicrovm.Command, requestID, tenantID, namespace, sessionID string) {
	c.calls = append(c.calls, Call{Command: command, RequestID: requestID, TenantID: tenantID, Namespace: namespace, SessionID: sessionID})
}

func coalesceTime(value time.Time, fallback time.Time) time.Time {
	if !value.IsZero() {
		return value.UTC()
	}
	if !fallback.IsZero() {
		return fallback.UTC()
	}
	return time.Unix(0, 0).UTC()
}

func cloneRecord(record runtimemicrovm.SessionRecord) runtimemicrovm.SessionRecord {
	if len(record.Metadata) > 0 {
		metadata := make(map[string]string, len(record.Metadata))
		for key, value := range record.Metadata {
			metadata[key] = value
		}
		record.Metadata = metadata
	}
	return record
}
