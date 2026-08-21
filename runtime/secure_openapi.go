package apptheory

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// OpenAPIAuthSchemes binds secure posture classes to document-level scheme names.
type OpenAPIAuthSchemes struct {
	Authenticated []string `json:"authenticated"`
	InternalOnly  []string `json:"internal_only"`
}

// SecureOpenAPISpec describes an exact HTTP projection for a SecureApp.
type SecureOpenAPISpec struct {
	Title           string                    `json:"title"`
	Version         string                    `json:"version"`
	Routes          []OpenAPIRouteSpec        `json:"routes"`
	SecuritySchemes map[string]map[string]any `json:"security_schemes"`
	AuthSchemes     OpenAPIAuthSchemes        `json:"auth_schemes"`
}

type secureOpenAPIJoin struct {
	route       SecureRoute
	description OpenAPIRouteSpec
	emittedPath string
	proxy       bool
	proxyName   string
}

// GenerateOpenAPI returns the deterministic secure-v1 OpenAPI document bound to this app's routes.
func (a *SecureApp) GenerateOpenAPI(spec SecureOpenAPISpec) (map[string]any, error) {
	if a == nil || a.core == nil {
		return nil, errors.New("apptheory: secure app is nil")
	}
	registered, err := secureHTTPRouteSet(a.Routes())
	if err != nil {
		return nil, err
	}
	described, order, err := secureOpenAPIDescriptions(spec.Routes)
	if err != nil {
		return nil, err
	}
	if validationErr := secureValidateExactRouteSet(registered, described); validationErr != nil {
		return nil, validationErr
	}
	schemes, authenticatedSchemes, internalSchemes, err := secureOpenAPISchemes(spec)
	if err != nil {
		return nil, err
	}
	joins, legacyRoutes, err := secureOpenAPIJoins(registered, described, order, authenticatedSchemes, internalSchemes)
	if err != nil {
		return nil, err
	}
	doc, err := GenerateOpenAPI(OpenAPISpec{Title: spec.Title, Version: spec.Version, Routes: legacyRoutes})
	if err != nil {
		return nil, err
	}
	if err := secureDecorateOpenAPI(doc, schemes, joins, authenticatedSchemes, internalSchemes); err != nil {
		return nil, err
	}
	return doc, nil
}

func secureHTTPRouteSet(routes []SecureRoute) (map[string]SecureRoute, error) {
	registered := map[string]SecureRoute{}
	for _, route := range routes {
		if route.Surface != SecureRouteHTTP {
			continue
		}
		key, _, err := canonicalRouteKey(route.Method, route.Path)
		if err != nil {
			return nil, err
		}
		registered[key] = route
	}
	return registered, nil
}

func secureOpenAPIDescriptions(routes []OpenAPIRouteSpec) (map[string]OpenAPIRouteSpec, []string, error) {
	described := map[string]OpenAPIRouteSpec{}
	order := make([]string, 0, len(routes))
	for _, description := range routes {
		key, path, err := canonicalRouteKey(description.Method, description.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("apptheory: secure openapi route: %w", err)
		}
		if _, exists := described[key]; exists {
			return nil, nil, fmt.Errorf("apptheory: secure openapi route %s is duplicated", key)
		}
		description.Method = strings.TrimSpace(strings.ToUpper(description.Method))
		description.Path = path
		described[key] = description
		order = append(order, key)
	}
	return described, order, nil
}

func secureValidateExactRouteSet(registered map[string]SecureRoute, described map[string]OpenAPIRouteSpec) error {
	registeredKeys := make([]string, 0, len(registered))
	for key := range registered {
		registeredKeys = append(registeredKeys, key)
	}
	sort.Strings(registeredKeys)
	for _, key := range registeredKeys {
		if _, ok := described[key]; !ok {
			return fmt.Errorf("apptheory: secure openapi missing route %s", key)
		}
	}
	describedKeys := make([]string, 0, len(described))
	for key := range described {
		describedKeys = append(describedKeys, key)
	}
	sort.Strings(describedKeys)
	for _, key := range describedKeys {
		if _, ok := registered[key]; !ok {
			return fmt.Errorf("apptheory: secure openapi extra route %s", key)
		}
	}
	return nil
}

