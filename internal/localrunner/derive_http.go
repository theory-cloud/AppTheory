package localrunner

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// deriveHTTPAPIs reads AWS::ApiGatewayV2::Api resources with ProtocolType HTTP
// and their routes. A WebSocket API is reported as not served, so an app that
// also has HTTP surfaces still runs. A CUSTOM REQUEST authorizer is resolved to
// the Lambda function that implements it, so the transport executes the real
// authorizer instead of bypassing it. Other authorizer types fail closed.
func deriveHTTPAPIs(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	authorizers, err := deriveHTTPAuthorizers(stack, types)
	if err != nil {
		return err
	}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeHTTPAPI {
			continue
		}
		var props httpAPIProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse HTTP API properties: %w", stack.Name, id, err)
		}
		switch props.ProtocolType {
		case websocketProtocol:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: qualify(stacks, stack.Name, id),
				Kind:      typeHTTPAPI,
				Reason:    "WebSocket API; the local HTTP transport does not deliver WebSocket frames, so its $connect/$disconnect/$default routes are not invoked",
			})
			continue
		case httpProtocol, "":
		default:
			return unsupported(stack.Name+"/"+id, "unsupported API Gateway v2 protocol %q", props.ProtocolType)
		}
		api := APISpec{
			Class:     APIHTTPV2,
			LogicalID: qualify(stacks, stack.Name, id),
			Stack:     stack.Name,
			Name:      props.Name,
			Stage:     httpStageName(stack, id),
		}
		if api.Name == "" {
			api.Name = id
		}
		routes, err := httpRoutes(stack, types, id, authorizers)
		if err != nil {
			return err
		}
		for index := range routes {
			routes[index].Function = qualify(stacks, stack.Name, routes[index].Function)
			if routes[index].AuthorizerFunction != "" {
				routes[index].AuthorizerFunction = qualify(stacks, stack.Name, routes[index].AuthorizerFunction)
			}
		}
		api.Routes = routes
		spec.APIs = append(spec.APIs, api)
	}
	return nil
}

// httpAuthorizer is one CUSTOM HTTP API REQUEST authorizer the transport runs.
type httpAuthorizer struct {
	Function        string
	IdentitySources []string
}

// deriveHTTPAuthorizers resolves the authorizer resources to the Lambda
// functions that implement them. The local transport executes these functions;
// it never serves a route whose authorizer it cannot run.
func deriveHTTPAuthorizers(stack assemblyStack, types map[string]string) (map[string]httpAuthorizer, error) {
	authorizers := map[string]httpAuthorizer{}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeHTTPAuthorizer {
			continue
		}
		var props httpAuthorizerProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return nil, fmt.Errorf("%s/%s: parse HTTP authorizer properties: %w", stack.Name, id, err)
		}
		if props.AuthorizerType != "REQUEST" {
			return nil, unsupported(
				stack.Name+"/"+id,
				"HTTP API authorizer type %q is not run locally; only REQUEST authorizers with simple responses are supported",
				props.AuthorizerType,
			)
		}
		if !props.EnableSimpleResponses {
			return nil, unsupported(
				stack.Name+"/"+id,
				"HTTP API authorizer does not enable simple responses; the local transport only runs simple-response authorizers",
			)
		}
		functionID, ok := findRefByType(props.AuthorizerURI, types, typeLambdaFunction, attrArn)
		if !ok {
			return nil, unsupported(stack.Name+"/"+id, "HTTP API authorizer Uri does not reference a Lambda function")
		}
		identitySources := make([]string, 0, len(props.IdentitySource))
		for _, source := range props.IdentitySource {
			trimmed := strings.TrimSpace(source)
			if err := validateIdentitySource(trimmed); err != nil {
				return nil, unsupported(stack.Name+"/"+id, "%v", err)
			}
			identitySources = append(identitySources, trimmed)
		}
		authorizers[id] = httpAuthorizer{Function: functionID, IdentitySources: identitySources}
	}
	return authorizers, nil
}

func httpStageName(stack assemblyStack, apiID string) string {
	stage := LocalStageName
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeHTTPStage {
			continue
		}
		var props httpStageProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			continue
		}
		if target, ok := directRefID(props.APIID); !ok || target != apiID {
			continue
		}
		if props.StageName != "" {
			stage = props.StageName
		}
	}
	return stage
}

