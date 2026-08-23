package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v4/jsii"
)

// AppTheory's canonical, versioned MCP route-algebra contract.
//
// Every OAuth route is derived from the four MCP patterns through the pure
// functions on this class. Concrete endpoint builders validate the same
// kind-to-identifier invariants as the Go runtime package.
type AppTheoryMcpRouteAlgebra interface {
}

// The jsii proxy struct for AppTheoryMcpRouteAlgebra
type jsiiProxy_AppTheoryMcpRouteAlgebra struct {
	_ byte // padding
}

func NewAppTheoryMcpRouteAlgebra_Override(a AppTheoryMcpRouteAlgebra) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		nil, // no parameters
		a,
	)
}

// Derive the authorization facade path from a resource path.
func AppTheoryMcpRouteAlgebra_AuthorizationAuthorizePathForResourcePath(resourcePath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_AuthorizationAuthorizePathForResourcePathParameters(resourcePath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"authorizationAuthorizePathForResourcePath",
		[]interface{}{resourcePath},
		&returns,
	)

	return returns
}

// Derive the canonical RFC 8414 discovery path from a resource path.
func AppTheoryMcpRouteAlgebra_AuthorizationServerPathForResourcePath(resourcePath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_AuthorizationServerPathForResourcePathParameters(resourcePath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"authorizationServerPathForResourcePath",
		[]interface{}{resourcePath},
		&returns,
	)

	return returns
}

// Derive the suffix-compatible RFC 8414 discovery path from a resource path.
func AppTheoryMcpRouteAlgebra_AuthorizationServerSuffixPathForResourcePath(resourcePath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_AuthorizationServerSuffixPathForResourcePathParameters(resourcePath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"authorizationServerSuffixPathForResourcePath",
		[]interface{}{resourcePath},
		&returns,
	)

	return returns
}

// Derive the token facade path from a resource path.
func AppTheoryMcpRouteAlgebra_AuthorizationTokenPathForResourcePath(resourcePath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_AuthorizationTokenPathForResourcePathParameters(resourcePath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"authorizationTokenPathForResourcePath",
		[]interface{}{resourcePath},
		&returns,
	)

	return returns
}

// Build the concrete MCP path for an endpoint.
func AppTheoryMcpRouteAlgebra_McpPath(endpoint *AppTheoryMcpEndpointPath) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_McpPathParameters(endpoint); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"mcpPath",
		[]interface{}{endpoint},
		&returns,
	)

	return returns
}

// Build the endpoint's canonical RFC 8414 discovery path.
func AppTheoryMcpRouteAlgebra_OauthAuthorizationServerPath(endpoint *AppTheoryMcpEndpointPath) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_OauthAuthorizationServerPathParameters(endpoint); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"oauthAuthorizationServerPath",
		[]interface{}{endpoint},
		&returns,
	)

	return returns
}

// Build the endpoint's suffix-compatible RFC 8414 discovery path.
func AppTheoryMcpRouteAlgebra_OauthAuthorizationServerSuffixPath(endpoint *AppTheoryMcpEndpointPath) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_OauthAuthorizationServerSuffixPathParameters(endpoint); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"oauthAuthorizationServerSuffixPath",
		[]interface{}{endpoint},
		&returns,
	)

	return returns
}

// Build the endpoint's authorization facade path.
func AppTheoryMcpRouteAlgebra_OauthAuthorizePath(endpoint *AppTheoryMcpEndpointPath) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_OauthAuthorizePathParameters(endpoint); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"oauthAuthorizePath",
		[]interface{}{endpoint},
		&returns,
	)

	return returns
}

// Build the endpoint's token facade path.
func AppTheoryMcpRouteAlgebra_OauthTokenPath(endpoint *AppTheoryMcpEndpointPath) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_OauthTokenPathParameters(endpoint); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"oauthTokenPath",
		[]interface{}{endpoint},
		&returns,
	)

	return returns
}

// Parse a concrete MCP path after contract normalization.
func AppTheoryMcpRouteAlgebra_ParseMcpPath(rawPath *string) *AppTheoryMcpEndpointPath {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_ParseMcpPathParameters(rawPath); err != nil {
		panic(err)
	}
	var returns *AppTheoryMcpEndpointPath

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"parseMcpPath",
		[]interface{}{rawPath},
		&returns,
	)

	return returns
}

