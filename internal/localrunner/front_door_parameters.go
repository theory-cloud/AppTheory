package localrunner

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

// Local FRONTED front-door parameters.
//
// A FRONTED application reads its front-door secret from a well-known Parameter
// Store parameter that its installer creates if absent. The CDK distribution
// header references the parameter by name through a CloudFormation
// {{resolve:ssm:...}} dynamic reference, which CloudFormation resolves at stack
// create/update time. Locally there is no CloudFormation and no AWS account, so
// the runner is the parameter source: it creates the name in its own SSM store
// when it is absent, never overwrites an existing value, and resolves the
// distribution header from that store.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-ssm.html

const (
	// frontDoorSSMReferencePrefix is the plaintext dynamic-reference form
	// CloudFront origin custom headers support. The ssM-secure form is not
	// supported for AWS::CloudFront::Distribution properties at all, so the
	// runner refuses it here for the same reason CloudFormation would.
	frontDoorSSMReferencePrefix = "{{resolve:ssm:"
	frontDoorReferencePrefix    = "{{resolve:"
	frontDoorReferenceSuffix    = "}}"
	// frontDoorLocalValuePrefix keeps a generated local value recognizable in
	// the run's log and in the local store.
	frontDoorLocalValuePrefix = "local-front-door-"
)

// frontDoorParameterNamePattern is the Parameter Store name alphabet with the
// hierarchy separator, which is also what a CloudFormation dynamic reference
// accepts.
var frontDoorParameterNamePattern = regexp.MustCompile(`^/[A-Za-z0-9_.\-/]+$`)

const (
	frontDoorParameterMaxLength = 1011
	frontDoorParameterMaxLevels = 15
)

// provisionFrontDoorParameters creates each --front-door-parameter in the run's
// local SSM store when it is absent and remembers the value for header
// resolution. An existing parameter is never overwritten.
func (r *Runner) provisionFrontDoorParameters(ctx context.Context) error {
	if len(r.options.FrontDoorParameters) == 0 {
		return nil
	}
	backend, ok := r.backendForService(backendSSM)
	if !ok || backend.HostURL == "" {
		return errors.New("--front-door-parameter needs the run's local SSM backend (add --backend moto)")
	}
	client := newSSMClient(backend.HostURL)
	for _, raw := range r.options.FrontDoorParameters {
		name := strings.TrimSpace(raw)
		if err := validateFrontDoorParameterName(name); err != nil {
			return fmt.Errorf("--front-door-parameter %q: %w", raw, err)
		}
		value, err := existingFrontDoorParameter(ctx, client, name)
		if err != nil {
			return err
		}
		if value == "" {
			value = localFrontDoorSecretValue(name)
			if _, err := client.PutParameter(ctx, &ssm.PutParameterInput{
				Name:      aws.String(name),
				Value:     aws.String(value),
				Type:      ssmtypes.ParameterTypeString,
				Overwrite: aws.Bool(false),
			}); err != nil {
				return fmt.Errorf("create the local front-door parameter %s: %w", name, err)
			}
			r.logf("created the local front-door parameter %s", name)
		} else {
			r.logf("kept the existing local front-door parameter %s", name)
		}
		r.rememberFrontDoorSecret(name, value)
	}
	return nil
}

// existingFrontDoorParameter returns the stored value, or "" when the parameter
// does not exist yet.
func existingFrontDoorParameter(ctx context.Context, client *ssm.Client, name string) (string, error) {
	output, err := client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		var notFound *ssmtypes.ParameterNotFound
		if errors.As(err, &notFound) {
			return "", nil
		}
		return "", fmt.Errorf("read the local front-door parameter %s: %w", name, err)
	}
	if output.Parameter == nil || output.Parameter.Value == nil {
		return "", nil
	}
	return *output.Parameter.Value, nil
}

// resolveOriginCustomHeaders replaces every {{resolve:ssm:...}} value on one
// origin's custom headers with the parameter's value from the local store.
func (r *Runner) resolveOriginCustomHeaders(
	ctx context.Context,
	distributionID string,
	origin *localcloudfront.DistributionOrigin,
) error {
	for header, value := range origin.CustomHeaders {
		resolved, err := r.resolveFrontDoorHeaderValue(ctx, distributionID, origin.ID, header, value)
		if err != nil {
			return err
		}
		origin.CustomHeaders[header] = resolved
	}
	return nil
}

