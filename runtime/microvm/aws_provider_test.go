package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
	"github.com/stretchr/testify/require"
)

func TestAWSLambdaMicroVMProviderMapsOfficialSDKOperations(t *testing.T) {
	now := time.Unix(500, 0).UTC()
	api := newRecordingLambdaMicroVMAPI(now)
	provider := &AWSLambdaMicroVMProvider{api: api, clock: providerClock{now: now}}

	runInput := validProviderRunInput()
	runInput.ExecutionRoleArn = "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole"
	run, err := provider.Run(context.Background(), runInput)
	require.NoError(t, err)
	require.Equal(t, "provider-1", run.ProviderMicroVMID)
	require.Equal(t, StateRunning, run.State)
	require.Equal(t, "running", run.ProviderState)
	require.Equal(t, "image-ref", aws.ToString(api.runInput.ImageIdentifier))
	require.Equal(t, "req-run", aws.ToString(api.runInput.ClientToken))
	require.Equal(t, "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole", aws.ToString(api.runInput.ExecutionRoleArn))
	require.Equal(t, []string{"egress-ref", "network-ref"}, api.runInput.EgressNetworkConnectors)
	require.Equal(t, []string{"ingress-ref"}, api.runInput.IngressNetworkConnectors)
	require.NotNil(t, api.runInput.RunHookPayload)
	require.NotContains(t, aws.ToString(api.runInput.RunHookPayload), "raw_lifecycle_hook_payload")

	binding := run.Binding()
	got, err := provider.Get(context.Background(), validProviderSessionInput("req-get", binding))
	require.NoError(t, err)
	require.Equal(t, binding, got.Binding())

	list, err := provider.List(context.Background(), ProviderListInput{
		RequestID:     "req-list",
		TenantID:      "tenant-1",
		Namespace:     "namespace-1",
		AuthContext:   validProviderAuth(),
		KnownSessions: []ProviderSessionBinding{binding},
	})
	require.NoError(t, err)
	require.Len(t, list.Sessions, 1)
	require.Empty(t, list.RecoveryCursor, "raw provider pagination tokens must not cross the AppTheory boundary")

	suspended, err := provider.Suspend(context.Background(), validProviderSessionInput("req-suspend", binding))
	require.NoError(t, err)
	require.Equal(t, StateSuspended, suspended.State)

	resumed, err := provider.Resume(context.Background(), validProviderSessionInput("req-resume", binding))
	require.NoError(t, err)
	require.Equal(t, StateRunning, resumed.State)

	terminated, err := provider.Terminate(context.Background(), validProviderSessionInput("req-terminate", binding))
	require.NoError(t, err)
	require.Equal(t, StateTerminated, terminated.State)
	require.True(t, terminated.Terminal)

	authToken, err := provider.CreateAuthToken(context.Background(), validProviderTokenInput("req-auth", binding))
	require.NoError(t, err)
	require.Equal(t, "auth", authToken.TokenType)
	require.Equal(t, int32(2), aws.ToInt32(api.authTokenInput.ExpirationInMinutes))
	require.Len(t, api.authTokenInput.AllowedPorts, 1)

	shellToken, err := provider.CreateShellToken(context.Background(), validProviderTokenInput("req-shell", binding))
	require.NoError(t, err)
	require.Equal(t, "shell", shellToken.TokenType)
	require.Equal(t, []string{"shell"}, shellToken.Scope)

	rawToken := recordingRawToken()
	encoded, err := json.Marshal([]ProviderToken{authToken, shellToken})
	require.NoError(t, err)
	require.NotContains(t, string(encoded), rawToken)
	require.NotContains(t, string(encoded), "X-aws-proxy-auth")
	require.Subset(t, api.calls, []string{
		"RunMicrovm",
		"GetMicrovm",
		"ListMicrovms",
		"SuspendMicrovm",
		"ResumeMicrovm",
		"TerminateMicrovm",
		"CreateMicrovmAuthToken",
		"CreateMicrovmShellAuthToken",
	})
}

