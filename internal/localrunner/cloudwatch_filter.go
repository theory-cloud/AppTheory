package localrunner

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// CloudWatch Logs subscription filters match log event messages with the filter
// pattern syntax. The runner implements the forms its examples and a local
// application actually use:
//
//   - the blank pattern matches every event;
//   - term patterns: bare terms ANDed, "quoted phrases", ? alternative terms
//     (OR), and -excluded terms;
//   - JSON patterns: `$.path = value`, `$.path != value`, `&&`, `||` and
//     parentheses, with string, number and boolean values.
//
// Anything else is refused at plan time with the filter and the unsupported
// construct named, never accepted and silently matched against nothing. Regex
// patterns (`%...%`), array wildcards and space-delimited field selectors are
// not implemented locally.
//
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html

// validateCloudWatchFilterPattern validates a subscription filter pattern.
func validateCloudWatchFilterPattern(pattern string) error {
	trimmed := strings.TrimSpace(pattern)
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "{") {
		_, err := parseCloudWatchJSONPattern(trimmed)
		return err
	}
	_, err := parseCloudWatchTermPattern(trimmed)
	return err
}

// cloudWatchFilterMatches applies one validated pattern to one log message.
func cloudWatchFilterMatches(pattern, message string) (bool, error) {
	trimmed := strings.TrimSpace(pattern)
	if trimmed == "" {
		return true, nil
	}
	if strings.HasPrefix(trimmed, "{") {
		expression, err := parseCloudWatchJSONPattern(trimmed)
		if err != nil {
			return false, err
		}
		var document any
		decoder := json.NewDecoder(strings.NewReader(message))
		decoder.UseNumber()
		if err := decoder.Decode(&document); err != nil {
			return false, nil
		}
		return expression.evaluate(document), nil
	}
	terms, err := parseCloudWatchTermPattern(trimmed)
	if err != nil {
		return false, err
	}
	return terms.match(message), nil
}

// cloudWatchTermPattern is the parsed term form.
type cloudWatchTermPattern struct {
	all      []string
	any      []string
	excluded []string
}

func parseCloudWatchTermPattern(pattern string) (cloudWatchTermPattern, error) {
	tokens, err := splitCloudWatchTerms(pattern)
	if err != nil {
		return cloudWatchTermPattern{}, err
	}
	var parsed cloudWatchTermPattern
	for _, token := range tokens {
		if token == "?" || token == "-" {
			return cloudWatchTermPattern{}, fmt.Errorf("filter term %q has no value", token)
		}
		switch {
		case strings.HasPrefix(token, "%") && strings.HasSuffix(token, "%"):
			return cloudWatchTermPattern{}, fmt.Errorf("regex filter pattern %q is not implemented locally", token)
		case strings.ContainsAny(token, "[]*{}"):
			return cloudWatchTermPattern{}, fmt.Errorf("filter term %q uses a syntax this runner does not implement", token)
		case strings.HasPrefix(token, "-") && len(token) > 1:
			parsed.excluded = append(parsed.excluded, token[1:])
		case strings.HasPrefix(token, "?") && len(token) > 1:
			parsed.any = append(parsed.any, token[1:])
		default:
			parsed.all = append(parsed.all, token)
		}
	}
	return parsed, nil
}

func (p cloudWatchTermPattern) match(message string) bool {
	for _, term := range p.excluded {
		if strings.Contains(message, term) {
			return false
		}
	}
	for _, term := range p.all {
		if !strings.Contains(message, term) {
			return false
		}
	}
	if len(p.any) > 0 {
		for _, term := range p.any {
			if strings.Contains(message, term) {
				return true
			}
		}
		return false
	}
	return true
}

// splitCloudWatchTerms splits on whitespace while keeping a quoted phrase as
// one term. An unterminated quote is refused.
func splitCloudWatchTerms(pattern string) ([]string, error) {
	var tokens []string
	var current strings.Builder
	quoted := false
	flush := func() {
		if current.Len() > 0 {
			tokens = append(tokens, current.String())
			current.Reset()
		}
	}
	for _, char := range pattern {
		switch {
		case char == '"':
			quoted = !quoted
			flush()
		case unicode.IsSpace(char) && !quoted:
			flush()
		case quoted:
			// A quoted phrase is a substring match without its quotes.
			current.WriteRune(char)
		default:
			current.WriteRune(char)
		}
	}
	if quoted {
		return nil, fmt.Errorf("filter pattern has an unterminated quoted phrase")
	}
	flush()
	if len(tokens) == 0 {
		return nil, fmt.Errorf("filter pattern has no term")
	}
	return tokens, nil
}