// resolveFrontDoorHeaderValue resolves one header value. A value without a
// dynamic reference passes through unchanged.
func (r *Runner) resolveFrontDoorHeaderValue(
	ctx context.Context,
	distributionID, originID, header, value string,
) (string, error) {
	trimmed := strings.TrimSpace(value)
	if !strings.Contains(trimmed, frontDoorReferencePrefix) {
		return value, nil
	}
	name, err := frontDoorReferenceParameterName(trimmed)
	if err != nil {
		return "", fmt.Errorf(
			"distribution %s origin %s header %s: %w", distributionID, originID, header, err,
		)
	}
	secret, err := r.frontDoorSecretValue(ctx, name)
	if err != nil {
		return "", fmt.Errorf(
			"distribution %s origin %s header %s: %w", distributionID, originID, header, err,
		)
	}
	return secret, nil
}

// frontDoorReferenceParameterName parses {{resolve:ssm:name[:version]}}.
//
// Only the plaintext form is accepted: AWS lists the properties that support
// ssm-secure exhaustively and CloudFront is not one of them.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-ssm-secure-strings.html
func frontDoorReferenceParameterName(value string) (string, error) {
	if !strings.HasPrefix(value, frontDoorSSMReferencePrefix) {
		return "", fmt.Errorf(
			"dynamic reference %q is not a {{resolve:ssm:...}} parameter reference; CloudFront origin headers cannot carry an ssm-secure or Secrets Manager reference",
			value,
		)
	}
	if !strings.HasSuffix(value, frontDoorReferenceSuffix) {
		return "", fmt.Errorf("dynamic reference %q is missing its closing %s", value, frontDoorReferenceSuffix)
	}
	body := strings.TrimSuffix(strings.TrimPrefix(value, frontDoorSSMReferencePrefix), frontDoorReferenceSuffix)
	name := body
	if index := strings.LastIndex(body, ":"); index >= 0 {
		version := body[index+1:]
		if version != "" && strings.Trim(version, "0123456789") == "" {
			// A pinned version selects the same current value locally; the run
			// has one value per parameter.
			name = body[:index]
		}
	}
	if err := validateFrontDoorParameterName(name); err != nil {
		return "", err
	}
	return name, nil
}

// frontDoorSecretValue reads a parameter from the local store, caching the value
// for the rest of the run.
func (r *Runner) frontDoorSecretValue(ctx context.Context, name string) (string, error) {
	r.frontDoorMu.Lock()
	cached, ok := r.frontDoorSecrets[name]
	r.frontDoorMu.Unlock()
	if ok {
		return cached, nil
	}
	backend, available := r.backendForService(backendSSM)
	if !available || backend.HostURL == "" {
		return "", fmt.Errorf(
			"SSM parameter %s is not declared by this app and the run has no local SSM backend to resolve it",
			name,
		)
	}
	value, err := existingFrontDoorParameter(ctx, newSSMClient(backend.HostURL), name)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", fmt.Errorf(
			"SSM parameter %s is not declared by this app and does not exist locally; pass --front-door-parameter %s so the run creates it",
			name, name,
		)
	}
	r.rememberFrontDoorSecret(name, value)
	return value, nil
}

func (r *Runner) rememberFrontDoorSecret(name, value string) {
	r.frontDoorMu.Lock()
	defer r.frontDoorMu.Unlock()
	if r.frontDoorSecrets == nil {
		r.frontDoorSecrets = map[string]string{}
	}
	r.frontDoorSecrets[name] = value
}

// localFrontDoorSecretValue generates the local value from the parameter name:
// 48 characters of the documented front-door alphabet [A-Za-z0-9._~-], so it
// satisfies the runtime's 32 to 128 character check and is stable across runs.
func localFrontDoorSecretValue(name string) string {
	return frontDoorLocalValuePrefix + stableHash(name, 31)
}

// validateFrontDoorParameterName mirrors the runtime's and construct's rules for
// a well-known front-door parameter name.
func validateFrontDoorParameterName(name string) error {
	if name == "" ||
		len(name) > frontDoorParameterMaxLength ||
		!frontDoorParameterNamePattern.MatchString(name) ||
		strings.HasSuffix(name, "/") ||
		strings.Contains(name, "//") {
		return errors.New(
			"must be a fully qualified SSM parameter name from '/', at most 1011 characters, of [A-Za-z0-9_.-/] with no empty segment",
		)
	}
	levels := strings.Split(strings.TrimPrefix(name, "/"), "/")
	if len(levels) == 0 || len(levels) > frontDoorParameterMaxLevels {
		return errors.New("must have between one and fifteen hierarchy levels")
	}
	switch strings.ToLower(levels[0]) {
	case "aws", "ssm":
		return errors.New("must not use the reserved aws or ssm hierarchy")
	}
	return nil
}