// Build the endpoint's RFC 9728 protected-resource path.
func AppTheoryMcpRouteAlgebra_ProtectedResourcePath(endpoint *AppTheoryMcpEndpointPath) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_ProtectedResourcePathParameters(endpoint); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"protectedResourcePath",
		[]interface{}{endpoint},
		&returns,
	)

	return returns
}

// Derive an RFC 9728 protected-resource path from a resource path.
func AppTheoryMcpRouteAlgebra_ProtectedResourcePathForResourcePath(resourcePath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_ProtectedResourcePathForResourcePathParameters(resourcePath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"protectedResourcePathForResourcePath",
		[]interface{}{resourcePath},
		&returns,
	)

	return returns
}

// Derive the protected-resource path for an MCP path.
func AppTheoryMcpRouteAlgebra_ProtectedResourcePathFromMcpPath(mcpPath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_ProtectedResourcePathFromMcpPathParameters(mcpPath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"protectedResourcePathFromMcpPath",
		[]interface{}{mcpPath},
		&returns,
	)

	return returns
}

// Recover a resource path from an RFC 9728 protected-resource path.
func AppTheoryMcpRouteAlgebra_ResourcePathFromProtectedResourcePath(protectedResourcePath *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_ResourcePathFromProtectedResourcePathParameters(protectedResourcePath); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"resourcePathFromProtectedResourcePath",
		[]interface{}{protectedResourcePath},
		&returns,
	)

	return returns
}

// Return every canonical MCP endpoint template in contract order.
func AppTheoryMcpRouteAlgebra_SupportedEndpointTemplates() *[]*AppTheoryMcpEndpointTemplate {
	_init_.Initialize()

	var returns *[]*AppTheoryMcpEndpointTemplate

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"supportedEndpointTemplates",
		nil, // no parameters
		&returns,
	)

	return returns
}

// Return every canonical OAuth discovery template in contract order.
func AppTheoryMcpRouteAlgebra_SupportedOAuthDiscoveryTemplates() *[]*AppTheoryMcpOAuthDiscoveryTemplate {
	_init_.Initialize()

	var returns *[]*AppTheoryMcpOAuthDiscoveryTemplate

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"supportedOAuthDiscoveryTemplates",
		nil, // no parameters
		&returns,
	)

	return returns
}

// Return every canonical OAuth authorization facade template in contract order.
func AppTheoryMcpRouteAlgebra_SupportedOAuthFacadeTemplates() *[]*AppTheoryMcpOAuthFacadeTemplate {
	_init_.Initialize()

	var returns *[]*AppTheoryMcpOAuthFacadeTemplate

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"supportedOAuthFacadeTemplates",
		nil, // no parameters
		&returns,
	)

	return returns
}

// Validate endpoint kind-to-identifier consistency and path-segment safety.
func AppTheoryMcpRouteAlgebra_ValidateEndpointPath(endpoint *AppTheoryMcpEndpointPath) {
	_init_.Initialize()

	if err := validateAppTheoryMcpRouteAlgebra_ValidateEndpointPathParameters(endpoint); err != nil {
		panic(err)
	}
	_jsii_.StaticInvokeVoid(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"validateEndpointPath",
		[]interface{}{endpoint},
	)
}

func AppTheoryMcpRouteAlgebra_AGENT_MCP_PATTERN() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"AGENT_MCP_PATTERN",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_AUTHORIZATION_SERVER_PREFIX() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"AUTHORIZATION_SERVER_PREFIX",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_CONTRACT_VERSION() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"CONTRACT_VERSION",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_ENDPOINT_KIND_AGENT() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"ENDPOINT_KIND_AGENT",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_ENDPOINT_KIND_NAMESPACE() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"ENDPOINT_KIND_NAMESPACE",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_ENDPOINT_KIND_PARTNER_AGENT() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"ENDPOINT_KIND_PARTNER_AGENT",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_ENDPOINT_KIND_PARTNER_NAMESPACE() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"ENDPOINT_KIND_PARTNER_NAMESPACE",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_NAMESPACE_MCP_PATTERN() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"NAMESPACE_MCP_PATTERN",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_PARTNER_AGENT_MCP_PATTERN() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"PARTNER_AGENT_MCP_PATTERN",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_PARTNER_NAMESPACE_MCP_PATTERN() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"PARTNER_NAMESPACE_MCP_PATTERN",
		&returns,
	)
	return returns
}

func AppTheoryMcpRouteAlgebra_PROTECTED_RESOURCE_PREFIX() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra",
		"PROTECTED_RESOURCE_PREFIX",
		&returns,
	)
	return returns
}