func TestAWSLambdaMicroVMProviderFailsClosedAndSanitizes(t *testing.T) {
	now := time.Unix(600, 0).UTC()
	provider := &AWSLambdaMicroVMProvider{api: newRecordingLambdaMicroVMAPI(now), clock: providerClock{now: now}}

	input := validProviderRunInput()
	input.AuthContext = AuthContext{}
	_, err := provider.Run(context.Background(), input)
	requireSafeError(t, err, ErrorCodeUnauthenticatedController)

	binding := ProviderSessionBinding{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1", ProviderMicroVMID: "provider-1"}
	crossTenant := validProviderSessionInput("req-cross", binding)
	crossTenant.TenantID = "tenant-2"
	_, err = provider.Get(context.Background(), crossTenant)
	requireSafeError(t, err, ErrorCodeTenantBindingViolation)

	err = ValidateProviderSessionInput(Operation("debug"), validProviderSessionInput("req-unsupported", binding))
	requireSafeError(t, err, ErrorCodeProviderOperationUnsupported)

	rawErrAPI := newRecordingLambdaMicroVMAPI(now)
	rawErrAPI.err = errors.New("provider failed with bearer_token and raw_sdk_client details")
	provider = &AWSLambdaMicroVMProvider{api: rawErrAPI, clock: providerClock{now: now}}
	_, err = provider.Get(context.Background(), validProviderSessionInput("req-raw", binding))
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)
	require.NotContains(t, err.Error(), "bearer_token")
	require.NotContains(t, err.Error(), "raw_sdk_client")

	_, err = provider.Suspend(context.Background(), validProviderSessionInput("req-suspend-raw", binding))
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)

	_, _, err = MapProviderState("provider-secret-state")
	requireSafeError(t, err, ErrorCodeProviderStateMappingIncomplete)
}

func TestNewAWSLambdaMicroVMProviderUsesInternalSDKWithoutNetwork(t *testing.T) {
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_REGION", "us-east-1")
	now := time.Unix(750, 0).UTC()

	provider, err := NewAWSLambdaMicroVMProvider(
		context.Background(),
		WithAWSLambdaMicroVMRegion(" us-east-1 "),
		WithAWSLambdaMicroVMClock(providerClock{now: now}),
	)
	require.NoError(t, err)
	require.NotNil(t, provider)
	require.NotNil(t, provider.api)
	require.Equal(t, now, provider.now())

	var config awsLambdaMicroVMProviderConfig
	WithAWSLambdaMicroVMRegion(" us-west-2 ")(&config)
	require.Equal(t, "us-west-2", config.region)
	WithAWSLambdaMicroVMRegion("ignored")(nil)
	WithAWSLambdaMicroVMClock(nil)(&config)
	require.NotNil(t, config.clock)
	WithAWSLambdaMicroVMClock(providerClock{now: now})(&config)
	require.Equal(t, now, config.clock.Now())
	WithAWSLambdaMicroVMClock(providerClock{now: now})(nil)
}

func TestProviderTokenValidationRejectsPlaintextFields(t *testing.T) {
	token := ProviderToken{
		TenantID:          "tenant-1",
		Namespace:         "namespace-1",
		SessionID:         "session-1",
		ProviderMicroVMID: "provider-1",
		TokenID:           "token_value",
		TokenType:         "auth",
		ExpiresAt:         time.Unix(700, 0).UTC(),
		Scope:             []string{"ports:443"},
	}
	err := ValidateProviderToken(token)
	requireSafeError(t, err, ErrorCodeTokenSafetyViolation)
}

