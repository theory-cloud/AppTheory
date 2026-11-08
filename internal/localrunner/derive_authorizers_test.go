package localrunner

import (
	"strings"
	"testing"
)

func authorizerAssembly(resources map[string]any) map[string]any {
	base := map[string]any{
		"Fn":       withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Pool":     map[string]any{"Type": typeCognitoUserPool, "Properties": map[string]any{"UserPoolName": "local-pool"}},
		"Client":   map[string]any{"Type": typeCognitoClient, "Properties": map[string]any{"UserPoolId": map[string]any{"Ref": "Pool"}}},
		"Api":      map[string]any{"Type": typeHTTPAPI, "Properties": map[string]any{"ProtocolType": "HTTP"}},
		"Stage":    map[string]any{"Type": typeHTTPStage, "Properties": map[string]any{"ApiId": map[string]any{"Ref": "Api"}, "StageName": "$default"}},
		"Route":    map[string]any{"Type": typeHTTPRoute, "Properties": map[string]any{}},
		"Integ":    map[string]any{"Type": typeHTTPIntegration, "Properties": map[string]any{"IntegrationType": "AWS_PROXY", "IntegrationUri": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}},
		"RestApi":  map[string]any{"Type": typeRESTAPI, "Properties": map[string]any{"Name": "rest"}},
		"Resource": map[string]any{"Type": typeRESTResource, "Properties": map[string]any{"RestApiId": map[string]any{"Ref": "RestApi"}, "ParentId": map[string]any{"Fn::GetAtt": []any{"RestApi", "RootResourceId"}}, "PathPart": "protected"}},
		"Method":   map[string]any{"Type": typeRESTMethod, "Properties": map[string]any{}},
	}
	for key, value := range resources {
		base[key] = value
	}
	return base
}

