package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v4/jsii"
)

// Canonical route paths for AppTheory MCP servers and OAuth discovery.
//
// These are paths, never origins or full URLs. Namespace applications derive
// their protected resource host from each request at runtime.
type AppTheoryMcpPaths interface {
}

// The jsii proxy struct for AppTheoryMcpPaths
type jsiiProxy_AppTheoryMcpPaths struct {
	_ byte // padding
}

func NewAppTheoryMcpPaths_Override(a AppTheoryMcpPaths) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpPaths",
		nil, // no parameters
		a,
	)
}

func AppTheoryMcpPaths_MCP() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpPaths",
		"MCP",
		&returns,
	)
	return returns
}

func AppTheoryMcpPaths_OAUTH_AUTHORIZATION_SERVER_MCP() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpPaths",
		"OAUTH_AUTHORIZATION_SERVER_MCP",
		&returns,
	)
	return returns
}

func AppTheoryMcpPaths_OAUTH_PROTECTED_RESOURCE() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpPaths",
		"OAUTH_PROTECTED_RESOURCE",
		&returns,
	)
	return returns
}

func AppTheoryMcpPaths_OAUTH_PROTECTED_RESOURCE_MCP() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpPaths",
		"OAUTH_PROTECTED_RESOURCE_MCP",
		&returns,
	)
	return returns
}
