package localrunner

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Route authorizer resolution.
//
// A template can name a JWT issuer or a Cognito pool ARN with a CloudFormation
// expression, because the pool id is assigned when the pool is created. The run
// resolves those expressions after provisioning, maps a provisioned pool to the
// loopback issuer the runner serves, and leaves every route that names no pool
// failing closed.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html

var cognitoIssuerPattern = regexp.MustCompile(`^https://cognito-idp\.([a-z0-9-]+)\.amazonaws\.com/([^/]+)$`)

// cognitoIssuerPoolID returns the pool id a canonical Cognito issuer names.
func cognitoIssuerPoolID(issuer string) (region, poolID string, ok bool) {
	match := cognitoIssuerPattern.FindStringSubmatch(strings.TrimSpace(issuer))
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

// cognitoPoolIDFromARN returns the pool id a Cognito pool ARN names.
func cognitoPoolIDFromARN(arn string) (string, bool) {
	const marker = ":userpool/"
	index := strings.Index(arn, marker)
	if index < 0 {
		return "", false
	}
	id := strings.TrimSpace(arn[index+len(marker):])
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// resolveRouteAuthorizers fills every route's issuer and JWKS values from the
// provisioned pools.
//
//nolint:gocognit // one explicit branch per supported provider value.
func (r *Runner) resolveRouteAuthorizers(spec *Spec) error {
	resources := spec.resourceIndex()
	for apiIndex := range spec.APIs {
		api := &spec.APIs[apiIndex]
		for routeIndex := range api.Routes {
			route := &api.Routes[routeIndex]
			switch route.AuthorizerKind {
			case AuthorizerKindJWT:
				issuer := route.JWTIssuer
				if strings.TrimSpace(route.JWTIssuerExpression) != "" {
					resolved, err := r.resolveTemplateString(route.JWTIssuerExpression, api.Stack, resources, spec.Templates[api.Stack])
					if err != nil {
						return fmt.Errorf("%s %s %s: resolve the JWT issuer: %w", api.LogicalID, route.Method, route.Path, err)
					}
					issuer = resolved
				}
				accepted, jwks, err := r.issuerForURL(issuer)
				if err != nil {
					return fmt.Errorf("%s %s %s: %w", api.LogicalID, route.Method, route.Path, err)
				}
				route.JWTIssuer = issuer
				route.AcceptedIssuers = accepted
				route.JWKSURL = jwks
				route.JWTAudience = nil
				for _, expression := range route.JWTAudienceExpressions {
					audience, err := r.resolveTemplateString(expression, api.Stack, resources, spec.Templates[api.Stack])
					if err != nil {
						return fmt.Errorf("%s %s %s: resolve the JWT audience: %w", api.LogicalID, route.Method, route.Path, err)
					}
					if strings.TrimSpace(audience) != "" {
						route.JWTAudience = append(route.JWTAudience, strings.TrimSpace(audience))
					}
				}
			case AuthorizerKindCognito:
				accepted, jwks, err := r.issuersForCognitoPools(route.CognitoPoolARNs, api.Stack, resources, spec.Templates[api.Stack])
				if err != nil {
					return fmt.Errorf("%s %s %s: %w", api.LogicalID, route.Method, route.Path, err)
				}
				route.AcceptedIssuers = accepted
				route.JWKSURL = jwks
			default:
				continue
			}
			if route.JWKSURL == "" {
				return fmt.Errorf(
					"%s %s %s: the authorizer has no JWKS endpoint; the route cannot be served",
					api.LogicalID, route.Method, route.Path,
				)
			}
		}
	}
	return nil
}

// resolveTemplateString evaluates one raw CloudFormation value.
func (r *Runner) resolveTemplateString(raw, stack string, resources map[string]map[string]ResourceSpec, template templateContext) (string, error) {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return strings.TrimSpace(raw), nil
	}
	return r.evaluate(value, stack, resources, r.resourceValues, template)
}

// issuerForURL maps a configured issuer to the accepted issuer values and the
// JWKS endpoint. A Cognito issuer for a provisioned pool resolves to the
// loopback issuer the runner serves; the token may still name the canonical
// Cognito issuer, so both are accepted.
func (r *Runner) issuerForURL(issuer string) ([]string, string, error) {
	issuer = strings.TrimSpace(issuer)
	if issuer == "" {
		return nil, "", fmt.Errorf("the authorizer declares an empty issuer")
	}
	if _, poolID, ok := cognitoIssuerPoolID(issuer); ok {
		value, found := r.provisionedPool(poolID)
		if !found {
			return nil, "", fmt.Errorf(
				"the JWT issuer %q names a Cognito pool the run did not provision",
				issuer,
			)
		}
		if value.LocalIssuer == "" {
			return nil, "", fmt.Errorf("the Cognito pool %s has no local issuer", poolID)
		}
		return []string{issuer, value.LocalIssuer}, value.LocalIssuer + "/.well-known/jwks.json", nil
	}
	if !strings.HasPrefix(issuer, "http://") && !strings.HasPrefix(issuer, "https://") {
		return nil, "", fmt.Errorf("the JWT issuer %q is not an http(s) OIDC issuer URL", issuer)
	}
	return []string{issuer}, strings.TrimSuffix(issuer, "/") + "/.well-known/jwks.json", nil
}

// issuersForCognitoPools maps a REST authorizer's pool ARNs to the provisioned
// pools' local issuers.
func (r *Runner) issuersForCognitoPools(expressions []string, stack string, resources map[string]map[string]ResourceSpec, template templateContext) ([]string, string, error) {
	if len(expressions) == 0 {
		return nil, "", fmt.Errorf("the Cognito authorizer names no pool")
	}
	var accepted []string
	var jwks string
	for _, expression := range expressions {
		arn, err := r.resolveTemplateString(expression, stack, resources, template)
		if err != nil {
			return nil, "", fmt.Errorf("resolve the Cognito pool ARN: %w", err)
		}
		poolID, ok := cognitoPoolIDFromARN(arn)
		if !ok {
			return nil, "", fmt.Errorf("the Cognito authorizer pool %q is not a user-pool ARN", arn)
		}
		value, found := r.provisionedPool(poolID)
		if !found {
			return nil, "", fmt.Errorf("the Cognito authorizer names pool %s, which the run did not provision", poolID)
		}
		if value.LocalIssuer == "" {
			return nil, "", fmt.Errorf("the Cognito pool %s has no local issuer", poolID)
		}
		accepted = append(accepted, value.LocalIssuer, "https://cognito-idp."+LocalRegion+".amazonaws.com/"+poolID)
		jwks = value.LocalIssuer + "/.well-known/jwks.json"
	}
	return accepted, jwks, nil
}

// provisionedPool finds a provisioned Cognito pool by its pool id.
func (r *Runner) provisionedPool(poolID string) (resourceValue, bool) {
	for _, value := range r.resourceValues {
		if value.Type == typeCognitoUserPool && value.Name == poolID {
			return value, true
		}
	}
	return resourceValue{}, false
}
