package runtimeaws

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	ststypes "github.com/aws/aws-sdk-go-v2/service/sts/types"
)

type fakeAssumeRoleClient struct {
	output *sts.AssumeRoleOutput
	err    error
	calls  int
	input  *sts.AssumeRoleInput
}

func (f *fakeAssumeRoleClient) AssumeRole(
	_ context.Context,
	input *sts.AssumeRoleInput,
	_ ...func(*sts.Options),
) (*sts.AssumeRoleOutput, error) {
	f.calls++
	f.input = input
	return f.output, f.err
}

type fakeCallerIdentityClient struct {
	output *sts.GetCallerIdentityOutput
	err    error
	calls  int
}

func (f *fakeCallerIdentityClient) GetCallerIdentity(
	context.Context,
	*sts.GetCallerIdentityInput,
	...func(*sts.Options),
) (*sts.GetCallerIdentityOutput, error) {
	f.calls++
	return f.output, f.err
}

func TestAssertAccountExplicitStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		expected   string
		client     *fakeCallerIdentityClient
		wantState  AccountAssertionState
		wantActual string
		wantErr    error
		wantCause  error
	}{
		{
			name:      "expected account not configured",
			expected:  "   ",
			client:    &fakeCallerIdentityClient{},
			wantState: AccountAssertionNotConfigured,
			wantErr:   ErrExpectedAccountNotConfigured,
		},
		{
			name:     "identity API unavailable",
			expected: "111122223333",
			client: &fakeCallerIdentityClient{
				output: &sts.GetCallerIdentityOutput{Account: awssdk.String("111122223333")},
				err:    context.Canceled,
			},
			wantState: AccountAssertionUnavailable,
			wantErr:   ErrCallerIdentityUnavailable,
			wantCause: context.Canceled,
		},
		{
			name:      "identity output unavailable",
			expected:  "111122223333",
			client:    &fakeCallerIdentityClient{output: &sts.GetCallerIdentityOutput{}},
			wantState: AccountAssertionUnavailable,
			wantErr:   ErrCallerIdentityUnavailable,
		},
		{
			name:       "account mismatch",
			expected:   "111122223333",
			client:     &fakeCallerIdentityClient{output: &sts.GetCallerIdentityOutput{Account: awssdk.String("444455556666")}},
			wantState:  AccountAssertionMismatch,
			wantActual: "444455556666",
			wantErr:    ErrAccountMismatch,
		},
		{
			name:       "account verified",
			expected:   " 111122223333 ",
			client:     &fakeCallerIdentityClient{output: &sts.GetCallerIdentityOutput{Account: awssdk.String(" 111122223333 ")}},
			wantState:  AccountAssertionVerified,
			wantActual: "111122223333",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			assertion, err := AssertAccount(context.Background(), test.client, test.expected)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("AssertAccount() error = %v, want errors.Is(%v)", err, test.wantErr)
			}
			if test.wantCause != nil && !errors.Is(err, test.wantCause) {
				t.Fatalf("AssertAccount() error = %v, want errors.Is(%v)", err, test.wantCause)
			}
			if assertion.State != test.wantState {
				t.Fatalf("AssertAccount() state = %q, want %q", assertion.State, test.wantState)
			}
			if assertion.ExpectedAccountID != strings.TrimSpace(test.expected) {
				t.Fatalf("AssertAccount() expected = %q, want %q", assertion.ExpectedAccountID, strings.TrimSpace(test.expected))
			}
			if assertion.ActualAccountID != test.wantActual {
				t.Fatalf("AssertAccount() actual = %q, want %q", assertion.ActualAccountID, test.wantActual)
			}
			wantCalls := 1
			if test.wantState == AccountAssertionNotConfigured {
				wantCalls = 0
			}
			if test.client.calls != wantCalls {
				t.Fatalf("GetCallerIdentity calls = %d, want %d", test.client.calls, wantCalls)
			}
		})
	}
}

func TestAssumeFirstFailureDoesNotExposeCredentials(t *testing.T) {
	t.Parallel()

	assumer := successfulAssumer()
	assumer.err = context.Canceled
	factoryCalls := 0
	result, err := AssumeFirst(
		context.Background(),
		assumer,
		func(awssdk.CredentialsProvider) CallerIdentityAPI {
			factoryCalls++
			return &fakeCallerIdentityClient{}
		},
		AssumeRoleRequest{
			RoleARN:           "arn:aws:iam::111122223333:role/Deploy",
			RoleSessionName:   "apptheory-test",
			ExpectedAccountID: "111122223333",
		},
	)
	if !errors.Is(err, ErrAssumeRoleFailed) {
		t.Fatalf("AssumeFirst() error = %v, want ErrAssumeRoleFailed", err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("AssumeFirst() error = %v, want context.Canceled", err)
	}
	if result.Assertion.State != AccountAssertionAssumeFailed {
		t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, AccountAssertionAssumeFailed)
	}
	if result.Credentials != nil {
		t.Fatal("AssumeFirst() exposed credentials after assume failure")
	}
	if factoryCalls != 0 {
		t.Fatalf("identity factory calls = %d, want 0", factoryCalls)
	}
}

