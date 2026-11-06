package localrunner

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// EventBridge target input shaping: Input, InputPath and InputTransformer.
//
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-transform-target-input.html
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html
//
// A missing path removes the variable, as AWS documents; a JSON template keeps
// a null placeholder so the rendered document stays valid JSON.

// eventBridgeInput selects what a target receives.
func eventBridgeInput(target RuleTargetSpec, event map[string]any, rule RuleSpec, now time.Time) ([]byte, error) {
	switch {
	case target.InputTransformer != nil:
		return renderEventBridgeTemplate(target.InputTransformer, event, rule, now)
	case target.InputPath != "":
		value, ok := lookupEventPath(event, target.InputPath)
		if !ok {
			return []byte("null"), nil
		}
		return json.Marshal(value)
	case target.Input != "":
		return []byte(target.Input), nil
	default:
		return json.Marshal(event)
	}
}

// lookupEventPath evaluates the supported JSON path syntax: dot notation and
// array indices. A wildcard is refused at plan time.
func lookupEventPath(value any, path string) (any, bool) {
	trimmed := strings.TrimSpace(path)
	if !strings.HasPrefix(trimmed, "$") {
		return nil, false
	}
	rest := strings.TrimPrefix(trimmed, "$")
	current := value
	for rest != "" {
		switch {
		case strings.HasPrefix(rest, "."):
			rest = strings.TrimPrefix(rest, ".")
			end := strings.IndexAny(rest, ".[")
			segment := rest
			if end >= 0 {
				segment = rest[:end]
				rest = rest[end:]
			} else {
				rest = ""
			}
			object, ok := current.(map[string]any)
			if !ok {
				return nil, false
			}
			current, ok = object[segment]
			if !ok {
				return nil, false
			}
		case strings.HasPrefix(rest, "["):
			end := strings.IndexByte(rest, ']')
			if end < 0 {
				return nil, false
			}
			index, err := strconv.Atoi(strings.TrimSpace(rest[1:end]))
			if err != nil {
				return nil, false
			}
			array, ok := current.([]any)
			if !ok || index < 0 || index >= len(array) {
				return nil, false
			}
			current = array[index]
			rest = rest[end+1:]
		default:
			return nil, false
		}
	}
	return current, true
}

// renderEventBridgeTemplate renders an InputTransformer.
func renderEventBridgeTemplate(transformer *RuleInputTransformer, event map[string]any, rule RuleSpec, now time.Time) ([]byte, error) {
	variables := make(map[string]any, len(transformer.InputPathsMap)+5)
	for name, path := range transformer.InputPathsMap {
		if value, ok := lookupEventPath(event, path); ok {
			variables[name] = value
		}
	}
	variables["aws.events.rule-arn"] = rule.ARN
	variables["aws.events.rule-name"] = rule.Name
	variables["aws.events.event.ingestion-time"] = now.UTC().Format(time.RFC3339)
	withoutDetail := make(map[string]any, len(event))
	for key, value := range event {
		if key == "detail" {
			continue
		}
		withoutDetail[key] = value
	}
	variables["aws.events.event"] = withoutDetail
	variables["aws.events.event.json"] = event

	template := transformer.InputTemplate
	var builder strings.Builder
	inString := false
	for index := 0; index < len(template); {
		char := template[index]
		switch {
		case char == '\\' && inString && index+1 < len(template):
			builder.WriteByte(char)
			builder.WriteByte(template[index+1])
			index += 2
		case char == '"':
			inString = !inString
			builder.WriteByte(char)
			index++
		case char == '<':
			end := strings.IndexByte(template[index:], '>')
			if end < 0 {
				builder.WriteByte(char)
				index++
				continue
			}
			name := template[index+1 : index+end]
			index += end + 1
			value, ok := variables[name]
			if !ok {
				// AWS removes a variable whose path has no value.
				continue
			}
			encoded, err := eventBridgeVariableJSON(value, inString)
			if err != nil {
				return nil, err
			}
			builder.Write(encoded)
		default:
			builder.WriteByte(char)
			index++
		}
	}
	rendered := []byte(builder.String())
	if len(strings.TrimSpace(string(rendered))) == 0 {
		return nil, fmt.Errorf("InputTransformer produced an empty payload")
	}
	return rendered, nil
}

// eventBridgeVariableJSON renders one variable for a string or JSON context.
// A string context receives the value's string form without enclosing quotes;
// a value context receives its JSON encoding.
func eventBridgeVariableJSON(value any, inString bool) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if !inString {
		return encoded, nil
	}
	if text, ok := value.(string); ok {
		escaped, escapeErr := json.Marshal(text)
		if escapeErr != nil {
			return nil, escapeErr
		}
		return escaped[1 : len(escaped)-1], nil
	}
	// A non-string value inside a string template is inserted as its JSON
	// text, escaped so the surrounding JSON string stays valid.
	escaped, err := json.Marshal(string(encoded))
	if err != nil {
		return nil, err
	}
	return escaped[1 : len(escaped)-1], nil
}
