package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The local Lambda Invoke endpoint.
//
// A custom-resource handler can invoke another function: a CDK trigger's
// provider calls `Lambda.Invoke` on the handler the trigger names, and an
// `Custom::AWS` resource can call Lambda too. The runner serves the documented
// invocation API on a loopback listener, injects it into every function as
// `AWS_ENDPOINT_URL_LAMBDA`, and dispatches the call to the target function's
// real container.
//
// https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html
// https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html

const (
	// lambdaInvokePathPrefix is the REST-JSON invocation path.
	lambdaInvokePathPrefix = "/2015-03-31/functions/"
	// lambdaInvokePathSuffix ends the path.
	lambdaInvokePathSuffix = "/invocations"
	// lambdaEndpointEnv is the SDK endpoint variable the run injects. Every AWS
	// SDK resolves a service-specific endpoint variable of this form before the
	// global one:
	// https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html
	lambdaEndpointEnv = "AWS_ENDPOINT_URL_LAMBDA"
	// lambdaInvocationTypeHeader selects synchronous or asynchronous
	// invocation.
	// https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html
	lambdaInvocationTypeHeader = "X-Amz-Invocation-Type"
	// lambdaFunctionErrorHeader reports a handler error on a synchronous
	// invocation.
	lambdaFunctionErrorHeader       = "X-Amz-Function-Error"
	lambdaInvocationRequestResponse = "RequestResponse"
	lambdaInvocationEvent           = "Event"
	// lambdaInvokeTimeout bounds one synchronous invocation.
	lambdaInvokeTimeout = 15 * time.Minute
)

// lambdaInvokeFront serves the Lambda Invoke API for the run's functions.
type lambdaInvokeFront struct {
	runner *Runner
	// invokerFor resolves a function id to its running container. It is nil in
	// production, where the runner's own invoker set answers.
	invokerFor func(string) (Invoker, bool)
}

// invoker returns the container one function id is served by.
func (f *lambdaInvokeFront) invoker(functionID string) (Invoker, bool) {
	if f.invokerFor != nil {
		return f.invokerFor(functionID)
	}
	process, ok := f.runner.invokers[functionID]
	if !ok {
		return nil, false
	}
	return process, true
}

// startLambdaInvokeFront serves the invocation API through a control listener
// and returns the URL function containers reach it at.
func (r *Runner) startLambdaInvokeFront(ctx context.Context) (string, error) {
	front := &lambdaInvokeFront{runner: r}
	listeners, err := r.listenControl(ctx, "Lambda")
	if err != nil {
		return "", err
	}
	server := &http.Server{
		Handler:           front,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := server.Serve(listener); serveErr != nil &&
				!errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("local Lambda endpoint stopped: %v", serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	containerURL := fmt.Sprintf("http://%s:%d", controlLeafName, listeners.Port)
	r.lambdaInvokeURL = containerURL
	r.logf("local Lambda endpoint for functions: %s", containerURL)
	return containerURL, nil
}

// ServeHTTP dispatches one invocation.
//
// https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html
func (f *lambdaInvokeFront) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeLambdaError(writer, http.StatusMethodNotAllowed, "InvalidParameterValueException",
			"the local Lambda endpoint accepts POST "+lambdaInvokePathPrefix+"<function>/invocations")
		return
	}
	name, ok := lambdaInvokeFunctionPath(request.URL.Path)
	if !ok {
		writeLambdaError(writer, http.StatusNotFound, "ResourceNotFoundException",
			"the local Lambda endpoint serves "+lambdaInvokePathPrefix+"<function name or ARN>"+lambdaInvokePathSuffix)
		return
	}
	functionID, ok := f.runner.functionByInvokeName(name)
	if !ok {
		writeLambdaError(writer, http.StatusNotFound, "ResourceNotFoundException",
			fmt.Sprintf("function not found: %s", name))
		return
	}
	invoker, ok := f.invoker(functionID)
	if !ok {
		writeLambdaError(writer, http.StatusServiceUnavailable, "ServiceException",
			fmt.Sprintf("function %s is not running", functionID))
		return
	}
	payload, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBody))
	if err != nil {
		writeLambdaError(writer, http.StatusBadRequest, "InvalidRequestContentException", err.Error())
		return
	}
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	invocationType := request.Header.Get(lambdaInvocationTypeHeader)
	if invocationType == "" {
		invocationType = lambdaInvocationRequestResponse
	}
	switch invocationType {
	case lambdaInvocationRequestResponse:
		ctx, cancel := context.WithTimeout(request.Context(), lambdaInvokeTimeout)
		defer cancel()
		raw, invokeErr := invoker.Invoke(ctx, payload)
		if invokeErr != nil {
			writer.Header().Set(lambdaFunctionErrorHeader, "Unhandled")
			writeLambdaBody(writer, http.StatusOK, []byte(invokeErr.Error()))
			return
		}
		writeLambdaBody(writer, http.StatusOK, raw)
	case lambdaInvocationEvent:
		asyncCtx := context.WithoutCancel(request.Context())
		go func() {
			ctx, cancel := context.WithTimeout(asyncCtx, lambdaInvokeTimeout)
			defer cancel()
			if _, invokeErr := invoker.Invoke(ctx, payload); invokeErr != nil {
				f.runner.logf("local Lambda endpoint: asynchronous invocation of %s failed: %v", functionID, invokeErr)
			}
		}()
		writer.WriteHeader(http.StatusAccepted)
	default:
		writeLambdaError(writer, http.StatusBadRequest, "InvalidParameterValueException",
			fmt.Sprintf("InvocationType %q is not supported locally", invocationType))
	}
}

