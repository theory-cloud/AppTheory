package mcp

import (
	"context"
	"fmt"
	"sync"
)

// ResourceDef defines an MCP resource's metadata.
type ResourceDef struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
	Size        int64  `json:"size,omitempty"`
}

// ResourceContent is a single content item returned from resources/read.
//
// Exactly one of Text or Blob should be set.
// Blob is expected to be a base64-encoded payload (client-decoded).
type ResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"`
}

// ResourceHandler resolves and returns the content for a resource.
type ResourceHandler func(ctx context.Context) ([]ResourceContent, error)

type registeredResource struct {
	def     ResourceDef
	handler ResourceHandler
}

// ResourceRegistry manages registered MCP resources.
type ResourceRegistry struct {
	mu        sync.RWMutex
	resources []registeredResource
	index     map[string]int
}

// NewResourceRegistry creates an empty resource registry.
func NewResourceRegistry() *ResourceRegistry {
	return &ResourceRegistry{
		index: make(map[string]int),
	}
}

func errDuplicateResource(uri string) error {
	return fmt.Errorf("resource already registered: %s", uri)
}

// RegisterResource registers a resource by URI.
func (r *ResourceRegistry) RegisterResource(def ResourceDef, handler ResourceHandler) error {
	if def.URI == "" {
		return fmt.Errorf("resource uri must not be empty")
	}
	if def.Name == "" {
		return fmt.Errorf("resource name must not be empty")
	}
	if handler == nil {
		return fmt.Errorf("resource handler must not be nil")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.index[def.URI]; exists {
		return errDuplicateResource(def.URI)
	}

	r.index[def.URI] = len(r.resources)
	r.resources = append(r.resources, registeredResource{def: def, handler: handler})
	return nil
}

// List returns all registered resource definitions in registration order.
func (r *ResourceRegistry) List() []ResourceDef {
	r.mu.RLock()
	defer r.mu.RUnlock()

	defs := make([]ResourceDef, len(r.resources))
	for i, res := range r.resources {
		defs[i] = res.def
	}
	return defs
}

// Len returns the number of registered resources.
func (r *ResourceRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.resources)
}

// Read resolves a resource by URI and returns its content.
func (r *ResourceRegistry) Read(ctx context.Context, uri string) ([]ResourceContent, error) {
	r.mu.RLock()
	idx, ok := r.index[uri]
	if !ok {
		r.mu.RUnlock()
		return nil, fmt.Errorf("resource not found: %s", uri)
	}
	handler := r.resources[idx].handler
	r.mu.RUnlock()

	return handler(ctx)
}
