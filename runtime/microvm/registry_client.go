package microvm

import (
	"context"
	"time"
)

const defaultSessionRegistryTTL = time.Hour

// RegistryClient is a deterministic constrained MicroVM client backed by a durable SessionRegistry.
type RegistryClient struct {
	registry SessionRegistry
	ttl      time.Duration
}

var _ Client = (*RegistryClient)(nil)

// RegistryClientOption configures a registry-backed constrained client.
type RegistryClientOption func(*RegistryClient)

// WithRegistryClientTTL configures the TTL applied to newly-created durable sessions.
func WithRegistryClientTTL(ttl time.Duration) RegistryClientOption {
	return func(client *RegistryClient) {
		if ttl > 0 {
			client.ttl = ttl
		}
	}
}

// NewRegistryClient creates a constrained client that persists sessions through a SessionRegistry.
func NewRegistryClient(registry SessionRegistry, opts ...RegistryClientOption) (*RegistryClient, error) {
	if registry == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry client requires a session registry", "")
	}
	client := &RegistryClient{registry: registry, ttl: defaultSessionRegistryTTL}
	for _, opt := range opts {
		if opt != nil {
			opt(client)
		}
	}
	return client, nil
}

// Create stores a requested durable session record.
func (c *RegistryClient) Create(ctx context.Context, input CreateSessionInput) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if c == nil || c.registry == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry client requires a session registry", input.RequestID)
	}
	now := registryClientTime(input.Now)
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
		CreatedAt:           now,
		UpdatedAt:           now,
		LastObservedAt:      now,
		ExpiresAt:           now.Add(c.ttl),
		Generation:          1,
		LastAction:          CommandCreate,
		LastCommandID:       input.RequestID,
		AuthSubject:         input.AuthSubject,
		Metadata:            cloneStringMap(input.SessionSpec.Metadata),
	}
	return c.registry.Put(ctx, record)
}

// Start marks a durable session as starting toward started.
func (c *RegistryClient) Start(ctx context.Context, input SessionCommandInput) (SessionRecord, error) {
	return c.transition(ctx, input, CommandStart, StateStarting, input.DesiredState)
}

// Stop marks a durable session as stopping toward stopped.
func (c *RegistryClient) Stop(ctx context.Context, input SessionCommandInput) (SessionRecord, error) {
	return c.transition(ctx, input, CommandStop, StateStopping, input.DesiredState)
}

// Status returns durable status for a session.
func (c *RegistryClient) Status(ctx context.Context, input SessionQueryInput) (SessionStatus, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	record, err := c.session(ctx, input)
	if err != nil {
		return SessionStatus{}, err
	}
	status := SessionStatus{
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
	}
	if err := ValidateSessionStatus(status); err != nil {
		return SessionStatus{}, err
	}
	return status, nil
}

// Session returns the durable session record.
func (c *RegistryClient) Session(ctx context.Context, input SessionQueryInput) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	return c.session(ctx, input)
}

func (c *RegistryClient) transition(ctx context.Context, input SessionCommandInput, action Command, state LifecycleState, desired LifecycleState) (SessionRecord, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if c == nil || c.registry == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry client requires a session registry", input.RequestID)
	}
	record, err := c.registry.Get(ctx, SessionKey{TenantID: input.TenantID, Namespace: input.Namespace, SessionID: input.SessionID})
	if err != nil {
		return SessionRecord{}, err
	}
	record.State = state
	record.DesiredState = desired
	record.ProviderID = defaultString(record.ProviderID, DefaultSessionProviderID)
	record.ProviderMicroVMID = defaultString(record.ProviderMicroVMID, record.SessionID)
	record.ProviderState = string(state)
	record.AWSLifecycleState = string(state)
	record.ControllerID = input.ControllerID
	record.AuthSubject = input.AuthSubject
	record.LastAction = action
	record.LastCommandID = input.RequestID
	record.UpdatedAt = registryClientTime(input.Now)
	record.LastObservedAt = record.UpdatedAt
	record.Generation++
	return c.registry.Put(ctx, record)
}

func (c *RegistryClient) session(ctx context.Context, input SessionQueryInput) (SessionRecord, error) {
	if c == nil || c.registry == nil {
		return SessionRecord{}, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm registry client requires a session registry", input.RequestID)
	}
	return c.registry.Get(ctx, SessionKey{TenantID: input.TenantID, Namespace: input.Namespace, SessionID: input.SessionID})
}

func registryClientTime(value time.Time) time.Time {
	if !value.IsZero() {
		return value.UTC()
	}
	return time.Unix(0, 0).UTC()
}

func defaultString(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}
