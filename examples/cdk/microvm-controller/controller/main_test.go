package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
	"github.com/theory-cloud/apptheory/v2/runtime/microvm"
)

func TestHandleLambdaRunsCanonicalControllerRoutes(t *testing.T) {
	app, err := buildApp(
		withClock(time.Date(2026, 6, 25, 8, 30, 0, 0, time.UTC)),
		withIDGenerator(newSequentialIDs("local-session")),
	)
	if err != nil {
		t.Fatalf("buildApp returned error: %v", err)
	}

	unauthorized := invoke(t, app, "POST", "/microvms", nil, runBody("tenant-1", "namespace-1"))
	if unauthorized.StatusCode != 401 {
		t.Fatalf("expected missing auth to fail closed with 401, got %d body=%s", unauthorized.StatusCode, unauthorized.Body)
	}

	run := invokeOK(t, app, "POST", "/microvms", nil, runBody("tenant-1", "namespace-1"))
	if run.Command != microvm.CommandRun {
		t.Fatalf("expected run command, got %q", run.Command)
	}
	if run.SessionID != "local-session-000001" {
		t.Fatalf("expected deterministic session id, got %q", run.SessionID)
	}
	if run.State != microvm.StateRunning {
		t.Fatalf("expected running state, got %q", run.State)
	}

	tokenBodies := make([]string, 0, 2)
	for _, route := range []struct {
		name    string
		method  string
		path    string
		body    string
		command microvm.Command
	}{
		{"get", "GET", "/microvms/local-session-000001", "{}", microvm.CommandGet},
		{"suspend", "POST", "/microvms/local-session-000001/suspend", "{}", microvm.CommandSuspend},
		{"resume", "POST", "/microvms/local-session-000001/resume", "{}", microvm.CommandResume},
		{"auth-token", "POST", "/microvms/local-session-000001/auth-token", `{"allowed_port_scope":[{"port":443}]}`, microvm.CommandAuthToken},
		{"shell-auth-token", "POST", "/microvms/local-session-000001/shell-auth-token", "{}", microvm.CommandShellAuthToken},
		{"terminate", "DELETE", "/microvms/local-session-000001", "{}", microvm.CommandTerminate},
	} {
		t.Run(route.name, func(t *testing.T) {
			response := invokeOK(t, app, route.method, route.path, nil, route.body)
			if response.Command != route.command {
				t.Fatalf("expected command %q, got %q", route.command, response.Command)
			}
			if route.command == microvm.CommandAuthToken || route.command == microvm.CommandShellAuthToken {
				encoded, err := json.Marshal(response)
				if err != nil {
					t.Fatalf("marshal token response: %v", err)
				}
				tokenBodies = append(tokenBodies, string(encoded))
			}
		})
	}

	list := invokeOK(t, app, "GET", "/microvms", map[string]string{"max_results": "10"}, "")
	if list.Command != microvm.CommandList {
		t.Fatalf("expected list command, got %q", list.Command)
	}
	if len(list.Sessions) != 1 || list.Sessions[0].SessionID != "local-session-000001" {
		t.Fatalf("expected list to return only the local tenant session, got %#v", list.Sessions)
	}

	forbiddenFragments := []string{"token_value", "bearer_token", "x-aws-proxy-auth", "Bearer "}
	combinedTokenBodies := strings.Join(tokenBodies, "\n")
	for _, fragment := range forbiddenFragments {
		if strings.Contains(combinedTokenBodies, fragment) {
			t.Fatalf("response leaked forbidden token fragment %q", fragment)
		}
	}
}

func TestControllerFailsClosedForTenantBindingAndRegistryHooks(t *testing.T) {
	app, err := buildApp(withIDGenerator(newSequentialIDs("tenant-test")))
	if err != nil {
		t.Fatalf("buildApp returned error: %v", err)
	}

	mismatch := invokeWithTenant(t, app, "POST", "/microvms", nil, runBody("tenant-2", "namespace-1"), "tenant-1", "namespace-1", true)
	if mismatch.StatusCode != 403 {
		t.Fatalf("expected tenant mismatch to fail closed with 403, got %d body=%s", mismatch.StatusCode, mismatch.Body)
	}
	if !strings.Contains(mismatch.Body, microvm.ErrorCodeTenantBindingViolation) {
		t.Fatalf("expected tenant binding violation, got %s", mismatch.Body)
	}

	_, err = microvm.NewReconstructingSessionRegistry(microvm.NewMemorySessionRegistry(), nil)
	if err == nil {
		t.Fatalf("expected missing product reconstruction hook to fail closed")
	}
}

