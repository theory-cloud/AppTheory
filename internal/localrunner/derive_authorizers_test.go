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

func TestDeriveRefusesUnsupportedAuthorizerOnARoute(t *testing.T) {
	resources := authorizerAssembly(map[string]any{
		"Auth": map[string]any{"Type": typeHTTPAuthorizer, "Properties": map[string]any{
			"AuthorizerType":        "REQUEST",
			"EnableSimpleResponses": false,
			"AuthorizerUri":         map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
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
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "lambda-request-policy") {
		t.Fatalf("derive error = %v", err)
	}
}

func TestDeriveRefusesIAMAuthorization(t *testing.T) {
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
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "AWS_IAM") {
		t.Fatalf("derive error = %v", err)
	}
}
