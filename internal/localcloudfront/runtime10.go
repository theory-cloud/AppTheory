package localcloudfront

import (
	"fmt"
	"strings"
	"unicode"
)

// checkRuntime10Syntax rejects the documented ES6 additions that
// cloudfront-js-1.0 does not support: const, let, async and await. The check
// strips comments and string literals first. It is a best-effort language gate:
// V8 has no ES5-only parser, so the executor documents that other post-ES5
// built-ins are not removed for runtime 1.0.
func checkRuntime10Syntax(code string) error {
	stripped := stripJavaScriptLiterals(code)
	for _, keyword := range []string{"const", "let", "async", "await"} {
		if containsJavaScriptWord(stripped, keyword) {
			return fmt.Errorf("cloudfront-js-1.0 does not support %q; use var or declare cloudfront-js-2.0", keyword)
		}
	}
	return nil
}

// stripJavaScriptLiterals replaces comments and string/template literals with
// spaces, preserving offsets for keyword checks. Regular expression literals
// are not parsed; a keyword inside one can be reported as a false positive,
// which fails closed.
//
//nolint:gocyclo // the scanner tracks JavaScript lexical state
func stripJavaScriptLiterals(code string) string {
	out := []byte(code)
	const (
		normal = iota
		lineComment
		blockComment
		singleQuote
		doubleQuote
		template
	)
	state := normal
	for index := 0; index < len(code); index++ {
		character := code[index]
		next := byte(0)
		if index+1 < len(code) {
			next = code[index+1]
		}
		switch state {
		case normal:
			switch {
			case character == '/' && next == '/':
				state = lineComment
				out[index] = ' '
			case character == '/' && next == '*':
				state = blockComment
				out[index] = ' '
			case character == '\'':
				state = singleQuote
				out[index] = ' '
			case character == '"':
				state = doubleQuote
				out[index] = ' '
			case character == '`':
				state = template
				out[index] = ' '
			}
		case lineComment:
			if character == '\n' {
				state = normal
			} else {
				out[index] = ' '
			}
		case blockComment:
			out[index] = ' '
			if character == '*' && next == '/' {
				out[index+1] = ' '
				index++
				state = normal
			}
		case singleQuote, doubleQuote, template:
			out[index] = ' '
			if character == '\\' && index+1 < len(code) {
				out[index+1] = ' '
				index++
				continue
			}
			if (state == singleQuote && character == '\'') ||
				(state == doubleQuote && character == '"') ||
				(state == template && character == '`') {
				state = normal
			}
		}
	}
	return string(out)
}

func containsJavaScriptWord(source, word string) bool {
	for offset := 0; offset+len(word) <= len(source); {
		index := strings.Index(source[offset:], word)
		if index < 0 {
			return false
		}
		index += offset
		beforeOK := index == 0 || !isJavaScriptIdentifierByte(source[index-1]) && source[index-1] != '.'
		after := index + len(word)
		afterOK := after == len(source) || !isJavaScriptIdentifierByte(source[after])
		if beforeOK && afterOK {
			return true
		}
		offset = index + len(word)
	}
	return false
}

func isJavaScriptIdentifierByte(value byte) bool {
	return value == '_' || value == '$' || unicode.IsLetter(rune(value)) || unicode.IsDigit(rune(value))
}
