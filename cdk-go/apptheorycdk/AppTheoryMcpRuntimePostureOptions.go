package apptheorycdk

// Runtime-side declaration that the transport routes validate RFC 9728 bearer tokens at runtime.
type AppTheoryMcpRuntimePostureOptions struct {
	// Assert the runtime registers the transport routes with the runtime-validated bearer posture (Go `FacadeConfig.RequireBearerToken`, TS `requireBearerTokenMiddleware`, Python `require_bearer_token_middleware`). Must be `true`.
	RequireBearerToken *bool `field:"required" json:"requireBearerToken" yaml:"requireBearerToken"`
}
