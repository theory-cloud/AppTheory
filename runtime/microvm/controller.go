package microvm

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"time"
)

const (
	// ErrorCodeInvalidControllerRequest reports a malformed controller request envelope.
	ErrorCodeInvalidControllerRequest = "m15.microvm.invalid_controller_request"
	// ErrorCodeControllerCommandFailed reports a sanitized client command failure.
	ErrorCodeControllerCommandFailed = "m15.microvm.controller_command_failed"
)

const (
	// EnvExecutionRoleArn names the optional IAM role ARN passed to AWS Lambda MicroVMs during execution.
	EnvExecutionRoleArn = "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN"
)

// Command names a constrained MicroVM controller command.
type Command string

const (
	CommandCreate  Command = "create"
	CommandStart   Command = "start"
	CommandStop    Command = "stop"
	CommandStatus  Command = "status"
	CommandSession Command = "session"

	CommandRun            Command = "run"
	CommandGet            Command = "get"
	CommandList           Command = "list"
	CommandSuspend        Command = "suspend"
	CommandResume         Command = "resume"
	CommandTerminate      Command = "terminate"
	CommandAuthToken      Command = "auth-token"
	CommandShellAuthToken Command = "shell-auth-token" //nolint:gosec // Contract command name, not a credential.
	// CommandShellToken is a compatibility alias for the canonical shell-auth-token command.
	CommandShellToken Command = CommandShellAuthToken
	// CommandLegacyShellToken is accepted only as a compatibility input alias.
	CommandLegacyShellToken Command = "shell-token"
)

// Clock supplies controller timestamps.
type Clock interface {
	Now() time.Time
}

// IDGenerator supplies controller-created session identifiers.
type IDGenerator interface {
	NewID() string
}

// AuthContext is the sanitized authenticated principal context required by controller requests.
type AuthContext struct {
	Subject      string            `json:"subject"`
	TenantID     string            `json:"tenant_id"`
	Namespace    string            `json:"namespace,omitempty"`
	Entitlements []string          `json:"entitlements,omitempty"`
	Metadata     map[string]string `json:"metadata,omitempty"`
}

// SessionSpec is the safe session specification accepted by the controller.
type SessionSpec struct {
	Metadata map[string]string `json:"metadata,omitempty"`
}

// ControllerRequest is the single AppTheory MicroVM control-plane request envelope.
type ControllerRequest struct {
	Command                     Command             `json:"command"`
	RequestID                   string              `json:"request_id"`
	TenantID                    string              `json:"tenant_id"`
	Namespace                   string              `json:"namespace"`
	AuthContext                 AuthContext         `json:"auth_context"`
	SessionID                   string              `json:"session_id,omitempty"`
	ImageRef                    string              `json:"image_ref,omitempty"`
	ImageVersion                string              `json:"image_version,omitempty"`
	NetworkConnectorRef         string              `json:"network_connector_ref,omitempty"`
	IngressNetworkConnectorRefs []string            `json:"ingress_network_connector_refs,omitempty"`
	EgressNetworkConnectorRefs  []string            `json:"egress_network_connector_refs,omitempty"`
	SessionSpec                 SessionSpec         `json:"session_spec,omitempty"`
	IdlePolicy                  *ProviderIdlePolicy `json:"idle_policy,omitempty"`
	MaximumDurationSeconds      int32               `json:"maximum_duration_seconds,omitempty"`
	TTLSeconds                  int32               `json:"ttl_seconds,omitempty"`
	AllowedPortScope            []ProviderPortScope `json:"allowed_port_scope,omitempty"`
	MaxResults                  int32               `json:"max_results,omitempty"`
}

