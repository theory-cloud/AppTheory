package main

import "strings"

// shellCommand is one command found in command position inside shell text.
type shellCommand struct {
	words []string
	line  int
	raw   string
}

// scanShellText walks shell text and reports every command in command position.
// It follows `bash -c` / `sh -c` payloads, `$(...)` and backtick command
// substitutions, and shell heredoc bodies, so an install cannot hide behind a
// comment, a subshell or a nested interpreter.
func scanShellText(text string, startLine int, visit func(shellCommand)) {
	scanner := &shellScanner{visit: visit}
	scanner.scan(text, startLine)
}

type shellScanner struct {
	visit func(shellCommand)
}

func (s *shellScanner) scan(text string, startLine int) {
	lines := logicalShellLines(text, startLine)
	for i := 0; i < len(lines); i++ {
		code := stripShellComment(lines[i].text)
		segments, substitutions := splitShellCode(code)
		for _, words := range segments {
			s.visitSegment(words, lines[i].line, strings.TrimSpace(lines[i].text))
		}
		for _, payload := range substitutions {
			s.scan(payload, lines[i].line)
		}
		markers := findHeredocMarkers(code)
		if len(markers) > 0 {
			body, next := collectHeredocBody(lines, i+1, markers)
			if runsShell(segments) {
				s.scan(body.text, body.line)
			}
			i = next
		}
	}
}

// runsShell reports whether a logical line hands its heredoc body to a shell:
// either directly (`bash <<EOF`) or through a pipeline (`cat <<EOF | bash`).
// The body of any other heredoc (`python3 - <<PY`, `cat > file <<EOF`) is data,
// not commands.
func runsShell(segments [][]string) bool {
	for _, words := range segments {
		rest, _ := unwrapCommand(words)
		for len(rest) > 0 {
			if isShellName(rest[0]) {
				return true
			}
			// Peel launcher words so `cat <<EOF | sudo bash` still counts.
			if !isCommandPrefixWord(rest[0]) {
				break
			}
			rest = rest[1:]
			for len(rest) > 0 && strings.HasPrefix(rest[0], "-") {
				rest = rest[1:]
			}
		}
	}
	return false
}

func (s *shellScanner) visitSegment(words []string, line int, raw string) {
	if len(words) == 0 {
		return
	}
	// A nested interpreter's own flags may precede `-c` (`bash -eu -c '...'`),
	// so the payload is the word after the first `-c`-style flag of that
	// interpreter rather than the word immediately after the interpreter name.
	for i := 0; i < len(words); i++ {
		if !isShellName(words[i]) {
			continue
		}
		for j := i + 1; j < len(words) && strings.HasPrefix(words[j], "-"); j++ {
			if isDashCFlag(words[j]) {
				if j+1 < len(words) {
					s.scan(words[j+1], line)
				}
				break
			}
		}
	}
	s.visit(shellCommand{words: words, line: line, raw: raw})
}

type shellLine struct {
	text string
	line int
}

// logicalShellLines joins backslash continuations and records the source line
// each logical line started on.
func logicalShellLines(text string, startLine int) []shellLine {
	raw := strings.Split(text, "\n")
	out := make([]shellLine, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		start := startLine + i
		buffer := raw[i]
		for i+1 < len(raw) && endsWithContinuation(buffer) {
			buffer = strings.TrimRight(buffer, " \t\r")
			buffer = buffer[:len(buffer)-1] + " " + strings.TrimLeft(raw[i+1], " \t")
			i++
		}
		out = append(out, shellLine{text: buffer, line: start})
	}
	return out
}

func endsWithContinuation(line string) bool {
	trimmed := strings.TrimRight(line, " \t\r")
	return strings.HasSuffix(trimmed, "\\") && !strings.HasSuffix(trimmed, "\\\\")
}

// stripShellComment removes a trailing unquoted `#` comment from a logical
// line, so a flag that only appears inside a comment cannot satisfy a rule.
func stripShellComment(text string) string {
	single, double := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if single {
			if c == '\'' {
				single = false
			}
			continue
		}
		if double {
			switch c {
			case '\\':
				i++
			case '"':
				double = false
			}
			continue
		}
		switch c {
		case '\'':
			single = true
		case '"':
			double = true
		case '#':
			if i == 0 || isCommentBoundary(text[i-1]) {
				return text[:i]
			}
		}
	}
	return text
}

func isCommentBoundary(c byte) bool {
	switch c {
	case ' ', '\t', ';', '&', '|', '(', ')':
		return true
	default:
		return false
	}
}

// splitShellCode splits shell code into command segments at top-level
// separators and collects the payloads of command substitutions.
func splitShellCode(code string) ([][]string, []string) {
	tokenizer := &shellTokenizer{}
	for i := 0; i < len(code); {
		c := code[i]
		switch {
		case c == '\'':
			content, next := singleQuoted(code, i)
			tokenizer.startWord()
			tokenizer.word.WriteString(content)
			i = next
		case c == '"':
			content, substitutions, next := doubleQuoted(code, i)
			tokenizer.startWord()
			tokenizer.word.WriteString(content)
			tokenizer.substitutions = append(tokenizer.substitutions, substitutions...)
			i = next
		case c == '\\':
			tokenizer.startWord()
			if i+1 < len(code) {
				tokenizer.word.WriteByte(code[i+1])
			}
			i += 2
		case isShellSpace(c):
			tokenizer.endWord()
			i++
		case isShellSeparator(c):
			tokenizer.endWord()
			tokenizer.endSegment()
			i = separatorWidth(code, i)
		default:
			if payload, next, ok := captureSubstitution(code, i); ok {
				tokenizer.startWord()
				tokenizer.substitutions = append(tokenizer.substitutions, payload)
				i = next
				continue
			}
			tokenizer.startWord()
			tokenizer.word.WriteByte(c)
			i++
		}
	}
	tokenizer.endWord()
	tokenizer.endSegment()
	return tokenizer.segments, tokenizer.substitutions
}

