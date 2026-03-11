package apptheory

import (
	"context"
	"encoding/json"
	"strings"
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

func appSyncMethod(parentTypeName string) string {
	switch strings.TrimSpace(parentTypeName) {
	case "Query", "Subscription":
		return "GET"
	default:
		return "POST"
	}
}

func appSyncPayloadFromResponse(resp Response) (any, error) {
	if resp.BodyReader != nil || resp.BodyStream != nil || resp.IsBase64 {
		return nil, &AppError{Code: errorCodeInternal, Message: errorMessageInternal}
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

// ServeAppSync adapts an AppSync Lambda resolver event into AppTheory routing semantics.
func (a *App) ServeAppSync(ctx context.Context, event AppSyncResolverEvent) any {
	request, err := requestFromAppSync(event)
	if err != nil {
		payload, _ := appSyncPayloadFromResponse(responseForError(err))
		return payload
	}

	payload, err := appSyncPayloadFromResponse(a.Serve(ctx, request))
	if err != nil {
		payload, _ = appSyncPayloadFromResponse(responseForError(err))
	}
	return payload
}
