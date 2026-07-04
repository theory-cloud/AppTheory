package microvm

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// AWSLambdaMicroVMProvider is the official AWS SDK-backed constrained provider adapter.
//
// The raw AWS SDK client and loaded AWS configuration remain private implementation details.
type AWSLambdaMicroVMProvider struct {
	api   lambdaMicroVMAPI
	clock Clock
}

// AWSLambdaMicroVMProviderOption configures the official AWS Lambda MicroVM provider adapter.
type AWSLambdaMicroVMProviderOption func(*awsLambdaMicroVMProviderConfig)

type awsLambdaMicroVMProviderConfig struct {
	region string
	clock  Clock
}

type lambdaMicroVMAPI interface {
	RunMicrovm(context.Context, *lambdamicrovms.RunMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error)
	GetMicrovm(context.Context, *lambdamicrovms.GetMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error)
	ListMicrovms(context.Context, *lambdamicrovms.ListMicrovmsInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error)
	SuspendMicrovm(context.Context, *lambdamicrovms.SuspendMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.SuspendMicrovmOutput, error)
	ResumeMicrovm(context.Context, *lambdamicrovms.ResumeMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ResumeMicrovmOutput, error)
	TerminateMicrovm(context.Context, *lambdamicrovms.TerminateMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error)
	CreateMicrovmAuthToken(context.Context, *lambdamicrovms.CreateMicrovmAuthTokenInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error)
	CreateMicrovmShellAuthToken(context.Context, *lambdamicrovms.CreateMicrovmShellAuthTokenInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmShellAuthTokenOutput, error)
}

var _ Provider = (*AWSLambdaMicroVMProvider)(nil)

// WithAWSLambdaMicroVMRegion sets the AWS region used by the official provider adapter.
func WithAWSLambdaMicroVMRegion(region string) AWSLambdaMicroVMProviderOption {
	return func(config *awsLambdaMicroVMProviderConfig) {
		if config == nil {
			return
		}
		config.region = strings.TrimSpace(region)
	}
}

// WithAWSLambdaMicroVMClock sets the clock used for sanitized token metadata.
func WithAWSLambdaMicroVMClock(clock Clock) AWSLambdaMicroVMProviderOption {
	return func(config *awsLambdaMicroVMProviderConfig) {
		if config == nil {
			return
		}
		if clock == nil {
			config.clock = realClock{}
			return
		}
		config.clock = clock
	}
}

// NewAWSLambdaMicroVMProvider creates an official AWS SDK-backed constrained provider adapter.
//
// AWS credentials and the raw SDK client are loaded and retained internally; callers receive only
// the AppTheory Provider interface implemented by the returned adapter.
func NewAWSLambdaMicroVMProvider(ctx context.Context, opts ...AWSLambdaMicroVMProviderOption) (*AWSLambdaMicroVMProvider, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	config := awsLambdaMicroVMProviderConfig{clock: realClock{}}
	for _, opt := range opts {
		if opt != nil {
			opt(&config)
		}
	}
	loadOptions := []func(*awsconfig.LoadOptions) error{}
	if config.region != "" {
		loadOptions = append(loadOptions, awsconfig.WithRegion(config.region))
	}
	awsConfig, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return nil, sanitizeProviderError(err, "")
	}
	return &AWSLambdaMicroVMProvider{
		api:   lambdamicrovms.NewFromConfig(awsConfig),
		clock: config.clock,
	}, nil
}

// Run maps a safe AppTheory run request to the official AWS RunMicrovm operation.
func (p *AWSLambdaMicroVMProvider) Run(ctx context.Context, input ProviderRunInput) (ProviderSession, error) {
	input, err := validateProviderRunInput(input)
	if err != nil {
		return ProviderSession{}, err
	}
	api, err := p.requireAPI(input.RequestID)
	if err != nil {
		return ProviderSession{}, err
	}
	out, err := api.RunMicrovm(ctxOrBackground(ctx), &lambdamicrovms.RunMicrovmInput{
		ImageIdentifier:          aws.String(input.ImageRef),
		ClientToken:              aws.String(input.RequestID),
		EgressNetworkConnectors:  providerEgressConnectors(input),
		ExecutionRoleArn:         optionalString(input.ExecutionRoleArn),
		ImageVersion:             optionalString(input.ImageVersion),
		IngressNetworkConnectors: input.IngressNetworkConnectorRefs,
		IdlePolicy:               awsIdlePolicy(input.IdlePolicy),
		MaximumDurationInSeconds: optionalInt32(input.MaximumDurationSeconds),
		RunHookPayload:           safeRunHookPayload(input),
	})
	if err != nil {
		return ProviderSession{}, sanitizeProviderError(err, input.RequestID)
	}
	return sessionFromRunOutput(input, out)
}