func secureOpenAPISchemes(spec SecureOpenAPISpec) (map[string]any, []string, []string, error) {
	schemes, err := secureCanonicalSecuritySchemes(spec.SecuritySchemes)
	if err != nil {
		return nil, nil, nil, err
	}
	authenticatedSchemes := normalizeScopeList(spec.AuthSchemes.Authenticated)
	internalSchemes := normalizeScopeList(spec.AuthSchemes.InternalOnly)
	for _, name := range append(append([]string(nil), authenticatedSchemes...), internalSchemes...) {
		if _, ok := schemes[name]; !ok {
			return nil, nil, nil, fmt.Errorf("apptheory: secure openapi auth scheme %s is not defined", name)
		}
	}
	return schemes, authenticatedSchemes, internalSchemes, nil
}

func secureOpenAPIJoins(registered map[string]SecureRoute, described map[string]OpenAPIRouteSpec, order, authenticatedSchemes, internalSchemes []string) ([]secureOpenAPIJoin, []OpenAPIRouteSpec, error) {
	joins := make([]secureOpenAPIJoin, 0, len(order))
	emitted := map[string]struct{}{}
	legacyRoutes := make([]OpenAPIRouteSpec, 0, len(order))
	for _, key := range order {
		route := registered[key]
		description := described[key]
		proxy, proxyName, emittedPath := secureProxyPath(description.Path)
		emittedKey := strings.ToUpper(description.Method) + " " + emittedPath
		if _, exists := emitted[emittedKey]; exists {
			return nil, nil, fmt.Errorf("apptheory: secure openapi emitted route %s collides", emittedKey)
		}
		emitted[emittedKey] = struct{}{}
		if proxy {
			description.Path = emittedPath
			description.Request.Fields = secureEnsureProxyField(description.Request.Fields, proxyName)
		}
		if route.Posture == AuthPostureOptional || route.Posture == AuthPostureAuthenticated || route.Posture == AuthPostureAuthenticatedAnyOf {
			if len(authenticatedSchemes) == 0 {
				return nil, nil, errors.New("apptheory: secure openapi authenticated scheme binding is required")
			}
		}
		if route.Posture == AuthPostureInternalOnly && len(internalSchemes) == 0 {
			return nil, nil, errors.New("apptheory: secure openapi internal scheme binding is required")
		}
		joins = append(joins, secureOpenAPIJoin{route: route, description: description, emittedPath: emittedPath, proxy: proxy, proxyName: proxyName})
		legacyRoutes = append(legacyRoutes, description)
	}
	return joins, legacyRoutes, nil
}

func secureDecorateOpenAPI(doc map[string]any, schemes map[string]any, joins []secureOpenAPIJoin, authenticatedSchemes, internalSchemes []string) error {
	components, ok := doc["components"].(map[string]any)
	if !ok {
		return errors.New("apptheory: secure openapi components invariant")
	}
	components["securitySchemes"] = schemes
	doc["x-apptheory-contract-mode"] = "secure-v1"

	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		return errors.New("apptheory: secure openapi paths invariant")
	}
	for _, join := range joins {
		pathItem, pathOK := paths[join.emittedPath].(map[string]any)
		if !pathOK {
			return errors.New("apptheory: secure openapi path invariant")
		}
		operation, operationOK := pathItem[strings.ToLower(join.description.Method)].(map[string]any)
		if !operationOK {
			return errors.New("apptheory: secure openapi operation invariant")
		}
		operation["x-apptheory-auth-posture"] = string(join.route.Posture)
		if len(join.route.Scopes) > 0 {
			operation["x-apptheory-required-scopes"] = append([]string(nil), join.route.Scopes...)
		}
		if join.proxy {
			operation["x-apptheory-proxy"] = true
		}
		operation["security"] = secureOperationSecurity(join.route, authenticatedSchemes, internalSchemes)
	}
	return nil
}