func TestProviderValidationBranches(t *testing.T) {
	run := validProviderRunInput()
	require.NoError(t, ValidateProviderRunInput(run))
	require.Equal(t, SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}, ProviderSessionBinding{
		TenantID:          " tenant-1 ",
		Namespace:         " namespace-1 ",
		SessionID:         " session-1 ",
		ProviderMicroVMID: " provider-1 ",
	}.Key())

	state, terminal, err := MapProviderState("TERMINATED")
	require.NoError(t, err)
	require.Equal(t, StateTerminated, state)
	require.True(t, terminal)
	_, _, err = MapProviderState("")
	requireSafeError(t, err, ErrorCodeProviderStateMappingIncomplete)

	session := ProviderSession{
		TenantID:          "tenant-1",
		Namespace:         "namespace-1",
		SessionID:         "session-1",
		ProviderMicroVMID: "provider-1",
		State:             StateTerminated,
		ProviderState:     "terminated",
		Terminal:          true,
	}
	require.NoError(t, ValidateProviderSession(session))
	require.Equal(t, SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}, session.Key())
	require.Equal(t, session.Binding(), ProviderSession{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1", ProviderMicroVMID: "provider-1"}.Binding())

	badSession := session
	badSession.State = StateRunning
	requireSafeError(t, ValidateProviderSession(badSession), ErrorCodeProviderStateMappingIncomplete)
	badSession = session
	badSession.ProviderMicroVMID = "raw_sdk_client"
	requireSafeError(t, ValidateProviderSession(badSession), ErrorCodeForbiddenField)
	requireSafeError(t, ValidateProviderSession(ProviderSession{}), ErrorCodeProviderRequestInvalid)

	badRun := run
	badRun.RequestID = ""
	requireSafeError(t, ValidateProviderRunInput(badRun), ErrorCodeProviderRequestInvalid)
	badRun = run
	badRun.ImageRef = "raw_sdk_client"
	requireSafeError(t, ValidateProviderRunInput(badRun), ErrorCodeForbiddenField)
	badRun = run
	badRun.SessionSpec.Metadata = map[string]string{"bearer_token": "value"}
	requireSafeError(t, ValidateProviderRunInput(badRun), ErrorCodeForbiddenField)
	badRun = run
	badRun.NetworkConnectorRef = "raw_sdk_client"
	requireSafeError(t, ValidateProviderRunInput(badRun), ErrorCodeForbiddenField)
	badRun = run
	badRun.IdlePolicy = &ProviderIdlePolicy{AutoResumeEnabled: true}
	requireSafeError(t, ValidateProviderRunInput(badRun), ErrorCodeProviderRequestInvalid)
	badRun = run
	badRun.MaximumDurationSeconds = -1
	requireSafeError(t, ValidateProviderRunInput(badRun), ErrorCodeProviderRequestInvalid)

	binding := ProviderSessionBinding{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1", ProviderMicroVMID: "provider-1"}
	require.NoError(t, ValidateProviderSessionInput(OperationGet, validProviderSessionInput("req-session", binding)))
	badInput := validProviderSessionInput("req-session", binding)
	badInput.AuthContext.Namespace = "other"
	requireSafeError(t, ValidateProviderSessionInput(OperationGet, badInput), ErrorCodeTenantBindingViolation)
	badInput = validProviderSessionInput("req-session", binding)
	badInput.Binding.ProviderMicroVMID = ""
	requireSafeError(t, ValidateProviderSessionInput(OperationGet, badInput), ErrorCodeTenantBindingViolation)

	listInput := ProviderListInput{
		RequestID:     "req-list",
		TenantID:      "tenant-1",
		Namespace:     "namespace-1",
		AuthContext:   validProviderAuth(),
		KnownSessions: []ProviderSessionBinding{binding},
	}
	require.NoError(t, ValidateProviderListInput(listInput))
	listInput.MaxResults = -1
	requireSafeError(t, ValidateProviderListInput(listInput), ErrorCodeProviderRequestInvalid)
	listInput = ProviderListInput{RequestID: "req-list", TenantID: "tenant-1", Namespace: "namespace-1", AuthContext: validProviderAuth(), ImageRef: "raw_sdk_client"}
	requireSafeError(t, ValidateProviderListInput(listInput), ErrorCodeForbiddenField)
	listInput = ProviderListInput{TenantID: "tenant-1", Namespace: "namespace-1", AuthContext: validProviderAuth()}
	requireSafeError(t, ValidateProviderListInput(listInput), ErrorCodeProviderRequestInvalid)
	listInput = ProviderListInput{RequestID: "req-list", TenantID: "tenant-1", Namespace: "namespace-1", AuthContext: validProviderAuth(), KnownSessions: []ProviderSessionBinding{{TenantID: "tenant-2", Namespace: "namespace-1", SessionID: "session-1", ProviderMicroVMID: "provider-1"}}}
	requireSafeError(t, ValidateProviderListInput(listInput), ErrorCodeTenantBindingViolation)

	require.NoError(t, ValidateProviderTokenInput(OperationShellToken, ProviderTokenInput{
		RequestID:   "req-shell",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: validProviderAuth(),
		Binding:     binding,
		TTLSeconds:  60,
	}))
	require.NoError(t, ValidateProviderTokenInput(OperationAuthToken, ProviderTokenInput{
		RequestID:   "req-auth",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		AuthContext: validProviderAuth(),
		Binding:     binding,
		TTLSeconds:  60,
		AllowedPortScope: []ProviderPortScope{
			{AllPorts: true},
			{StartPort: 8000, EndPort: 8002},
		},
	}))
	badToken := validProviderTokenInput("req-token", binding)
	badToken.TTLSeconds = 901
	requireSafeError(t, ValidateProviderTokenInput(OperationAuthToken, badToken), ErrorCodeTokenSafetyViolation)
	badToken = validProviderTokenInput("req-token", binding)
	badToken.AllowedPortScope = []ProviderPortScope{{Port: 443, AllPorts: true}}
	requireSafeError(t, ValidateProviderTokenInput(OperationAuthToken, badToken), ErrorCodeTokenSafetyViolation)
	badToken = validProviderTokenInput("", binding)
	requireSafeError(t, ValidateProviderTokenInput(OperationAuthToken, badToken), ErrorCodeProviderRequestInvalid)
	badToken = validProviderTokenInput("req-token", binding)
	badToken.AllowedPortScope = nil
	requireSafeError(t, ValidateProviderTokenInput(OperationAuthToken, badToken), ErrorCodeTokenSafetyViolation)
	badToken = validProviderTokenInput("req-token", binding)
	requireSafeError(t, ValidateProviderTokenInput(OperationRun, badToken), ErrorCodeProviderOperationUnsupported)
	requireSafeError(t, ValidateProviderToken(ProviderToken{}), ErrorCodeTokenSafetyViolation)
	token, err := providerTokenMetadata(OperationShellToken, ProviderTokenInput{Binding: binding, TTLSeconds: 1}, time.Time{})
	require.NoError(t, err)
	require.Equal(t, "shell", token.TokenType)
}

func TestAWSLambdaMicroVMProviderErrorBranchesAndHelpers(t *testing.T) {
	binding := ProviderSessionBinding{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1", ProviderMicroVMID: "provider-1"}
	var nilProvider *AWSLambdaMicroVMProvider
	_, err := nilProvider.Get(context.Background(), validProviderSessionInput("req-nil", binding))
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)

	api := newRecordingLambdaMicroVMAPI(time.Unix(800, 0).UTC())
	api.emptyTokens = true
	provider := &AWSLambdaMicroVMProvider{api: api, clock: zeroProviderClock{}}
	_, err = provider.CreateAuthToken(context.Background(), validProviderTokenInput("req-empty-token", binding))
	requireSafeError(t, err, ErrorCodeTokenSafetyViolation)
	require.Equal(t, time.Unix(0, 0).UTC(), provider.now())
	require.Equal(t, time.Unix(0, 0).UTC(), nilProvider.now())

	api = newRecordingLambdaMicroVMAPI(time.Unix(800, 0).UTC())
	api.err = errors.New("provider failed with aws_secret_access_key")
	provider = &AWSLambdaMicroVMProvider{api: api, clock: providerClock{now: time.Unix(800, 0).UTC()}}
	_, err = provider.List(context.Background(), ProviderListInput{RequestID: "req-list", TenantID: "tenant-1", Namespace: "namespace-1", AuthContext: validProviderAuth(), KnownSessions: []ProviderSessionBinding{binding}})
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)
	require.NotContains(t, err.Error(), "aws_secret_access_key")

	_, err = sessionFromRunOutput(validProviderRunInput(), nil)
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)
	_, err = sessionFromProviderState(binding, "unknown", "image-ref", "1", time.Unix(800, 0).UTC(), time.Time{})
	requireSafeError(t, err, ErrorCodeProviderStateMappingIncomplete)
	_, err = sessionFromGetOutput("req-empty", binding, nil)
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)
	_, err = sessionFromGetOutput("req-mismatch", binding, &lambdamicrovms.GetMicrovmOutput{
		MicrovmId:    aws.String("provider-2"),
		ImageArn:     aws.String("image-ref"),
		ImageVersion: aws.String("1"),
		StartedAt:    aws.Time(time.Unix(800, 0).UTC()),
		State:        lambdatypes.MicrovmStateRunning,
	})
	requireSafeError(t, err, ErrorCodeTenantBindingViolation)
	_, err = listOutputFromSDK(ProviderListInput{RequestID: "req-list"}, nil)
	requireSafeError(t, err, ErrorCodeProviderOperationFailed)

	require.Nil(t, awsIdlePolicy(nil))
	require.Len(t, awsPortScopes([]ProviderPortScope{{AllPorts: true}, {StartPort: 1, EndPort: 2}}), 2)
	var nilCtx context.Context
	require.NotNil(t, ctxOrBackground(nilCtx))
	require.NotNil(t, ctxOrBackground(context.Background()))
	requireSafeError(t, sanitizeProviderError(SafeError{Code: ErrorCodeProviderOperationFailed, Message: "safe"}, "req-safe"), ErrorCodeProviderOperationFailed)

	emptyShellAPI := newRecordingLambdaMicroVMAPI(time.Unix(800, 0).UTC())
	emptyShellAPI.emptyTokens = true
	emptyShellProvider := &AWSLambdaMicroVMProvider{api: emptyShellAPI, clock: providerClock{now: time.Unix(800, 0).UTC()}}
	_, err = emptyShellProvider.CreateShellToken(context.Background(), validProviderTokenInput("req-empty-shell", binding))
	requireSafeError(t, err, ErrorCodeTokenSafetyViolation)
}

