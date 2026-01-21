package apptheory

import (
	"encoding/json"
	"strings"
)

// StepFunctionsTaskToken extracts an AWS Step Functions callback task token from common payload shapes.
//
// It checks (in order): "taskToken", "TaskToken", and "task_token". If no token is found, it returns "".
func StepFunctionsTaskToken(event any) string {
	if event == nil {
		return ""
	}

	switch value := event.(type) {
	case map[string]any:
		return stepFunctionsTaskTokenFromMap(value)
	case map[string]string:
		for _, key := range []string{"taskToken", "TaskToken", "task_token"} {
			if token := strings.TrimSpace(value[key]); token != "" {
				return token
			}
		}
		return ""
	case json.RawMessage:
		var parsed map[string]any
		if err := json.Unmarshal(value, &parsed); err != nil {
			return ""
		}
		return stepFunctionsTaskTokenFromMap(parsed)
	case []byte:
		var parsed map[string]any
		if err := json.Unmarshal(value, &parsed); err != nil {
			return ""
		}
		return stepFunctionsTaskTokenFromMap(parsed)
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		var parsed map[string]any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return ""
		}
		return stepFunctionsTaskTokenFromMap(parsed)
	}
}

func stepFunctionsTaskTokenFromMap(event map[string]any) string {
	for _, key := range []string{"taskToken", "TaskToken", "task_token"} {
		raw, ok := event[key]
		if !ok {
			continue
		}
		switch value := raw.(type) {
		case string:
			if token := strings.TrimSpace(value); token != "" {
				return token
			}
		case []byte:
			if token := strings.TrimSpace(string(value)); token != "" {
				return token
			}
		}
	}
	return ""
}
