package mcp

// CapabilityConfig controls which implemented MCP server surfaces may be
// advertised during initialize.
//
// The config is intentionally limited to surfaces that AppTheory currently
// implements. Unsupported MCP sub-capabilities such as listChanged and tasks
// are omitted until their concrete hooks exist. Resource subscription and
// logging are also omitted until AppTheory has a first-class outbound
// notification contract for notifications/resources/updated and
// notifications/message. Completion and task support are advertised only when
// their explicit hooks or stores are configured. That keeps capability
// negotiation fail-closed instead of allowing callers to overclaim unsupported
// behavior.
type CapabilityConfig struct {
	Tools       bool
	Resources   bool
	Prompts     bool
	Completions bool
	Tasks       bool
}

type capabilitySurface string

const (
	capabilitySurfaceTools     capabilitySurface = "tools"
	capabilitySurfaceResources capabilitySurface = "resources"
	capabilitySurfacePrompts   capabilitySurface = "prompts"
	capabilitySurfaceComplete  capabilitySurface = "completions"
	capabilitySurfaceTasks     capabilitySurface = "tasks"
)

// DefaultCapabilityConfig returns the default MCP capability policy.
//
// A surface is still advertised only when it is actually present on the server:
// tools require at least one registered tool, resources require at least one
// registered resource, and prompts require at least one registered prompt.
func DefaultCapabilityConfig() CapabilityConfig {
	return CapabilityConfig{
		Tools:       true,
		Resources:   true,
		Prompts:     true,
		Completions: true,
		Tasks:       true,
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

	s.addToolsCapability(protocolVersion, capabilities)
	s.addResourcesCapability(protocolVersion, capabilities)
	s.addPromptsCapability(protocolVersion, capabilities)
	s.addCompletionsCapability(protocolVersion, capabilities)
	s.addTasksCapability(protocolVersion, capabilities)

	return capabilities
}

func (s *Server) addToolsCapability(protocolVersion string, capabilities map[string]any) {
	if s.capabilities.Tools && protocolSupportsCapability(protocolVersion, capabilitySurfaceTools) && s.registry.Len() > 0 {
		capabilities["tools"] = map[string]any{}
	}
}

func (s *Server) addResourcesCapability(protocolVersion string, capabilities map[string]any) {
	if s.capabilities.Resources && protocolSupportsCapability(protocolVersion, capabilitySurfaceResources) && s.resourceRegistry.Len() > 0 {
		capabilities["resources"] = map[string]any{}
	}
}

func (s *Server) addPromptsCapability(protocolVersion string, capabilities map[string]any) {
	if s.capabilities.Prompts && protocolSupportsCapability(protocolVersion, capabilitySurfacePrompts) && s.promptRegistry.Len() > 0 {
		capabilities["prompts"] = map[string]any{}
	}
}

func (s *Server) addCompletionsCapability(protocolVersion string, capabilities map[string]any) {
	if s.capabilities.Completions && protocolSupportsCapability(protocolVersion, capabilitySurfaceComplete) && s.hasCompletionHooks() {
		capabilities["completions"] = map[string]any{}
	}
}

func (s *Server) addTasksCapability(protocolVersion string, capabilities map[string]any) {
	if !s.capabilities.Tasks || !protocolSupportsCapability(protocolVersion, capabilitySurfaceTasks) || !s.hasTaskRuntime() {
		return
	}

	tasks := map[string]any{
		"list":   map[string]any{},
		"cancel": map[string]any{},
	}
	if s.registry.supportsTasks() {
		tasks["requests"] = map[string]any{
			"tools": map[string]any{
				"call": map[string]any{},
			},
		}
	}
	capabilities["tasks"] = tasks
}

func (s *Server) hasResourceSubscriptionHooks() bool {
	return s.resourceSubscribeHook != nil && s.resourceUnsubscribeHook != nil
}

func (s *Server) hasCompletionHooks() bool {
	return s.promptCompletionHook != nil || s.resourceCompletionHook != nil
}

func (s *Server) tasksEnabled() bool {
	return s != nil && s.capabilities.Tasks && s.hasTaskRuntime()
}

func (s *Server) methodCapabilityEnabled(method string) bool {
	if s == nil {
		return false
	}
	switch method {
	case methodToolsList, methodToolsCall:
		return s.capabilities.Tools
	case methodResourcesList, methodResourcesRead, methodResourcesSubscribe, methodResourcesUnsubscribe:
		return s.capabilities.Resources
	case methodPromptsList, methodPromptsGet:
		return s.capabilities.Prompts
	case methodCompletionComplete:
		return s.capabilities.Completions
	default:
		return true
	}
}

func protocolSupportsCapability(pv string, surface capabilitySurface) bool {
	if surface == capabilitySurfaceTasks {
		return pv == protocolVersion
	}
	return isSupportedProtocolVersion(pv)
}
