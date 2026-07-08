package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/lambda"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/runtime/microvm"
	"github.com/theory-cloud/tabletheory/v2"
)

const (
	localBearerHeader = "Bearer local-demo-only"
	localProviderID   = "apptheory.local.microvm.fake"
)

type appOptions struct {
	clock    clock
	ids      microvm.IDGenerator
	provider *localProvider
	registry microvm.SessionRegistry
}

type appOption func(*appOptions)

type clock struct{ now time.Time }

func (c clock) Now() time.Time {
	if c.now.IsZero() {
		return time.Now().UTC()
	}
	return c.now.UTC()
}

type sequentialIDs struct {
	mu     sync.Mutex
	prefix string
	next   int
}

func newSequentialIDs(prefix string) *sequentialIDs {
	return &sequentialIDs{prefix: prefix}
}

func (g *sequentialIDs) NewID() string {
	if g == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.next++
	return fmt.Sprintf("%s-%06d", g.prefix, g.next)
}

func withClock(now time.Time) appOption {
	return func(opts *appOptions) {
		opts.clock = clock{now: now}
	}
}

func withIDGenerator(ids microvm.IDGenerator) appOption {
	return func(opts *appOptions) {
		if ids != nil {
			opts.ids = ids
		}
	}
}

func withProvider(provider *localProvider) appOption {
	return func(opts *appOptions) {
		if provider != nil {
			opts.provider = provider
		}
	}
}

func withRegistry(registry microvm.SessionRegistry) appOption {
	return func(opts *appOptions) {
		if registry != nil {
			opts.registry = registry
		}
	}
}

func buildApp(options ...appOption) (*apptheory.App, error) {
	if len(options) == 0 && strings.EqualFold(strings.TrimSpace(os.Getenv("APPTHEORY_MICROVM_EXAMPLE_PROVIDER")), "aws") {
		return buildAWSApp(context.Background())
	}

	now := time.Date(2026, 6, 25, 8, 0, 0, 0, time.UTC)
	opts := appOptions{
		clock:    clock{now: now},
		ids:      newSequentialIDs("local-session"),
		provider: newLocalProvider(clock{now: now}),
		registry: microvm.NewMemorySessionRegistry(),
	}
	for _, option := range options {
		if option != nil {
			option(&opts)
		}
	}
	if opts.provider == nil {
		return nil, errors.New("microvm controller example requires a constrained provider fake")
	}
	if opts.registry == nil {
		return nil, errors.New("microvm controller example requires a session registry")
	}

	registry, err := microvm.NewReconstructingSessionRegistry(
		opts.registry,
		opts.provider.reconstructSession,
		microvm.WithSessionReconstructionClock(opts.clock),
		microvm.WithSessionReconstructionStaleAfter(5*time.Minute),
	)
	if err != nil {
		return nil, err
	}

	controller, err := microvm.NewRealController(
		opts.provider,
		registry,
		microvm.WithControllerClock(opts.clock),
		microvm.WithControllerIDGenerator(opts.ids),
		microvm.WithControllerProviderID(localProviderID),
		microvm.WithControllerSessionTTL(time.Hour),
	)
	if err != nil {
		return nil, err
	}

	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(opts.clock),
		apptheory.WithAuthHook(localAuthHook),
	)
	if _, err := microvm.RegisterControllerRoutes(app, controller); err != nil {
		return nil, err
	}
	return app, nil
}

func buildAWSApp(ctx context.Context) (*apptheory.App, error) {
	db, err := tabletheory.NewLambdaOptimized()
	if err != nil {
		return nil, fmt.Errorf("tabletheory init: %w", err)
	}
	registry, err := microvm.NewTableTheorySessionRegistry(db)
	if err != nil {
		return nil, err
	}
	provider, err := microvm.NewAWSLambdaMicroVMProvider(ctx)
	if err != nil {
		return nil, err
	}
	controller, err := microvm.NewRealController(
		provider,
		registry,
		microvm.WithControllerSessionTTL(time.Hour),
	)
	if err != nil {
		return nil, err
	}
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithAuthHook(localAuthHook),
	)
	if _, err := microvm.RegisterControllerRoutes(app, controller); err != nil {
		return nil, err
	}
	return app, nil
}

