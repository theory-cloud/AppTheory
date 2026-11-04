package localrunner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Lambda authorizer policy matching.
//
// A Lambda authorizer returns an IAM policy document that API Gateway evaluates
// against the method it is about to invoke. The runner does not implement IAM
// evaluation (docs/125 true limit, decision D2); it matches the returned policy
// narrowly against the method or route ARN, which is the single documented
// evaluation that decides whether this request may proceed. Deny wins over
// Allow, the action must name execute-api:Invoke (or match it with a wildcard),
// and the resource must match the ARN with IAM-style * and ? wildcards.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-output.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-using-iam-policies-to-invoke-api.html

// authorizerPolicy is the response a Lambda authorizer returns.
type authorizerPolicy struct {
	PrincipalID    string `json:"principalId"`
	PolicyDocument struct {
		Version   string `json:"Version"`
		Statement []struct {
			Action   any    `json:"Action"`
			Effect   string `json:"Effect"`
			Resource any    `json:"Resource"`
		} `json:"Statement"`
	} `json:"policyDocument"`
	Context map[string]any `json:"context"`
}

// evaluateAuthorizerPolicy applies the narrow Allow/Deny match the docs/125
// exception permits: the returned policy is matched against the method ARN with
// IAM-style wildcards. It is never described as IAM evaluation, which stays a
// docs/125 true limit.
func evaluateAuthorizerPolicy(body []byte, methodARN string) (bool, map[string]any, error) {
	var policy authorizerPolicy
	if err := json.Unmarshal(body, &policy); err != nil {
		return false, nil, fmt.Errorf("the authorizer response is not an IAM policy: %w", err)
	}
	if len(policy.PolicyDocument.Statement) == 0 {
		return false, nil, fmt.Errorf("the authorizer policy has no Statement")
	}
	allowed := false
	for _, statement := range policy.PolicyDocument.Statement {
		effect := strings.TrimSpace(statement.Effect)
		if !strings.EqualFold(effect, "Allow") && !strings.EqualFold(effect, "Deny") {
			continue
		}
		if !policyMatchesAction(statement.Action) {
			continue
		}
		matched := false
		for _, resource := range stringValues(statement.Resource) {
			if arnPatternMatches(resource, methodARN) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		if strings.EqualFold(effect, "Deny") {
			return false, nil, nil
		}
		allowed = true
	}
	if !allowed {
		return false, nil, nil
	}
	return true, policy.Context, nil
}

// authorizerUnauthorizedResponse reports whether a Lambda authorizer answered
// with the documented Unauthorized error instead of a policy. Returning
// {"errorMessage":"Unauthorized"} (or {"message":"Unauthorized"}) makes API
// Gateway answer 401 rather than treating the response as an invalid policy.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
func authorizerUnauthorizedResponse(body []byte) bool {
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		return false
	}
	for _, key := range []string{"errorMessage", "message"} {
		if value, ok := document[key].(string); ok && strings.EqualFold(strings.TrimSpace(value), "Unauthorized") {
			return true
		}
	}
	return false
}

// policyMatchesAction reports whether a statement names execute-api:Invoke. An
// absent Action matches every action, as IAM documents; a wildcard pattern is
// matched against the action name.
func policyMatchesAction(action any) bool {
	values := stringValues(action)
	if len(values) == 0 {
		return true
	}
	for _, value := range values {
		if wildcardMatch(strings.ToLower(value), strings.ToLower("execute-api:Invoke")) {
			return true
		}
	}
	return false
}

func stringValues(value any) []string {
	switch typed := value.(type) {
	case string:
		return []string{typed}
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

// arnPatternMatches matches an IAM resource pattern (* and ?) against an ARN.
func arnPatternMatches(pattern, arn string) bool {
	return wildcardMatch(pattern, arn)
}

// wildcardMatch is a small * and ? matcher.
func wildcardMatch(pattern, value string) bool {
	patternRunes := []rune(pattern)
	valueRunes := []rune(value)
	p, v := 0, 0
	star, match := -1, 0
	for v < len(valueRunes) {
		switch {
		case p < len(patternRunes) && (patternRunes[p] == '?' || patternRunes[p] == valueRunes[v]):
			p++
			v++
		case p < len(patternRunes) && patternRunes[p] == '*':
			star = p
			match = v
			p++
		case star >= 0:
			p = star + 1
			match++
			v = match
		default:
			return false
		}
	}
	for p < len(patternRunes) && patternRunes[p] == '*' {
		p++
	}
	return p == len(patternRunes)
}