// GenerateOpenAPIJSON returns the byte-stable canonical JSON encoding of secure OpenAPI generation.
func (a *SecureApp) GenerateOpenAPIJSON(spec SecureOpenAPISpec) ([]byte, error) {
	doc, err := a.GenerateOpenAPI(spec)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(doc); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func secureOperationSecurity(route SecureRoute, authenticated, internal []string) []any {
	out := []any{}
	appendSchemes := func(names []string, scopes []string) {
		for _, name := range names {
			out = append(out, map[string]any{name: append([]string{}, scopes...)})
		}
	}
	switch route.Posture {
	case AuthPosturePublic:
		return out
	case AuthPostureOptional:
		appendSchemes(authenticated, nil)
		return append(out, map[string]any{})
	case AuthPostureAuthenticated:
		appendSchemes(authenticated, route.Scopes)
	case AuthPostureAuthenticatedAnyOf:
		for _, name := range authenticated {
			for _, scope := range route.Scopes {
				out = append(out, map[string]any{name: []string{scope}})
			}
		}
	case AuthPostureInternalOnly:
		appendSchemes(internal, nil)
	}
	return out
}

func secureProxyPath(path string) (bool, string, string) {
	segments := splitPath(path)
	if len(segments) == 0 {
		return false, "", "/"
	}
	last := strings.TrimSpace(segments[len(segments)-1])
	if !strings.HasPrefix(last, "{") || !strings.HasSuffix(last, "+}") {
		return false, "", path
	}
	name := strings.TrimSpace(last[1 : len(last)-2])
	segments[len(segments)-1] = "{" + name + "}"
	return true, name, "/" + strings.Join(segments, "/")
}

func secureEnsureProxyField(fields []OpenAPIFieldSpec, name string) []OpenAPIFieldSpec {
	out := append([]OpenAPIFieldSpec(nil), fields...)
	for i := range out {
		if strings.EqualFold(strings.TrimSpace(out[i].Source), bindSourcePath) && strings.TrimSpace(out[i].Name) == name {
			out[i].Required = true
			return out
		}
	}
	return append(out, OpenAPIFieldSpec{Field: name, Source: bindSourcePath, Name: name, Type: openAPITypeString, Required: true})
}

func secureCanonicalSecuritySchemes(input map[string]map[string]any) (map[string]any, error) {
	out := make(map[string]any, len(input))
	seen := map[uintptr]bool{}
	for rawName, scheme := range input {
		name := strings.TrimSpace(rawName)
		if name == "" {
			return nil, errors.New("apptheory: secure openapi security scheme name is required")
		}
		if _, exists := out[name]; exists {
			return nil, fmt.Errorf("apptheory: secure openapi security scheme %s is duplicated", name)
		}
		value, err := secureCanonicalJSONValue(reflect.ValueOf(scheme), seen)
		if err != nil {
			return nil, fmt.Errorf("apptheory: secure openapi security scheme %s: %w", name, err)
		}
		out[name] = value
	}
	return out, nil
}

func secureCanonicalJSONValue(value reflect.Value, seen map[uintptr]bool) (any, error) {
	if !value.IsValid() {
		return nil, nil
	}
	if value.Kind() == reflect.Interface {
		if value.IsNil() {
			return nil, nil
		}
		return secureCanonicalJSONValue(value.Elem(), seen)
	}
	switch value.Kind() {
	case reflect.Bool:
		return value.Bool(), nil
	case reflect.String:
		return value.String(), nil
	case reflect.Map:
		return secureCanonicalJSONObject(value, seen)
	case reflect.Slice, reflect.Array:
		return secureCanonicalJSONArray(value, seen)
	default:
		return nil, fmt.Errorf("value type %s is not allowed", value.Kind())
	}
}

func secureCanonicalJSONObject(value reflect.Value, seen map[uintptr]bool) (map[string]any, error) {
	if value.Type().Key().Kind() != reflect.String {
		return nil, errors.New("object keys must be strings")
	}
	ptr := value.Pointer()
	if ptr != 0 && seen[ptr] {
		return nil, errors.New("cyclic value is not allowed")
	}
	if ptr != 0 {
		seen[ptr] = true
		defer delete(seen, ptr)
	}
	out := map[string]any{}
	iter := value.MapRange()
	for iter.Next() {
		item, err := secureCanonicalJSONValue(iter.Value(), seen)
		if err != nil {
			return nil, err
		}
		out[iter.Key().String()] = item
	}
	return out, nil
}

func secureCanonicalJSONArray(value reflect.Value, seen map[uintptr]bool) ([]any, error) {
	ptr := uintptr(0)
	if value.Kind() == reflect.Slice && !value.IsNil() {
		ptr = value.Pointer()
	}
	if ptr != 0 && seen[ptr] {
		return nil, errors.New("cyclic value is not allowed")
	}
	if ptr != 0 {
		seen[ptr] = true
		defer delete(seen, ptr)
	}
	out := make([]any, value.Len())
	for i := 0; i < value.Len(); i++ {
		item, err := secureCanonicalJSONValue(value.Index(i), seen)
		if err != nil {
			return nil, err
		}
		out[i] = item
	}
	return out, nil
}
