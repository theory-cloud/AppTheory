package sanitization

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// PolicyFromEnv loads a sanitization policy from an environment variable.
//
// When the variable is unset or contains only whitespace, the returned policy is nil so callers can
// pass it directly into observability.LoggerConfig (nil means "use defaults").
//
// The value can be JSON or YAML (using the same field names as the JSON policy schema).
func PolicyFromEnv(envVar string) (*Policy, error) {
	name := strings.TrimSpace(envVar)
	if name == "" {
		return nil, fmt.Errorf("sanitization: policy env var name is required")
	}

	raw, ok := os.LookupEnv(name)
	if !ok {
		return nil, nil
	}

	p, err := PolicyFromText(raw)
	if err != nil {
		return nil, fmt.Errorf("sanitization: %s: %w", name, err)
	}
	return p, nil
}

// PolicyFromText parses and validates a sanitization policy from a string.
//
// The input can be JSON or YAML. Empty/whitespace-only values (and JSON "null") return (nil, nil).
func PolicyFromText(text string) (*Policy, error) {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil, nil
	}
	if strings.EqualFold(raw, "null") {
		return nil, nil
	}

	var policy Policy
	jsonErr := json.Unmarshal([]byte(raw), &policy)
	if jsonErr == nil {
		if _, compileErr := compilePolicy(policy); compileErr != nil {
			return nil, compileErr
		}
		return &policy, nil
	}

	policy = Policy{}
	if err := yaml.Unmarshal([]byte(raw), &policy); err != nil {
		return nil, fmt.Errorf("sanitization: invalid policy text (json: %v, yaml: %v)", jsonErr, err)
	}
	if _, err := compilePolicy(policy); err != nil {
		return nil, err
	}
	return &policy, nil
}