// Get maps a safe AppTheory get request to the official AWS GetMicrovm operation.
func (p *AWSLambdaMicroVMProvider) Get(ctx context.Context, input ProviderSessionInput) (ProviderSession, error) {
	input, err := validateProviderSessionInput(OperationGet, input)
	if err != nil {
		return ProviderSession{}, err
	}
	api, err := p.requireAPI(input.RequestID)
	if err != nil {
		return ProviderSession{}, err
	}
	out, err := api.GetMicrovm(ctxOrBackground(ctx), &lambdamicrovms.GetMicrovmInput{
		MicrovmIdentifier: aws.String(input.Binding.ProviderMicroVMID),
	})
	if err != nil {
		return ProviderSession{}, sanitizeProviderError(err, input.RequestID)
	}
	return sessionFromGetOutput(input.RequestID, input.Binding, out)
}

// List maps a tenant-bound AppTheory list request to the official AWS ListMicrovms operation.
func (p *AWSLambdaMicroVMProvider) List(ctx context.Context, input ProviderListInput) (ProviderListOutput, error) {
	input, err := validateProviderListInput(input)
	if err != nil {
		return ProviderListOutput{}, err
	}
	api, err := p.requireAPI(input.RequestID)
	if err != nil {
		return ProviderListOutput{}, err
	}
	out, err := api.ListMicrovms(ctxOrBackground(ctx), &lambdamicrovms.ListMicrovmsInput{
		ImageIdentifier: optionalString(input.ImageRef),
		ImageVersion:    optionalString(input.ImageVersion),
		MaxResults:      optionalInt32(input.MaxResults),
	})
	if err != nil {
		return ProviderListOutput{}, sanitizeProviderError(err, input.RequestID)
	}
	return listOutputFromSDK(input, out)
}

// Suspend maps a safe AppTheory suspend request to the official AWS SuspendMicrovm operation.
func (p *AWSLambdaMicroVMProvider) Suspend(ctx context.Context, input ProviderSessionInput) (ProviderSession, error) {
	return p.runStateChangingOperation(ctx, OperationSuspend, input, func(ctx context.Context, api lambdaMicroVMAPI, providerID string) error {
		_, err := api.SuspendMicrovm(ctx, &lambdamicrovms.SuspendMicrovmInput{MicrovmIdentifier: aws.String(providerID)})
		return err
	})
}

// Resume maps a safe AppTheory resume request to the official AWS ResumeMicrovm operation.
func (p *AWSLambdaMicroVMProvider) Resume(ctx context.Context, input ProviderSessionInput) (ProviderSession, error) {
	return p.runStateChangingOperation(ctx, OperationResume, input, func(ctx context.Context, api lambdaMicroVMAPI, providerID string) error {
		_, err := api.ResumeMicrovm(ctx, &lambdamicrovms.ResumeMicrovmInput{MicrovmIdentifier: aws.String(providerID)})
		return err
	})
}

// Terminate maps a safe AppTheory terminate request to the official AWS TerminateMicrovm operation.
func (p *AWSLambdaMicroVMProvider) Terminate(ctx context.Context, input ProviderSessionInput) (ProviderSession, error) {
	return p.runStateChangingOperation(ctx, OperationTerminate, input, func(ctx context.Context, api lambdaMicroVMAPI, providerID string) error {
		_, err := api.TerminateMicrovm(ctx, &lambdamicrovms.TerminateMicrovmInput{MicrovmIdentifier: aws.String(providerID)})
		return err
	})
}

