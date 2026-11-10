package localrunner

import (
	"fmt"
	"net/http"
	"strings"
)

// The transport-side IAM gate.
//
// An AWS_IAM REST method, HTTP API route or Function URL runs this gate before
// the handler is invoked. It verifies the request's Signature Version 4
// signature with the credentials the run issued, resolves the caller principal
// (the assumed-role ARN for a session), evaluates the API's resource policy and
// the caller's identity policies under AWS's combination rule, and either lets
// the request through with the principal in the event identity or refuses it
// with a named error.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html

// iamAuthorize is the gate the transport calls.
func (r *Runner) iamAuthorize(
	request *http.Request,
	route Route,
	path string,
	stagePrefix string,
	body []byte,
) (authorizerResult, error) {
	spec := r.CurrentSpec()
	if spec == nil {
		return authorizerResult{}, fmt.Errorf("the run has no derived surface for the IAM gate")
	}
	api := r.apiForRoute(route)
	if api == nil {
		return authorizerResult{}, fmt.Errorf("the IAM gate cannot find the API that serves %s %s", route.Method, path)
	}
	principal, err := r.verifySigV4(request, body, r.now(), iamExecuteAPIService)
	if err != nil {
		r.logf("%s %s -> 403 (AWS_IAM: %v)", request.Method, path, err)
		return authorizerResult{
			Status:  http.StatusForbidden,
			Refusal: err.Error(),
		}, nil
	}
	stage := api.Stage
	if trimmed := strings.Trim(stagePrefix, "/"); trimmed != "" {
		stage = trimmed
	}
	call := iamCall{
		API:    *api,
		Stack:  api.Stack,
		Method: request.Method,
		Path:   path,
		Stage:  stage,
		Caller: principal,
	}
	decision := r.iamAllowsInvoke(spec, call)
	if !decision.Allowed {
		r.logf("%s %s -> 403 (AWS_IAM: %s)", request.Method, path, decision.Reason)
		return authorizerResult{Status: http.StatusForbidden, Refusal: decision.Reason}, nil
	}
	r.logf("%s %s -> allowed for %s", request.Method, path, principal.ARN)
	return authorizerResult{Principal: &principal}, nil
}

// apiForRoute finds the API spec a route belongs to.
func (r *Runner) apiForRoute(route Route) *APISpec {
	spec := r.CurrentSpec()
	if spec == nil {
		return nil
	}
	for index := range spec.APIs {
		api := &spec.APIs[index]
		for _, candidate := range api.Routes {
			if candidate.Class == route.Class && candidate.Method == route.Method &&
				candidate.Path == route.Path && candidate.Function == route.Function {
				return api
			}
		}
	}
	// A Function URL's API is synthesized from its spec, not from spec.APIs.
	for _, url := range spec.FunctionURLs {
		if url.Function == route.Function && route.Class == APIFunctionURL {
			api := functionURLAPI(url)
			return &api
		}
	}
	return nil
}

// refusalMessage is the body a refused AWS_IAM call carries. API Gateway answers
// a missing or invalid signature with `{"message":"Forbidden"}` and a policy
// refusal with `{"message":"Missing Authentication Token"}`; the local gate names
// the reason so a developer can act on it.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
func refusalMessage(reason string) string {
	if reason == "" {
		return `{"message":"Forbidden"}`
	}
	encoder := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `{"message":"Forbidden","reason":"` + encoder.Replace(reason) + `"}`
}
