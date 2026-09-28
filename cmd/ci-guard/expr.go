package main

import (
	"fmt"
	"strings"
)

// state is one concrete assignment of the GitHub Actions contexts a job-level
// `if:` expression may reference. A job's effective triggers are derived by
// evaluating its expression over a finite set of states rather than by matching
// the expression's text, so negations, `!=`, folded scalars and reordered
// clauses cannot hide coverage.
type state struct {
	event  string            // push | pull_request | workflow_dispatch
	ref    string            // github.ref; "" models a null context
	base   string            // github.event.pull_request.base.ref
	head   string            // github.event.pull_request.head.ref
	draft  string            // github.event.pull_request.draft ("true"/"false")
	inputs map[string]string // workflow_dispatch inputs; nil for other events
}

// expr is a parsed boolean GitHub Actions expression.
type expr interface {
	eval(state) (bool, error)
}

type orExpr struct{ parts []expr }

func (e orExpr) eval(s state) (bool, error) {
	for _, part := range e.parts {
		ok, err := part.eval(s)
		if err != nil {
			return false, err
		}
		if ok {
			return true, nil
		}
	}
	return false, nil
}

type andExpr struct{ parts []expr }

func (e andExpr) eval(s state) (bool, error) {
	for _, part := range e.parts {
		ok, err := part.eval(s)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}
	return true, nil
}

type notExpr struct{ child expr }

func (e notExpr) eval(s state) (bool, error) {
	ok, err := e.child.eval(s)
	if err != nil {
		return false, err
	}
	return !ok, nil
}

type constExpr struct{ value bool }

func (e constExpr) eval(state) (bool, error) { return e.value, nil }

// alwaysExpr is GitHub's always() status function. It is kept distinct from the
// other status functions because it is the one spelling that makes a job
// independent of its `needs:` outcomes: a job with `needs:` and `if: always()`
// still runs when the jobs it needs were skipped, so the classifier must not
// narrow its triggers to theirs.
type alwaysExpr struct{}

func (e alwaysExpr) eval(state) (bool, error) { return true, nil }

// containsAlways reports whether an expression calls always() anywhere, which
// is what decides whether a `needs:` edge narrows the job's effective triggers.
func containsAlways(e expr) bool {
	switch typed := e.(type) {
	case alwaysExpr:
		return true
	case orExpr:
		for _, part := range typed.parts {
			if containsAlways(part) {
				return true
			}
		}
	case andExpr:
		for _, part := range typed.parts {
			if containsAlways(part) {
				return true
			}
		}
	case notExpr:
		return containsAlways(typed.child)
	}
	return false
}

type compareExpr struct {
	op    string
	left  operand
	right operand
}

func (e compareExpr) eval(s state) (bool, error) {
	left, leftSet, err := e.left.resolve(s)
	if err != nil {
		return false, err
	}
	right, rightSet, err := e.right.resolve(s)
	if err != nil {
		return false, err
	}
	// GitHub Actions compares a null context as unequal to any literal and
	// equal to another null context.
	equal := !leftSet && !rightSet
	if leftSet && rightSet {
		equal = strings.EqualFold(left, right)
	}
	if e.op == "==" {
		return equal, nil
	}
	return !equal, nil
}

type truthyExpr struct{ value operand }

func (e truthyExpr) eval(s state) (bool, error) {
	value, set, err := e.value.resolve(s)
	if err != nil {
		return false, err
	}
	if !set {
		return false, nil
	}
	return value != "" && !strings.EqualFold(value, "false"), nil
}

type operandKind int

const (
	operandContext operandKind = iota
	operandLiteral
)

type operand struct {
	kind operandKind
	text string
}

var modeledContexts = map[string]bool{
	"github.event_name":                  true,
	"github.ref":                         true,
	"github.event.pull_request.base.ref": true,
	"github.event.pull_request.head.ref": true,
	"github.event.pull_request.draft":    true,
}