func TestAssumeFirstRejectsMissingAssumeInputs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		assumer AssumeRoleAPI
		request AssumeRoleRequest
	}{
		{
			name: "nil assumer",
			request: AssumeRoleRequest{
				RoleARN:           "arn:aws:iam::111122223333:role/Deploy",
				RoleSessionName:   "apptheory-test",
				ExpectedAccountID: "111122223333",
			},
		},
		{
			name:    "empty role ARN",
			assumer: successfulAssumer(),
			request: AssumeRoleRequest{
				RoleARN:           " ",
				RoleSessionName:   "apptheory-test",
				ExpectedAccountID: "111122223333",
			},
		},
		{
			name:    "empty role session name",
			assumer: successfulAssumer(),
			request: AssumeRoleRequest{
				RoleARN:           "arn:aws:iam::111122223333:role/Deploy",
				RoleSessionName:   " ",
				ExpectedAccountID: "111122223333",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			result, err := AssumeFirst(
				context.Background(),
				test.assumer,
				func(awssdk.CredentialsProvider) CallerIdentityAPI {
					return &fakeCallerIdentityClient{output: &sts.GetCallerIdentityOutput{
						Account: awssdk.String("111122223333"),
					}}
				},
				test.request,
			)
			if !errors.Is(err, ErrAssumeRoleFailed) {
				t.Fatalf("AssumeFirst() error = %v, want ErrAssumeRoleFailed", err)
			}
			if result.Assertion.State != AccountAssertionAssumeFailed {
				t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, AccountAssertionAssumeFailed)
			}
			if result.Credentials != nil {
				t.Fatal("AssumeFirst() exposed credentials with missing assume inputs")
			}
			if assumer, ok := test.assumer.(*fakeAssumeRoleClient); ok && assumer.calls != 0 {
				t.Fatalf("AssumeRole calls = %d, want 0", assumer.calls)
			}
		})
	}
}

func TestAssumeFirstRejectsEmptyCredentials(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		output *sts.AssumeRoleOutput
	}{
		{name: "nil output"},
		{name: "nil credentials", output: &sts.AssumeRoleOutput{}},
		{name: "empty access key", output: &sts.AssumeRoleOutput{Credentials: &ststypes.Credentials{
			SecretAccessKey: awssdk.String("secret"),
		}}},
		{name: "empty secret key", output: &sts.AssumeRoleOutput{Credentials: &ststypes.Credentials{
			AccessKeyId: awssdk.String("ASIAEXAMPLE"),
		}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			factoryCalls := 0
			result, err := AssumeFirst(
				context.Background(),
				&fakeAssumeRoleClient{output: test.output},
				func(awssdk.CredentialsProvider) CallerIdentityAPI {
					factoryCalls++
					return &fakeCallerIdentityClient{}
				},
				AssumeRoleRequest{
					RoleARN:           "arn:aws:iam::111122223333:role/Deploy",
					RoleSessionName:   "apptheory-test",
					ExpectedAccountID: "111122223333",
				},
			)
			if !errors.Is(err, ErrAssumeRoleFailed) {
				t.Fatalf("AssumeFirst() error = %v, want ErrAssumeRoleFailed", err)
			}
			if result.Assertion.State != AccountAssertionAssumeFailed {
				t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, AccountAssertionAssumeFailed)
			}
			if result.Credentials != nil {
				t.Fatal("AssumeFirst() exposed incomplete credentials")
			}
			if factoryCalls != 0 {
				t.Fatalf("identity factory calls = %d, want 0", factoryCalls)
			}
		})
	}
}

func TestAssumeFirstNilIdentityFactoryFailsClosed(t *testing.T) {
	t.Parallel()

	result, err := AssumeFirst(
		context.Background(),
		successfulAssumer(),
		nil,
		AssumeRoleRequest{
			RoleARN:           "arn:aws:iam::111122223333:role/Deploy",
			RoleSessionName:   "apptheory-test",
			ExpectedAccountID: "111122223333",
		},
	)
	if !errors.Is(err, ErrCallerIdentityUnavailable) {
		t.Fatalf("AssumeFirst() error = %v, want ErrCallerIdentityUnavailable", err)
	}
	if result.Assertion.State != AccountAssertionUnavailable {
		t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, AccountAssertionUnavailable)
	}
	if result.Credentials != nil {
		t.Fatal("AssumeFirst() exposed credentials without an identity factory")
	}
}

func TestAssertAccountNilClientFailsClosed(t *testing.T) {
	t.Parallel()

	assertion, err := AssertAccount(context.Background(), nil, "111122223333")
	if !errors.Is(err, ErrCallerIdentityUnavailable) {
		t.Fatalf("AssertAccount() error = %v, want ErrCallerIdentityUnavailable", err)
	}
	if assertion.State != AccountAssertionUnavailable {
		t.Fatalf("AssertAccount() state = %q, want %q", assertion.State, AccountAssertionUnavailable)
	}
}