func TestDeriveHTTPJWTAuthorizer(t *testing.T) {
	resources := authorizerAssembly(map[string]any{
		"Auth": map[string]any{"Type": typeHTTPAuthorizer, "Properties": map[string]any{
			"AuthorizerType": "JWT",
			"IdentitySource": []any{"$request.header.Authorization"},
			"JwtConfiguration": map[string]any{
				"Issuer":   map[string]any{"Fn::Join": []any{"", []any{"https://cognito-idp.us-east-1.amazonaws.com/", map[string]any{"Ref": "Pool"}}}},
				"Audience": []any{map[string]any{"Ref": "Client"}},
			},
		}},
		"Route": map[string]any{"Type": typeHTTPRoute, "Properties": map[string]any{
			"ApiId":               map[string]any{"Ref": "Api"},
			"RouteKey":            "GET /protected",
			"AuthorizationType":   "JWT",
			"AuthorizerId":        map[string]any{"Ref": "Auth"},
			"AuthorizationScopes": []any{"api/read"},
			"Target":              map[string]any{"Ref": "Integ"},
		}},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	var route Route
	for _, api := range spec.APIs {
		for _, candidate := range api.Routes {
			if candidate.Path == "/protected" {
				route = candidate
			}
		}
	}
	if route.AuthorizerKind != AuthorizerKindJWT {
		t.Fatalf("route = %+v", route)
	}
	if len(route.JWTAudienceExpressions) != 1 || !strings.Contains(route.JWTAudienceExpressions[0], "Client") {
		t.Fatalf("audience expressions = %+v", route.JWTAudienceExpressions)
	}
	if len(route.AuthorizationScopes) != 1 || route.AuthorizationScopes[0] != "api/read" {
		t.Fatalf("scopes = %+v", route.AuthorizationScopes)
	}
	if len(route.AuthorizerIdentitySources) != 1 || route.AuthorizerIdentitySources[0] != "$request.header.Authorization" {
		t.Fatalf("identity sources = %+v", route.AuthorizerIdentitySources)
	}
}

func TestDeriveRESTCognitoAuthorizer(t *testing.T) {
	resources := authorizerAssembly(map[string]any{
		"RestAuth": map[string]any{"Type": typeRESTAuthorizer, "Properties": map[string]any{
			"Type":           "COGNITO_USER_POOLS",
			"ProviderARNs":   []any{map[string]any{"Fn::GetAtt": []any{"Pool", "Arn"}}},
			"IdentitySource": "method.request.header.Authorization",
		}},
		"Method": map[string]any{"Type": typeRESTMethod, "Properties": map[string]any{
			"RestApiId":           map[string]any{"Ref": "RestApi"},
			"ResourceId":          map[string]any{"Ref": "Resource"},
			"HttpMethod":          "GET",
			"AuthorizationType":   "COGNITO_USER_POOLS",
			"AuthorizerId":        map[string]any{"Ref": "RestAuth"},
			"AuthorizationScopes": []any{"aws.cognito.signin.user.admin"},
			"Integration": map[string]any{
				"Type": "AWS_PROXY",
				"Uri":  map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		}},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	var route Route
	for _, api := range spec.APIs {
		for _, candidate := range api.Routes {
			if candidate.Path == "/protected" {
				route = candidate
			}
		}
	}
	if route.AuthorizerKind != AuthorizerKindCognito {
		t.Fatalf("route = %+v", route)
	}
	if len(route.CognitoPoolARNs) != 1 || !strings.Contains(route.CognitoPoolARNs[0], "Fn::GetAtt") {
		t.Fatalf("pool ARNs = %+v", route.CognitoPoolARNs)
	}
	if len(route.AuthorizationScopes) != 1 || route.AuthorizationScopes[0] != "aws.cognito.signin.user.admin" {
		t.Fatalf("scopes = %+v", route.AuthorizationScopes)
	}
}

func TestDeriveHTTPPolicyAuthorizerRequiresAFunction(t *testing.T) {
	resources := authorizerAssembly(map[string]any{
		"Auth": map[string]any{"Type": typeHTTPAuthorizer, "Properties": map[string]any{
			"AuthorizerType":        "REQUEST",
			"EnableSimpleResponses": false,
			"AuthorizerUri":         map[string]any{"Fn::GetAtt": []any{"Missing", "Arn"}},
		}},
		"Route": map[string]any{"Type": typeHTTPRoute, "Properties": map[string]any{
			"ApiId":             map[string]any{"Ref": "Api"},
			"RouteKey":          "GET /protected",
			"AuthorizationType": "CUSTOM",
			"AuthorizerId":      map[string]any{"Ref": "Auth"},
			"Target":            map[string]any{"Ref": "Integ"},
		}},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	if _, err := deriveAssembly(t, dir); err == nil || !strings.Contains(err.Error(), "Lambda function") {
		t.Fatalf("an authorizer without a Lambda function must fail closed, got %v", err)
	}
}

func TestDeriveServesIAMAuthorization(t *testing.T) {
	// An AWS_IAM route is served, and the transport's gate decides every call.
	// docs/127 W3-D1: the local runner verifies the SigV4 signature and
	// evaluates the enumerated policy shapes instead of refusing the route.
	resources := authorizerAssembly(map[string]any{
		"Route": map[string]any{"Type": typeHTTPRoute, "Properties": map[string]any{
			"ApiId":             map[string]any{"Ref": "Api"},
			"RouteKey":          "GET /protected",
			"AuthorizationType": "AWS_IAM",
			"Target":            map[string]any{"Ref": "Integ"},
		}},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("an AWS_IAM route must be served, got %v", err)
	}
	found := false
	for _, api := range spec.APIs {
		for _, route := range api.Routes {
			if route.Path == "/protected" && route.AuthorizerKind == AuthorizerKindIAM {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("the route must carry the IAM authorizer kind: %+v", spec.APIs)
	}
}

func TestDeriveServesAnIAMFunctionURL(t *testing.T) {
	resources := map[string]any{
		"Fn": withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Url": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          authorizationTypeIAM,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
		"Permission": map[string]any{
			"Type": typeLambdaPermission,
			"Properties": map[string]any{
				"Action":              iamActionInvokeFunctionURL,
				"FunctionName":        map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				"Principal":           "123456789012",
				"FunctionUrlAuthType": authorizationTypeIAM,
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.FunctionURLs) != 1 || !spec.FunctionURLs[0].IAM {
		t.Fatalf("an AWS_IAM Function URL must be served with the IAM flag: %+v", spec.FunctionURLs)
	}
	if len(spec.FunctionURLs[0].FunctionPolicy) == 0 {
		t.Fatal("the Function URL must carry the function's resource policy")
	}
	api := functionURLAPI(spec.FunctionURLs[0])
	if api.Routes[0].AuthorizerKind != AuthorizerKindIAM {
		t.Fatalf("the Function URL route must carry the IAM authorizer kind: %+v", api.Routes[0])
	}
}