func TestListStaysTenantBoundThroughRegistryKnownSessions(t *testing.T) {
	app, err := buildApp(withIDGenerator(newSequentialIDs("tenant-bound")))
	if err != nil {
		t.Fatalf("buildApp returned error: %v", err)
	}

	first := invokeOK(t, app, "POST", "/microvms", nil, runBody("tenant-1", "namespace-1"))
	second := invokeOKWithTenant(t, app, "POST", "/microvms", nil, runBody("tenant-2", "namespace-1"), "tenant-2", "namespace-1")
	if first.SessionID == second.SessionID {
		t.Fatalf("expected distinct sessions")
	}

	list := invokeOK(t, app, "GET", "/microvms", nil, "")
	if len(list.Sessions) != 1 || list.Sessions[0].TenantID != "tenant-1" {
		t.Fatalf("expected tenant-bound list for tenant-1 only, got %#v", list.Sessions)
	}
}

func TestLocalProductReconstructionHookRestoresProviderState(t *testing.T) {
	now := time.Date(2026, 6, 25, 9, 0, 0, 0, time.UTC)
	provider := newLocalProvider(clock{now: now})
	session, err := provider.Run(context.Background(), microvm.ProviderRunInput{
		RequestID:           "req-run",
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		SessionID:           "reconstruct-me",
		AuthContext:         microvm.AuthContext{Subject: "subject-1", TenantID: "tenant-1", Namespace: "namespace-1"},
		ImageRef:            "local-image",
		NetworkConnectorRef: "local-egress",
		Logging:             microvm.ProviderLogging{Disabled: true},
	})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	wrapped, err := microvm.NewReconstructingSessionRegistry(
		microvm.NewMemorySessionRegistry(),
		provider.reconstructSession,
		microvm.WithSessionReconstructionClock(clock{now: now}),
	)
	if err != nil {
		t.Fatalf("NewReconstructingSessionRegistry returned error: %v", err)
	}
	record, err := wrapped.Get(context.Background(), session.Key())
	if err != nil {
		t.Fatalf("wrapped.Get returned error: %v", err)
	}
	if record.ProviderMicroVMID != session.ProviderMicroVMID || record.NetworkConnectorRef != "local-egress" {
		t.Fatalf("unexpected reconstructed record: %#v", record)
	}
}

func invokeOK(t *testing.T, app *apptheory.App, method string, path string, query map[string]string, body string) microvm.ControllerResponse {
	t.Helper()
	return invokeOKWithTenant(t, app, method, path, query, body, "tenant-1", "namespace-1")
}

func invokeOKWithTenant(
	t *testing.T,
	app *apptheory.App,
	method string,
	path string,
	query map[string]string,
	body string,
	tenantID string,
	namespace string,
) microvm.ControllerResponse {
	t.Helper()
	response := invokeWithTenant(t, app, method, path, query, body, tenantID, namespace, true)
	if response.StatusCode != 200 {
		t.Fatalf("expected 200 from %s %s, got %d body=%s", method, path, response.StatusCode, response.Body)
	}
	var payload microvm.ControllerResponse
	if err := json.Unmarshal([]byte(response.Body), &payload); err != nil {
		t.Fatalf("invalid controller response JSON: %v body=%s", err, response.Body)
	}
	if payload.Error != nil {
		t.Fatalf("expected success response, got error %#v", payload.Error)
	}
	return payload
}

func invoke(t *testing.T, app *apptheory.App, method string, path string, query map[string]string, body string) events.APIGatewayV2HTTPResponse {
	t.Helper()
	return invokeWithTenant(t, app, method, path, query, body, "tenant-1", "namespace-1", false)
}

func invokeWithTenant(
	t *testing.T,
	app *apptheory.App,
	method string,
	path string,
	query map[string]string,
	body string,
	tenantID string,
	namespace string,
	authorized bool,
) events.APIGatewayV2HTTPResponse {
	t.Helper()
	headers := map[string]string{
		"content-type":   "application/json",
		"x-request-id":   "req-local",
		"x-tenant-id":    tenantID,
		"x-namespace-id": namespace,
	}
	if authorized {
		headers["authorization"] = localBearerHeader
	}
	event := events.APIGatewayV2HTTPRequest{
		RouteKey:              method + " " + path,
		RawPath:               path,
		Headers:               headers,
		QueryStringParameters: query,
		Body:                  body,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method:   method,
				Path:     path,
				SourceIP: "127.0.0.1",
			},
		},
	}
	out, err := app.HandleLambda(context.Background(), mustJSON(t, event))
	if err != nil {
		t.Fatalf("HandleLambda returned error: %v", err)
	}
	response, ok := out.(events.APIGatewayV2HTTPResponse)
	if !ok {
		t.Fatalf("expected APIGatewayV2HTTPResponse, got %T", out)
	}
	return response
}

func runBody(tenantID string, namespace string) string {
	return `{"tenant_id":"` + tenantID + `","namespace":"` + namespace + `","image_ref":"local-image","network_connector_ref":"local-egress","ingress_network_connector_refs":["local-ingress"],"egress_network_connector_refs":["local-egress"],"session_spec":{"metadata":{"purpose":"local-example"}}}`
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	return encoded
}
