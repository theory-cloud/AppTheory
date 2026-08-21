//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

func validateAppTheoryMcpRouteAlgebra_AuthorizationAuthorizePathForResourcePathParameters(resourcePath *string) error {
	if resourcePath == nil {
		return fmt.Errorf("parameter resourcePath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_AuthorizationServerPathForResourcePathParameters(resourcePath *string) error {
	if resourcePath == nil {
		return fmt.Errorf("parameter resourcePath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_AuthorizationServerSuffixPathForResourcePathParameters(resourcePath *string) error {
	if resourcePath == nil {
		return fmt.Errorf("parameter resourcePath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_AuthorizationTokenPathForResourcePathParameters(resourcePath *string) error {
	if resourcePath == nil {
		return fmt.Errorf("parameter resourcePath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_McpPathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_OauthAuthorizationServerPathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_OauthAuthorizationServerSuffixPathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_OauthAuthorizePathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_OauthTokenPathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_ParseMcpPathParameters(rawPath *string) error {
	if rawPath == nil {
		return fmt.Errorf("parameter rawPath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_ProtectedResourcePathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_ProtectedResourcePathForResourcePathParameters(resourcePath *string) error {
	if resourcePath == nil {
		return fmt.Errorf("parameter resourcePath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_ProtectedResourcePathFromMcpPathParameters(mcpPath *string) error {
	if mcpPath == nil {
		return fmt.Errorf("parameter mcpPath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_ResourcePathFromProtectedResourcePathParameters(protectedResourcePath *string) error {
	if protectedResourcePath == nil {
		return fmt.Errorf("parameter protectedResourcePath is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMcpRouteAlgebra_ValidateEndpointPathParameters(endpoint *AppTheoryMcpEndpointPath) error {
	if endpoint == nil {
		return fmt.Errorf("parameter endpoint is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(endpoint, func() string { return "parameter endpoint" }); err != nil {
		return err
	}

	return nil
}
