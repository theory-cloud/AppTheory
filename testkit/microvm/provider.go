package microvm

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

// ProviderCall records one fake provider operation.
type ProviderCall struct {
	Operation runtimemicrovm.Operation
	RequestID string
	TenantID  string
	Namespace string
	SessionID string
}

// FakeProvider is an in-memory deterministic M16 real MicroVM provider for tests.
type FakeProvider struct {
	mu       sync.Mutex
	now      time.Time
	next     int64
	tokens   int64
	sessions map[runtimemicrovm.SessionKey]runtimemicrovm.ProviderSession
	errors   map[runtimemicrovm.Operation]error
	calls    []ProviderCall
}

var _ runtimemicrovm.Provider = (*FakeProvider)(nil)

// NewFakeProvider creates a fake provider with a deterministic starting clock.
func NewFakeProvider() *FakeProvider {
	return NewFakeProviderWithTime(time.Unix(0, 0).UTC())
}

// NewFakeProviderWithTime creates a fake provider with the provided current time.
func NewFakeProviderWithTime(now time.Time) *FakeProvider {
	if now.IsZero() {
		now = time.Unix(0, 0).UTC()
	}
	return &FakeProvider{
		now:      now.UTC(),
		sessions: map[runtimemicrovm.SessionKey]runtimemicrovm.ProviderSession{},
		errors:   map[runtimemicrovm.Operation]error{},
	}
}

// SetNow sets the fake provider clock.
func (p *FakeProvider) SetNow(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !now.IsZero() {
		p.now = now.UTC()
	}
}

// SetOperationError configures a sanitized failure for the next calls to an operation.
func (p *FakeProvider) SetOperationError(operation runtimemicrovm.Operation, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.errors == nil {
		p.errors = map[runtimemicrovm.Operation]error{}
	}
	if err == nil {
		delete(p.errors, operation)
		return
	}
	p.errors[operation] = err
}

// Calls returns a copy of recorded provider calls.
func (p *FakeProvider) Calls() []ProviderCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]ProviderCall(nil), p.calls...)
}

// Run creates a deterministic fake provider MicroVM session.
func (p *FakeProvider) Run(_ context.Context, input runtimemicrovm.ProviderRunInput) (runtimemicrovm.ProviderSession, error) {
	if err := runtimemicrovm.ValidateProviderRunInput(input); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.record(runtimemicrovm.OperationRun, input.RequestID, input.TenantID, input.Namespace, input.SessionID)
	if err := p.configuredError(runtimemicrovm.OperationRun, input.RequestID); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	key := providerKey(input.TenantID, input.Namespace, input.SessionID)
	if _, exists := p.sessions[key]; exists {
		return runtimemicrovm.ProviderSession{}, fakeProviderError(input.RequestID)
	}
	p.next++
	session := runtimemicrovm.ProviderSession{
		TenantID:          strings.TrimSpace(input.TenantID),
		Namespace:         strings.TrimSpace(input.Namespace),
		SessionID:         strings.TrimSpace(input.SessionID),
		ProviderMicroVMID: fmt.Sprintf("microvm-%06d", p.next),
		State:             runtimemicrovm.StateRunning,
		ProviderState:     "running",
		ImageRef:          strings.TrimSpace(input.ImageRef),
		ImageVersion:      strings.TrimSpace(input.ImageVersion),
		StartedAt:         p.now,
		RegistryVersion:   p.next,
	}
	if err := runtimemicrovm.ValidateProviderSession(session); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.sessions[key] = session
	return session, nil
}

// Get returns a tenant-bound fake provider session.
func (p *FakeProvider) Get(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.lookup(runtimemicrovm.OperationGet, input)
}

// List returns deterministic fake provider sessions for one tenant and namespace.
func (p *FakeProvider) List(_ context.Context, input runtimemicrovm.ProviderListInput) (runtimemicrovm.ProviderListOutput, error) {
	if err := runtimemicrovm.ValidateProviderListInput(input); err != nil {
		return runtimemicrovm.ProviderListOutput{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.record(runtimemicrovm.OperationList, input.RequestID, input.TenantID, input.Namespace, "")
	if err := p.configuredError(runtimemicrovm.OperationList, input.RequestID); err != nil {
		return runtimemicrovm.ProviderListOutput{}, err
	}
	sessions := make([]runtimemicrovm.ProviderSession, 0)
	for _, session := range p.sessions {
		if session.TenantID != strings.TrimSpace(input.TenantID) || session.Namespace != strings.TrimSpace(input.Namespace) {
			continue
		}
		if input.ImageRef != "" && session.ImageRef != strings.TrimSpace(input.ImageRef) {
			continue
		}
		if input.ImageVersion != "" && session.ImageVersion != strings.TrimSpace(input.ImageVersion) {
			continue
		}
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].SessionID < sessions[j].SessionID
	})
	return runtimemicrovm.ProviderListOutput{Sessions: sessions}, nil
}

// Suspend marks a fake provider session suspended.
func (p *FakeProvider) Suspend(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.transition(runtimemicrovm.OperationSuspend, input, "suspended", p.now, time.Time{})
}

// Resume marks a fake provider session ready.
func (p *FakeProvider) Resume(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.transition(runtimemicrovm.OperationResume, input, "ready", p.now, time.Time{})
}

// Terminate marks a fake provider session terminated.
func (p *FakeProvider) Terminate(_ context.Context, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	return p.transition(runtimemicrovm.OperationTerminate, input, "terminated", p.now, p.now)
}