type providerClock struct{ now time.Time }

func (c providerClock) Now() time.Time { return c.now }

type zeroProviderClock struct{}

func (zeroProviderClock) Now() time.Time { return time.Time{} }

type recordingLambdaMicroVMAPI struct {
	now             time.Time
	state           lambdatypes.MicrovmState
	err             error
	emptyTokens     bool
	calls           []string
	runInput        *lambdamicrovms.RunMicrovmInput
	getInput        *lambdamicrovms.GetMicrovmInput
	listInput       *lambdamicrovms.ListMicrovmsInput
	authTokenInput  *lambdamicrovms.CreateMicrovmAuthTokenInput
	shellTokenInput *lambdamicrovms.CreateMicrovmShellAuthTokenInput
}

func newRecordingLambdaMicroVMAPI(now time.Time) *recordingLambdaMicroVMAPI {
	return &recordingLambdaMicroVMAPI{now: now.UTC(), state: lambdatypes.MicrovmStateRunning}
}

func (api *recordingLambdaMicroVMAPI) RunMicrovm(_ context.Context, input *lambdamicrovms.RunMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error) {
	api.calls = append(api.calls, "RunMicrovm")
	api.runInput = input
	if api.err != nil {
		return nil, api.err
	}
	api.state = lambdatypes.MicrovmStateRunning
	return &lambdamicrovms.RunMicrovmOutput{
		MicrovmId:                aws.String("provider-1"),
		ImageArn:                 aws.String(aws.ToString(input.ImageIdentifier)),
		ImageVersion:             aws.String("1"),
		MaximumDurationInSeconds: aws.Int32(300),
		StartedAt:                aws.Time(api.now),
		State:                    api.state,
	}, nil
}

