package localcloudfront

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Geo restriction.
//
// "You can use CloudFront geo restriction ... to prevent users in specific
// geographic locations from accessing content that you're distributing through
// a CloudFront web distribution." "If CloudFront can't determine a user's
// location, CloudFront serves the content."
// A blocked viewer receives "HTTP status code 403 (Forbidden)", and the
// distribution's custom error response for 403 applies with the error caching
// minimum.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html

// GeoRestriction is DistributionConfig Restrictions.GeoRestriction.
type GeoRestriction struct {
	// Type is none, whitelist or blacklist. CloudFront's API also accepts the
	// allowlist/denylist spellings; they are normalized.
	Type      string   `json:"type"`
	Locations []string `json:"locations,omitempty"`
}

// parseRestrictions reads Restrictions. Only GeoRestriction is understood;
// every other member is refused by name.
func parseRestrictions(raw json.RawMessage, _ string) (*GeoRestriction, []string) {
	if isEmptyValue(raw) {
		return nil, nil
	}
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, []string{"distribution: Restrictions is not an object"}
	}
	var restriction *GeoRestriction
	var refusals []string
	for _, name := range sortedKeys(properties) {
		if name != "GeoRestriction" {
			refusals = append(refusals, fmt.Sprintf(
				"distribution: Restrictions.%s is not understood; only GeoRestriction is emulated locally", name))
			continue
		}
		parsed, problem := parseGeoRestriction(properties[name])
		if problem != "" {
			refusals = append(refusals, "distribution: "+problem)
			continue
		}
		restriction = parsed
	}
	return restriction, refusals
}

//nolint:gocyclo // one branch per restriction type and location
func parseGeoRestriction(raw json.RawMessage) (*GeoRestriction, string) {
	fields, err := decodeObject(raw)
	if err != nil {
		return nil, "Restrictions.GeoRestriction is not an object"
	}
	restriction := &GeoRestriction{}
	for _, name := range sortedKeys(fields) {
		switch name {
		case "RestrictionType":
			if err := json.Unmarshal(fields[name], &restriction.Type); err != nil {
				return nil, "Restrictions.GeoRestriction.RestrictionType is not a string"
			}
		case "Locations":
			var locations []string
			if err := json.Unmarshal(fields[name], &locations); err == nil {
				restriction.Locations = locations
				continue
			}
			items, problem := unwrapItems(fields[name], "Locations")
			if problem != "" {
				return nil, "Restrictions.GeoRestriction." + problem
			}
			for _, item := range items {
				var location string
				if err := json.Unmarshal(item, &location); err != nil {
					return nil, "Restrictions.GeoRestriction.Locations entry is not a string"
				}
				restriction.Locations = append(restriction.Locations, location)
			}
		default:
			return nil, fmt.Sprintf("Restrictions.GeoRestriction property %q is not understood", name)
		}
	}
	switch strings.ToLower(restriction.Type) {
	case valueNone:
		restriction.Type = valueNone
		restriction.Locations = nil
	case valueWhitelist, "allowlist":
		restriction.Type = valueWhitelist
	case valueBlacklist, "denylist":
		restriction.Type = valueBlacklist
	default:
		return nil, fmt.Sprintf("Restrictions.GeoRestriction.RestrictionType %q is not none, whitelist or blacklist", restriction.Type)
	}
	if restriction.Type != valueNone && len(restriction.Locations) == 0 {
		return nil, fmt.Sprintf("Restrictions.GeoRestriction is a %s with no Locations", restriction.Type)
	}
	for position, location := range restriction.Locations {
		if !isCountryCode(location) {
			return nil, fmt.Sprintf(
				"Restrictions.GeoRestriction.Locations[%d] %q is not an ISO 3166-1 alpha-2 code in upper case", position, location)
		}
	}
	return restriction, ""
}

// isCountryCode reports whether the value is two upper-case ASCII letters.
// CloudFront documents "ISO 3166-1 alpha-2 uppercase codes".
func isCountryCode(value string) bool {
	if len(value) != 2 {
		return false
	}
	for _, r := range value {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// Blocks reports whether a resolved viewer country is denied by the
// restriction. An empty country is an undetermined location, which CloudFront
// serves.
func (r *GeoRestriction) Blocks(country string) bool {
	if r == nil || r.Type == valueNone || country == "" {
		return false
	}
	listed := false
	for _, location := range r.Locations {
		if strings.EqualFold(location, country) {
			listed = true
			break
		}
	}
	switch r.Type {
	case valueWhitelist:
		return !listed
	case valueBlacklist:
		return listed
	default:
		return false
	}
}
