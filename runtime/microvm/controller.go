package microvm

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

const (
	// ErrorCodeInvalidControllerRequest reports a malformed controller request envelope.
	ErrorCodeInvalidControllerRequest = "m15.microvm.invalid_controller_request"
	// ErrorCodeControllerCommandFailed reports a sanitized client command failure.
	ErrorCodeControllerCommandFailed = "m15.microvm.controller_command_failed"
)

// Command names a constrained MicroVM controller command.
type Command string

const (
	CommandCreate  Command = "create"
	CommandStart   Command = "start"
	CommandStop    Command = "stop"
	CommandStatus  Command = "status"
	CommandSession Command = "session"
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
	Command             Command     `json:"command"`
	RequestID           string      `json:"request_id"`
	TenantID            string      `json:"tenant_id"`
	Namespace           string      `json:"namespace"`
	AuthContext         AuthContext `json:"auth_context"`
	SessionID           string      `json:"session_id,omitempty"`
	ImageRef            string      `json:"image_ref,omitempty"`
	NetworkConnectorRef string      `json:"network_connector_ref,omitempty"`
	SessionSpec         SessionSpec `json:"session_spec,omitempty"`
}

// ControllerResponse is the safe controller response envelope.
type ControllerResponse struct {
	Command         Command        `json:"command"`
	RequestID       string         `json:"request_id"`
	TenantID        string         `json:"tenant_id,omitempty"`
	Namespace       string         `json:"namespace,omitempty"`
	SessionID       string         `json:"session_id,omitempty"`
	State           LifecycleState `json:"state,omitempty"`
	DesiredState    LifecycleState `json:"desired_state,omitempty"`
	LifecycleState  LifecycleState `json:"lifecycle_state,omitempty"`
	Endpoint        string         `json:"endpoint,omitempty"`
	MicroVMID       string         `json:"microvm_id,omitempty"`
	LastAction      Command        `json:"last_action,omitempty"`
	LastTransition  time.Time      `json:"last_transition,omitempty"`
	RegistryVersion int64          `json:"registry_version,omitempty"`
	Error           *SafeError     `json:"error,omitempty"`
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
	client       Client
	controllerID string
	clock        Clock
	ids          IDGenerator
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

// NewController creates a fail-closed MicroVM controller.
func NewController(client Client, opts ...ControllerOption) (*Controller, error) {
	if client == nil {
		return nil, safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller requires a constrained client", "")
	}
	controller := &Controller{
		client:       client,
		controllerID: "apptheory-microvm-controller",
		clock:        realClock{},
		ids:          randomIDGenerator{},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(controller)
		}
	}
	return controller, nil
}

// Handle executes a controller request after authenticated, tenant-bound envelope validation.
func (c *Controller) Handle(ctx context.Context, request ControllerRequest) (ControllerResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if c == nil || c.client == nil {
		err := safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller requires a constrained client", request.RequestID)
		return controllerErrorResponse(request, err), err
	}
	request = normalizeControllerRequest(request)
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
		return commandFailedResponse(request)
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
		return commandFailedResponse(request)
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
		return commandFailedResponse(request)
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
		return commandFailedResponse(request)
	}
	if err := ValidateSessionRecord(record); err != nil {
		safe := asSafeError(err, request.RequestID)
		return controllerErrorResponse(request, safe), safe
	}
	return responseFromSession(request, record), nil
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

func commandFailedResponse(request ControllerRequest) (ControllerResponse, error) {
	safe := safeError(ErrorCodeControllerCommandFailed, "apptheory: microvm controller command failed", request.RequestID)
	return controllerErrorResponse(request, safe), safe
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
	return validateSafeMetadata(request.SessionSpec.Metadata, request.RequestID)
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
	request.NetworkConnectorRef = strings.TrimSpace(request.NetworkConnectorRef)
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
		Command:         request.Command,
		RequestID:       request.RequestID,
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
	return Command(strings.TrimSpace(string(command)))
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