func TestAssumeFirstIdentityFailureDoesNotExposeCredentials(t *testing.T) {
	t.Parallel()

	assumer := successfulAssumer()
	result, err := AssumeFirst(
		context.Background(),
		assumer,
		func(awssdk.CredentialsProvider) CallerIdentityAPI {
			return &fakeCallerIdentityClient{err: errors.New("identity unavailable")}
		},
		AssumeRoleRequest{
			RoleARN:           "arn:aws:iam::111122223333:role/Deploy",
			RoleSessionName:   "apptheory-test",
			ExpectedAccountID: "111122223333",
		},
	)
	if !errors.Is(err, ErrCallerIdentityUnavailable) {
		t.Fatalf("AssumeFirst() error = %v, want ErrCallerIdentityUnavailable", err)
	}
	if result.Assertion.State != AccountAssertionUnavailable {
		t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, AccountAssertionUnavailable)
	}
	if result.Credentials != nil {
		t.Fatal("AssumeFirst() exposed credentials after identity failure")
	}
}

func TestAssumeFirstMismatchAndVerified(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		actual       string
		wantState    AccountAssertionState
		wantErr      error
		wantProvider bool
	}{
		{
			name:      "mismatch",
			actual:    "444455556666",
			wantState: AccountAssertionMismatch,
			wantErr:   ErrAccountMismatch,
		},
		{
			name:         "verified",
			actual:       "111122223333",
			wantState:    AccountAssertionVerified,
			wantProvider: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			assumer := successfulAssumer()
			providerChecked := false
			result, err := AssumeFirst(
				context.Background(),
				assumer,
				func(provider awssdk.CredentialsProvider) CallerIdentityAPI {
					credentials, retrieveErr := provider.Retrieve(context.Background())
					if retrieveErr != nil {
						t.Fatalf("assumed provider Retrieve() error = %v", retrieveErr)
					}
					if credentials.AccessKeyID != "ASIAEXAMPLE" || credentials.SecretAccessKey != "secret" || credentials.SessionToken != "token" {
						t.Fatalf("assumed provider credentials = %#v", credentials)
					}
					providerChecked = true
					return &fakeCallerIdentityClient{output: &sts.GetCallerIdentityOutput{Account: awssdk.String(test.actual)}}
				},
				AssumeRoleRequest{
					RoleARN:           " arn:aws:iam::111122223333:role/Deploy ",
					RoleSessionName:   " apptheory-test ",
					ExternalID:        " external-id ",
					ExpectedAccountID: "111122223333",
				},
			)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("AssumeFirst() error = %v, want errors.Is(%v)", err, test.wantErr)
			}
			if result.Assertion.State != test.wantState {
				t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, test.wantState)
			}
			if (result.Credentials != nil) != test.wantProvider {
				t.Fatalf("AssumeFirst() provider presence = %v, want %v", result.Credentials != nil, test.wantProvider)
			}
			if !providerChecked {
				t.Fatal("identity factory did not receive the assumed credentials provider")
			}
			if assumer.calls != 1 {
				t.Fatalf("AssumeRole calls = %d, want 1", assumer.calls)
			}
			if awssdk.ToString(assumer.input.RoleArn) != "arn:aws:iam::111122223333:role/Deploy" {
				t.Fatalf("RoleArn = %q", awssdk.ToString(assumer.input.RoleArn))
			}
			if awssdk.ToString(assumer.input.RoleSessionName) != "apptheory-test" {
				t.Fatalf("RoleSessionName = %q", awssdk.ToString(assumer.input.RoleSessionName))
			}
			if awssdk.ToString(assumer.input.ExternalId) != "external-id" {
				t.Fatalf("ExternalId = %q", awssdk.ToString(assumer.input.ExternalId))
			}
		})
	}
}

func TestAssumeFirstEmptyExpectedAccountSkipsSTS(t *testing.T) {
	t.Parallel()

	assumer := successfulAssumer()
	result, err := AssumeFirst(context.Background(), assumer, nil, AssumeRoleRequest{
		RoleARN:         "arn:aws:iam::111122223333:role/Deploy",
		RoleSessionName: "apptheory-test",
	})
	if !errors.Is(err, ErrExpectedAccountNotConfigured) {
		t.Fatalf("AssumeFirst() error = %v, want ErrExpectedAccountNotConfigured", err)
	}
	if result.Assertion.State != AccountAssertionNotConfigured {
		t.Fatalf("AssumeFirst() state = %q, want %q", result.Assertion.State, AccountAssertionNotConfigured)
	}
	if assumer.calls != 0 {
		t.Fatalf("AssumeRole calls = %d, want 0", assumer.calls)
	}
}

func successfulAssumer() *fakeAssumeRoleClient {
	expires := time.Now().Add(time.Hour)
	return &fakeAssumeRoleClient{output: &sts.AssumeRoleOutput{Credentials: &ststypes.Credentials{
		AccessKeyId:     awssdk.String("ASIAEXAMPLE"),
		SecretAccessKey: awssdk.String("secret"),
		SessionToken:    awssdk.String("token"),
		Expiration:      &expires,
	}}}
}