// cloudWatchJSONExpression is one parsed JSON filter expression.
type cloudWatchJSONExpression struct {
	op       string
	path     []string
	value    any
	children []*cloudWatchJSONExpression
}

// cloudWatchPatternParser is a recursive-descent parser for the supported JSON
// filter grammar. The outer braces wrap the whole expression; conditions inside
// are written `$.path = value` without their own braces, as AWS documents.
type cloudWatchPatternParser struct {
	input string
	pos   int
}

func parseCloudWatchJSONPattern(pattern string) (*cloudWatchJSONExpression, error) {
	trimmed := strings.TrimSpace(pattern)
	if !strings.HasPrefix(trimmed, "{") || !strings.HasSuffix(trimmed, "}") {
		return nil, fmt.Errorf("a JSON filter pattern must be wrapped in { }")
	}
	parser := &cloudWatchPatternParser{input: strings.TrimSpace(trimmed[1 : len(trimmed)-1])}
	if parser.input == "" {
		return nil, fmt.Errorf("a JSON filter pattern has no expression")
	}
	expression, err := parser.parseOr()
	if err != nil {
		return nil, err
	}
	parser.skipSpace()
	if parser.pos != len(parser.input) {
		return nil, fmt.Errorf("filter pattern has trailing content at offset %d", parser.pos)
	}
	return expression, nil
}

func (p *cloudWatchPatternParser) parseOr() (*cloudWatchJSONExpression, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for {
		p.skipSpace()
		if !p.consume("||") {
			return left, nil
		}
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = &cloudWatchJSONExpression{op: "or", children: []*cloudWatchJSONExpression{left, right}}
	}
}

func (p *cloudWatchPatternParser) parseAnd() (*cloudWatchJSONExpression, error) {
	left, err := p.parseFactor()
	if err != nil {
		return nil, err
	}
	for {
		p.skipSpace()
		if !p.consume("&&") {
			return left, nil
		}
		right, err := p.parseFactor()
		if err != nil {
			return nil, err
		}
		left = &cloudWatchJSONExpression{op: "and", children: []*cloudWatchJSONExpression{left, right}}
	}
}

func (p *cloudWatchPatternParser) parseFactor() (*cloudWatchJSONExpression, error) {
	p.skipSpace()
	if p.consume("(") {
		expression, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if !p.consume(")") {
			return nil, fmt.Errorf("filter pattern has an unclosed parenthesis")
		}
		return expression, nil
	}
	return p.parseCondition()
}

// parseCondition parses `$.path = value` or `$.path != value`.
func (p *cloudWatchPatternParser) parseCondition() (*cloudWatchJSONExpression, error) {
	p.skipSpace()
	start := p.pos
	for p.pos < len(p.input) && !strings.ContainsRune(" \t\r\n=!()", rune(p.input[p.pos])) {
		p.pos++
	}
	pathText := strings.TrimSpace(p.input[start:p.pos])
	if pathText == "" {
		return nil, fmt.Errorf("filter condition has no JSON path at offset %d", start)
	}
	p.skipSpace()
	operator := "="
	if p.consume("!=") {
		operator = "!="
	} else if !p.consume("=") {
		return nil, fmt.Errorf("filter condition %q has no = or != comparison", pathText)
	}
	p.skipSpace()
	valueText, err := p.readValue()
	if err != nil {
		return nil, err
	}
	path, err := parseCloudWatchJSONPath(pathText)
	if err != nil {
		return nil, err
	}
	value, err := parseCloudWatchJSONValue(valueText)
	if err != nil {
		return nil, err
	}
	return &cloudWatchJSONExpression{op: operator, path: path, value: value}, nil
}

// readValue reads one quoted string or one bare token.
func (p *cloudWatchPatternParser) readValue() (string, error) {
	if p.pos < len(p.input) && p.input[p.pos] == '"' {
		start := p.pos
		p.pos++
		for p.pos < len(p.input) {
			if p.input[p.pos] == '\\' {
				p.pos += 2
				continue
			}
			if p.input[p.pos] == '"' {
				p.pos++
				return p.input[start:p.pos], nil
			}
			p.pos++
		}
		return "", fmt.Errorf("filter value has an unterminated string")
	}
	start := p.pos
	for p.pos < len(p.input) && !strings.ContainsRune(" \t\r\n)&|", rune(p.input[p.pos])) {
		p.pos++
	}
	value := strings.TrimSpace(p.input[start:p.pos])
	if value == "" {
		return "", fmt.Errorf("filter condition has no value")
	}
	return value, nil
}