func httpRoutes(stack assemblyStack, types map[string]string, apiID string, authorizers map[string]httpAuthorizer) ([]Route, error) {
	var routes []Route
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeHTTPRoute {
			continue
		}
		var props httpRouteProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return nil, fmt.Errorf("%s/%s: parse route properties: %w", stack.Name, id, err)
		}
		if target, ok := directRefID(props.APIID); !ok || target != apiID {
			continue
		}
		route, err := httpRoute(stack, types, id, props)
		if err != nil {
			return nil, err
		}
		switch props.AuthorizationType {
		case "", noneAuthorization:
			if len(props.AuthorizerID) > 0 {
				return nil, unsupported(stack.Name+"/"+id, "route has an authorizer id but authorization type NONE")
			}
		case "CUSTOM":
			authorizerID, ok := directRefID(props.AuthorizerID)
			if !ok {
				return nil, unsupported(stack.Name+"/"+id, "CUSTOM route does not reference an authorizer")
			}
			authorizer, ok := authorizers[authorizerID]
			if !ok {
				return nil, unsupported(stack.Name+"/"+id, "CUSTOM route references authorizer %s, which the runner did not derive", authorizerID)
			}
			route.AuthorizerFunction = authorizer.Function
			route.AuthorizerIdentitySources = authorizer.IdentitySources
		default:
			return nil, unsupported(
				stack.Name+"/"+id,
				"route authorization %q is not run locally; the local transport must not bypass it",
				props.AuthorizationType,
			)
		}
		routes = append(routes, route)
	}
	return routes, nil
}

func httpRoute(stack assemblyStack, types map[string]string, id string, props httpRouteProperties) (Route, error) {
	method, path, err := parseHTTPRouteKey(props.RouteKey)
	if err != nil {
		return Route{}, unsupported(stack.Name+"/"+id, "%v", err)
	}
	integrationID, ok := findRefByType(props.Target, types, typeHTTPIntegration)
	if !ok {
		return Route{}, unsupported(
			stack.Name+"/"+id,
			"route target does not reference an API Gateway v2 integration",
		)
	}
	integration := stack.Template.Resources[integrationID]
	var integrationProps httpIntegrationProperties
	if err := json.Unmarshal(integration.Properties, &integrationProps); err != nil {
		return Route{}, fmt.Errorf("%s/%s: parse integration properties: %w", stack.Name, integrationID, err)
	}
	if integrationProps.IntegrationType != proxyIntegration {
		return Route{}, unsupported(
			stack.Name+"/"+integrationID,
			"integration type %q is not supported locally; only AWS_PROXY Lambda integrations are",
			integrationProps.IntegrationType,
		)
	}
	if integrationProps.PayloadFormatVersion != "" && integrationProps.PayloadFormatVersion != "2.0" {
		return Route{}, unsupported(
			stack.Name+"/"+integrationID,
			"payload format %q is not supported locally; HTTP API v2 requires 2.0",
			integrationProps.PayloadFormatVersion,
		)
	}
	functionID, ok := findRefByType(integrationProps.IntegrationURI, types, typeLambdaFunction, "Arn")
	if !ok {
		return Route{}, unsupported(
			stack.Name+"/"+integrationID,
			"integration target is not a Lambda function ARN",
		)
	}
	return Route{
		Class:    APIHTTPV2,
		Method:   method,
		Path:     path,
		Function: functionID,
		RouteKey: props.RouteKey,
	}, nil
}

// parseHTTPRouteKey splits "METHOD /path" and accepts the "$default" catch-all.
func parseHTTPRouteKey(key string) (string, string, error) {
	trimmed := strings.TrimSpace(key)
	if trimmed == "$default" {
		return "ANY", catchAllPath, nil
	}
	parts := strings.SplitN(trimmed, " ", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("route key %q is not \"METHOD /path\"", key)
	}
	method := strings.ToUpper(strings.TrimSpace(parts[0]))
	path := strings.TrimSpace(parts[1])
	if method == "" || !strings.HasPrefix(path, "/") {
		return "", "", fmt.Errorf("route key %q is not \"METHOD /path\"", key)
	}
	return method, path, nil
}