// CreateAuthToken returns sanitized deterministic auth-token metadata.
func (p *FakeProvider) CreateAuthToken(_ context.Context, input runtimemicrovm.ProviderTokenInput) (runtimemicrovm.ProviderToken, error) {
	return p.token(runtimemicrovm.OperationAuthToken, input)
}

// CreateShellToken returns sanitized deterministic shell-token metadata.
func (p *FakeProvider) CreateShellToken(_ context.Context, input runtimemicrovm.ProviderTokenInput) (runtimemicrovm.ProviderToken, error) {
	return p.token(runtimemicrovm.OperationShellToken, input)
}

func (p *FakeProvider) lookup(operation runtimemicrovm.Operation, input runtimemicrovm.ProviderSessionInput) (runtimemicrovm.ProviderSession, error) {
	if err := runtimemicrovm.ValidateProviderSessionInput(operation, input); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.record(operation, input.RequestID, input.TenantID, input.Namespace, input.Binding.SessionID)
	if err := p.configuredError(operation, input.RequestID); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	session, err := p.boundSession(input.RequestID, input.Binding)
	if err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	return session, nil
}

func (p *FakeProvider) transition(operation runtimemicrovm.Operation, input runtimemicrovm.ProviderSessionInput, providerState string, updatedAt time.Time, terminatedAt time.Time) (runtimemicrovm.ProviderSession, error) {
	if err := runtimemicrovm.ValidateProviderSessionInput(operation, input); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.record(operation, input.RequestID, input.TenantID, input.Namespace, input.Binding.SessionID)
	if err := p.configuredError(operation, input.RequestID); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	session, err := p.boundSession(input.RequestID, input.Binding)
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
	if !updatedAt.IsZero() && session.StartedAt.IsZero() {
		session.StartedAt = updatedAt.UTC()
	}
	session.TerminatedAt = terminatedAt.UTC()
	session.RegistryVersion++
	if err := runtimemicrovm.ValidateProviderSession(session); err != nil {
		return runtimemicrovm.ProviderSession{}, err
	}
	p.sessions[session.Key()] = session
	return session, nil
}

func (p *FakeProvider) token(operation runtimemicrovm.Operation, input runtimemicrovm.ProviderTokenInput) (runtimemicrovm.ProviderToken, error) {
	if err := runtimemicrovm.ValidateProviderTokenInput(operation, input); err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.record(operation, input.RequestID, input.TenantID, input.Namespace, input.Binding.SessionID)
	if err := p.configuredError(operation, input.RequestID); err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	if _, err := p.boundSession(input.RequestID, input.Binding); err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	tokenType := "auth"
	scope := fakeProviderTokenScope(input.AllowedPortScope)
	if operation == runtimemicrovm.OperationShellToken {
		tokenType = "shell"
		scope = []string{"shell"}
	}
	ttl := input.TTLSeconds
	if ttl == 0 {
		ttl = 900
	}
	p.tokens++
	token := runtimemicrovm.ProviderToken{
		TenantID:          input.Binding.TenantID,
		Namespace:         input.Binding.Namespace,
		SessionID:         input.Binding.SessionID,
		ProviderMicroVMID: input.Binding.ProviderMicroVMID,
		TokenID:           fmt.Sprintf("%s-%06d", tokenType, p.tokens),
		TokenType:         tokenType,
		ExpiresAt:         p.now.Add(time.Duration(ttl) * time.Second).UTC(),
		Scope:             scope,
	}
	if err := runtimemicrovm.ValidateProviderToken(token); err != nil {
		return runtimemicrovm.ProviderToken{}, err
	}
	return token, nil
}

func (p *FakeProvider) boundSession(requestID string, binding runtimemicrovm.ProviderSessionBinding) (runtimemicrovm.ProviderSession, error) {
	session, ok := p.sessions[binding.Key()]
	if !ok || session.ProviderMicroVMID != strings.TrimSpace(binding.ProviderMicroVMID) {
		return runtimemicrovm.ProviderSession{}, runtimemicrovm.SafeError{
			Code:      runtimemicrovm.ErrorCodeTenantBindingViolation,
			Message:   "apptheory: microvm provider binding is not available",
			RequestID: requestID,
		}
	}
	return session, nil
}

func (p *FakeProvider) configuredError(operation runtimemicrovm.Operation, requestID string) error {
	if err := p.errors[operation]; err != nil {
		_ = err
		return fakeProviderError(requestID)
	}
	return nil
}

func (p *FakeProvider) record(operation runtimemicrovm.Operation, requestID, tenantID, namespace, sessionID string) {
	p.calls = append(p.calls, ProviderCall{
		Operation: operation,
		RequestID: strings.TrimSpace(requestID),
		TenantID:  strings.TrimSpace(tenantID),
		Namespace: strings.TrimSpace(namespace),
		SessionID: strings.TrimSpace(sessionID),
	})
}

func fakeProviderError(requestID string) error {
	return runtimemicrovm.SafeError{
		Code:      runtimemicrovm.ErrorCodeProviderOperationFailed,
		Message:   "apptheory: microvm provider operation failed",
		RequestID: strings.TrimSpace(requestID),
	}
}

func fakeProviderTokenScope(scopes []runtimemicrovm.ProviderPortScope) []string {
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

func providerKey(tenantID, namespace, sessionID string) runtimemicrovm.SessionKey {
	return runtimemicrovm.SessionKey{TenantID: strings.TrimSpace(tenantID), Namespace: strings.TrimSpace(namespace), SessionID: strings.TrimSpace(sessionID)}
}