type shellTokenizer struct {
	word          strings.Builder
	hasWord       bool
	segment       []string
	segments      [][]string
	substitutions []string
}

func isShellSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

func isShellSeparator(c byte) bool {
	return c == ';' || c == '&' || c == '|' || c == '(' || c == ')'
}

func (t *shellTokenizer) startWord() { t.hasWord = true }

func (t *shellTokenizer) endWord() {
	if !t.hasWord {
		return
	}
	value := t.word.String()
	t.word.Reset()
	t.hasWord = false
	if value == "" {
		return
	}
	t.segment = append(t.segment, value)
}

func (t *shellTokenizer) endSegment() {
	if len(t.segment) > 0 {
		t.segments = append(t.segments, t.segment)
		t.segment = nil
	}
}

// singleQuoted returns the literal content of a single-quoted string and the
// index just past its closing quote.
func singleQuoted(code string, start int) (string, int) {
	for i := start + 1; i < len(code); i++ {
		if code[i] == '\'' {
			return code[start+1 : i], i + 1
		}
	}
	return code[start+1:], len(code)
}

// doubleQuoted returns the content of a double-quoted string, the payloads of
// any command substitutions inside it, and the index past its closing quote.
func doubleQuoted(code string, start int) (string, []string, int) {
	var builder strings.Builder
	var substitutions []string
	for i := start + 1; i < len(code); {
		switch {
		case code[i] == '\\' && i+1 < len(code):
			builder.WriteByte(code[i+1])
			i += 2
		case code[i] == '"':
			return builder.String(), substitutions, i + 1
		default:
			if payload, next, ok := captureSubstitution(code, i); ok {
				substitutions = append(substitutions, payload)
				i = next
				continue
			}
			builder.WriteByte(code[i])
			i++
		}
	}
	return builder.String(), substitutions, len(code)
}

func skipQuoted(code string, index int) int {
	if code[index] == '\'' {
		_, next := singleQuoted(code, index)
		return next
	}
	_, _, next := doubleQuoted(code, index)
	return next
}

func separatorWidth(code string, index int) int {
	if index+1 < len(code) && code[index+1] == code[index] && (code[index] == '&' || code[index] == '|') {
		return index + 2
	}
	return index + 1
}

// captureSubstitution returns the payload of `$(...)`, `<(...)`, `>(...)` or a
// backtick substitution starting at index.
func captureSubstitution(code string, index int) (string, int, bool) {
	if strings.HasPrefix(code[index:], "$(") {
		return captureBalancedParens(code, index+2)
	}
	if (code[index] == '<' || code[index] == '>') && index+1 < len(code) && code[index+1] == '(' {
		return captureBalancedParens(code, index+2)
	}
	if code[index] == '`' {
		for i := index + 1; i < len(code); i++ {
			if code[i] == '\\' {
				i++
				continue
			}
			if code[i] == '`' {
				return code[index+1 : i], i + 1, true
			}
		}
		return code[index+1:], len(code), true
	}
	return "", index, false
}

func captureBalancedParens(code string, start int) (string, int, bool) {
	depth := 1
	for i := start; i < len(code); i++ {
		switch code[i] {
		case '\'':
			i = skipQuoted(code, i) - 1
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return code[start:i], i + 1, true
			}
		}
	}
	return code[start:], len(code), true
}

func isShellName(word string) bool {
	switch commandBase(word) {
	case "bash", "sh", "zsh", "dash", "ksh", "ash":
		return true
	default:
		return false
	}
}

func isDashCFlag(word string) bool {
	return len(word) >= 2 && word[0] == '-' && word[1] != '-' && strings.ContainsRune(word[1:], 'c')
}

// findHeredocMarkers lists the heredoc terminators introduced on a line.
func findHeredocMarkers(code string) []string {
	var markers []string
	for i := 0; i < len(code); {
		if code[i] == '\'' || code[i] == '"' {
			i = skipQuoted(code, i)
			continue
		}
		if code[i] == '<' && i+1 < len(code) && code[i+1] == '<' {
			marker, next := readHeredocMarker(code, i+2)
			if marker != "" {
				markers = append(markers, marker)
			}
			i = next
			continue
		}
		i++
	}
	return markers
}

func readHeredocMarker(code string, start int) (string, int) {
	i := start
	if i < len(code) && code[i] == '-' {
		i++
	}
	for i < len(code) && (code[i] == ' ' || code[i] == '\t') {
		i++
	}
	quote := byte(0)
	if i < len(code) && (code[i] == '\'' || code[i] == '"') {
		quote = code[i]
		i++
	}
	begin := i
	for i < len(code) && !isHeredocDelimiter(code[i]) && code[i] != quote {
		i++
	}
	marker := code[begin:i]
	if quote != 0 && i < len(code) {
		i++
	}
	return marker, i
}

func isHeredocDelimiter(c byte) bool {
	switch c {
	case ' ', '\t', ';', '&', '|', '(', ')', '<', '>', '\n', '\r':
		return true
	default:
		return false
	}
}

func collectHeredocBody(lines []shellLine, start int, markers []string) (shellLine, int) {
	var body []string
	index := start
	line := start
	if start < len(lines) {
		line = lines[start].line
	}
	for _, marker := range markers {
		for index < len(lines) {
			if strings.TrimSpace(lines[index].text) == marker {
				index++
				break
			}
			body = append(body, lines[index].text)
			index++
		}
	}
	return shellLine{text: strings.Join(body, "\n"), line: line}, index
}
