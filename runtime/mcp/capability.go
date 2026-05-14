package mcp

// CapabilityConfig controls which implemented MCP server surfaces may be
// advertised during initialize.
//
// The config is intentionally limited to surfaces that AppTheory currently
// implements. Optional MCP sub-capabilities such as listChanged, logging,
// completions, and tasks are omitted until their concrete hooks exist. Resource
// subscription support is advertised only when both subscription hooks are
// configured. That keeps capability negotiation fail-closed instead of allowing
// callers to overclaim unsupported behavior.
type CapabilityConfig struct {
	Tools     bool
	Resources bool
	Prompts   bool
}

type capabilitySurface string

const (
	capabilitySurfaceTools     capabilitySurface = "tools"
	capabilitySurfaceResources capabilitySurface = "resources"
	capabilitySurfacePrompts   capabilitySurface = "prompts"
)

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

func (s *Server) initializeCapabilities(protocolVersion string) map[string]any {
	capabilities := map[string]any{}

	if s.capabilities.Tools && protocolSupportsCapability(protocolVersion, capabilitySurfaceTools) && s.registry.Len() > 0 {
		capabilities["tools"] = map[string]any{}
	}
	if s.capabilities.Resources && protocolSupportsCapability(protocolVersion, capabilitySurfaceResources) && s.resourceRegistry.Len() > 0 {
		resourceCaps := map[string]any{}
		if s.hasResourceSubscriptionHooks() {
			resourceCaps["subscribe"] = true
		}
		capabilities["resources"] = resourceCaps
	}
	if s.capabilities.Prompts && protocolSupportsCapability(protocolVersion, capabilitySurfacePrompts) && s.promptRegistry.Len() > 0 {
		capabilities["prompts"] = map[string]any{}
	}

	return capabilities
}

func (s *Server) hasResourceSubscriptionHooks() bool {
	return s.resourceSubscribeHook != nil && s.resourceUnsubscribeHook != nil
}

func protocolSupportsCapability(pv string, _ capabilitySurface) bool {
	return isSupportedProtocolVersion(pv)
}