func localAuthHook(ctx *apptheory.Context) (string, error) {
	if ctx == nil {
		return "", nil
	}
	if strings.TrimSpace(ctx.Header("authorization")) != localBearerHeader {
		return "", nil
	}
	if strings.TrimSpace(ctx.TenantID) == "" || strings.TrimSpace(ctx.Header("x-namespace-id")) == "" {
		return "", nil
	}
	return "local-demo-subject", nil
}

type localProvider struct {
	mu       sync.Mutex
	clock    clock
	next     int64
	tokens   int64
	sessions map[microvm.SessionKey]localProviderSession
}

type localProviderSession struct {
	session                     microvm.ProviderSession
	networkConnectorRef         string
	ingressNetworkConnectorRefs []string
	egressNetworkConnectorRefs  []string
	metadata                    map[string]string
	authSubject                 string
}

func newLocalProvider(clock clock) *localProvider {
	return &localProvider{clock: clock, sessions: map[microvm.SessionKey]localProviderSession{}}
}

func (p *localProvider) Run(_ context.Context, input microvm.ProviderRunInput) (microvm.ProviderSession, error) {
	if err := microvm.ValidateProviderRunInput(input); err != nil {
		return microvm.ProviderSession{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	p.next++
	now := p.clock.Now()
	session := microvm.ProviderSession{
		TenantID:          input.TenantID,
		Namespace:         input.Namespace,
		SessionID:         input.SessionID,
		ProviderMicroVMID: stableProviderMicroVMID(input.SessionID),
		State:             microvm.StateRunning,
		ProviderState:     "running",
		Endpoint:          fmt.Sprintf("https://%s.example.test", stableProviderMicroVMID(input.SessionID)),
		ImageRef:          input.ImageRef,
		ImageVersion:      input.ImageVersion,
		StartedAt:         now,
		RegistryVersion:   p.next,
	}
	if err := microvm.ValidateProviderSession(session); err != nil {
		return microvm.ProviderSession{}, err
	}
	p.sessions[session.Key()] = localProviderSession{
		session:                     session,
		networkConnectorRef:         input.NetworkConnectorRef,
		ingressNetworkConnectorRefs: append([]string(nil), input.IngressNetworkConnectorRefs...),
		egressNetworkConnectorRefs:  append([]string(nil), input.EgressNetworkConnectorRefs...),
		metadata:                    cloneStringMap(input.SessionSpec.Metadata),
		authSubject:                 input.AuthContext.Subject,
	}
	return session, nil
}

func (p *localProvider) Get(_ context.Context, input microvm.ProviderSessionInput) (microvm.ProviderSession, error) {
	if err := microvm.ValidateProviderSessionInput(microvm.OperationGet, input); err != nil {
		return microvm.ProviderSession{}, err
	}
	return p.bound(input.Binding, input.RequestID)
}

func (p *localProvider) List(_ context.Context, input microvm.ProviderListInput) (microvm.ProviderListOutput, error) {
	if err := microvm.ValidateProviderListInput(input); err != nil {
		return microvm.ProviderListOutput{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	sessions := make([]microvm.ProviderSession, 0, len(input.KnownSessions))
	for _, binding := range input.KnownSessions {
		stored, ok := p.sessions[binding.Key()]
		if !ok || stored.session.ProviderMicroVMID != binding.ProviderMicroVMID {
			continue
		}
		sessions = append(sessions, stored.session)
		if input.MaxResults > 0 && int32(len(sessions)) >= input.MaxResults {
			break
		}
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].SessionID < sessions[j].SessionID
	})
	return microvm.ProviderListOutput{Sessions: sessions}, nil
}

func (p *localProvider) Suspend(_ context.Context, input microvm.ProviderSessionInput) (microvm.ProviderSession, error) {
	if err := microvm.ValidateProviderSessionInput(microvm.OperationSuspend, input); err != nil {
		return microvm.ProviderSession{}, err
	}
	return p.transition(input.Binding, "suspended", input.RequestID)
}

func (p *localProvider) Resume(_ context.Context, input microvm.ProviderSessionInput) (microvm.ProviderSession, error) {
	if err := microvm.ValidateProviderSessionInput(microvm.OperationResume, input); err != nil {
		return microvm.ProviderSession{}, err
	}
	return p.transition(input.Binding, "ready", input.RequestID)
}

func (p *localProvider) Terminate(_ context.Context, input microvm.ProviderSessionInput) (microvm.ProviderSession, error) {
	if err := microvm.ValidateProviderSessionInput(microvm.OperationTerminate, input); err != nil {
		return microvm.ProviderSession{}, err
	}
	return p.transition(input.Binding, "terminated", input.RequestID)
}

func (p *localProvider) CreateAuthToken(_ context.Context, input microvm.ProviderTokenInput) (microvm.ProviderToken, error) {
	if err := microvm.ValidateProviderTokenInput(microvm.OperationAuthToken, input); err != nil {
		return microvm.ProviderToken{}, err
	}
	return p.token(input, "auth", portScopes(input.AllowedPortScope)), nil
}

func (p *localProvider) CreateShellToken(_ context.Context, input microvm.ProviderTokenInput) (microvm.ProviderToken, error) {
	if err := microvm.ValidateProviderTokenInput(microvm.OperationShellAuthToken, input); err != nil {
		return microvm.ProviderToken{}, err
	}
	return p.token(input, "shell", []string{"shell"}), nil
}

func (p *localProvider) Invoke(_ context.Context, input microvm.ProviderInvokeInput) (microvm.ProviderInvokeOutput, error) {
	if err := microvm.ValidateProviderInvokeInput(input); err != nil {
		return microvm.ProviderInvokeOutput{}, err
	}
	if _, err := p.bound(input.Binding, input.RequestID); err != nil {
		return microvm.ProviderInvokeOutput{}, err
	}
	body, err := json.Marshal(map[string]string{
		"runtime": "local-microvm",
		"method":  input.Method,
		"path":    input.Path,
	})
	if err != nil {
		return microvm.ProviderInvokeOutput{}, err
	}
	return microvm.ProviderInvokeOutput{
		Status:  200,
		Headers: map[string][]string{"content-type": {"application/json; charset=utf-8"}},
		Body:    body,
	}, nil
}

func (p *localProvider) bound(binding microvm.ProviderSessionBinding, requestID string) (microvm.ProviderSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	stored, ok := p.sessions[binding.Key()]
	if !ok || stored.session.ProviderMicroVMID != binding.ProviderMicroVMID {
		return microvm.ProviderSession{}, fmt.Errorf("microvm provider binding not available for request %s", requestID)
	}
	return stored.session, nil
}

func (p *localProvider) transition(
	binding microvm.ProviderSessionBinding,
	providerState string,
	requestID string,
) (microvm.ProviderSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	stored, ok := p.sessions[binding.Key()]
	if !ok || stored.session.ProviderMicroVMID != binding.ProviderMicroVMID {
		return microvm.ProviderSession{}, fmt.Errorf("microvm provider binding not available for request %s", requestID)
	}
	state, terminal, err := microvm.MapProviderState(providerState)
	if err != nil {
		return microvm.ProviderSession{}, err
	}
	p.next++
	stored.session.State = state
	stored.session.ProviderState = providerState
	stored.session.RegistryVersion = p.next
	stored.session.Terminal = terminal
	if terminal {
		stored.session.TerminatedAt = p.clock.Now()
	}
	p.sessions[stored.session.Key()] = stored
	return stored.session, nil
}

func (p *localProvider) token(input microvm.ProviderTokenInput, tokenType string, scope []string) microvm.ProviderToken {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokens++
	return microvm.ProviderToken{
		TenantID:          input.TenantID,
		Namespace:         input.Namespace,
		SessionID:         input.Binding.SessionID,
		ProviderMicroVMID: input.Binding.ProviderMicroVMID,
		TokenID:           fmt.Sprintf("%s-token-%06d", tokenType, p.tokens),
		TokenType:         tokenType,
		ExpiresAt:         p.clock.Now().Add(15 * time.Minute),
		Scope:             append([]string(nil), scope...),
	}
}

func (p *localProvider) reconstructSession(
	_ context.Context,
	request microvm.SessionReconstructionRequest,
) (microvm.SessionRecord, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := microvm.SessionKey{TenantID: request.TenantID, Namespace: request.Namespace, SessionID: request.SessionID}
	stored, ok := p.sessions[key]
	if !ok {
		return microvm.SessionRecord{}, fmt.Errorf("local product truth missing session %s", request.SessionID)
	}
	now := request.Now
	if now.IsZero() {
		now = p.clock.Now()
	}
	return sessionRecordFromLocalProvider(stored, now, request.RequestID)
}

func sessionRecordFromLocalProvider(
	stored localProviderSession,
	now time.Time,
	requestID string,
) (microvm.SessionRecord, error) {
	if requestID == "" {
		requestID = "local-reconstruction"
	}
	session := stored.session
	record := microvm.SessionRecord{
		TenantID:                    session.TenantID,
		Namespace:                   session.Namespace,
		SessionID:                   session.SessionID,
		State:                       session.State,
		DesiredState:                session.State,
		ProviderID:                  localProviderID,
		ProviderMicroVMID:           session.ProviderMicroVMID,
		ProviderState:               session.ProviderState,
		AWSLifecycleState:           session.ProviderState,
		ImageRef:                    session.ImageRef,
		ImageVersion:                session.ImageVersion,
		NetworkConnectorRef:         stored.networkConnectorRef,
		IngressNetworkConnectorRefs: append([]string(nil), stored.ingressNetworkConnectorRefs...),
		EgressNetworkConnectorRefs:  append([]string(nil), stored.egressNetworkConnectorRefs...),
		ControllerID:                "apptheory-microvm-controller",
		CreatedAt:                   session.StartedAt,
		UpdatedAt:                   now,
		LastObservedAt:              now,
		ProviderStartedAt:           session.StartedAt,
		ProviderTerminatedAt:        session.TerminatedAt,
		ExpiresAt:                   now.Add(time.Hour),
		Generation:                  session.RegistryVersion,
		LastAction:                  microvm.CommandGet,
		LastCommandID:               requestID,
		AuthSubject:                 stored.authSubject,
		Metadata:                    cloneStringMap(stored.metadata),
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = now
	}
	if record.Generation <= 0 {
		record.Generation = 1
	}
	if err := microvm.ValidateSessionRecord(record); err != nil {
		return microvm.SessionRecord{}, err
	}
	return record, nil
}

func stableProviderMicroVMID(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return "local-microvm-" + hex.EncodeToString(sum[:4])
}

func portScopes(scopes []microvm.ProviderPortScope) []string {
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		switch {
		case scope.AllPorts:
			out = append(out, "ports:all")
		case scope.Port > 0:
			out = append(out, fmt.Sprintf("ports:%d", scope.Port))
		case scope.StartPort > 0 && scope.EndPort > 0:
			out = append(out, fmt.Sprintf("ports:%d-%d", scope.StartPort, scope.EndPort))
		}
	}
	return out
}

func cloneStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func main() {
	app, err := buildApp()
	if err != nil {
		panic(err)
	}
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
