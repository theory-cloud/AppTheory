package localrunner

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// WebSocket APIs.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html
//
// An AWS::ApiGatewayV2::Api with ProtocolType WEBSOCKET is served on its own
// listener. Its routes are $connect, $disconnect, $default and the custom route
// keys the route selection expression can produce. The expression is the API's
// RouteSelectionExpression, defaulting to $request.body.action; a message that
// does not evaluate to a route key goes to $default:
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-routes.html
//
// Only $connect can be authorized. A Lambda REQUEST authorizer on $connect
// returns an IAM policy; the runner matches that policy against the documented
// $connect method ARN (narrow Allow/Deny matching, not IAM evaluation, which
// stays a docs/125 true limit):
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html

const (
	// defaultWebSocketRouteSelectionExpression is API Gateway's default.
	defaultWebSocketRouteSelectionExpression = "$request.body.action"
	// webSocketConnect / Disconnect / Default are the predefined route keys.
	webSocketConnect    = "$connect"
	webSocketDisconnect = "$disconnect"
	webSocketDefault    = "$default"
)

// WebSocketAPISpec is one WebSocket API the runner serves.
type WebSocketAPISpec struct {
	Class     APIClass `json:"class"`
	LogicalID string   `json:"logicalId"`
	Stack     string   `json:"stack"`
	Name      string   `json:"name"`
	Stage     string   `json:"stage"`
	// RouteSelectionExpression is the API's expression, for example
	// $request.body.action.
	RouteSelectionExpression string               `json:"routeSelectionExpression"`
	Routes                   []WebSocketRouteSpec `json:"routes"`
	// Authorizer is the $connect authorizer, when the API declares one.
	Authorizer *WebSocketAuthorizerSpec `json:"authorizer,omitempty"`
	// APIID is the id the events and the method ARN report. AWS assigns a
	// ten-character id; the local run derives a stable one from the logical id.
	APIID string `json:"apiId"`
}

// WebSocketRouteSpec is one route of a WebSocket API.
type WebSocketRouteSpec struct {
	RouteKey string `json:"routeKey"`
	Function string `json:"function"`
	// TwoWay is true for $default and custom routes: the integration's response
	// is sent back to the client. $connect and $disconnect are one-way.
	TwoWay bool `json:"twoWay"`
}

// WebSocketAuthorizerSpec is the $connect REQUEST authorizer.
type WebSocketAuthorizerSpec struct {
	Function        string   `json:"function"`
	IdentitySources []string `json:"identitySources,omitempty"`
	// MethodARN is the $connect method ARN the returned policy is matched
	// against: arn:aws:execute-api:<region>:<account>:<apiId>/<stage>/$connect
	MethodARN string `json:"methodArn"`
}

// Route returns the declared route for a key.
func (api WebSocketAPISpec) Route(routeKey string) (WebSocketRouteSpec, bool) {
	for _, route := range api.Routes {
		if route.RouteKey == routeKey {
			return route, true
		}
	}
	return WebSocketRouteSpec{}, false
}

// WebSocketAPIs returns the WebSocket surfaces the runner serves.
func (s *Spec) WebSocketAPIs() []WebSocketAPISpec {
	return s.WebSockets
}

