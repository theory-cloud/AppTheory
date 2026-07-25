package mcp

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	extensionPrefixLabelPattern = regexp.MustCompile(`^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`)
	extensionNamePattern        = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`)
)

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

// WithExtensionCapabilities configures the MCP extensions advertised by
// server/discover for protocol version 2026-07-28.
//
// Extension identifiers must use the MCP _meta key form with a mandatory
// prefix (for example, "com.example/review"). Invalid identifiers or settings
// that cannot be represented as JSON objects are omitted so negotiation fails
// closed. Extensions are never advertised to initialization-based clients.
func WithExtensionCapabilities(capabilities map[string]map[string]any) ServerOption {
	return func(s *Server) {
		s.extensionCapabilities = normalizeExtensionCapabilities(capabilities)
	}
}

func (s *Server) initializeCapabilities(protocolVersion string) map[string]any {
	capabilities := map[string]any{}

	s.addToolsCapability(protocolVersion, capabilities)
	s.addResourcesCapability(protocolVersion, capabilities)
	s.addPromptsCapability(protocolVersion, capabilities)
	s.addCompletionsCapability(protocolVersion, capabilities)
	s.addTasksCapability(protocolVersion, capabilities)
	s.addExtensionCapabilities(protocolVersion, capabilities)

	return capabilities
}

func (s *Server) addToolsCapability(protocolVersion string, capabilities map[string]any) {
	if s.capabilities.Tools && protocolSupportsCapability(protocolVersion, capabilitySurfaceTools) && s.registry.Len() > 0 {
		capabilities["tools"] = map[string]any{}
	}
}

func (s *Server) addResourcesCapability(protocolVersion string, capabilities map[string]any) {
	if s.capabilities.Resources && protocolSupportsCapability(protocolVersion, capabilitySurfaceResources) && (s.resourceRegistry.Len() > 0 || s.resourceRegistry.templateLen() > 0) {
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

func (s *Server) addExtensionCapabilities(protocolVersion string, capabilities map[string]any) {
	if protocolVersion != ProtocolVersion20260728 || len(s.extensionCapabilities) == 0 {
		return
	}

	extensions := make(map[string]any, len(s.extensionCapabilities))
	for identifier, settings := range s.extensionCapabilities {
		extensions[identifier] = cloneExtensionSettings(settings)
	}
	capabilities["extensions"] = extensions
}

func normalizeExtensionCapabilities(capabilities map[string]map[string]any) map[string]map[string]any {
	if len(capabilities) == 0 {
		return nil
	}

	normalized := make(map[string]map[string]any, len(capabilities))
	for rawIdentifier, settings := range capabilities {
		identifier := rawIdentifier
		if !validExtensionIdentifier(identifier) {
			continue
		}
		cloned, ok := normalizeExtensionSettings(settings)
		if !ok {
			continue
		}
		normalized[identifier] = cloned
	}
	if len(normalized) == 0 {
		return nil
	}
	return normalized
}

func validExtensionIdentifier(identifier string) bool {
	if identifier != strings.TrimSpace(identifier) || strings.Count(identifier, "/") != 1 {
		return false
	}
	prefix, name, _ := strings.Cut(identifier, "/")
	if prefix == "" {
		return false
	}
	for _, label := range strings.Split(prefix, ".") {
		if !extensionPrefixLabelPattern.MatchString(label) {
			return false
		}
	}
	return name == "" || extensionNamePattern.MatchString(name)
}

func normalizeExtensionSettings(settings map[string]any) (map[string]any, bool) {
	if settings == nil {
		return nil, false
	}
	data, err := json.Marshal(settings)
	if err != nil {
		return nil, false
	}
	var cloned map[string]any
	if err := json.Unmarshal(data, &cloned); err != nil || cloned == nil {
		return nil, false
	}
	return cloned, true
}

func cloneExtensionSettings(settings map[string]any) map[string]any {
	cloned, ok := normalizeExtensionSettings(settings)
	if !ok {
		return map[string]any{}
	}
	return cloned
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
	case methodResourcesList, methodResourcesRead, methodResourcesTemplatesList, methodResourcesSubscribe, methodResourcesUnsubscribe:
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
	return pv == ProtocolVersion20260728 || isSupportedProtocolVersion(pv)
}
