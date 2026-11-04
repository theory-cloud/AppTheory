package localrunner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// API authorizers.
//
// API Gateway has four authorizer kinds the runner can meet in a template:
//
//   - an HTTP API v2 REQUEST Lambda authorizer with simple responses, run by the
//     local transport before the route handler;
//   - an HTTP API v2 JWT authorizer, validated against the issuer's JWKS;
//   - a WebSocket API REQUEST authorizer on $connect, which returns an IAM
//     policy the runner matches narrowly against the $connect method ARN;
//   - a REST API v1 Cognito user-pool authorizer, validated against the pool's
//     JWKS.
//
// Derivation reads all four so one stack can carry several APIs. A route that
// references a kind the transport cannot run fails closed with the kind named;
// the transport never bypasses a real authorizer.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html

const (
	authorizerTypeRequest          = "REQUEST"
	authorizerTypeCognitoUserPools = "COGNITO_USER_POOLS"
)

// AuthorizerKind names one authorizer implementation.
type AuthorizerKind string

const (
	// AuthorizerKindSimpleRequest is an HTTP API REQUEST authorizer with
	// EnableSimpleResponses.
	AuthorizerKindSimpleRequest AuthorizerKind = "http-request-simple"
	// AuthorizerKindJWT is an HTTP API JWT authorizer.
	AuthorizerKindJWT AuthorizerKind = "http-jwt"
	// AuthorizerKindLambdaRequest is a Lambda authorizer that returns an IAM
	// policy: a WebSocket $connect authorizer, or a REST TOKEN/REQUEST one.
	AuthorizerKindLambdaRequest AuthorizerKind = "lambda-request-policy"
	// AuthorizerKindCognito is a REST API COGNITO_USER_POOLS authorizer.
	AuthorizerKindCognito AuthorizerKind = "rest-cognito-user-pools"
)

// apiAuthorizer is one authorizer resource a route can reference.
type apiAuthorizer struct {
	Kind AuthorizerKind
	// Function is the qualified Lambda function for a Lambda-backed kind.
	Function        string
	IdentitySources []string
	// SimpleResponses is EnableSimpleResponses for an HTTP API REQUEST
	// authorizer.
	SimpleResponses bool
	// JWT is set for a JWT authorizer.
	JWT *jwtAuthorizer
	// Cognito is set for a REST Cognito user-pool authorizer.
	Cognito *cognitoAuthorizer
}

// jwtAuthorizer is an HTTP API JWT authorizer's configuration. The issuer is a
// template value: a literal URL or a CloudFormation expression that names the
// provisioned Cognito pool. The run resolves the expression, because a pool id
// is assigned at provisioning.
type jwtAuthorizer struct {
	Issuer           string
	IssuerExpression json.RawMessage
	Audience         []json.RawMessage
}

// cognitoAuthorizer is a REST API COGNITO_USER_POOLS authorizer's
// configuration. ProviderARNs are the pool ARNs the template names; the runner
// resolves a pool it provisioned to the local issuer.
type cognitoAuthorizer struct {
	ProviderARNs []json.RawMessage
}

type httpJWTAuthorizerProperties struct {
	AuthorizerType        string          `json:"AuthorizerType"`
	AuthorizerURI         json.RawMessage `json:"AuthorizerUri"`
	IdentitySource        []string        `json:"IdentitySource"`
	EnableSimpleResponses bool            `json:"EnableSimpleResponses"`
	JwtConfiguration      struct {
		Issuer   json.RawMessage   `json:"Issuer"`
		Audience []json.RawMessage `json:"Audience"`
	} `json:"JwtConfiguration"`
}

type restAuthorizerProperties struct {
	Type                         string            `json:"Type"`
	ProviderARNs                 []json.RawMessage `json:"ProviderARNs"`
	AuthorizerURI                json.RawMessage   `json:"AuthorizerUri"`
	IdentitySource               string            `json:"IdentitySource"`
	AuthorizerResultTtlInSeconds int               `json:"AuthorizerResultTtlInSeconds"`
}

// deriveAPIAuthorizers parses every authorizer resource in one stack. A
// destination this stack's routes do not use is still parsed, but a kind the
// runner cannot run only fails the route that references it.
func deriveAPIAuthorizers(stacks []assemblyStack, stack assemblyStack, types map[string]string) (map[string]apiAuthorizer, error) {
	authorizers := map[string]apiAuthorizer{}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		switch resource.Type {
		case typeHTTPAuthorizer:
			authorizer, err := parseHTTPAPIAuthorizer(stack, types, id, resource)
			if err != nil {
				return nil, err
			}
			authorizers[id] = authorizer
		case typeRESTAuthorizer:
			authorizer, err := parseRESTAPIAuthorizer(stack, id, resource)
			if err != nil {
				return nil, err
			}
			authorizers[id] = authorizer
		}
	}
	for id, authorizer := range authorizers {
		if authorizer.Function != "" {
			authorizer.Function = qualify(stacks, stack.Name, authorizer.Function)
			authorizers[id] = authorizer
		}
	}
	return authorizers, nil
}