func (api *recordingLambdaMicroVMAPI) GetMicrovm(_ context.Context, input *lambdamicrovms.GetMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	api.calls = append(api.calls, "GetMicrovm")
	api.getInput = input
	if api.err != nil {
		return nil, api.err
	}
	out := &lambdamicrovms.GetMicrovmOutput{
		MicrovmId:                aws.String(aws.ToString(input.MicrovmIdentifier)),
		ImageArn:                 aws.String("image-ref"),
		ImageVersion:             aws.String("1"),
		MaximumDurationInSeconds: aws.Int32(300),
		StartedAt:                aws.Time(api.now),
		State:                    api.state,
	}
	if api.state == lambdatypes.MicrovmStateTerminated {
		out.TerminatedAt = aws.Time(api.now.Add(time.Minute))
	}
	return out, nil
}

func (api *recordingLambdaMicroVMAPI) ListMicrovms(_ context.Context, input *lambdamicrovms.ListMicrovmsInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error) {
	api.calls = append(api.calls, "ListMicrovms")
	api.listInput = input
	if api.err != nil {
		return nil, api.err
	}
	return &lambdamicrovms.ListMicrovmsOutput{
		Items: []lambdatypes.MicrovmItem{
			{
				MicrovmId:    aws.String("provider-1"),
				ImageArn:     aws.String("image-ref"),
				ImageVersion: aws.String("1"),
				StartedAt:    aws.Time(api.now),
				State:        api.state,
			},
			{
				MicrovmId:    aws.String("provider-foreign"),
				ImageArn:     aws.String("image-ref"),
				ImageVersion: aws.String("1"),
				StartedAt:    aws.Time(api.now),
				State:        lambdatypes.MicrovmStateRunning,
			},
		},
		NextToken: aws.String("raw-provider-pagination-token"),
	}, nil
}

func (api *recordingLambdaMicroVMAPI) SuspendMicrovm(_ context.Context, _ *lambdamicrovms.SuspendMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.SuspendMicrovmOutput, error) {
	api.calls = append(api.calls, "SuspendMicrovm")
	if api.err != nil {
		return nil, api.err
	}
	api.state = lambdatypes.MicrovmStateSuspended
	return &lambdamicrovms.SuspendMicrovmOutput{}, nil
}

