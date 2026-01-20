package naming

import (
	"regexp"
	"strings"
)

var (
	nonAlnum  = regexp.MustCompile(`[^a-z0-9-]+`)
	multiDash = regexp.MustCompile(`-+`)
)

func sanitizePart(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	value = strings.ReplaceAll(value, "_", "-")
	value = strings.ReplaceAll(value, " ", "-")
	value = nonAlnum.ReplaceAllString(value, "-")
	value = multiDash.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	return value
}

// NormalizeStage maps stage aliases to canonical values.
//
// Canonical stages are lowercased and safe for typical resource naming schemes.
func NormalizeStage(stage string) string {
	stage = strings.ToLower(strings.TrimSpace(stage))
	switch stage {
	case "prod", "production", "live":
		return "live"
	case "dev", "development":
		return "dev"
	case "stg", "stage", "staging":
		return "stage"
	case "test", "testing":
		return "test"
	case "local":
		return "local"
	default:
		return sanitizePart(stage)
	}
}

// BaseName returns a deterministic base name:
// - <app>-<stage>
// - <app>-<tenant>-<stage> (when tenant is provided)
func BaseName(appName, stage, tenant string) string {
	app := sanitizePart(appName)
	tenant = sanitizePart(tenant)
	stage = NormalizeStage(stage)

	parts := []string{app}
	if tenant != "" {
		parts = append(parts, tenant)
	}
	if stage != "" {
		parts = append(parts, stage)
	}
	return strings.Join(parts, "-")
}

// ResourceName returns a deterministic resource name:
// - <app>-<resource>-<stage>
// - <app>-<tenant>-<resource>-<stage> (when tenant is provided)
func ResourceName(appName, resource, stage, tenant string) string {
	app := sanitizePart(appName)
	tenant = sanitizePart(tenant)
	resource = sanitizePart(resource)
	stage = NormalizeStage(stage)

	parts := []string{app}
	if tenant != "" {
		parts = append(parts, tenant)
	}
	if resource != "" {
		parts = append(parts, resource)
	}
	if stage != "" {
		parts = append(parts, stage)
	}
	return strings.Join(parts, "-")
}
