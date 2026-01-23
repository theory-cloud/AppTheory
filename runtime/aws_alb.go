package apptheory

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

func (a *App) ServeALB(ctx context.Context, event events.ALBTargetGroupRequest) events.ALBTargetGroupResponse {
	req, err := requestFromALB(event)
	if err != nil {
		return albTargetGroupResponseFromResponse(responseForError(err))
	}
	return albTargetGroupResponseFromResponse(a.Serve(ctx, req))
}

func requestFromALB(event events.ALBTargetGroupRequest) (Request, error) {
	return Request{
		Method:   event.HTTPMethod,
		Path:     event.Path,
		Query:    queryFromProxyEvent(event.QueryStringParameters, event.MultiValueQueryStringParameters),
		Headers:  headersFromProxyEvent(event.Headers, event.MultiValueHeaders),
		Body:     []byte(event.Body),
		IsBase64: event.IsBase64Encoded,
	}, nil
}

func albTargetGroupResponseFromResponse(resp Response) events.ALBTargetGroupResponse {
	out := events.ALBTargetGroupResponse{
		StatusCode:        resp.Status,
		StatusDescription: albStatusDescription(resp.Status),
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		IsBase64Encoded:   resp.IsBase64,
		Body:              string(resp.Body),
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = values[0]
		out.MultiValueHeaders[key] = append([]string(nil), values...)
	}

	if len(resp.Cookies) > 0 {
		out.Headers["set-cookie"] = resp.Cookies[0]
		out.MultiValueHeaders["set-cookie"] = append([]string(nil), resp.Cookies...)
	}

	if resp.IsBase64 {
		out.Body = base64.StdEncoding.EncodeToString(resp.Body)
	}

	return out
}

func albStatusDescription(status int) string {
	text := strings.TrimSpace(http.StatusText(status))
	if text == "" {
		return fmt.Sprintf("%d", status)
	}
	return fmt.Sprintf("%d %s", status, text)
}