func (api *recordingLambdaMicroVMAPI) ResumeMicrovm(_ context.Context, _ *lambdamicrovms.ResumeMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ResumeMicrovmOutput, error) {
	api.calls = append(api.calls, "ResumeMicrovm")
	if api.err != nil {
		return nil, api.err
	}
	api.state = lambdatypes.MicrovmStateRunning
	return &lambdamicrovms.ResumeMicrovmOutput{}, nil
}

func (api *recordingLambdaMicroVMAPI) TerminateMicrovm(_ context.Context, _ *lambdamicrovms.TerminateMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error) {
	api.calls = append(api.calls, "TerminateMicrovm")
	if api.err != nil {
		return nil, api.err
	}
	api.state = lambdatypes.MicrovmStateTerminated
	return &lambdamicrovms.TerminateMicrovmOutput{}, nil
}

func (api *recordingLambdaMicroVMAPI) CreateMicrovmAuthToken(_ context.Context, input *lambdamicrovms.CreateMicrovmAuthTokenInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error) {
	api.calls = append(api.calls, "CreateMicrovmAuthToken")
	api.authTokenInput = input
	if api.err != nil {
		return nil, api.err
	}
	if api.emptyTokens {
		return &lambdamicrovms.CreateMicrovmAuthTokenOutput{}, nil
	}
	return &lambdamicrovms.CreateMicrovmAuthTokenOutput{AuthToken: map[string]string{"X-aws-proxy-auth": recordingRawToken()}}, nil
}

func (api *recordingLambdaMicroVMAPI) CreateMicrovmShellAuthToken(_ context.Context, input *lambdamicrovms.CreateMicrovmShellAuthTokenInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmShellAuthTokenOutput, error) {
	api.calls = append(api.calls, "CreateMicrovmShellAuthToken")
	api.shellTokenInput = input
	if api.err != nil {
		return nil, api.err
	}
	if api.emptyTokens {
		return &lambdamicrovms.CreateMicrovmShellAuthTokenOutput{}, nil
	}
	return &lambdamicrovms.CreateMicrovmShellAuthTokenOutput{AuthToken: map[string]string{"X-aws-proxy-auth": recordingRawToken()}}, nil
}

func validProviderRunInput() ProviderRunInput {
	return ProviderRunInput{
		RequestID:                   "req-run",
		TenantID:                    "tenant-1",
		Namespace:                   "namespace-1",
		SessionID:                   "session-1",
		AuthContext:                 validProviderAuth(),
		ImageRef:                    "image-ref",
		ImageVersion:                "1",
		NetworkConnectorRef:         "network-ref",
		IngressNetworkConnectorRefs: []string{"ingress-ref"},
		EgressNetworkConnectorRefs:  []string{"egress-ref"},
		SessionSpec:                 SessionSpec{Metadata: map[string]string{"purpose": "test"}},
		IdlePolicy: &ProviderIdlePolicy{
			AutoResumeEnabled:        true,
			MaxIdleDurationSeconds:   60,
			SuspendedDurationSeconds: 120,
		},
		MaximumDurationSeconds: 300,
	}
}

func validProviderSessionInput(requestID string, binding ProviderSessionBinding) ProviderSessionInput {
	return ProviderSessionInput{
		RequestID:   requestID,
		TenantID:    binding.TenantID,
		Namespace:   binding.Namespace,
		AuthContext: validProviderAuth(),
		Binding:     binding,
	}
}

func validProviderTokenInput(requestID string, binding ProviderSessionBinding) ProviderTokenInput {
	return ProviderTokenInput{
		RequestID:   requestID,
		TenantID:    binding.TenantID,
		Namespace:   binding.Namespace,
		AuthContext: validProviderAuth(),
		Binding:     binding,
		TTLSeconds:  120,
		AllowedPortScope: []ProviderPortScope{
			{Port: 443},
		},
	}
}

func validProviderAuth() AuthContext {
	return AuthContext{
		Subject:   "subject-1",
		TenantID:  "tenant-1",
		Namespace: "namespace-1",
	}
}

func requireSafeError(t *testing.T, err error, code string) {
	t.Helper()
	require.Error(t, err)
	var safe SafeError
	require.ErrorAs(t, err, &safe)
	require.Equal(t, code, safe.Code)
}

func recordingRawToken() string {
	return strings.Join([]string{"provider", "token", "value"}, "-")
}