// lambdaInvokeFunctionPath extracts the function name or ARN from a path.
func lambdaInvokeFunctionPath(path string) (string, bool) {
	trimmed := strings.TrimPrefix(path, lambdaInvokePathPrefix)
	if trimmed == path || !strings.HasSuffix(trimmed, lambdaInvokePathSuffix) {
		return "", false
	}
	name := strings.TrimSuffix(trimmed, lambdaInvokePathSuffix)
	if name == "" {
		return "", false
	}
	decoded, err := url.PathUnescape(name)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(decoded), true
}

// functionByInvokeName resolves the name or ARN a caller passed to the local
// function id, comparing the deployed name against every local function name.
func (r *Runner) functionByInvokeName(name string) (string, bool) {
	wanted := name
	if strings.HasPrefix(name, "arn:") {
		// arn:<partition>:lambda:<region>:<account>:function:<name>[:version]
		if index := strings.Index(name, ":function:"); index >= 0 {
			wanted = name[index+len(":function:"):]
			if slash := strings.Index(wanted, ":"); slash >= 0 {
				wanted = wanted[:slash]
			}
		}
	}
	spec := r.CurrentSpec()
	if spec == nil {
		return "", false
	}
	for _, function := range spec.Functions {
		resource, ok := spec.resource(function.Stack, baseLogicalID(function))
		if !ok {
			continue
		}
		deployed, err := resourceName(resource)
		if err != nil {
			continue
		}
		if deployed == wanted {
			return function.LogicalID, true
		}
	}
	return "", false
}

// writeLambdaBody writes a synchronous invocation's payload.
func writeLambdaBody(writer http.ResponseWriter, status int, body []byte) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(body) //nolint:errcheck // the response is committed
}

// writeLambdaError writes the REST-JSON error shape.
func writeLambdaError(writer http.ResponseWriter, status int, kind, message string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("X-Amzn-ErrorType", kind)
	writer.WriteHeader(status)
	// The message quotes runner-owned text only, and the body is JSON so the
	// encoder escapes it.
	encoded, err := json.Marshal(map[string]string{"Type": kind, "message": message})
	if err != nil {
		encoded = []byte(`{"Type":"ServiceException"}`)
	}
	_, _ = writer.Write(encoded) //nolint:errcheck,gosec // JSON-encoded runner-owned text, not HTML
}
