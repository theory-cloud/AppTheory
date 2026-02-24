package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// PromptArgument defines an argument a prompt can accept.
type PromptArgument struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

// PromptDef defines an MCP prompt's metadata.
type PromptDef struct {
	Name        string           `json:"name"`
	Title       string           `json:"title,omitempty"`
	Description string           `json:"description,omitempty"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
}

// PromptMessage is a single message returned from prompts/get.
type PromptMessage struct {
	Role    string       `json:"role"`
	Content ContentBlock `json:"content"`
}

// PromptResult is the result payload returned from prompts/get.
type PromptResult struct {
	Description string          `json:"description,omitempty"`
	Messages    []PromptMessage `json:"messages"`
}

// PromptHandler renders a prompt given optional arguments.
type PromptHandler func(ctx context.Context, args json.RawMessage) (*PromptResult, error)

type registeredPrompt struct {
	def     PromptDef
	handler PromptHandler
}

// PromptRegistry manages registered MCP prompts.
type PromptRegistry struct {
	mu      sync.RWMutex
	prompts []registeredPrompt
	index   map[string]int
}

// NewPromptRegistry creates an empty prompt registry.
func NewPromptRegistry() *PromptRegistry {
	return &PromptRegistry{
		index: make(map[string]int),
	}
}

func errDuplicatePrompt(name string) error {
	return fmt.Errorf("prompt already registered: %s", name)
}

// RegisterPrompt registers a prompt by name.
func (r *PromptRegistry) RegisterPrompt(def PromptDef, handler PromptHandler) error {
	if def.Name == "" {
		return fmt.Errorf("prompt name must not be empty")
	}
	if handler == nil {
		return fmt.Errorf("prompt handler must not be nil")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.index[def.Name]; exists {
		return errDuplicatePrompt(def.Name)
	}

	r.index[def.Name] = len(r.prompts)
	r.prompts = append(r.prompts, registeredPrompt{def: def, handler: handler})
	return nil
}

// List returns all registered prompt definitions in registration order.
func (r *PromptRegistry) List() []PromptDef {
	r.mu.RLock()
	defer r.mu.RUnlock()

	defs := make([]PromptDef, len(r.prompts))
	for i, p := range r.prompts {
		defs[i] = p.def
	}
	return defs
}

// Len returns the number of registered prompts.
func (r *PromptRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.prompts)
}

// Get resolves a prompt by name and renders it.
func (r *PromptRegistry) Get(ctx context.Context, name string, args json.RawMessage) (*PromptResult, error) {
	r.mu.RLock()
	idx, ok := r.index[name]
	if !ok {
		r.mu.RUnlock()
		return nil, fmt.Errorf("prompt not found: %s", name)
	}
	handler := r.prompts[idx].handler
	r.mu.RUnlock()

	return handler(ctx, args)
}
