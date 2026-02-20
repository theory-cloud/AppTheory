package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"pgregory.net/rapid"
)

// genDistinctToolDefs generates a slice of ToolDefs with unique names.
func genDistinctToolDefs(minCount, maxCount int) *rapid.Generator[[]ToolDef] {
	return rapid.Custom[[]ToolDef](func(t *rapid.T) []ToolDef {
		n := rapid.IntRange(minCount, maxCount).Draw(t, "count")
		seen := make(map[string]bool)
		defs := make([]ToolDef, 0, n)
		for len(defs) < n {
			def := genToolDef().Draw(t, fmt.Sprintf("tool_%d", len(defs)))
			if seen[def.Name] {
				continue
			}
			seen[def.Name] = true
			defs = append(defs, def)
		}
		return defs
	})
}

// noopHandler is a tool handler that returns a simple text result.
func noopHandler(_ context.Context, _ json.RawMessage) (*ToolResult, error) {
	return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
}

// Feature: cloud-mcp-gateway, Property 3: Tool Registration Round-Trip
// Validates: Requirements 3.5, 2.3
//
// For any set of distinct tool definitions, registering them all and then
// calling List() SHALL return tool definitions with the same names,
// descriptions, and input schemas as those registered.
func TestProperty3_ToolRegistrationRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		defs := genDistinctToolDefs(1, 10).Draw(t, "toolDefs")

		reg := NewToolRegistry()
		for _, def := range defs {
			if err := reg.RegisterTool(def, noopHandler); err != nil {
				t.Fatalf("RegisterTool(%q) failed: %v", def.Name, err)
			}
		}

		listed := reg.List()
		if len(listed) != len(defs) {
			t.Fatalf("List() returned %d tools, want %d", len(listed), len(defs))
		}

		for i, got := range listed {
			want := defs[i]
			if got.Name != want.Name {
				t.Fatalf("tool[%d] name: got %q, want %q", i, got.Name, want.Name)
			}
			if got.Description != want.Description {
				t.Fatalf("tool[%d] description: got %q, want %q", i, got.Description, want.Description)
			}
			if !jsonEqual(got.InputSchema, want.InputSchema) {
				t.Fatalf("tool[%d] inputSchema mismatch:\n  got:  %s\n  want: %s", i, got.InputSchema, want.InputSchema)
			}
		}
	})
}

// Feature: cloud-mcp-gateway, Property 4: Duplicate Tool Registration Rejection
// Validates: Requirements 3.2
//
// For any tool name, registering a tool with that name and then attempting to
// register another tool with the same name SHALL return an error, and the
// registry SHALL still contain exactly the original tool definition.
func TestProperty4_DuplicateToolRegistrationRejection(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		original := genToolDef().Draw(t, "original")
		duplicate := genToolDef().Draw(t, "duplicate")
		duplicate.Name = original.Name // force same name

		reg := NewToolRegistry()
		if err := reg.RegisterTool(original, noopHandler); err != nil {
			t.Fatalf("first RegisterTool(%q) failed: %v", original.Name, err)
		}

		err := reg.RegisterTool(duplicate, noopHandler)
		if err == nil {
			t.Fatal("second RegisterTool should have returned an error for duplicate name")
		}

		// Registry must still contain exactly the original definition.
		listed := reg.List()
		if len(listed) != 1 {
			t.Fatalf("List() returned %d tools after duplicate rejection, want 1", len(listed))
		}
		if listed[0].Name != original.Name {
			t.Fatalf("tool name: got %q, want %q", listed[0].Name, original.Name)
		}
		if listed[0].Description != original.Description {
			t.Fatalf("tool description: got %q, want %q", listed[0].Description, original.Description)
		}
		if !jsonEqual(listed[0].InputSchema, original.InputSchema) {
			t.Fatalf("tool inputSchema changed after duplicate rejection")
		}
	})
}

// Feature: cloud-mcp-gateway, Property 5: Stable Tool Ordering
// Validates: Requirements 3.4
//
// For any set of registered tools, calling List() multiple times SHALL return
// the tools in the same order every time.
func TestProperty5_StableToolOrdering(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		defs := genDistinctToolDefs(1, 10).Draw(t, "toolDefs")

		reg := NewToolRegistry()
		for _, def := range defs {
			if err := reg.RegisterTool(def, noopHandler); err != nil {
				t.Fatalf("RegisterTool(%q) failed: %v", def.Name, err)
			}
		}

		first := reg.List()
		second := reg.List()

		if len(first) != len(second) {
			t.Fatalf("List() length changed: %d vs %d", len(first), len(second))
		}

		for i := range first {
			if first[i].Name != second[i].Name {
				t.Fatalf("ordering changed at index %d: %q vs %q", i, first[i].Name, second[i].Name)
			}
		}
	})
}