// deriveRESTAPIs reads AWS::ApiGateway::RestApi resources, their resource tree,
// methods and the stage the event reports.
func deriveRESTAPIs(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	if err := rejectRESTAuthorizers(stack); err != nil {
		return err
	}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeRESTAPI {
			continue
		}
		var props restAPIProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse REST API properties: %w", stack.Name, id, err)
		}
		api := APISpec{
			Class:     APIRESTV1,
			LogicalID: qualify(stacks, stack.Name, id),
			Stack:     stack.Name,
			Name:      props.Name,
			Stage:     restStageName(stack, id),
		}
		if api.Name == "" {
			api.Name = id
		}
		routes, err := restRoutes(stack, types, id)
		if err != nil {
			return err
		}
		for index := range routes {
			routes[index].Function = qualify(stacks, stack.Name, routes[index].Function)
		}
		api.Routes = routes
		spec.APIs = append(spec.APIs, api)
	}
	return nil
}

func rejectRESTAuthorizers(stack assemblyStack) error {
	for _, id := range sortedKeys(stack.Template.Resources) {
		if stack.Template.Resources[id].Type == typeRESTAuthorizer {
			return unsupported(
				stack.Name+"/"+id,
				"REST API authorizers are not run locally; the local transport must not bypass a real authorizer",
			)
		}
	}
	return nil
}

func restStageName(stack assemblyStack, apiID string) string {
	stage := LocalStageName
	names := map[string]struct{}{}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeRESTStage {
			continue
		}
		var props restStageProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			continue
		}
		if target, ok := directRefID(props.RestAPIID); !ok || target != apiID {
			continue
		}
		if props.StageName == "" {
			continue
		}
		names[props.StageName] = struct{}{}
		if stage == LocalStageName {
			stage = props.StageName
		}
	}
	return stage
}

func restRoutes(stack assemblyStack, types map[string]string, apiID string) ([]Route, error) {
	paths, err := restResourcePaths(stack, apiID)
	if err != nil {
		return nil, err
	}
	var routes []Route
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeRESTMethod {
			continue
		}
		var props restMethodProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return nil, fmt.Errorf("%s/%s: parse method properties: %w", stack.Name, id, err)
		}
		if target, ok := directRefID(props.RestAPIID); !ok || target != apiID {
			continue
		}
		route, err := restRoute(stack, types, paths, id, props)
		if err != nil {
			return nil, err
		}
		routes = append(routes, route)
	}
	return routes, nil
}

func restRoute(stack assemblyStack, types map[string]string, paths map[string]string, id string, props restMethodProperties) (Route, error) {
	if props.AuthorizationType != "" && props.AuthorizationType != noneAuthorization {
		return Route{}, unsupported(
			stack.Name+"/"+id,
			"method authorization %q is not run locally; the local transport must not bypass it",
			props.AuthorizationType,
		)
	}
	if len(props.AuthorizerID) > 0 {
		return Route{}, unsupported(stack.Name+"/"+id, "method has an authorizer; the local transport must not bypass it")
	}
	if props.Integration.Type == mockIntegration {
		return restMockRoute(stack, paths, id, props)
	}
	if props.Integration.Type != proxyIntegration {
		return Route{}, unsupported(
			stack.Name+"/"+id,
			"integration type %q is not supported locally; only AWS_PROXY Lambda integrations are",
			props.Integration.Type,
		)
	}
	path, ok := paths[resourceKey(props.ResourceID)]
	if !ok {
		path = "/"
	}
	functionID, ok := findRefByType(props.Integration.URI, types, typeLambdaFunction, "Arn")
	if !ok {
		return Route{}, unsupported(stack.Name+"/"+id, "integration URI is not a Lambda function ARN")
	}
	streaming := props.Integration.ResponseTransferMode == responseStreamMode ||
		containsString(props.Integration.URI, streamingURIMarker)
	return Route{
		Class:     APIRESTV1,
		Method:    strings.ToUpper(props.HTTPMethod),
		Path:      path,
		Function:  functionID,
		Streaming: streaming,
	}, nil
}

