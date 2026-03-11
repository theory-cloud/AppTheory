package apptheory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/lambdacontext"
)

const (
	contextKeyTriggerType           = "apptheory.trigger_type"
	contextKeyAppSyncFieldName      = "apptheory.appsync.field_name"
	contextKeyAppSyncParentTypeName = "apptheory.appsync.parent_type_name"
	contextKeyAppSyncArguments      = "apptheory.appsync.arguments"
	contextKeyAppSyncIdentity       = "apptheory.appsync.identity"
	contextKeyAppSyncSource         = "apptheory.appsync.source"
	contextKeyAppSyncVariables      = "apptheory.appsync.variables"
	contextKeyAppSyncPrev           = "apptheory.appsync.prev"
	contextKeyAppSyncStash          = "apptheory.appsync.stash"
	contextKeyAppSyncRequestHeaders = "apptheory.appsync.request_headers"
	contextKeyAppSyncRawEvent       = "apptheory.appsync.raw_event"
	appSyncProjectionMessage        = "unsupported appsync response"
	appSyncProjectionBinaryReason   = "binary_body_unsupported"
	appSyncProjectionStreamReason   = "streaming_body_unsupported"
	appSyncErrorTypeClient          = "CLIENT_ERROR"
	appSyncErrorTypeSystem          = "SYSTEM_ERROR"
)

// AppSyncResolverEvent is the standard AWS AppSync Lambda resolver event shape.
type AppSyncResolverEvent struct {
	Arguments map[string]any         `json:"arguments"`
	Identity  map[string]any         `json:"identity,omitempty"`
	Source    map[string]any         `json:"source,omitempty"`
	Request   AppSyncResolverRequest `json:"request,omitempty"`
	Info      AppSyncResolverInfo    `json:"info"`
	Prev      any                    `json:"prev,omitempty"`
	Stash     map[string]any         `json:"stash,omitempty"`
}

// AppSyncResolverRequest contains request metadata forwarded by AppSync.
type AppSyncResolverRequest struct {
	Headers map[string]string `json:"headers,omitempty"`
}

// AppSyncResolverInfo contains resolver metadata for the invoked GraphQL field.
type AppSyncResolverInfo struct {
	FieldName           string         `json:"fieldName"`
	ParentTypeName      string         `json:"parentTypeName"`
	Variables           map[string]any `json:"variables,omitempty"`
	SelectionSetList    []string       `json:"selectionSetList,omitempty"`
	SelectionSetGraphQL string         `json:"selectionSetGraphQL,omitempty"`
}

func cloneStringAnyMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func cloneStringStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func newAppSyncContext(event AppSyncResolverEvent) *AppSyncContext {
	return &AppSyncContext{
		FieldName:      strings.TrimSpace(event.Info.FieldName),
		ParentTypeName: strings.TrimSpace(event.Info.ParentTypeName),
		Arguments:      cloneStringAnyMap(event.Arguments),
		Identity:       cloneStringAnyMap(event.Identity),
		Source:         cloneStringAnyMap(event.Source),
		Variables:      cloneStringAnyMap(event.Info.Variables),
		Stash:          cloneStringAnyMap(event.Stash),
		Prev:           event.Prev,
		RequestHeaders: cloneStringStringMap(event.Request.Headers),
		RawEvent: AppSyncResolverEvent{
			Arguments: cloneStringAnyMap(event.Arguments),
			Identity:  cloneStringAnyMap(event.Identity),
			Source:    cloneStringAnyMap(event.Source),
			Request: AppSyncResolverRequest{
				Headers: cloneStringStringMap(event.Request.Headers),
			},
			Info: AppSyncResolverInfo{
				FieldName:           strings.TrimSpace(event.Info.FieldName),
				ParentTypeName:      strings.TrimSpace(event.Info.ParentTypeName),
				Variables:           cloneStringAnyMap(event.Info.Variables),
				SelectionSetList:    append([]string(nil), event.Info.SelectionSetList...),
				SelectionSetGraphQL: event.Info.SelectionSetGraphQL,
			},
			Prev:  event.Prev,
			Stash: cloneStringAnyMap(event.Stash),
		},
	}
}

func requestFromAppSync(event AppSyncResolverEvent) (Request, error) {
	fieldName := strings.TrimSpace(event.Info.FieldName)
	parentTypeName := strings.TrimSpace(event.Info.ParentTypeName)
	if fieldName == "" || parentTypeName == "" {
		return Request{}, &AppError{Code: errorCodeBadRequest, Message: "invalid appsync event"}
	}

	headers := map[string][]string{}
	for key, value := range event.Request.Headers {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		headers[key] = []string{value}
	}
	if len(headers["content-type"]) == 0 {
		headers["content-type"] = []string{"application/json; charset=utf-8"}
	}

	var body []byte
	if len(event.Arguments) > 0 {
		var err error
		body, err = json.Marshal(event.Arguments)
		if err != nil {
			return Request{}, &AppError{Code: errorCodeBadRequest, Message: "invalid appsync event"}
		}
	}

	return Request{
		Method:  appSyncMethod(parentTypeName),
		Path:    "/" + fieldName,
		Headers: headers,
		Body:    body,
	}, nil
}

