package microvm

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// RegisterControllerRoutes registers the canonical M16 MicroVM controller HTTP routes on an AppTheory app.
func RegisterControllerRoutes(app *apptheory.App, controller *Controller) (*apptheory.App, error) {
	if app == nil {
		return nil, errors.New("apptheory: microvm controller route registration requires an app")
	}
	if controller == nil {
		return app, safeError(ErrorCodeControllerIncomplete, "apptheory: microvm controller route registration requires a controller", "")
	}
	routes := []struct {
		method  string
		path    string
		command Command
	}{
		{"POST", "/microvms", CommandRun},
		{"GET", "/microvms", CommandList},
		{"GET", "/microvms/{session_id}", CommandGet},
		{"POST", "/microvms/{session_id}/suspend", CommandSuspend},
		{"POST", "/microvms/{session_id}/resume", CommandResume},
		{"DELETE", "/microvms/{session_id}", CommandTerminate},
		{"POST", "/microvms/{session_id}/auth-token", CommandAuthToken},
		{"POST", "/microvms/{session_id}/shell-auth-token", CommandShellAuthToken},
		// Compatibility route for callers created during the earlier M16 contract correction.
		{"POST", "/microvms/{session_id}/shell-token", CommandShellAuthToken},
	}
	for _, route := range routes {
		if _, err := app.HandleStrict(route.method, route.path, controllerRouteHandler(controller, route.command), apptheory.RequireAuth()); err != nil {
			return app, err
		}
	}
	return app, nil
}

// RegisterMicroVMControllerRoutes is an explicit alias for RegisterControllerRoutes.
func RegisterMicroVMControllerRoutes(app *apptheory.App, controller *Controller) (*apptheory.App, error) {
	return RegisterControllerRoutes(app, controller)
}

type controllerRoutePayload struct {
	TenantID                    string              `json:"tenant_id"`
	Namespace                   string              `json:"namespace"`
	SessionID                   string              `json:"session_id"`
	ImageRef                    string              `json:"image_ref"`
	ImageVersion                string              `json:"image_version"`
	NetworkConnectorRef         string              `json:"network_connector_ref"`
	IngressNetworkConnectorRefs []string            `json:"ingress_network_connector_refs"`
	EgressNetworkConnectorRefs  []string            `json:"egress_network_connector_refs"`
	SessionSpec                 SessionSpec         `json:"session_spec"`
	IdlePolicy                  *ProviderIdlePolicy `json:"idle_policy"`
	MaximumDurationSeconds      int32               `json:"maximum_duration_seconds"`
	TTLSeconds                  int32               `json:"ttl_seconds"`
	AllowedPortScope            []ProviderPortScope `json:"allowed_port_scope"`
	MaxResults                  int32               `json:"max_results"`
}

func controllerRouteHandler(controller *Controller, command Command) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		request, safe := controllerRequestFromHTTP(ctx, command)
		if safe.Code != "" {
			return controllerHTTPResponse(controllerErrorResponse(request, safe)), nil
		}
		response, err := controller.Handle(ctx.Context(), request)
		if err != nil && response.Error == nil {
			safe := asSafeError(err, request.RequestID)
			response = controllerErrorResponse(request, safe)
		}
		return controllerHTTPResponse(response), nil
	}
}