// ControllerResponse is the safe controller response envelope.
type ControllerResponse struct {
	Command           Command           `json:"command"`
	RequestID         string            `json:"request_id"`
	TenantID          string            `json:"tenant_id,omitempty"`
	Namespace         string            `json:"namespace,omitempty"`
	SessionID         string            `json:"session_id,omitempty"`
	State             LifecycleState    `json:"state,omitempty"`
	DesiredState      LifecycleState    `json:"desired_state,omitempty"`
	LifecycleState    LifecycleState    `json:"lifecycle_state,omitempty"`
	Endpoint          string            `json:"endpoint,omitempty"`
	MicroVMID         string            `json:"microvm_id,omitempty"`
	ProviderMicroVMID string            `json:"provider_microvm_id,omitempty"`
	ProviderState     string            `json:"provider_state,omitempty"`
	LastAction        Command           `json:"last_action,omitempty"`
	LastTransition    time.Time         `json:"last_transition,omitempty"`
	RegistryVersion   int64             `json:"registry_version,omitempty"`
	Sessions          []ProviderSession `json:"sessions,omitempty"`
	RecoveryCursor    string            `json:"recovery_cursor,omitempty"`
	TokenID           string            `json:"token_id,omitempty"`
	TokenType         string            `json:"token_type,omitempty"`
	ExpiresAt         time.Time         `json:"expires_at,omitempty"`
	Scope             []string          `json:"scope,omitempty"`
	Error             *SafeError        `json:"error,omitempty"`
}

// Client is the constrained MicroVM client surface. It deliberately exposes no raw AWS SDK client.
type Client interface {
	Create(context.Context, CreateSessionInput) (SessionRecord, error)
	Start(context.Context, SessionCommandInput) (SessionRecord, error)
	Stop(context.Context, SessionCommandInput) (SessionRecord, error)
	Status(context.Context, SessionQueryInput) (SessionStatus, error)
	Session(context.Context, SessionQueryInput) (SessionRecord, error)
}

// Controller handles constrained MicroVM control-plane commands.
type Controller struct {
	client           Client
	provider         Provider
	registry         SessionRegistry
	controllerID     string
	providerID       string
	executionRoleArn string
	clock            Clock
	ids              IDGenerator
	ttl              time.Duration
}

// ControllerOption configures a Controller.
type ControllerOption func(*Controller)

// WithControllerID sets the controller_id written into session records.
func WithControllerID(controllerID string) ControllerOption {
	return func(controller *Controller) {
		controllerID = strings.TrimSpace(controllerID)
		if controllerID != "" {
			controller.controllerID = controllerID
		}
	}
}

// WithControllerClock sets the controller clock. Nil restores the real clock.
func WithControllerClock(clock Clock) ControllerOption {
	return func(controller *Controller) {
		if clock == nil {
			controller.clock = realClock{}
			return
		}
		controller.clock = clock
	}
}

// WithControllerIDGenerator sets the controller session ID generator. Nil restores the default generator.
func WithControllerIDGenerator(ids IDGenerator) ControllerOption {
	return func(controller *Controller) {
		if ids == nil {
			controller.ids = randomIDGenerator{}
			return
		}
		controller.ids = ids
	}
}

// WithControllerSessionTTL configures the TTL applied to real provider-backed session records.
func WithControllerSessionTTL(ttl time.Duration) ControllerOption {
	return func(controller *Controller) {
		if ttl > 0 {
			controller.ttl = ttl
		}
	}
}

// WithControllerProviderID sets the provider id written into real provider-backed session records.
func WithControllerProviderID(providerID string) ControllerOption {
	return func(controller *Controller) {
		providerID = strings.TrimSpace(providerID)
		if providerID != "" {
			controller.providerID = providerID
		}
	}
}

// WithControllerExecutionRoleArn sets the optional IAM role ARN passed to provider RunMicrovm requests.
func WithControllerExecutionRoleArn(executionRoleArn string) ControllerOption {
	return func(controller *Controller) {
		controller.executionRoleArn = strings.TrimSpace(executionRoleArn)
	}
}

// NewController creates a fail-closed MicroVM controller.
func NewController(client Client, opts ...ControllerOption) (*Controller, error) {
	if client == nil {
		return nil, safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller requires a constrained client", "")
	}
	controller := &Controller{
		client:       client,
		controllerID: "apptheory-microvm-controller",
		providerID:   AWSLambdaMicroVMProviderID,
		clock:        realClock{},
		ids:          randomIDGenerator{},
		ttl:          defaultSessionRegistryTTL,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(controller)
		}
	}
	return controller, nil
}