// restMockRoute serves a REST API MOCK integration from the response the
// template declares. CDK emits these for CORS preflight; the transport returns
// exactly the declared status and headers and invokes no function.
func restMockRoute(stack assemblyStack, paths map[string]string, id string, props restMethodProperties) (Route, error) {
	if len(props.Integration.IntegrationResponses) == 0 {
		return Route{}, unsupported(stack.Name+"/"+id, "MOCK integration declares no IntegrationResponses")
	}
	declared := props.Integration.IntegrationResponses[0]
	statusCode, err := strconv.Atoi(strings.TrimSpace(declared.StatusCode))
	if err != nil || statusCode < 100 || statusCode > 599 {
		return Route{}, unsupported(
			stack.Name+"/"+id,
			"MOCK integration status %q is not an HTTP status",
			declared.StatusCode,
		)
	}
	headers := map[string]string{}
	for name, value := range declared.ResponseParameters {
		const prefix = "method.response.header."
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		headerName := strings.TrimSpace(strings.TrimPrefix(name, prefix))
		if headerName == "" {
			continue
		}
		headers[headerName] = unquoteAPIGatewayValue(value)
	}
	path, ok := paths[resourceKey(props.ResourceID)]
	if !ok {
		path = "/"
	}
	return Route{
		Class:  APIRESTV1,
		Method: strings.ToUpper(props.HTTPMethod),
		Path:   path,
		Mock:   &MockResponse{StatusCode: statusCode, Headers: headers},
	}, nil
}

// unquoteAPIGatewayValue removes the single quotes API Gateway uses around
// static mapping values, for example "'*'" or "'600'".
func unquoteAPIGatewayValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 2 && strings.HasPrefix(trimmed, "'") && strings.HasSuffix(trimmed, "'") {
		return trimmed[1 : len(trimmed)-1]
	}
	return trimmed
}

// restResourcePaths reconstructs each resource's path from its parent chain. The
// API's root resource is addressed as Fn::GetAtt [RestApi, RootResourceId].
func restResourcePaths(stack assemblyStack, apiID string) (map[string]string, error) {
	paths := map[string]string{}
	parents := map[string]string{}
	parts := map[string]string{}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeRESTResource {
			continue
		}
		var props restResourceProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return nil, fmt.Errorf("%s/%s: parse resource properties: %w", stack.Name, id, err)
		}
		if target, ok := directRefID(props.RestAPIID); !ok || target != apiID {
			continue
		}
		parents[id] = firstRef(props.ParentID)
		parts[id] = props.PathPart
	}
	for _, id := range sortedKeys(parts) {
		path, err := resourcePath(id, parents, parts, apiID)
		if err != nil {
			return nil, fmt.Errorf("%s/%s: %w", stack.Name, id, err)
		}
		paths[id] = path
	}
	return paths, nil
}

func resourcePath(id string, parents, parts map[string]string, apiID string) (string, error) {
	var segments []string
	current := id
	for depth := 0; depth < 64; depth++ {
		part := parts[current]
		parent := parents[current]
		segments = append(segments, part)
		if parent == apiID || parent == "" {
			for left, right := 0, len(segments)-1; left < right; left, right = left+1, right-1 {
				segments[left], segments[right] = segments[right], segments[left]
			}
			return "/" + strings.Join(segments, "/"), nil
		}
		if _, ok := parts[parent]; !ok {
			return "", fmt.Errorf("parent resource %q is not defined", parent)
		}
		current = parent
	}
	return "", fmt.Errorf("resource parent chain is cyclic")
}

// resourceKey extracts the resource id a method references.
func resourceKey(raw json.RawMessage) string {
	return firstRef(raw)
}

// firstRef returns the first Ref or Fn::GetAtt target id in raw.
func firstRef(raw json.RawMessage) string {
	refs := refsIn(raw)
	if len(refs) == 0 {
		return ""
	}
	return refs[0].ID
}

func deriveFunctionURLs(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeFunctionURL {
			continue
		}
		var props functionURLProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse Function URL properties: %w", stack.Name, id, err)
		}
		functionID, ok := findRefByType(props.TargetFunctionARN, types, typeLambdaFunction, "Arn")
		if !ok {
			return unsupported(stack.Name+"/"+id, "Function URL target is not a Lambda function ARN")
		}
		qualifiedURL := qualify(stacks, stack.Name, id)
		qualifiedFunction := qualify(stacks, stack.Name, functionID)
		spec.functionURLTargets[qualifiedURL] = qualifiedFunction
		if props.AuthType != noneAuthorization {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: qualifiedURL,
				Kind:      typeFunctionURL,
				Reason: fmt.Sprintf(
					"Function URL auth type %q is not run locally as a standalone URL; the local transport must not bypass it",
					props.AuthType,
				),
			})
			continue
		}
		spec.FunctionURLs = append(spec.FunctionURLs, FunctionURLSpec{
			LogicalID: qualifiedURL,
			Stack:     stack.Name,
			Function:  qualifiedFunction,
			Streaming: props.InvokeMode == responseStreamMode,
		})
	}
	return nil
}