type appSyncResolverEventProbe struct {
	Arguments json.RawMessage `json:"arguments"`
	Info      json.RawMessage `json:"info"`
}

type appSyncResolverInfoProbe struct {
	FieldName      string `json:"fieldName"`
	ParentTypeName string `json:"parentTypeName"`
}

func appSyncEventFromRawMessage(raw json.RawMessage) (AppSyncResolverEvent, bool, error) {
	var probe appSyncResolverEventProbe
	if err := json.Unmarshal(raw, &probe); err != nil {
		return AppSyncResolverEvent{}, false, nil
	}
	if len(bytes.TrimSpace(probe.Arguments)) == 0 || len(bytes.TrimSpace(probe.Info)) == 0 {
		return AppSyncResolverEvent{}, false, nil
	}

	var info appSyncResolverInfoProbe
	if err := json.Unmarshal(probe.Info, &info); err != nil {
		return AppSyncResolverEvent{}, false, nil
	}
	if strings.TrimSpace(info.FieldName) == "" || strings.TrimSpace(info.ParentTypeName) == "" {
		return AppSyncResolverEvent{}, false, nil
	}

	var event AppSyncResolverEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		return AppSyncResolverEvent{}, true, err
	}
	return event, true, nil
}

func appSyncMethod(parentTypeName string) string {
	switch strings.TrimSpace(parentTypeName) {
	case "Query", "Subscription":
		return "GET"
	default:
		return "POST"
	}
}

func applyAppSyncContextValues(ctx *Context, event AppSyncResolverEvent) {
	if ctx == nil {
		return
	}
	ctx.appsync = newAppSyncContext(event)
	ctx.Set(contextKeyTriggerType, "appsync")
	ctx.Set(contextKeyAppSyncFieldName, event.Info.FieldName)
	ctx.Set(contextKeyAppSyncParentTypeName, event.Info.ParentTypeName)
	ctx.Set(contextKeyAppSyncArguments, event.Arguments)
	ctx.Set(contextKeyAppSyncIdentity, event.Identity)
	ctx.Set(contextKeyAppSyncSource, event.Source)
	ctx.Set(contextKeyAppSyncVariables, event.Info.Variables)
	ctx.Set(contextKeyAppSyncPrev, event.Prev)
	ctx.Set(contextKeyAppSyncStash, event.Stash)
	ctx.Set(contextKeyAppSyncRequestHeaders, event.Request.Headers)
	ctx.Set(contextKeyAppSyncRawEvent, event)
}

func appSyncPayloadFromResponse(resp Response) (any, error) {
	if resp.IsBase64 {
		return nil, NewAppTheoryError(errorCodeInternal, appSyncProjectionMessage).
			WithStatusCode(500).
			WithDetails(map[string]any{"reason": appSyncProjectionBinaryReason})
	}
	if resp.BodyReader != nil || resp.BodyStream != nil {
		return nil, NewAppTheoryError(errorCodeInternal, appSyncProjectionMessage).
			WithStatusCode(500).
			WithDetails(map[string]any{"reason": appSyncProjectionStreamReason})
	}
	if len(resp.Body) == 0 {
		return nil, nil
	}
	if hasJSONContentType(resp.Headers) {
		var value any
		if err := json.Unmarshal(resp.Body, &value); err != nil {
			return nil, &AppError{Code: errorCodeInternal, Message: errorMessageInternal}
		}
		return value, nil
	}

	contentType := strings.ToLower(firstHeaderValue(resp.Headers, "content-type"))
	if strings.HasPrefix(contentType, "text/") {
		return string(resp.Body), nil
	}
	return string(resp.Body), nil
}

func appSyncRequestForEvent(event AppSyncResolverEvent) Request {
	fieldName := strings.TrimSpace(event.Info.FieldName)
	parentTypeName := strings.TrimSpace(event.Info.ParentTypeName)
	if fieldName == "" || parentTypeName == "" {
		return Request{}
	}
	return Request{
		Method: appSyncMethod(parentTypeName),
		Path:   "/" + fieldName,
	}
}

func appSyncRequestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if lc, ok := lambdacontext.FromContext(ctx); ok {
		return strings.TrimSpace(lc.AwsRequestID)
	}
	return ""
}

func appSyncRequestIDFromResponse(resp Response, fallback string) string {
	if requestID := strings.TrimSpace(firstHeaderValue(resp.Headers, "x-request-id")); requestID != "" {
		return requestID
	}
	return strings.TrimSpace(fallback)
}

func appSyncErrorTypeForStatus(status int) string {
	if status >= 400 && status < 500 {
		return appSyncErrorTypeClient
	}
	return appSyncErrorTypeSystem
}