// NewRealController creates the canonical M16 provider-backed MicroVM controller.
func NewRealController(provider Provider, registry SessionRegistry, opts ...ControllerOption) (*Controller, error) {
	if provider == nil {
		return nil, safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller requires a provider adapter", "")
	}
	if registry == nil {
		return nil, safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm controller requires a session registry", "")
	}
	controller := &Controller{
		provider:         provider,
		registry:         registry,
		controllerID:     "apptheory-microvm-controller",
		providerID:       AWSLambdaMicroVMProviderID,
		executionRoleArn: strings.TrimSpace(os.Getenv(EnvExecutionRoleArn)),
		clock:            realClock{},
		ids:              randomIDGenerator{},
		ttl:              defaultSessionRegistryTTL,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(controller)
		}
	}
	if err := validateExecutionRoleArn(controller.executionRoleArn, ""); err != nil {
		return nil, safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm execution role arn is invalid", "")
	}
	return controller, nil
}

// Handle executes a controller request after authenticated, tenant-bound envelope validation.
func (c *Controller) Handle(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if c == nil || c.client == nil {
		if c == nil || c.provider == nil || c.registry == nil {
			err := safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller requires a provider adapter and session registry", request.RequestID)
			return controllerErrorResponse(request, err), err
		}
	}
	request = normalizeControllerRequest(request)
	if c.provider != nil || c.registry != nil {
		return c.handleReal(ctx, request)
	}
	if err := validateControllerRequest(request); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}

	switch request.Command {
	case CommandCreate:
		return c.handleCreate(ctx, request)
	case CommandStart:
		return c.handleCommand(ctx, request, StateStarted, c.client.Start)
	case CommandStop:
		return c.handleCommand(ctx, request, StateStopped, c.client.Stop)
	case CommandStatus:
		return c.handleStatus(ctx, request)
	case CommandSession:
		return c.handleSession(ctx, request)
	default:
		err := safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller command is unsupported", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
}