// deriveWebSocketAPIs reads every WEBSOCKET API and its routes. A route whose
// integration the runner cannot run fails closed at plan time.
func deriveWebSocketAPIs(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	authorizers, err := deriveAPIAuthorizers(stacks, stack, types)
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
			return fmt.Errorf("%s/%s: parse API properties: %w", stack.Name, id, err)
		}
		if props.ProtocolType != websocketProtocol {
			continue
		}
		var apiProps struct {
			RouteSelectionExpression string `json:"RouteSelectionExpression"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &apiProps); err != nil {
				return fmt.Errorf("%s/%s: parse WebSocket API properties: %w", stack.Name, id, err)
			}
		}
		qualified := qualify(stacks, stack.Name, id)
		api := WebSocketAPISpec{
			Class:                    APIWebSocket,
			LogicalID:                qualified,
			Stack:                    stack.Name,
			Name:                     props.Name,
			Stage:                    webSocketStageName(stack, id),
			RouteSelectionExpression: strings.TrimSpace(apiProps.RouteSelectionExpression),
			APIID:                    localPhysicalID("wsapi", qualified),
		}
		if api.Name == "" {
			api.Name = id
		}
		if api.RouteSelectionExpression == "" {
			api.RouteSelectionExpression = defaultWebSocketRouteSelectionExpression
		}
		routes, authorizer, err := webSocketRoutes(stacks, stack, types, authorizers, id, api)
		if err != nil {
			return err
		}
		api.Routes = routes
		api.Authorizer = authorizer
		spec.WebSockets = append(spec.WebSockets, api)
	}
	return nil
}

func webSocketStageName(stack assemblyStack, apiID string) string {
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

//nolint:gocyclo // one case per route authorization kind the template can declare.
//nolint:gocognit // one explicit branch per supported provider value.
func webSocketRoutes( //nolint:gocognit // one explicit branch per route authorization kind.
	stacks []assemblyStack,
	stack assemblyStack,
	types map[string]string,
	authorizers map[string]apiAuthorizer,
	apiID string,
	api WebSocketAPISpec,
) ([]WebSocketRouteSpec, *WebSocketAuthorizerSpec, error) {
	var routes []WebSocketRouteSpec
	var authorizer *WebSocketAuthorizerSpec
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeHTTPRoute {
			continue
		}
		var props httpRouteProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return nil, nil, fmt.Errorf("%s/%s: parse route properties: %w", stack.Name, id, err)
		}
		if target, ok := directRefID(props.APIID); !ok || target != apiID {
			continue
		}
		routeKey := strings.TrimSpace(props.RouteKey)
		if routeKey == "" {
			return nil, nil, unsupported(stack.Name+"/"+id, "WebSocket route declares no RouteKey")
		}
		integrationID, ok := findRefByType(props.Target, types, typeHTTPIntegration)
		if !ok {
			return nil, nil, unsupported(stack.Name+"/"+id, "route target does not reference an API Gateway v2 integration")
		}
		integration := stack.Template.Resources[integrationID]
		var integrationProps httpIntegrationProperties
		if err := json.Unmarshal(integration.Properties, &integrationProps); err != nil {
			return nil, nil, fmt.Errorf("%s/%s: parse integration properties: %w", stack.Name, integrationID, err)
		}
		if integrationProps.IntegrationType != proxyIntegration {
			return nil, nil, unsupported(
				stack.Name+"/"+integrationID,
				"integration type %q is not supported locally; only AWS_PROXY Lambda integrations are",
				integrationProps.IntegrationType,
			)
		}
		functionID, ok := findRefByType(integrationProps.IntegrationURI, types, typeLambdaFunction, attrArn)
		if !ok {
			return nil, nil, unsupported(stack.Name+"/"+integrationID, "integration target is not a Lambda function ARN")
		}
		route := WebSocketRouteSpec{
			RouteKey: routeKey,
			Function: qualify(stacks, stack.Name, functionID),
			TwoWay:   routeKey != webSocketConnect && routeKey != webSocketDisconnect,
		}
		switch props.AuthorizationType {
		case "", noneAuthorization:
			if len(props.AuthorizerID) > 0 {
				return nil, nil, unsupported(stack.Name+"/"+id, "route has an authorizer id but authorization type NONE")
			}
		case "CUSTOM":
			authorizerID, ok := directRefID(props.AuthorizerID)
			if !ok {
				return nil, nil, unsupported(stack.Name+"/"+id, "CUSTOM route does not reference an authorizer")
			}
			declared, ok := authorizers[authorizerID]
			if !ok {
				return nil, nil, unsupported(stack.Name+"/"+id, "CUSTOM route references authorizer %s, which the runner did not derive", authorizerID)
			}
			if routeKey != webSocketConnect {
				return nil, nil, unsupported(
					stack.Name+"/"+id,
					"only $connect can be authorized on a WebSocket API; route %s declares a CUSTOM authorizer",
					routeKey,
				)
			}
			if declared.Kind != AuthorizerKindLambdaRequest {
				return nil, nil, unsupported(
					stack.Name+"/"+id,
					"$connect uses a %s authorizer; a WebSocket $connect authorizer must return an IAM policy",
					declared.Kind,
				)
			}
			authorizer = &WebSocketAuthorizerSpec{
				Function:        declared.Function,
				IdentitySources: declared.IdentitySources,
				MethodARN: "arn:" + LocalPartition + ":execute-api:" + LocalRegion + ":" + LocalAccountID +
					":" + api.APIID + "/" + api.Stage + "/" + webSocketConnect,
			}
		default:
			return nil, nil, unsupported(
				stack.Name+"/"+id,
				"route authorization %q is not run locally; the local transport must not bypass it",
				props.AuthorizationType,
			)
		}
		routes = append(routes, route)
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].RouteKey < routes[j].RouteKey })
	return routes, authorizer, nil
}

// webSocketRouteFunctionSet returns every function a WebSocket API invokes.
func webSocketRouteFunctionSet(spec *Spec) map[string]struct{} {
	functions := map[string]struct{}{}
	for _, api := range spec.WebSockets {
		for _, route := range api.Routes {
			if route.Function != "" {
				functions[route.Function] = struct{}{}
			}
		}
		if api.Authorizer != nil && api.Authorizer.Function != "" {
			functions[api.Authorizer.Function] = struct{}{}
		}
	}
	return functions
}
