package mcp

// CapabilityConfig controls which implemented MCP server surfaces may be
// advertised during initialize.
//
// The config is intentionally limited to surfaces that AppTheory currently
// implements. Optional MCP sub-capabilities such as listChanged, resource
// subscriptions, logging, completions, and tasks are omitted until their
// concrete hooks exist. That keeps capability negotiation fail-closed instead
// of allowing callers to overclaim unsupported behavior.
type CapabilityConfig struct {
	Tools     bool
	Resources bool
	Prompts   bool
}

// DefaultCapabilityConfig returns the default MCP capability policy.
//
// A surface is still advertised only when it is actually present on the server:
// tools require at least one registered tool, resources require at least one
// registered resource, and prompts require at least one registered prompt.
func DefaultCapabilityConfig() CapabilityConfig {
	return CapabilityConfig{
		Tools:     true,
		Resources: true,
		Prompts:   true,
	}
}

// WithCapabilityConfig sets the server capability policy used for initialize
// responses.
func WithCapabilityConfig(config CapabilityConfig) ServerOption {
	return func(s *Server) {
		s.capabilities = config
	}
}

func (s *Server) initializeCapabilities(_ string) map[string]any {
	capabilities := map[string]any{}

	if s.capabilities.Tools && s.registry.Len() > 0 {
		capabilities["tools"] = map[string]any{}
	}
	if s.capabilities.Resources && s.resourceRegistry.Len() > 0 {
		capabilities["resources"] = map[string]any{}
	}
	if s.capabilities.Prompts && s.promptRegistry.Len() > 0 {
		capabilities["prompts"] = map[string]any{}
	}

	return capabilities
}