// CreateAuthToken maps a safe AppTheory auth-token request to the official AWS token operation.
func (p *AWSLambdaMicroVMProvider) CreateAuthToken(ctx context.Context, input ProviderTokenInput) (ProviderToken, error) {
	input, err := validateProviderTokenInput(OperationAuthToken, input)
	if err != nil {
		return ProviderToken{}, err
	}
	api, err := p.requireAPI(input.RequestID)
	if err != nil {
		return ProviderToken{}, err
	}
	out, err := api.CreateMicrovmAuthToken(ctxOrBackground(ctx), &lambdamicrovms.CreateMicrovmAuthTokenInput{
		MicrovmIdentifier:   aws.String(input.Binding.ProviderMicroVMID),
		ExpirationInMinutes: aws.Int32(providerExpirationMinutes(input.TTLSeconds)),
		AllowedPorts:        awsPortScopes(input.AllowedPortScope),
	})
	if err != nil {
		return ProviderToken{}, sanitizeProviderError(err, input.RequestID)
	}
	if len(out.AuthToken) == 0 {
		return ProviderToken{}, safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider returned incomplete token metadata", input.RequestID)
	}
	return providerTokenMetadata(OperationAuthToken, input, p.now())
}

// CreateShellToken maps a safe AppTheory shell-token request to the official AWS token operation.
func (p *AWSLambdaMicroVMProvider) CreateShellToken(ctx context.Context, input ProviderTokenInput) (ProviderToken, error) {
	input, err := validateProviderTokenInput(OperationShellToken, input)
	if err != nil {
		return ProviderToken{}, err
	}
	api, err := p.requireAPI(input.RequestID)
	if err != nil {
		return ProviderToken{}, err
	}
	out, err := api.CreateMicrovmShellAuthToken(ctxOrBackground(ctx), &lambdamicrovms.CreateMicrovmShellAuthTokenInput{
		MicrovmIdentifier:   aws.String(input.Binding.ProviderMicroVMID),
		ExpirationInMinutes: aws.Int32(providerExpirationMinutes(input.TTLSeconds)),
	})
	if err != nil {
		return ProviderToken{}, sanitizeProviderError(err, input.RequestID)
	}
	if len(out.AuthToken) == 0 {
		return ProviderToken{}, safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm provider returned incomplete token metadata", input.RequestID)
	}
	return providerTokenMetadata(OperationShellToken, input, p.now())
}

func (p *AWSLambdaMicroVMProvider) runStateChangingOperation(
	ctx context.Context,
	operation Operation,
	input ProviderSessionInput,
	run func(context.Context, lambdaMicroVMAPI, string) error,
) (ProviderSession, error) {
	input, err := validateProviderSessionInput(operation, input)
	if err != nil {
		return ProviderSession{}, err
	}
	api, err := p.requireAPI(input.RequestID)
	if err != nil {
		return ProviderSession{}, err
	}
	ctx = ctxOrBackground(ctx)
	if runErr := run(ctx, api, input.Binding.ProviderMicroVMID); runErr != nil {
		return ProviderSession{}, sanitizeProviderError(runErr, input.RequestID)
	}
	out, err := api.GetMicrovm(ctx, &lambdamicrovms.GetMicrovmInput{
		MicrovmIdentifier: aws.String(input.Binding.ProviderMicroVMID),
	})
	if err != nil {
		return ProviderSession{}, sanitizeProviderError(err, input.RequestID)
	}
	return sessionFromGetOutput(input.RequestID, input.Binding, out)
}

func (p *AWSLambdaMicroVMProvider) requireAPI(requestID string) (lambdaMicroVMAPI, error) {
	if p == nil || p.api == nil {
		return nil, safeError(ErrorCodeProviderOperationFailed, "apptheory: microvm provider adapter requires official AWS Lambda MicroVM SDK client", requestID)
	}
	return p.api, nil
}

func (p *AWSLambdaMicroVMProvider) now() time.Time {
	if p == nil || p.clock == nil {
		return time.Unix(0, 0).UTC()
	}
	now := p.clock.Now()
	if now.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return now.UTC()
}

func sessionFromRunOutput(input ProviderRunInput, out *lambdamicrovms.RunMicrovmOutput) (ProviderSession, error) {
	if out == nil {
		return ProviderSession{}, safeError(ErrorCodeProviderOperationFailed, "apptheory: microvm provider run returned no result", input.RequestID)
	}
	binding := ProviderSessionBinding{
		TenantID:          input.TenantID,
		Namespace:         input.Namespace,
		SessionID:         input.SessionID,
		ProviderMicroVMID: aws.ToString(out.MicrovmId),
	}
	return sessionFromProviderState(binding, string(out.State), aws.ToString(out.ImageArn), aws.ToString(out.ImageVersion), timeFromPtr(out.StartedAt), timeFromPtr(out.TerminatedAt))
}