func (o operand) resolve(s state) (string, bool, error) {
	if o.kind == operandLiteral {
		return o.text, true, nil
	}
	switch o.text {
	case "github.event_name":
		return s.event, s.event != "", nil
	case "github.ref":
		return s.ref, s.ref != "", nil
	case "github.event.pull_request.base.ref":
		return s.base, s.base != "", nil
	case "github.event.pull_request.head.ref":
		return s.head, s.head != "", nil
	case "github.event.pull_request.draft":
		return s.draft, s.draft != "", nil
	}
	if name, ok := strings.CutPrefix(o.text, "inputs."); ok && name != "" {
		if s.inputs == nil {
			return "", false, nil
		}
		value, found := s.inputs[name]
		return value, found, nil
	}
	return "", false, fmt.Errorf("context %q is not modeled by the trigger classifier", o.text)
}

type tokenKind int

const (
	tokenIdent tokenKind = iota
	tokenString
	tokenPunct
)

type token struct {
	kind tokenKind
	text string
}

// parseCondition parses a job-level `if:` value into an expression. Any
// construct the classifier does not model is an error, and the caller fails
// closed on that error.
func parseCondition(source string) (expr, error) {
	text := strings.TrimSpace(source)
	if inner, ok := unwrapExpressionInterpolation(text); ok {
		text = inner
	}
	if text == "" {
		return nil, fmt.Errorf("empty if: expression")
	}
	tokens, err := lexExpression(text)
	if err != nil {
		return nil, err
	}
	parser := &expressionParser{tokens: tokens}
	result, err := parser.parseOr()
	if err != nil {
		return nil, err
	}
	if parser.pos != len(parser.tokens) {
		return nil, fmt.Errorf("unexpected token %q after if: expression", parser.tokens[parser.pos].text)
	}
	return result, nil
}

func unwrapExpressionInterpolation(text string) (string, bool) {
	if strings.HasPrefix(text, "${{") && strings.HasSuffix(text, "}}") {
		return strings.TrimSpace(text[3 : len(text)-2]), true
	}
	return text, false
}

func lexExpression(source string) ([]token, error) {
	var tokens []token
	for i := 0; i < len(source); {
		c := source[i]
		switch {
		case isExpressionSpace(c):
			i++
		case c == '\'':
			value, next, err := lexString(source, i)
			if err != nil {
				return nil, err
			}
			tokens = append(tokens, token{kind: tokenString, text: value})
			i = next
		case isExpressionPunct(c):
			tokens = append(tokens, token{kind: tokenPunct, text: string(c)})
			i++
		case isIdentifierStart(c):
			j := i
			for j < len(source) && isIdentifierPart(source[j]) {
				j++
			}
			tokens = append(tokens, token{kind: tokenIdent, text: source[i:j]})
			i = j
		default:
			operator, next, ok := lexOperator(source, i)
			if !ok {
				return nil, fmt.Errorf("unexpected character %q in if: expression", string(c))
			}
			tokens = append(tokens, operator)
			i = next
		}
	}
	return tokens, nil
}

// lexOperator reads one of the operators the classifier models.
func lexOperator(source string, index int) (token, int, bool) {
	for _, operator := range []string{"==", "!=", "&&", "||"} {
		if strings.HasPrefix(source[index:], operator) {
			return token{kind: tokenPunct, text: operator}, index + len(operator), true
		}
	}
	if source[index] == '!' {
		return token{kind: tokenPunct, text: "!"}, index + 1, true
	}
	return token{}, index, false
}

func isExpressionSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isExpressionPunct(c byte) bool {
	return c == '(' || c == ')' || c == ','
}

func lexString(source string, start int) (string, int, error) {
	var builder strings.Builder
	for i := start + 1; i < len(source); i++ {
		switch {
		case source[i] == '\'' && i+1 < len(source) && source[i+1] == '\'':
			builder.WriteByte('\'')
			i++
		case source[i] == '\'':
			return builder.String(), i + 1, nil
		default:
			builder.WriteByte(source[i])
		}
	}
	return "", 0, fmt.Errorf("unterminated string literal in if: expression")
}

func isIdentifierStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isIdentifierPart(c byte) bool {
	return isIdentifierStart(c) || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '*' || c == '$'
}

type expressionParser struct {
	tokens []token
	pos    int
}

func (p *expressionParser) peekPunct(text string) bool {
	return p.pos < len(p.tokens) && p.tokens[p.pos].kind == tokenPunct && p.tokens[p.pos].text == text
}

func (p *expressionParser) parseOr() (expr, error) {
	first, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	parts := []expr{first}
	for p.peekPunct("||") {
		p.pos++
		next, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		parts = append(parts, next)
	}
	if len(parts) == 1 {
		return first, nil
	}
	return orExpr{parts: parts}, nil
}

