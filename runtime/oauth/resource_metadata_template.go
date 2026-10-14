package oauth

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// resourceMetadataURLTemplateMaxParamBytes bounds a single interpolated route
// parameter value, so one request cannot inflate the advertised challenge.
const resourceMetadataURLTemplateMaxParamBytes = 128

var (
	// Placeholder names are deliberately narrow: they name route parameters, not
	// free-form expressions.
	resourceMetadataURLTemplateParamPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

	// ResourceMetadataURLTemplateParamValues are the only bytes that may be
	// interpolated into the advertised challenge URL. The alphabet is the RFC
	// 3986 unreserved set plus the three path-safe punctuation bytes RFC 3986
	// allows unescaped; it is deliberately narrower than the router's own
	// segment rule, so the advertised URL cannot differ from the matched route
	// through case folding, percent-decoding, or separator handling in a proxy,
	// CDN, or client.
	resourceMetadataURLTemplateParamValuePattern = regexp.MustCompile(
		fmt.Sprintf(`^[a-z0-9._~-]{1,%d}$`, resourceMetadataURLTemplateMaxParamBytes),
	)
)

// resourceMetadataURLTemplate is a compiled `{param}` protected-resource
// metadata URL template. Compilation validates the template once, at
// registration, so request time only validates and interpolates the matched
// route parameters.
type resourceMetadataURLTemplate struct {
	base   url.URL
	params []string
}

// compileResourceMetadataURLTemplate validates a template and records the route
// parameters it interpolates.
//
// A template is valid when it is an absolute HTTPS URL with no userinfo, query,
// fragment, or percent-escape, and every `{param}` placeholder sits in the URL
// path and names a lower-case route parameter. Placeholders outside the path
// are refused, because interpolating one would let a request steer the
// advertised authority rather than only its path suffix.
func compileResourceMetadataURLTemplate(raw string) (*resourceMetadataURLTemplate, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: template is empty", ErrInvalidURL)
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("%w: template is not an absolute URL", ErrInvalidURL)
	}
	switch {
	case !strings.EqualFold(u.Scheme, httpsScheme):
		return nil, fmt.Errorf("%w: template must be an absolute HTTPS URL", ErrInvalidURL)
	case u.Host == "" || u.Hostname() == "":
		return nil, fmt.Errorf("%w: template must include a host", ErrInvalidURL)
	case u.User != nil:
		return nil, fmt.Errorf("%w: template must not include userinfo", ErrInvalidURL)
	case u.RawQuery != "" || u.ForceQuery:
		return nil, fmt.Errorf("%w: template must not include a query", ErrInvalidURL)
	case u.Fragment != "" || u.RawFragment != "":
		return nil, fmt.Errorf("%w: template must not include a fragment", ErrInvalidURL)
	case strings.ContainsAny(u.Host, "{}"):
		return nil, fmt.Errorf("%w: template placeholders must appear in the path, not the authority", ErrInvalidURL)
	}

	rawPath := u.RawPath
	if rawPath == "" {
		rawPath = u.Path
	}
	if strings.Contains(rawPath, "%") {
		return nil, fmt.Errorf("%w: template must not percent-encode its path", ErrInvalidURL)
	}

	params, err := resourceMetadataURLTemplateParams(u.Path)
	if err != nil {
		return nil, err
	}

	compiled := &resourceMetadataURLTemplate{base: *u, params: params}
	compiled.base.RawPath = ""
	return compiled, nil
}

// resourceMetadataURLTemplateParams returns the distinct placeholder names in
// path order, refusing anything that is not a well-formed `{param}`.
func resourceMetadataURLTemplateParams(rawPath string) ([]string, error) {
	params := make([]string, 0, 2)
	seen := make(map[string]bool, 2)
	for i := 0; i < len(rawPath); {
		switch rawPath[i] {
		case '{':
			end := strings.IndexByte(rawPath[i:], '}')
			if end < 0 {
				return nil, fmt.Errorf("%w: template placeholder is unterminated", ErrInvalidURL)
			}
			name := rawPath[i+1 : i+end]
			if !resourceMetadataURLTemplateParamPattern.MatchString(name) {
				return nil, fmt.Errorf("%w: template placeholder %q is not a route parameter name", ErrInvalidURL, name)
			}
			if !seen[name] {
				seen[name] = true
				params = append(params, name)
			}
			i += end + 1
		case '}':
			return nil, fmt.Errorf("%w: template has an unmatched %q", ErrInvalidURL, "}")
		default:
			i++
		}
	}
	return params, nil
}

// resolve interpolates the matched route parameters into the template.
//
// Every placeholder must be present in the matched route and its value must
// satisfy IsSafeResourceMetadataURLTemplateValue; the resolved URL is then
// rebuilt and checked to be free of leftover placeholders. Any failure returns
// ok=false so the caller emits the bare `Bearer` challenge instead of a literal
// placeholder or a partially resolved URL.
func (t *resourceMetadataURLTemplate) resolve(params map[string]string) (string, bool) {
	if t == nil {
		return "", false
	}
	resolvedPath := t.base.Path
	for _, name := range t.params {
		value := params[name]
		if !isSafeResourceMetadataURLTemplateValue(value) {
			return "", false
		}
		resolvedPath = strings.ReplaceAll(resolvedPath, "{"+name+"}", value)
	}
	if strings.ContainsAny(resolvedPath, "{}") {
		return "", false
	}

	resolved := t.base
	resolved.Path = resolvedPath
	resolved.RawPath = ""
	return resolved.String(), true
}

// isSafeResourceMetadataURLTemplateValue reports whether a route parameter value
// may be interpolated into the advertised challenge URL.
//
// The pinned rule accepts 1..128 bytes drawn from `[a-z0-9._~-]`, excluding the
// dot segments `.` and `..`. Everything else — empty, `/`-containing,
// percent-encoded, upper-case, whitespace, control, backslash, or non-ASCII —
// is refused, and the caller then emits the bare `Bearer` challenge.
func isSafeResourceMetadataURLTemplateValue(value string) bool {
	if value == "." || value == ".." {
		return false
	}
	return resourceMetadataURLTemplateParamValuePattern.MatchString(value)
}