func controllerRequestFromHTTP(ctx *apptheory.Context, command Command) (ControllerRequest, SafeError) {
	request := ControllerRequest{Command: normalizeCommand(command)}
	if ctx == nil {
		err := safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller route context is missing", "")
		return request, err
	}
	payload := controllerRoutePayload{}
	if len(ctx.Request.Body) > 0 {
		if err := json.Unmarshal(ctx.Request.Body, &payload); err != nil {
			request.RequestID = strings.TrimSpace(ctx.RequestID)
			err := safeError(ErrorCodeInvalidControllerRequest, "apptheory: microvm controller route request is malformed", request.RequestID)
			return request, err
		}
	}
	pathSessionID := strings.TrimSpace(ctx.Param("session_id"))
	bodySessionID := strings.TrimSpace(payload.SessionID)
	if pathSessionID != "" && bodySessionID != "" && pathSessionID != bodySessionID {
		request.RequestID = strings.TrimSpace(ctx.RequestID)
		err := safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm controller route session binding mismatch", request.RequestID)
		return request, err
	}
	if ctx.TenantID != "" && strings.TrimSpace(payload.TenantID) != "" && strings.TrimSpace(payload.TenantID) != strings.TrimSpace(ctx.TenantID) {
		request.RequestID = strings.TrimSpace(ctx.RequestID)
		err := safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm controller route tenant binding mismatch", request.RequestID)
		return request, err
	}
	if ctx.TenantID != "" && strings.TrimSpace(ctx.Query("tenant_id")) != "" && strings.TrimSpace(ctx.Query("tenant_id")) != strings.TrimSpace(ctx.TenantID) {
		request.RequestID = strings.TrimSpace(ctx.RequestID)
		err := safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm controller route tenant binding mismatch", request.RequestID)
		return request, err
	}
	sessionID := defaultString(pathSessionID, bodySessionID)
	tenantID := defaultString(strings.TrimSpace(ctx.TenantID), defaultString(payload.TenantID, ctx.Query("tenant_id")))
	namespace := defaultString(strings.TrimSpace(payload.Namespace), defaultString(ctx.Header("x-namespace-id"), ctx.Query("namespace")))
	request = ControllerRequest{
		Command:                     normalizeCommand(command),
		RequestID:                   strings.TrimSpace(ctx.RequestID),
		TenantID:                    tenantID,
		Namespace:                   namespace,
		AuthContext:                 AuthContext{Subject: strings.TrimSpace(ctx.AuthIdentity), TenantID: strings.TrimSpace(ctx.TenantID), Namespace: namespace},
		SessionID:                   sessionID,
		ImageRef:                    payload.ImageRef,
		ImageVersion:                payload.ImageVersion,
		NetworkConnectorRef:         payload.NetworkConnectorRef,
		IngressNetworkConnectorRefs: append([]string(nil), payload.IngressNetworkConnectorRefs...),
		EgressNetworkConnectorRefs:  append([]string(nil), payload.EgressNetworkConnectorRefs...),
		SessionSpec:                 cloneSessionSpec(payload.SessionSpec),
		IdlePolicy:                  payload.IdlePolicy,
		MaximumDurationSeconds:      payload.MaximumDurationSeconds,
		TTLSeconds:                  payload.TTLSeconds,
		AllowedPortScope:            append([]ProviderPortScope(nil), payload.AllowedPortScope...),
		MaxResults:                  firstPositiveInt32(payload.MaxResults, parseInt32(ctx.Query("max_results"))),
	}
	request = normalizeControllerRequest(request)
	return request, SafeError{}
}

func controllerHTTPResponse(response ControllerResponse) *apptheory.Response {
	status := controllerHTTPStatus(response.Error)
	out, err := apptheory.JSON(status, response)
	if err != nil {
		return apptheory.Text(500, "internal error")
	}
	return out
}

func controllerHTTPStatus(err *SafeError) int {
	if err == nil || err.Code == "" {
		return 200
	}
	switch err.Code {
	case ErrorCodeUnauthenticatedController:
		return 401
	case ErrorCodeTenantBindingViolation:
		return 403
	case ErrorCodeSessionRegistryIncomplete:
		return 404
	case ErrorCodeControllerIncomplete:
		return 500
	case ErrorCodeControllerCommandFailed, ErrorCodeProviderOperationFailed:
		return 502
	default:
		return 400
	}
}

func parseInt32(value string) int32 {
	n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 32)
	if err != nil || n <= 0 {
		return 0
	}
	return int32(n)
}

func firstPositiveInt32(value int32, fallback int32) int32 {
	if value > 0 {
		return value
	}
	return fallback
}