func sessionFromGetOutput(requestID string, binding ProviderSessionBinding, out *lambdamicrovms.GetMicrovmOutput) (ProviderSession, error) {
	if out == nil {
		return ProviderSession{}, safeError(ErrorCodeProviderOperationFailed, "apptheory: microvm provider get returned no result", requestID)
	}
	providerID := aws.ToString(out.MicrovmId)
	if providerID != "" && providerID != binding.ProviderMicroVMID {
		return ProviderSession{}, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm provider returned mismatched session binding", requestID)
	}
	return sessionFromProviderState(binding, string(out.State), aws.ToString(out.ImageArn), aws.ToString(out.ImageVersion), timeFromPtr(out.StartedAt), timeFromPtr(out.TerminatedAt))
}

func listOutputFromSDK(input ProviderListInput, out *lambdamicrovms.ListMicrovmsOutput) (ProviderListOutput, error) {
	if out == nil {
		return ProviderListOutput{}, safeError(ErrorCodeProviderOperationFailed, "apptheory: microvm provider list returned no result", input.RequestID)
	}
	bindings := map[string]ProviderSessionBinding{}
	for _, binding := range input.KnownSessions {
		bindings[binding.ProviderMicroVMID] = binding
	}
	sessions := make([]ProviderSession, 0, len(out.Items))
	for _, item := range out.Items {
		providerID := aws.ToString(item.MicrovmId)
		binding, ok := bindings[providerID]
		if !ok {
			continue
		}
		session, err := sessionFromProviderState(binding, string(item.State), aws.ToString(item.ImageArn), aws.ToString(item.ImageVersion), timeFromPtr(item.StartedAt), time.Time{})
		if err != nil {
			return ProviderListOutput{}, err
		}
		sessions = append(sessions, session)
	}
	return ProviderListOutput{Sessions: sessions}, nil
}

func awsIdlePolicy(policy *ProviderIdlePolicy) *lambdatypes.IdlePolicy {
	if policy == nil {
		return nil
	}
	return &lambdatypes.IdlePolicy{
		AutoResumeEnabled:        aws.Bool(policy.AutoResumeEnabled),
		MaxIdleDurationSeconds:   aws.Int32(policy.MaxIdleDurationSeconds),
		SuspendedDurationSeconds: aws.Int32(policy.SuspendedDurationSeconds),
	}
}

func awsPortScopes(scopes []ProviderPortScope) []lambdatypes.PortSpecification {
	out := make([]lambdatypes.PortSpecification, 0, len(scopes))
	for _, scope := range scopes {
		switch {
		case scope.AllPorts:
			out = append(out, &lambdatypes.PortSpecificationMemberAllPorts{Value: lambdatypes.Unit{}})
		case scope.Port > 0:
			out = append(out, &lambdatypes.PortSpecificationMemberPort{Value: scope.Port})
		default:
			out = append(out, &lambdatypes.PortSpecificationMemberRange{
				Value: lambdatypes.PortRange{
					StartPort: aws.Int32(scope.StartPort),
					EndPort:   aws.Int32(scope.EndPort),
				},
			})
		}
	}
	return out
}

func providerEgressConnectors(input ProviderRunInput) []string {
	connectors := append([]string{}, input.EgressNetworkConnectorRefs...)
	if input.NetworkConnectorRef != "" {
		connectors = append(connectors, input.NetworkConnectorRef)
	}
	return normalizeStringSlice(connectors)
}

func safeRunHookPayload(input ProviderRunInput) *string {
	payload := map[string]string{
		"request_id": input.RequestID,
		"tenant_id":  input.TenantID,
		"namespace":  input.Namespace,
		"session_id": input.SessionID,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return aws.String(string(data))
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return aws.String(value)
}

func optionalInt32(value int32) *int32 {
	if value <= 0 {
		return nil
	}
	return aws.Int32(value)
}

func timeFromPtr(value *time.Time) time.Time {
	if value == nil || value.IsZero() {
		return time.Time{}
	}
	return value.UTC()
}

func providerExpirationMinutes(ttlSeconds int32) int32 {
	return int32(math.Ceil(float64(ttlSeconds) / 60.0))
}

func ctxOrBackground(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