func parseHTTPAPIAuthorizer(stack assemblyStack, types map[string]string, id string, resource templateResource) (apiAuthorizer, error) {
	var props httpJWTAuthorizerProperties
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return apiAuthorizer{}, fmt.Errorf("%s/%s: parse HTTP authorizer properties: %w", stack.Name, id, err)
	}
	identitySources, err := parseIdentitySourcesList(stack, id, props.IdentitySource)
	if err != nil {
		return apiAuthorizer{}, err
	}
	switch strings.TrimSpace(props.AuthorizerType) {
	case "JWT":
		issuer, expression, err := parseIssuerValue(stack.Name+"/"+id, props.JwtConfiguration.Issuer)
		if err != nil {
			return apiAuthorizer{}, err
		}
		return apiAuthorizer{
			Kind:            AuthorizerKindJWT,
			IdentitySources: identitySources,
			JWT: &jwtAuthorizer{
				Issuer:           issuer,
				IssuerExpression: expression,
				Audience:         append([]json.RawMessage(nil), props.JwtConfiguration.Audience...),
			},
		}, nil
	case authorizerTypeRequest:
		functionID, ok := findRefByType(props.AuthorizerURI, types, typeLambdaFunction, attrArn)
		if !ok {
			return apiAuthorizer{}, unsupported(stack.Name+"/"+id, "HTTP API authorizer Uri does not reference a Lambda function")
		}
		kind := AuthorizerKindLambdaRequest
		if props.EnableSimpleResponses {
			kind = AuthorizerKindSimpleRequest
		}
		return apiAuthorizer{
			Kind:            kind,
			Function:        functionID,
			IdentitySources: identitySources,
			SimpleResponses: props.EnableSimpleResponses,
		}, nil
	default:
		return apiAuthorizer{}, unsupported(
			stack.Name+"/"+id,
			"HTTP API authorizer type %q is not run locally",
			props.AuthorizerType,
		)
	}
}

// parseRESTAPIAuthorizer reads an AWS::ApiGateway::Authorizer.
func parseRESTAPIAuthorizer(stack assemblyStack, id string, resource templateResource) (apiAuthorizer, error) {
	var props restAuthorizerProperties
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return apiAuthorizer{}, fmt.Errorf("%s/%s: parse REST authorizer properties: %w", stack.Name, id, err)
		}
	}
	authorizerType := strings.ToUpper(strings.TrimSpace(props.Type))
	switch authorizerType {
	case authorizerTypeCognitoUserPools:
		if len(props.ProviderARNs) == 0 {
			return apiAuthorizer{}, unsupported(stack.Name+"/"+id, "COGNITO_USER_POOLS authorizer declares no ProviderARNs")
		}
		return apiAuthorizer{
			Kind:            AuthorizerKindCognito,
			IdentitySources: []string{strings.TrimSpace(props.IdentitySource)},
			Cognito:         &cognitoAuthorizer{ProviderARNs: props.ProviderARNs},
		}, nil
	case "TOKEN", authorizerTypeRequest:
		return apiAuthorizer{Kind: AuthorizerKindLambdaRequest}, nil
	case "":
		return apiAuthorizer{}, unsupported(stack.Name+"/"+id, "REST authorizer declares no Type")
	default:
		return apiAuthorizer{}, unsupported(stack.Name+"/"+id, "REST authorizer type %q is not run locally", props.Type)
	}
}

// parseIssuerValue splits a JWT issuer into a literal and, when the template
// value is an expression, the raw expression the run resolves.
func parseIssuerValue(construct string, raw json.RawMessage) (string, json.RawMessage, error) {
	if len(raw) == 0 {
		return "", nil, unsupported(construct, "JWT authorizer declares no JwtConfiguration.Issuer")
	}
	var literal string
	if err := json.Unmarshal(raw, &literal); err == nil {
		literal = strings.TrimSpace(literal)
		if literal == "" {
			return "", nil, unsupported(construct, "JWT authorizer declares an empty JwtConfiguration.Issuer")
		}
		if !strings.HasPrefix(literal, "http://") && !strings.HasPrefix(literal, "https://") {
			return "", nil, unsupported(
				construct,
				"JWT authorizer issuer %q is not an http(s) OIDC issuer URL",
				literal,
			)
		}
		return literal, nil, nil
	}
	return "", raw, nil
}

// parseIdentitySourcesList validates every configured identity source.
func parseIdentitySourcesList(stack assemblyStack, id string, sources []string) ([]string, error) {
	parsed := make([]string, 0, len(sources))
	for _, source := range sources {
		trimmed := strings.TrimSpace(source)
		if trimmed == "" {
			continue
		}
		if err := validateIdentitySource(trimmed); err != nil {
			return nil, unsupported(stack.Name+"/"+id, "%v", err)
		}
		parsed = append(parsed, trimmed)
	}
	return parsed, nil
}