func (p *expressionParser) parseAnd() (expr, error) {
	first, err := p.parseNot()
	if err != nil {
		return nil, err
	}
	parts := []expr{first}
	for p.peekPunct("&&") {
		p.pos++
		next, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		parts = append(parts, next)
	}
	if len(parts) == 1 {
		return first, nil
	}
	return andExpr{parts: parts}, nil
}

func (p *expressionParser) parseNot() (expr, error) {
	if p.peekPunct("!") {
		p.pos++
		child, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return notExpr{child: child}, nil
	}
	return p.parsePrimary()
}

func (p *expressionParser) parsePrimary() (expr, error) {
	if p.peekPunct("(") {
		p.pos++
		inner, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if !p.peekPunct(")") {
			return nil, fmt.Errorf("missing closing parenthesis in if: expression")
		}
		p.pos++
		return inner, nil
	}
	if p.isFunctionCall() {
		return p.parseFunctionCall()
	}
	left, err := p.parseOperand()
	if err != nil {
		return nil, err
	}
	if p.peekPunct("==") || p.peekPunct("!=") {
		op := p.tokens[p.pos].text
		p.pos++
		right, err := p.parseOperand()
		if err != nil {
			return nil, err
		}
		return compareExpr{op: op, left: left, right: right}, nil
	}
	return truthyExpr{value: left}, nil
}

func (p *expressionParser) isFunctionCall() bool {
	return p.pos+1 < len(p.tokens) &&
		p.tokens[p.pos].kind == tokenIdent &&
		p.tokens[p.pos+1].kind == tokenPunct &&
		p.tokens[p.pos+1].text == "("
}

func (p *expressionParser) parseFunctionCall() (expr, error) {
	name := p.tokens[p.pos].text
	p.pos += 2
	if !p.peekPunct(")") {
		return nil, fmt.Errorf("function %q with arguments in if: expression is not modeled", name)
	}
	p.pos++
	switch name {
	case "always":
		return alwaysExpr{}, nil
	case "success", "failure", "cancelled": //nolint:misspell // GitHub Actions spells the function cancelled()
		// For trigger classification these three all mean "the job runs only
		// where its needs ran and completed", which is the default gate the
		// needs: handling applies; only always() lifts that gate.
		return constExpr{value: true}, nil
	default:
		return nil, fmt.Errorf("function %q in if: expression is not modeled", name)
	}
}

func (p *expressionParser) parseOperand() (operand, error) {
	if p.pos >= len(p.tokens) {
		return operand{}, fmt.Errorf("unexpected end of if: expression")
	}
	tok := p.tokens[p.pos]
	switch tok.kind {
	case tokenString:
		p.pos++
		return operand{kind: operandLiteral, text: tok.text}, nil
	case tokenIdent:
		p.pos++
		return classifyIdentOperand(tok.text)
	default:
		return operand{}, fmt.Errorf("unexpected token %q in if: expression", tok.text)
	}
}

func classifyIdentOperand(text string) (operand, error) {
	switch {
	case text == "true" || text == "false":
		return operand{kind: operandLiteral, text: text}, nil
	case isNumberLiteral(text):
		return operand{kind: operandLiteral, text: text}, nil
	case modeledContexts[text]:
		return operand{kind: operandContext, text: text}, nil
	}
	if name, ok := strings.CutPrefix(text, "inputs."); ok && name != "" {
		return operand{kind: operandContext, text: text}, nil
	}
	return operand{}, fmt.Errorf("context %q in if: expression is not modeled", text)
}

func isNumberLiteral(text string) bool {
	if text == "" {
		return false
	}
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

// referencedInputs lists the workflow_dispatch input names an expression may
// read, so the classifier can enumerate their value combinations.
func referencedInputs(source string) []string {
	seen := map[string]bool{}
	var names []string
	for i := 0; i < len(source); {
		if !strings.HasPrefix(source[i:], "inputs.") {
			i++
			continue
		}
		j := i + len("inputs.")
		for j < len(source) && isIdentifierPart(source[j]) {
			j++
		}
		name := source[i+len("inputs.") : j]
		if name != "" && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
		i = j
	}
	return names
}
