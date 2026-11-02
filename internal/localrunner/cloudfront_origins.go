package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// refusedOrigin reports a CloudFront origin the local gateway deliberately does
// not reach. The path-routed-frontend example's API origin is a literal external
// hostname; the local gateway never makes an external network request.
type refusedOrigin struct {
	originID string
	reason   string
}

func (o *refusedOrigin) Fetch(context.Context, localcloudfront.OriginRequest) (localcloudfront.OriginResponse, error) {
	return localcloudfront.OriginResponse{}, &localcloudfront.OriginUnavailableError{
		OriginID: o.originID,
		Reason:   o.reason,
	}
}

// cloudFrontOrigins builds the origin implementations for one servable
// distribution. S3 origins reach the runner's s3proxy backend, Function URL
// origins invoke the runner's function container, and origin groups wrap their
// members with CloudFront's failover rules.
func (r *Runner) cloudFrontOrigins(spec *Spec, distribution *localcloudfront.Distribution) (map[string]localcloudfront.Origin, error) {
	origins := map[string]localcloudfront.Origin{}
	for _, origin := range distribution.Origins {
		implementation, err := r.cloudFrontOrigin(spec, origin)
		if err != nil {
			return nil, fmt.Errorf("distribution %s origin %s: %w", distribution.LogicalID, origin.ID, err)
		}
		origins[origin.ID] = implementation
	}
	for _, group := range distribution.OriginGroups {
		members := make([]localcloudfront.OriginGroupMember, 0, len(group.Members))
		for _, memberID := range group.Members {
			member, ok := distribution.Origin(memberID)
			if !ok {
				return nil, fmt.Errorf("distribution %s origin group %s member %s is not an origin", distribution.LogicalID, group.ID, memberID)
			}
			implementation, ok := origins[memberID]
			if !ok {
				return nil, fmt.Errorf("distribution %s origin group %s member %s has no local implementation", distribution.LogicalID, group.ID, memberID)
			}
			members = append(members, localcloudfront.OriginGroupMember{
				OriginID:   memberID,
				Origin:     implementation,
				OriginPath: member.OriginPath,
				Host:       member.DomainName,
			})
		}
		origins[group.ID] = localcloudfront.NewOriginGroupOrigin(group.ID, members, group.FailoverStatusCodes)
	}
	return origins, nil
}

func (r *Runner) cloudFrontOrigin(spec *Spec, origin *localcloudfront.DistributionOrigin) (localcloudfront.Origin, error) {
	switch {
	case origin.FunctionURL != "":
		return r.functionURLOrigin(spec, origin)
	case origin.Kind == localcloudfront.OriginS3:
		return r.s3OriginFor(spec, origin)
	case origin.Kind == localcloudfront.OriginCustom:
		return &refusedOrigin{
			originID: origin.ID,
			reason: fmt.Sprintf(
				"custom origin %q is outside this machine; the local gateway does not make external network requests",
				origin.DomainName,
			),
		}, nil
	default:
		return nil, fmt.Errorf("origin kind %q is not implemented locally", origin.Kind)
	}
}

func (r *Runner) s3OriginFor(spec *Spec, origin *localcloudfront.DistributionOrigin) (localcloudfront.Origin, error) {
	backend, ok := r.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return nil, fmt.Errorf("an S3 origin needs the s3proxy backend; start the run with --backend s3proxy")
	}
	bucketName, ok := r.bucketName(origin.Bucket)
	if !ok {
		return nil, fmt.Errorf("bucket %s was not provisioned", origin.Bucket)
	}
	noListBucket := origin.OriginAccessControl != "" || (origin.S3 != nil && origin.S3.OriginAccessIdentity != "")
	return &s3Origin{
		originID:     origin.ID,
		bucket:       bucketName,
		client:       newS3Client(backend.HostURL),
		noListBucket: noListBucket,
		hasCORS:      bucketDeclaresCORS(spec, origin.Bucket),
		requestID:    NewRequestID,
	}, nil
}

func (r *Runner) functionURLOrigin(spec *Spec, origin *localcloudfront.DistributionOrigin) (localcloudfront.Origin, error) {
	functionID, ok := spec.functionURLTargets[origin.FunctionURL]
	if !ok {
		return nil, fmt.Errorf("Function URL %s does not target a Lambda function", origin.FunctionURL)
	}
	invoker, ok := r.invokers[functionID]
	if !ok {
		return nil, fmt.Errorf("function %s behind Function URL %s is not running", functionID, origin.FunctionURL)
	}
	authType, err := functionURLAuthType(spec, origin.FunctionURL)
	if err != nil {
		return nil, err
	}
	implementation := &functionURLOrigin{
		originID:   origin.ID,
		urlID:      origin.FunctionURL,
		functionID: functionID,
		authType:   authType,
		domainName: origin.DomainName,
		invoker:    invoker,
		now:        nil,
		logf:       r.logf,
	}
	if authType != noneAuthorization {
		implementation.signer = newLocalOACSigner()
	}
	return implementation, nil
}

// bucketName maps a qualified bucket logical id to the name provisioning
// created. A single-stack assembly keeps the bare logical id.
func (r *Runner) bucketName(qualifiedID string) (string, bool) {
	if value, ok := r.resourceValues[qualifiedID]; ok && value.Type == typeS3Bucket {
		return value.Name, true
	}
	if strings.Contains(qualifiedID, "/") {
		return "", false
	}
	for key, value := range r.resourceValues {
		if value.Type == typeS3Bucket && strings.HasSuffix(key, "/"+qualifiedID) {
			return value.Name, true
		}
	}
	return "", false
}

func bucketDeclaresCORS(spec *Spec, qualifiedID string) bool {
	for _, resource := range spec.Resources {
		if resource.Type != typeS3Bucket {
			continue
		}
		if resource.Stack+"/"+resource.LogicalID != qualifiedID && resource.LogicalID != qualifiedID {
			continue
		}
		var properties map[string]json.RawMessage
		if err := json.Unmarshal(resource.Properties, &properties); err != nil {
			return false
		}
		raw, ok := properties["CorsConfiguration"]
		return ok && len(raw) > 0 && string(raw) != "null"
	}
	return false
}

// functionURLAuthType reads the AuthType of one AWS::Lambda::Url resource. An
// absent property is CloudFormation's NONE default for the local origin path.
func functionURLAuthType(spec *Spec, qualifiedID string) (string, error) {
	for _, resource := range spec.Resources {
		if resource.Type != typeFunctionURL {
			continue
		}
		if resource.Stack+"/"+resource.LogicalID != qualifiedID && resource.LogicalID != qualifiedID {
			continue
		}
		var properties struct {
			AuthType string `json:"AuthType"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &properties); err != nil {
				return "", fmt.Errorf("parse Function URL %s properties: %w", qualifiedID, err)
			}
		}
		switch properties.AuthType {
		case "", noneAuthorization:
			return noneAuthorization, nil
		case "AWS_IAM":
			return "AWS_IAM", nil
		default:
			return "", fmt.Errorf("Function URL %s auth type %q is not implemented locally", qualifiedID, properties.AuthType)
		}
	}
	return "", fmt.Errorf("Function URL %s is not defined in the assembly", qualifiedID)
}