func parseCloudWatchJSONPath(path string) ([]string, error) {
	if !strings.HasPrefix(path, "$") {
		return nil, fmt.Errorf("filter path %q must start with $", path)
	}
	trimmed := strings.TrimPrefix(path, "$")
	if trimmed == "" {
		return nil, fmt.Errorf("filter path %q has no field", path)
	}
	if !strings.HasPrefix(trimmed, ".") {
		return nil, fmt.Errorf("filter path %q uses a syntax this runner does not implement", path)
	}
	parts := strings.Split(strings.TrimPrefix(trimmed, "."), ".")
	for _, part := range parts {
		if part == "" {
			return nil, fmt.Errorf("filter path %q has an empty segment", path)
		}
		if strings.ContainsAny(part, "[]*") {
			return nil, fmt.Errorf("filter path %q uses an array or wildcard selector this runner does not implement", path)
		}
	}
	return parts, nil
}

func parseCloudWatchJSONValue(raw string) (any, error) {
	if strings.HasPrefix(raw, `"`) {
		var value string
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			return nil, fmt.Errorf("filter value %q is not a valid JSON string", raw)
		}
		return value, nil
	}
	switch raw {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case jsonNull:
		return nil, nil
	}
	if _, err := strconv.ParseFloat(raw, 64); err == nil {
		return json.Number(raw), nil
	}
	if strings.ContainsAny(raw, " \t\r\n") {
		return nil, fmt.Errorf("filter value %q is not a single term", raw)
	}
	return raw, nil
}

func (p *cloudWatchPatternParser) skipSpace() {
	for p.pos < len(p.input) && unicode.IsSpace(rune(p.input[p.pos])) {
		p.pos++
	}
}

func (p *cloudWatchPatternParser) consume(token string) bool {
	if strings.HasPrefix(p.input[p.pos:], token) {
		p.pos += len(token)
		return true
	}
	return false
}

// evaluate applies one expression to a decoded JSON document.
func (e *cloudWatchJSONExpression) evaluate(document any) bool {
	switch e.op {
	case "and":
		return e.children[0].evaluate(document) && e.children[1].evaluate(document)
	case "or":
		return e.children[0].evaluate(document) || e.children[1].evaluate(document)
	}
	actual, present := lookupCloudWatchPath(document, e.path)
	switch e.op {
	case "=":
		return present && cloudWatchJSONEqual(e.value, actual)
	case "!=":
		return !present || !cloudWatchJSONEqual(e.value, actual)
	default:
		return false
	}
}

func lookupCloudWatchPath(document any, path []string) (any, bool) {
	current := document
	for _, segment := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[segment]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func cloudWatchJSONEqual(pattern, actual any) bool {
	switch expected := pattern.(type) {
	case json.Number:
		switch got := actual.(type) {
		case json.Number:
			return expected.String() == got.String()
		case float64:
			return expected.String() == strconv.FormatFloat(got, 'f', -1, 64)
		}
		return false
	case string:
		text, ok := actual.(string)
		return ok && expected == text
	case bool:
		value, ok := actual.(bool)
		return ok && expected == value
	case nil:
		return actual == nil
	default:
		return false
	}
}

// cloudWatchSubscriptionPayload is the documented gzip payload a subscription
// filter delivers. It is JSON before gzip and base64.
//
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html
type cloudWatchSubscriptionPayload struct {
	MessageType         string               `json:"messageType"`
	Owner               string               `json:"owner"`
	LogGroup            string               `json:"logGroup"`
	LogStream           string               `json:"logStream"`
	SubscriptionFilters []string             `json:"subscriptionFilters"`
	LogEvents           []cloudWatchLogEvent `json:"logEvents"`
}

// gzip compresses the payload for a subscription delivery.
func (p cloudWatchSubscriptionPayload) gzip() ([]byte, error) {
	return gzipJSON(p)
}

// gzipJSON marshals and gzip-compresses one payload.
func gzipJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(encoded); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