func appSyncErrorPayload(err error, request Request, requestID string) map[string]any {
	if portableErr, ok := AsAppTheoryError(err); ok {
		return appSyncPortableErrorPayload(
			strings.TrimSpace(portableErr.Code),
			portableErr.Message,
			appSyncStatusForPortableError(portableErr),
			portableErr.Details,
			resolveAppSyncRequestID(strings.TrimSpace(portableErr.RequestID), requestID),
			strings.TrimSpace(portableErr.TraceID),
			portableErr.Timestamp,
			request,
		)
	}

	var appErr *AppError
	if errors.As(err, &appErr) {
		return appSyncPortableErrorPayload(
			strings.TrimSpace(appErr.Code),
			appErr.Message,
			statusForErrorCode(appErr.Code),
			nil,
			strings.TrimSpace(requestID),
			"",
			time.Time{},
			request,
		)
	}

	message := errorMessageInternal
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	return map[string]any{
		"pay_theory_error": true,
		"error_message":    message,
		"error_type":       appSyncErrorTypeSystem,
		"error_data":       map[string]any{},
		"error_info":       map[string]any{},
	}
}

func appSyncPortableErrorPayload(
	code string,
	message string,
	status int,
	details map[string]any,
	requestID string,
	traceID string,
	timestamp time.Time,
	request Request,
) map[string]any {
	if code == "" {
		code = errorCodeInternal
	}
	if status == 0 {
		status = statusForErrorCode(code)
	}
	errorData := map[string]any{
		"status_code": status,
	}
	if requestID = strings.TrimSpace(requestID); requestID != "" {
		errorData["request_id"] = requestID
	}
	if traceID = strings.TrimSpace(traceID); traceID != "" {
		errorData["trace_id"] = traceID
	}
	if !timestamp.IsZero() {
		errorData["timestamp"] = timestamp.UTC().Format(time.RFC3339Nano)
	}

	errorInfo := map[string]any{
		"code":         code,
		"trigger_type": "appsync",
	}
	if method := strings.TrimSpace(request.Method); method != "" {
		errorInfo["method"] = method
	}
	if path := strings.TrimSpace(request.Path); path != "" {
		errorInfo["path"] = path
	}
	if len(details) > 0 {
		errorInfo["details"] = details
	}

	return map[string]any{
		"pay_theory_error": true,
		"error_message":    message,
		"error_type":       appSyncErrorTypeForStatus(status),
		"error_data":       errorData,
		"error_info":       errorInfo,
	}
}

func appSyncStatusForPortableError(err *AppTheoryError) int {
	if err == nil {
		return 0
	}
	if err.StatusCode > 0 {
		return err.StatusCode
	}
	return statusForErrorCode(err.Code)
}

func resolveAppSyncRequestID(primary string, fallback string) string {
	if strings.TrimSpace(primary) != "" {
		return strings.TrimSpace(primary)
	}
	return strings.TrimSpace(fallback)
}

func appSyncErrorResponse(err error, request Request, requestID string) Response {
	status := statusForErrorCode(errorCodeInternal)
	if portableErr, ok := AsAppTheoryError(err); ok {
		status = appSyncStatusForPortableError(portableErr)
	} else {
		var appErr *AppError
		if errors.As(err, &appErr) {
			status = statusForErrorCode(appErr.Code)
		}
	}
	body, marshalErr := json.Marshal(appSyncErrorPayload(err, request, requestID))
	if marshalErr != nil {
		body = []byte(`{"pay_theory_error":true,"error_message":"internal error","error_type":"SYSTEM_ERROR","error_data":{},"error_info":{}}`)
	}
	return Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"application/json; charset=utf-8"},
		},
		Body:     body,
		IsBase64: false,
	}
}

// ServeAppSync adapts an AppSync Lambda resolver event into AppTheory routing semantics.
func (a *App) ServeAppSync(ctx context.Context, event AppSyncResolverEvent) any {
	requestID := appSyncRequestIDFromContext(ctx)
	requestMeta := appSyncRequestForEvent(event)
	request, err := requestFromAppSync(event)
	if err != nil {
		payload, _ := appSyncPayloadFromResponse(appSyncErrorResponse(err, requestMeta, requestID))
		return payload
	}

	resp := a.serveWithOptions(ctx, request, serveOptions{
		configure: func(requestCtx *Context) {
			applyAppSyncContextValues(requestCtx, event)
		},
		errorResponder: func(err error, request Request, requestID string) Response {
			return appSyncErrorResponse(err, request, requestID)
		},
		fallbackRequestID: requestID,
	})

	payload, err := appSyncPayloadFromResponse(resp)
	if err != nil {
		payload, _ = appSyncPayloadFromResponse(appSyncErrorResponse(err, requestMeta, appSyncRequestIDFromResponse(resp, requestID)))
	}
	return payload
}
