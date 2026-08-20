package runtimeaws

import (
	"context"
	"errors"
	"fmt"
	"strings"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

var (
	// ErrExpectedAccountNotConfigured means no non-empty expected account ID was provided.
	ErrExpectedAccountNotConfigured = errors.New("apptheory runtime aws: expected account is not configured")
	// ErrAssumeRoleFailed means STS did not return usable ephemeral credentials.
	ErrAssumeRoleFailed = errors.New("apptheory runtime aws: assume role failed")
	// ErrCallerIdentityUnavailable means STS did not return a usable caller account ID.
	ErrCallerIdentityUnavailable = errors.New("apptheory runtime aws: caller identity is unavailable")
	// ErrAccountMismatch means the caller account ID did not equal the configured account ID.
	ErrAccountMismatch = errors.New("apptheory runtime aws: caller account does not match expected account")
)

// AccountAssertionState is the explicit outcome of an AWS account assertion.
type AccountAssertionState string

const (
	// AccountAssertionNotConfigured means the expected account ID was empty.
	AccountAssertionNotConfigured AccountAssertionState = "not_configured"
	// AccountAssertionAssumeFailed means STS could not establish assumed authority.
	AccountAssertionAssumeFailed AccountAssertionState = "assume_failed"
	// AccountAssertionUnavailable means caller identity could not be established.
	AccountAssertionUnavailable AccountAssertionState = "unavailable"
	// AccountAssertionMismatch means caller identity was available but named another account.
	AccountAssertionMismatch AccountAssertionState = "mismatch"
	// AccountAssertionVerified means caller identity exactly matched the expected account.
	AccountAssertionVerified AccountAssertionState = "verified"
)

// AccountAssertion records the expected and observed account identity with an explicit state.
type AccountAssertion struct {
	State             AccountAssertionState
	ExpectedAccountID string
	ActualAccountID   string
}

// AssumeRoleAPI is the narrow STS operation required by AssumeFirst.
type AssumeRoleAPI interface {
	AssumeRole(context.Context, *sts.AssumeRoleInput, ...func(*sts.Options)) (*sts.AssumeRoleOutput, error)
}

// CallerIdentityAPI is the narrow STS operation required by AssertAccount.
type CallerIdentityAPI interface {
	GetCallerIdentity(context.Context, *sts.GetCallerIdentityInput, ...func(*sts.Options)) (*sts.GetCallerIdentityOutput, error)
}

// CallerIdentityFactory creates an STS identity client bound to assumed credentials.
//
// Implementations should copy their base aws.Config, replace only Credentials with
// the supplied provider, and create an STS client from that copy.
type CallerIdentityFactory func(awssdk.CredentialsProvider) CallerIdentityAPI

// AssumeRoleRequest is the bounded role-assumption contract used by AssumeFirst.
type AssumeRoleRequest struct {
	RoleARN           string
	RoleSessionName   string
	ExternalID        string
	ExpectedAccountID string
}

// AssumeFirstResult carries verified account evidence and, only when verified,
// the ephemeral assumed credentials provider.
type AssumeFirstResult struct {
	Assertion   AccountAssertion
	Credentials awssdk.CredentialsProvider
}

// AssumeFirst eagerly assumes a role, resolves caller identity using the assumed
// credentials, and returns authority only after the expected account is verified.
func AssumeFirst(
	ctx context.Context,
	assumer AssumeRoleAPI,
	identityFactory CallerIdentityFactory,
	request AssumeRoleRequest,
) (AssumeFirstResult, error) {
	expected := strings.TrimSpace(request.ExpectedAccountID)
	assertion := AccountAssertion{
		State:             AccountAssertionNotConfigured,
		ExpectedAccountID: expected,
	}
	if expected == "" {
		return AssumeFirstResult{Assertion: assertion}, ErrExpectedAccountNotConfigured
	}

	roleARN := strings.TrimSpace(request.RoleARN)
	roleSessionName := strings.TrimSpace(request.RoleSessionName)
	if assumer == nil || roleARN == "" || roleSessionName == "" {
		assertion.State = AccountAssertionAssumeFailed
		return AssumeFirstResult{Assertion: assertion}, ErrAssumeRoleFailed
	}
	if ctx == nil {
		ctx = context.Background()
	}

	input := &sts.AssumeRoleInput{
		RoleArn:         awssdk.String(roleARN),
		RoleSessionName: awssdk.String(roleSessionName),
	}
	if externalID := strings.TrimSpace(request.ExternalID); externalID != "" {
		input.ExternalId = awssdk.String(externalID)
	}
	output, err := assumer.AssumeRole(ctx, input)
	if err != nil {
		assertion.State = AccountAssertionAssumeFailed
		return AssumeFirstResult{Assertion: assertion}, fmt.Errorf("%w: %w", ErrAssumeRoleFailed, err)
	}
	if output == nil || output.Credentials == nil ||
		strings.TrimSpace(awssdk.ToString(output.Credentials.AccessKeyId)) == "" ||
		strings.TrimSpace(awssdk.ToString(output.Credentials.SecretAccessKey)) == "" {
		assertion.State = AccountAssertionAssumeFailed
		return AssumeFirstResult{Assertion: assertion}, ErrAssumeRoleFailed
	}

	credentials := awssdk.Credentials{
		AccessKeyID:     strings.TrimSpace(awssdk.ToString(output.Credentials.AccessKeyId)),
		SecretAccessKey: strings.TrimSpace(awssdk.ToString(output.Credentials.SecretAccessKey)),
		SessionToken:    strings.TrimSpace(awssdk.ToString(output.Credentials.SessionToken)),
		Source:          "AppTheoryAssumeFirst",
	}
	if output.Credentials.Expiration != nil {
		credentials.CanExpire = true
		credentials.Expires = *output.Credentials.Expiration
	}
	provider := awssdk.NewCredentialsCache(awssdk.CredentialsProviderFunc(
		func(context.Context) (awssdk.Credentials, error) {
			return credentials, nil
		},
	))

	if identityFactory == nil {
		assertion.State = AccountAssertionUnavailable
		return AssumeFirstResult{Assertion: assertion}, ErrCallerIdentityUnavailable
	}
	identity := identityFactory(provider)
	verified, err := AssertAccount(ctx, identity, expected)
	if err != nil {
		return AssumeFirstResult{Assertion: verified}, err
	}
	return AssumeFirstResult{Assertion: verified, Credentials: provider}, nil
}

// AssertAccount resolves the caller through STS and requires an exact account-ID match.
func AssertAccount(ctx context.Context, client CallerIdentityAPI, expectedAccountID string) (AccountAssertion, error) {
	expected := strings.TrimSpace(expectedAccountID)
	assertion := AccountAssertion{
		State:             AccountAssertionNotConfigured,
		ExpectedAccountID: expected,
	}
	if expected == "" {
		return assertion, ErrExpectedAccountNotConfigured
	}
	if client == nil {
		assertion.State = AccountAssertionUnavailable
		return assertion, ErrCallerIdentityUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}

	output, err := client.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		assertion.State = AccountAssertionUnavailable
		return assertion, fmt.Errorf("%w: %w", ErrCallerIdentityUnavailable, err)
	}
	if output == nil || strings.TrimSpace(awssdk.ToString(output.Account)) == "" {
		assertion.State = AccountAssertionUnavailable
		return assertion, ErrCallerIdentityUnavailable
	}

	assertion.ActualAccountID = strings.TrimSpace(awssdk.ToString(output.Account))
	if assertion.ActualAccountID != expected {
		assertion.State = AccountAssertionMismatch
		return assertion, ErrAccountMismatch
	}
	assertion.State = AccountAssertionVerified
	return assertion, nil
}