// deriveSkipped records constructs the runner deliberately does not serve, so a
// run never gives the impression that they were exercised.
func deriveSkipped(spec *Spec) {
	served := map[string]struct{}{}
	for _, id := range spec.RuntimeFunctions() {
		served[id] = struct{}{}
	}
	originFunctions := map[string]struct{}{}
	for _, distribution := range spec.CloudFront {
		for _, origin := range distribution.Origins {
			if origin.FunctionURL == "" {
				continue
			}
			if functionID, ok := spec.functionURLTargets[origin.FunctionURL]; ok {
				originFunctions[functionID] = struct{}{}
			}
		}
	}
	for _, function := range spec.Functions {
		if _, ok := served[function.LogicalID]; ok {
			continue
		}
		reason := "not targeted by an HTTP route, Function URL, event source mapping or EventBridge rule the local runner can invoke"
		if _, isOrigin := originFunctions[function.LogicalID]; isOrigin {
			reason = "CloudFront origin function; the local gateway does not start it until A5b wires origins"
		}
		spec.Skipped = append(spec.Skipped, Skipped{
			LogicalID: function.LogicalID,
			Kind:      typeLambdaFunction,
			Reason:    reason,
		})
	}
}

// refsIn returns every Ref and Fn::GetAtt target in a JSON value.
func refsIn(raw json.RawMessage) []logicalRef {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	var out []logicalRef
	collectRefs(value, &out)
	return out
}

func collectRefs(value any, out *[]logicalRef) {
	switch typed := value.(type) {
	case map[string]any:
		if id, ok := typed["Ref"].(string); ok && id != "" {
			*out = append(*out, logicalRef{ID: id})
		}
		collectGetAtt(typed["Fn::GetAtt"], out)
		for key, child := range typed {
			if key == "Ref" || key == "Fn::GetAtt" {
				continue
			}
			collectRefs(child, out)
		}
	case []any:
		for _, child := range typed {
			collectRefs(child, out)
		}
	}
}

func collectGetAtt(value any, out *[]logicalRef) {
	switch typed := value.(type) {
	case []any:
		if len(typed) != 2 {
			return
		}
		id, idOK := typed[0].(string)
		attr, attrOK := typed[1].(string)
		if !attrOK {
			attr = ""
		}
		if idOK && id != "" {
			*out = append(*out, logicalRef{ID: id, Attr: attr})
		}
	case string:
		parts := strings.SplitN(typed, ".", 2)
		ref := logicalRef{ID: parts[0]}
		if len(parts) == 2 {
			ref.Attr = parts[1]
		}
		if ref.ID != "" {
			*out = append(*out, ref)
		}
	}
}

// findRefByType returns the first reference whose target has the wanted
// resource type. When attributes are given the reference must use one of them.
func findRefByType(raw json.RawMessage, types map[string]string, resourceType string, attributes ...string) (string, bool) {
	for _, ref := range refsIn(raw) {
		if types[ref.ID] != resourceType {
			continue
		}
		if len(attributes) == 0 || ref.Attr == "" {
			return ref.ID, true
		}
		for _, attribute := range attributes {
			if ref.Attr == attribute {
				return ref.ID, true
			}
		}
	}
	return "", false
}

func directRefID(raw json.RawMessage) (string, bool) {
	var value struct {
		Ref string `json:"Ref"`
	}
	if err := json.Unmarshal(raw, &value); err != nil || value.Ref == "" {
		return "", false
	}
	return value.Ref, true
}

func containsString(raw json.RawMessage, needle string) bool {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	return valueContainsString(value, needle)
}

func valueContainsString(value any, needle string) bool {
	switch typed := value.(type) {
	case string:
		return strings.Contains(typed, needle)
	case map[string]any:
		for _, child := range typed {
			if valueContainsString(child, needle) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if valueContainsString(child, needle) {
				return true
			}
		}
	}
	return false
}

var _ = sort.Strings