func (c *Controller) handleCreate(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	input := CreateSessionInput{
		RequestID:           request.RequestID,
		TenantID:            request.TenantID,
		Namespace:           request.Namespace,
		SessionID:           strings.TrimSpace(request.SessionID),
		ImageRef:            request.ImageRef,
		NetworkConnectorRef: request.NetworkConnectorRef,
		SessionSpec:         cloneSessionSpec(request.SessionSpec),
		ControllerID:        c.controllerID,
		AuthSubject:         request.AuthContext.Subject,
		Now:                 c.clock.Now(),
	}
	if input.SessionID == "" {
		input.SessionID = strings.TrimSpace(c.ids.NewID())
	}
	if input.SessionID == "" {
		err := safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller could not allocate session id", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
	record, err := c.client.Create(ctx, input)
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if err := ValidateSessionRecord(record); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromSession(request, record), nil
}

func (c *Controller) handleCommand(
	ctx context.Context,
	request ControllerRequest,
	desired LifecycleState,
	run func(context.Context, SessionCommandInput) (SessionRecord, error),
) (ControllerResponse, error) {
	record, err := run(ctx, SessionCommandInput{
		RequestID:    request.RequestID,
		TenantID:     request.TenantID,
		Namespace:    request.Namespace,
		SessionID:    request.SessionID,
		ControllerID: c.controllerID,
		AuthSubject:  request.AuthContext.Subject,
		DesiredState: desired,
		Now:          c.clock.Now(),
	})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if err := ValidateSessionRecord(record); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromSession(request, record), nil
}

func (c *Controller) handleStatus(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	status, err := c.client.Status(ctx, controllerQueryInput(request))
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if err := ValidateSessionStatus(status); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromStatus(request, status), nil
}

func (c *Controller) handleSession(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	record, err := c.client.Session(ctx, controllerQueryInput(request))
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if err := ValidateSessionRecord(record); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromSession(request, record), nil
}

func (c *Controller) handleReal(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	if c == nil || c.provider == nil || c.registry == nil {
		err := safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller requires a provider adapter and session registry", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
	if err := validateRealControllerRequest(request); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	switch request.Command {
	case CommandRun:
		return c.handleRealRun(ctx, request)
	case CommandGet:
		return c.handleRealSession(ctx, request, OperationGet, c.provider.Get)
	case CommandList:
		return c.handleRealList(ctx, request)
	case CommandSuspend:
		return c.handleRealSession(ctx, request, OperationSuspend, c.provider.Suspend)
	case CommandResume:
		return c.handleRealSession(ctx, request, OperationResume, c.provider.Resume)
	case CommandTerminate:
		return c.handleRealSession(ctx, request, OperationTerminate, c.provider.Terminate)
	case CommandAuthToken:
		return c.handleRealToken(ctx, request, OperationAuthToken, c.provider.CreateAuthToken)
	case CommandShellAuthToken:
		return c.handleRealToken(ctx, request, OperationShellAuthToken, c.provider.CreateShellToken)
	default:
		err := safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller command is unsupported", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
}

func (c *Controller) handleRealRun(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	sessionID := strings.TrimSpace(request.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSpace(c.ids.NewID())
	}
	if sessionID == "" {
		err := safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller could not allocate session id", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
	request.SessionID = sessionID
	providerSession, err := c.provider.Run(ctx, ProviderRunInput{
		RequestID:                   request.RequestID,
		TenantID:                    request.TenantID,
		Namespace:                   request.Namespace,
		SessionID:                   request.SessionID,
		AuthContext:                 request.AuthContext,
		ImageRef:                    request.ImageRef,
		ImageVersion:                request.ImageVersion,
		NetworkConnectorRef:         request.NetworkConnectorRef,
		IngressNetworkConnectorRefs: append([]string(nil), request.IngressNetworkConnectorRefs...),
		EgressNetworkConnectorRefs:  append([]string(nil), request.EgressNetworkConnectorRefs...),
		SessionSpec:                 cloneSessionSpec(request.SessionSpec),
		IdlePolicy:                  request.IdlePolicy,
		MaximumDurationSeconds:      request.MaximumDurationSeconds,
		ExecutionRoleArn:            c.executionRoleArn,
	})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if validationErr := ValidateProviderSession(providerSession); validationErr != nil {
		safe := asSafeError(validationErr, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	record, err := c.putProviderSession(ctx, request, providerSession, nil)
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromProviderSession(request, providerSessionFromRecord(record)), nil
}

func (c *Controller) handleRealSession(
	ctx context.Context,
	request ControllerRequest,
	operation Operation,
	run func(context.Context, ProviderSessionInput) (ProviderSession, error),
) (ControllerResponse, error) {
	record, err := c.registry.Get(ctx, SessionKey{TenantID: request.TenantID, Namespace: request.Namespace, SessionID: request.SessionID})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if validationErr := ValidateSessionRecord(record); validationErr != nil {
		safe := asSafeError(validationErr, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	session, err := run(ctx, ProviderSessionInput{
		RequestID:   request.RequestID,
		TenantID:    request.TenantID,
		Namespace:   request.Namespace,
		AuthContext: request.AuthContext,
		Binding:     providerBindingFromRecord(record),
	})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if validationErr := ValidateProviderSession(session); validationErr != nil {
		safe := asSafeError(validationErr, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	request.Command = commandFromOperation(operation)
	updated, err := c.putProviderSession(ctx, request, session, &record)
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromProviderSession(request, providerSessionFromRecord(updated)), nil
}

func (c *Controller) handleRealList(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	lister, ok := c.registry.(SessionRegistryLister)
	if !ok {
		err := safeError(ErrorCodeSessionRegistryIncomplete, "apptheory: microvm controller list requires a tenant-bound session registry lister", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
	records, err := lister.List(ctx, SessionListInput{
		RequestID:   request.RequestID,
		TenantID:    request.TenantID,
		Namespace:   request.Namespace,
		AuthSubject: request.AuthContext.Subject,
	})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	bindings := make([]ProviderSessionBinding, 0, len(records))
	recordsByKey := make(map[SessionKey]SessionRecord, len(records))
	for _, record := range records {
		if validationErr := ValidateSessionRecord(record); validationErr != nil {
			safe := asSafeError(validationErr, request.RequestID)
			return controllerErrorResponse(request, safe), safe
		}
		binding := providerBindingFromRecord(record)
		bindings = append(bindings, binding)
		recordsByKey[binding.Key()] = record
	}
	out, err := c.provider.List(ctx, ProviderListInput{
		RequestID:     request.RequestID,
		TenantID:      request.TenantID,
		Namespace:     request.Namespace,
		AuthContext:   request.AuthContext,
		ImageRef:      request.ImageRef,
		ImageVersion:  request.ImageVersion,
		MaxResults:    request.MaxResults,
		KnownSessions: bindings,
	})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	sessions := make([]ProviderSession, 0, len(out.Sessions))
	for _, session := range out.Sessions {
		session = normalizeProviderSession(session)
		record, ok := recordsByKey[session.Key()]
		if !ok {
			continue
		}
		if err := ValidateProviderSession(session); err != nil {
			safe := asSafeError(err, request.RequestID)
			return controllerErrorResponse(request, safe), safe
		}
		updated, err := c.putProviderSession(ctx, request, session, &record)
		if err != nil {
			safe := asSafeError(err, request.RequestID)
			return controllerErrorResponse(request, safe), safe
		}
		sessions = append(sessions, providerSessionFromRecord(updated))
	}
	return ControllerResponse{
		Command:        request.Command,
		RequestID:      request.RequestID,
		TenantID:       request.TenantID,
		Namespace:      request.Namespace,
		Sessions:       sessions,
		RecoveryCursor: strings.TrimSpace(out.RecoveryCursor),
	}, nil
}

func (c *Controller) handleRealToken(
	ctx context.Context,
	request ControllerRequest,
	operation Operation,
	run func(context.Context, ProviderTokenInput) (ProviderToken, error),
) (ControllerResponse, error) {
	record, err := c.registry.Get(ctx, SessionKey{TenantID: request.TenantID, Namespace: request.Namespace, SessionID: request.SessionID})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if validationErr := ValidateSessionRecord(record); validationErr != nil {
		safe := asSafeError(validationErr, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	token, err := run(ctx, ProviderTokenInput{
		RequestID:        request.RequestID,
		TenantID:         request.TenantID,
		Namespace:        request.Namespace,
		AuthContext:      request.AuthContext,
		Binding:          providerBindingFromRecord(record),
		TTLSeconds:       request.TTLSeconds,
		AllowedPortScope: append([]ProviderPortScope(nil), request.AllowedPortScope...),
	})
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	if validationErr := ValidateProviderToken(token); validationErr != nil {
		safe := asSafeError(validationErr, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	metadata, err := SessionTokenMetadataFromProviderToken(token)
	if err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	record.TokenMetadata = append(cloneSessionTokenMetadata(record.TokenMetadata), metadata)
	record.LastAction = commandFromOperation(operation)
	record.LastCommandID = request.RequestID
	record.AuthSubject = request.AuthContext.Subject
	record.UpdatedAt = c.clock.Now().UTC()
	record.LastObservedAt = record.UpdatedAt
	record.Generation++
	if _, err := c.registry.Put(ctx, record); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromProviderToken(request, token), nil
}

func controllerQueryInput(request ControllerRequest) SessionQueryInput {
	return SessionQueryInput{
		RequestID:   request.RequestID,
		TenantID:    request.TenantID,
		Namespace:   request.Namespace,
		SessionID:   request.SessionID,
		AuthSubject: request.AuthContext.Subject,
	}
}

func validateControllerRequest(request ControllerRequest) error {
	if err := validateControllerEnvelope(request); err != nil {
		return err
	}
	if err := validateControllerAuth(request); err != nil {
		return err
	}
	if err := validateControllerSafeFields(request); err != nil {
		return err
	}
	return validateControllerCommandFields(request)
}

func validateRealControllerRequest(request ControllerRequest) error {
	if err := validateControllerEnvelope(request); err != nil {
		return err
	}
	if err := validateControllerAuth(request); err != nil {
		return err
	}
	if err := validateControllerSafeFields(request); err != nil {
		return err
	}
	switch request.Command {
	case CommandRun:
		if request.ImageRef == "" || request.NetworkConnectorRef == "" {
			return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm run requires image and network connector refs", request.RequestID)
		}
	case CommandList:
		return nil
	case CommandGet, CommandSuspend, CommandResume, CommandTerminate, CommandAuthToken, CommandShellAuthToken:
		if request.SessionID == "" {
			return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller session_id is required", request.RequestID)
		}
	default:
		return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller command is unsupported", request.RequestID)
	}
	return nil
}

func validateControllerEnvelope(request ControllerRequest) error {
	if request.Command == "" || request.RequestID == "" || request.TenantID == "" || request.Namespace == "" {
		return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller envelope is incomplete", request.RequestID)
	}
	return nil
}

func validateControllerAuth(request ControllerRequest) error {
	if request.AuthContext.Subject == "" || request.AuthContext.TenantID == "" {
		return safeError(ErrorCodeUnauthenticatedController, "apptheory: microvm controller must default to authenticated deny", request.RequestID)
	}
	if request.AuthContext.TenantID != request.TenantID {
		return safeError(ErrorCodeUnauthenticatedController, "apptheory: microvm controller tenant binding mismatch", request.RequestID)
	}
	if request.AuthContext.Namespace != "" && request.AuthContext.Namespace != request.Namespace {
		return safeError(ErrorCodeUnauthenticatedController, "apptheory: microvm controller namespace binding mismatch", request.RequestID)
	}
	return nil
}

func validateControllerSafeFields(request ControllerRequest) error {
	if err := validateSafeMetadata(request.AuthContext.Metadata, request.RequestID); err != nil {
		return err
	}
	if err := validateSafeMetadata(request.SessionSpec.Metadata, request.RequestID); err != nil {
		return err
	}
	for _, ref := range append(append([]string{request.ImageRef, request.ImageVersion, request.NetworkConnectorRef}, request.IngressNetworkConnectorRefs...), request.EgressNetworkConnectorRefs...) {
		if err := validateSafeFieldValue(ref, request.RequestID); err != nil {
			return err
		}
	}
	return nil
}

func validateControllerCommandFields(request ControllerRequest) error {
	switch request.Command {
	case CommandCreate:
		return validateCreateRequestFields(request)
	case CommandStart, CommandStop, CommandStatus, CommandSession:
		return validateSessionCommandFields(request)
	default:
		return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller command is unsupported", request.RequestID)
	}
}

func validateCreateRequestFields(request ControllerRequest) error {
	if request.ImageRef == "" || request.NetworkConnectorRef == "" {
		return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm create requires image and network connector refs", request.RequestID)
	}
	return nil
}

func validateSessionCommandFields(request ControllerRequest) error {
	if request.SessionID == "" {
		return safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller session_id is required", request.RequestID)
	}
	return nil
}

func normalizeControllerRequest(request ControllerRequest) ControllerRequest {
	request.Command = normalizeCommand(request.Command)
	request.RequestID = strings.TrimSpace(request.RequestID)
	request.TenantID = strings.TrimSpace(request.TenantID)
	request.Namespace = strings.TrimSpace(request.Namespace)
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.ImageRef = strings.TrimSpace(request.ImageRef)
	request.ImageVersion = strings.TrimSpace(request.ImageVersion)
	request.NetworkConnectorRef = strings.TrimSpace(request.NetworkConnectorRef)
	request.IngressNetworkConnectorRefs = normalizeStringSlice(request.IngressNetworkConnectorRefs)
	request.EgressNetworkConnectorRefs = normalizeStringSlice(request.EgressNetworkConnectorRefs)
	request.AuthContext = normalizeAuthContext(request.AuthContext)
	request.SessionSpec = cloneSessionSpec(request.SessionSpec)
	return request
}

func normalizeAuthContext(auth AuthContext) AuthContext {
	auth.Subject = strings.TrimSpace(auth.Subject)
	auth.TenantID = strings.TrimSpace(auth.TenantID)
	auth.Namespace = strings.TrimSpace(auth.Namespace)
	auth.Entitlements = append([]string(nil), auth.Entitlements...)
	auth.Metadata = cloneStringMap(auth.Metadata)
	return auth
}

func cloneSessionSpec(spec SessionSpec) SessionSpec {
	return SessionSpec{Metadata: cloneStringMap(spec.Metadata)}
}

func responseFromSession(request ControllerRequest, record SessionRecord) ControllerResponse {
	return ControllerResponse{
		Command:           request.Command,
		RequestID:         request.RequestID,
		TenantID:          record.TenantID,
		Namespace:         record.Namespace,
		SessionID:         record.SessionID,
		State:             record.State,
		DesiredState:      record.DesiredState,
		LifecycleState:    record.State,
		Endpoint:          record.Endpoint,
		MicroVMID:         record.MicroVMID,
		ProviderMicroVMID: record.ProviderMicroVMID,
		ProviderState:     record.ProviderState,
		LastAction:        record.LastAction,
		LastTransition:    record.UpdatedAt,
		RegistryVersion:   record.Generation,
	}
}

func responseFromStatus(request ControllerRequest, status SessionStatus) ControllerResponse {
	return ControllerResponse{
		Command:         request.Command,
		RequestID:       request.RequestID,
		TenantID:        status.TenantID,
		Namespace:       status.Namespace,
		SessionID:       status.SessionID,
		State:           status.State,
		DesiredState:    status.DesiredState,
		LifecycleState:  status.LifecycleState,
		Endpoint:        status.Endpoint,
		MicroVMID:       status.MicroVMID,
		LastAction:      status.LastAction,
		LastTransition:  status.LastTransition,
		RegistryVersion: status.RegistryVersion,
	}
}

func controllerErrorResponse(request ControllerRequest, err SafeError) ControllerResponse {
	return ControllerResponse{
		Command:   normalizeCommand(request.Command),
		RequestID: strings.TrimSpace(request.RequestID),
		TenantID:  strings.TrimSpace(request.TenantID),
		Namespace: strings.TrimSpace(request.Namespace),
		SessionID: strings.TrimSpace(request.SessionID),
		Error:     &err,
	}
}

func normalizeCommand(command Command) Command {
	normalized := Command(strings.TrimSpace(string(command)))
	if normalized == CommandLegacyShellToken {
		return CommandShellAuthToken
	}
	return normalized
}

func commandFromOperation(operation Operation) Command {
	switch normalizeOperation(operation) {
	case OperationRun:
		return CommandRun
	case OperationGet:
		return CommandGet
	case OperationList:
		return CommandList
	case OperationSuspend:
		return CommandSuspend
	case OperationResume:
		return CommandResume
	case OperationTerminate:
		return CommandTerminate
	case OperationAuthToken:
		return CommandAuthToken
	case OperationShellAuthToken:
		return CommandShellAuthToken
	default:
		return Command(strings.TrimSpace(string(operation)))
	}
}

func (c *Controller) putProviderSession(ctx context.Context, request ControllerRequest, session ProviderSession, existing *SessionRecord) (SessionRecord, error) {
	record := c.sessionRecordFromProviderSession(request, session, existing)
	if err := ValidateSessionRecord(record); err != nil {
		return SessionRecord{}, err
	}
	return c.registry.Put(ctx, record)
}

func (c *Controller) sessionRecordFromProviderSession(request ControllerRequest, session ProviderSession, existing *SessionRecord) SessionRecord {
	now := c.clock.Now().UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	ttl := c.ttl
	if ttl <= 0 {
		ttl = defaultSessionRegistryTTL
	}
	record := SessionRecord{}
	if existing != nil {
		record = normalizeSessionRecord(*existing)
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = now
	}
	if record.ExpiresAt.IsZero() || !record.ExpiresAt.After(now) {
		record.ExpiresAt = now.Add(ttl)
	}
	record.TenantID = session.TenantID
	record.Namespace = session.Namespace
	record.SessionID = session.SessionID
	record.State = session.State
	record.DesiredState = desiredStateForCommand(request.Command, session.State)
	record.ProviderID = defaultString(record.ProviderID, c.providerID)
	record.ProviderMicroVMID = session.ProviderMicroVMID
	record.ProviderState = session.ProviderState
	record.AWSLifecycleState = session.ProviderState
	record.ImageRef = defaultString(session.ImageRef, defaultString(request.ImageRef, record.ImageRef))
	record.ImageVersion = defaultString(session.ImageVersion, defaultString(request.ImageVersion, record.ImageVersion))
	record.NetworkConnectorRef = defaultString(request.NetworkConnectorRef, record.NetworkConnectorRef)
	record.IngressNetworkConnectorRefs = firstNonEmptySlice(request.IngressNetworkConnectorRefs, record.IngressNetworkConnectorRefs)
	record.EgressNetworkConnectorRefs = firstNonEmptySlice(request.EgressNetworkConnectorRefs, record.EgressNetworkConnectorRefs)
	record.ControllerID = c.controllerID
	record.UpdatedAt = now
	record.LastObservedAt = now
	record.ProviderStartedAt = session.StartedAt.UTC()
	record.ProviderTerminatedAt = session.TerminatedAt.UTC()
	record.LastAction = request.Command
	record.LastCommandID = request.RequestID
	record.AuthSubject = request.AuthContext.Subject
	record.Metadata = cloneStringMap(request.SessionSpec.Metadata)
	if existing != nil {
		record.Metadata = cloneStringMap(existing.Metadata)
	}
	if record.Generation <= 0 {
		record.Generation = 1
	} else {
		record.Generation++
	}
	return record
}

func desiredStateForCommand(command Command, fallback LifecycleState) LifecycleState {
	switch normalizeCommand(command) {
	case CommandRun:
		return StateRunning
	case CommandSuspend:
		return StateSuspended
	case CommandResume:
		return StateReady
	case CommandTerminate:
		return StateTerminated
	default:
		return fallback
	}
}

func firstNonEmptySlice(values []string, fallback []string) []string {
	normalized := normalizeStringSlice(values)
	if len(normalized) > 0 {
		return normalized
	}
	return normalizeStringSlice(fallback)
}

func providerBindingFromRecord(record SessionRecord) ProviderSessionBinding {
	record = normalizeSessionRecord(record)
	return ProviderSessionBinding{
		TenantID:          record.TenantID,
		Namespace:         record.Namespace,
		SessionID:         record.SessionID,
		ProviderMicroVMID: record.ProviderMicroVMID,
		RegistryVersion:   record.Generation,
	}
}

func providerSessionFromRecord(record SessionRecord) ProviderSession {
	record = normalizeSessionRecord(record)
	state, terminal, err := MapProviderState(record.ProviderState)
	if err != nil {
		state = record.State
		terminal = IsTerminalState(record.State)
	}
	return ProviderSession{
		TenantID:          record.TenantID,
		Namespace:         record.Namespace,
		SessionID:         record.SessionID,
		ProviderMicroVMID: record.ProviderMicroVMID,
		State:             state,
		ProviderState:     record.ProviderState,
		ImageRef:          record.ImageRef,
		ImageVersion:      record.ImageVersion,
		StartedAt:         record.ProviderStartedAt,
		TerminatedAt:      record.ProviderTerminatedAt,
		RegistryVersion:   record.Generation,
		Terminal:          terminal,
	}
}

func responseFromProviderSession(request ControllerRequest, session ProviderSession) ControllerResponse {
	return ControllerResponse{
		Command:           request.Command,
		RequestID:         request.RequestID,
		TenantID:          session.TenantID,
		Namespace:         session.Namespace,
		SessionID:         session.SessionID,
		State:             session.State,
		DesiredState:      desiredStateForCommand(request.Command, session.State),
		LifecycleState:    session.State,
		ProviderMicroVMID: session.ProviderMicroVMID,
		ProviderState:     session.ProviderState,
		LastAction:        request.Command,
		LastTransition:    time.Time{},
		RegistryVersion:   session.RegistryVersion,
	}
}

func responseFromProviderToken(request ControllerRequest, token ProviderToken) ControllerResponse {
	return ControllerResponse{
		Command:           request.Command,
		RequestID:         request.RequestID,
		TenantID:          token.TenantID,
		Namespace:         token.Namespace,
		SessionID:         token.SessionID,
		ProviderMicroVMID: token.ProviderMicroVMID,
		TokenID:           token.TokenID,
		TokenType:         token.TokenType,
		ExpiresAt:         token.ExpiresAt,
		Scope:             append([]string(nil), token.Scope...),
	}
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now().UTC() }

type randomIDGenerator struct{}

func (randomIDGenerator) NewID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return "microvm-" + hex.EncodeToString(buf[:])
	}
	return "microvm-" + time.Now().UTC().Format("20060102150405.000000000")
}
