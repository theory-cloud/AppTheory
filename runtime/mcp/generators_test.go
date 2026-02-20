package mcp

import (
	"encoding/json"
	"fmt"
	"time"

	"pgregory.net/rapid"
)

// genAlphanumericString generates a non-empty alphanumeric string.
func genAlphanumericString(minLen, maxLen int) *rapid.Generator[string] {
	return rapid.StringMatching(fmt.Sprintf("[a-zA-Z0-9_]{%d,%d}", minLen, maxLen))
}

// genJSONSchema generates a valid JSON Schema object as json.RawMessage.
func genJSONSchema() *rapid.Generator[json.RawMessage] {
	return rapid.Custom[json.RawMessage](func(t *rapid.T) json.RawMessage {
		numProps := rapid.IntRange(0, 4).Draw(t, "numProps")
		props := make(map[string]any, numProps)
		for i := range numProps {
			propName := genAlphanumericString(1, 12).Draw(t, fmt.Sprintf("propName_%d", i))
			propType := rapid.SampledFrom([]string{"string", "integer", "boolean", "number"}).Draw(t, fmt.Sprintf("propType_%d", i))
			props[propName] = map[string]string{"type": propType}
		}

		schema := map[string]any{
			"type":       "object",
			"properties": props,
		}

		data, err := json.Marshal(schema)
		if err != nil {
			t.Fatal(err)
		}
		return json.RawMessage(data)
	})
}

// genToolDef generates a random valid ToolDef.
func genToolDef() *rapid.Generator[ToolDef] {
	return rapid.Custom[ToolDef](func(t *rapid.T) ToolDef {
		return ToolDef{
			Name:        genAlphanumericString(1, 32).Draw(t, "name"),
			Description: rapid.StringMatching("[a-zA-Z0-9 .,!?]{0,64}").Draw(t, "description"),
			InputSchema: genJSONSchema().Draw(t, "inputSchema"),
		}
	})
}

// jsonEqual compares two json.RawMessage values for semantic equality.
func jsonEqual(a, b json.RawMessage) bool {
	// Handle nil/empty cases.
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if len(a) == 0 || len(b) == 0 {
		return false
	}

	var va, vb any
	if err := json.Unmarshal(a, &va); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &vb); err != nil {
		return false
	}

	// Re-marshal both to canonical form and compare.
	ca, err := json.Marshal(va)
	if err != nil {
		return false
	}
	cb, err := json.Marshal(vb)
	if err != nil {
		return false
	}
	return string(ca) == string(cb)
}

// genRequestID generates a random JSON-RPC request ID (integer or string).
func genRequestID() *rapid.Generator[any] {
	return rapid.Custom[any](func(t *rapid.T) any {
		useString := rapid.Bool().Draw(t, "useStringID")
		if useString {
			return genAlphanumericString(1, 16).Draw(t, "stringID")
		}
		return rapid.IntRange(1, 100000).Draw(t, "intID")
	})
}

// genSessionID generates a random non-empty session ID string.
func genSessionID() *rapid.Generator[string] {
	return genAlphanumericString(8, 32)
}

// genSessionData generates a random map of string key-value pairs.
func genSessionData() *rapid.Generator[map[string]string] {
	return rapid.Custom[map[string]string](func(t *rapid.T) map[string]string {
		n := rapid.IntRange(0, 5).Draw(t, "numEntries")
		if n == 0 {
			return nil
		}
		data := make(map[string]string, n)
		for i := range n {
			key := genAlphanumericString(1, 16).Draw(t, fmt.Sprintf("key_%d", i))
			val := genAlphanumericString(0, 32).Draw(t, fmt.Sprintf("val_%d", i))
			data[key] = val
		}
		return data
	})
}

// genSession generates a random valid Session with an expiry in the future
// relative to the given base time.
func genSession(base time.Time) *rapid.Generator[Session] {
	return rapid.Custom[Session](func(t *rapid.T) Session {
		ttlMinutes := rapid.IntRange(1, 120).Draw(t, "ttlMinutes")
		return Session{
			ID:        genSessionID().Draw(t, "id"),
			CreatedAt: base,
			ExpiresAt: base.Add(time.Duration(ttlMinutes) * time.Minute),
			Data:      genSessionData().Draw(t, "data"),
		}
	})
}
