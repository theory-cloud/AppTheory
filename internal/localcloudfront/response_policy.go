package localcloudfront

import (
	"encoding/json"
	"fmt"
	"strings"
)

func parseResponseHeadersPolicyConfig(raw json.RawMessage, policy *Policy) (*ResponseHeadersPolicy, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	response := &ResponseHeadersPolicy{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case propertyName, propertyComment:
			policy.Reported = append(policy.Reported, reportProperty("response headers policy", key))
		case "CorsConfig":
			cors, err := parseCORSConfig(value)
			if err != nil {
				return nil, fmt.Errorf("CorsConfig: %w", err)
			}
			response.CORS = cors
		case "CustomHeadersConfig":
			headers, err := parseCustomHeaders(value)
			if err != nil {
				return nil, fmt.Errorf("CustomHeadersConfig: %w", err)
			}
			response.Custom = headers
		case "RemoveHeadersConfig":
			headers, err := parseRemoveHeaders(value)
			if err != nil {
				return nil, fmt.Errorf("RemoveHeadersConfig: %w", err)
			}
			response.Remove = headers
		case "SecurityHeadersConfig":
			security, err := parseSecurityHeaders(value)
			if err != nil {
				return nil, fmt.Errorf("SecurityHeadersConfig: %w", err)
			}
			response.Security = security
		case "ServerTimingHeadersConfig":
			policy.Reported = append(policy.Reported, reportProperty("response headers policy", key))
		default:
			if _, known := responseHeadersPolicyPropertyInventory[key]; !known {
				policy.Refusals = append(policy.Refusals,
					fmt.Sprintf("ResponseHeadersPolicyConfig property %q is not understood", key))
			}
		}
	}
	return response, nil
}

func parseCORSConfig(raw json.RawMessage) (*CORSConfig, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	cors := &CORSConfig{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "AccessControlAllowCredentials":
			if decodeErr := json.Unmarshal(value, &cors.AllowCredentials); decodeErr != nil {
				return nil, decodeErr
			}
		case "AccessControlAllowHeaders":
			cors.AllowHeaders, err = parseStringItems(value)
		case "AccessControlAllowMethods":
			cors.AllowMethods, err = parseStringItems(value)
		case "AccessControlAllowOrigins":
			cors.AllowOrigins, err = parseStringItems(value)
		case "AccessControlExposeHeaders":
			cors.ExposeHeaders, err = parseStringItems(value)
		case "AccessControlMaxAgeSec":
			seconds, decodeErr := decodeIntPointer(value)
			if decodeErr != nil {
				return nil, decodeErr
			}
			cors.MaxAgeSeconds = seconds
		case "OriginOverride":
			if decodeErr := json.Unmarshal(value, &cors.OriginOverride); decodeErr != nil {
				return nil, decodeErr
			}
		default:
			if _, known := corsConfigPropertyInventory[key]; !known {
				return nil, fmt.Errorf("CorsConfig property %q is not understood", key)
			}
		}
		if err != nil {
			return nil, err
		}
	}
	return cors, nil
}

//nolint:gocyclo // the switch names each security header
func parseSecurityHeaders(raw json.RawMessage) (*SecurityHeaders, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	security := &SecurityHeaders{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "ContentSecurityPolicy":
			csp, err := parseOverrideString(value, "ContentSecurityPolicy", "ContentSecurityPolicy")
			if err != nil {
				return nil, err
			}
			security.ContentSecurityPolicy = csp
		case "ContentTypeOptions":
			config, err := parseContentTypeOptions(value)
			if err != nil {
				return nil, err
			}
			security.ContentTypeOptions = config
		case "FrameOptions":
			frame, err := parseFrameOptions(value)
			if err != nil {
				return nil, err
			}
			security.FrameOptions = frame
		case "ReferrerPolicy":
			referrer, err := parseReferrerPolicy(value)
			if err != nil {
				return nil, err
			}
			security.ReferrerPolicy = referrer
		case "StrictTransportSecurity":
			hsts, err := parseStrictTransportSecurity(value)
			if err != nil {
				return nil, err
			}
			security.StrictTransportSecurity = hsts
		case "XSSProtection":
			xss, err := parseXSSProtection(value)
			if err != nil {
				return nil, err
			}
			security.XSSProtection = xss
		default:
			if _, known := securityHeadersPropertyInventory[key]; !known {
				return nil, fmt.Errorf("SecurityHeadersConfig property %q is not understood", key)
			}
		}
	}
	return security, nil
}

func parseContentTypeOptions(raw json.RawMessage) (*ContentTypeOptions, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	config := &ContentTypeOptions{}
	for _, key := range sortedKeys(properties) {
		if key != propertyOverride {
			return nil, fmt.Errorf("ContentTypeOptions property %q is not understood", key)
		}
		if err := json.Unmarshal(properties[key], &config.Override); err != nil {
			return nil, err
		}
	}
	return config, nil
}

func parseOverrideString(raw json.RawMessage, context, valueKey string) (*ContentSecurityPolicy, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	config := &ContentSecurityPolicy{}
	for _, key := range sortedKeys(properties) {
		switch key {
		case valueKey:
			if err := json.Unmarshal(properties[key], &config.Value); err != nil {
				return nil, err
			}
		case propertyOverride:
			if err := json.Unmarshal(properties[key], &config.Override); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("%s property %q is not understood", context, key)
		}
	}
	return config, nil
}

func parseFrameOptions(raw json.RawMessage) (*FrameOptions, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	config := &FrameOptions{}
	for _, key := range sortedKeys(properties) {
		switch key {
		case "FrameOption":
			if err := json.Unmarshal(properties[key], &config.Value); err != nil {
				return nil, err
			}
		case propertyOverride:
			if err := json.Unmarshal(properties[key], &config.Override); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("FrameOptions property %q is not understood", key)
		}
	}
	if config.Value != "DENY" && config.Value != "SAMEORIGIN" {
		return nil, fmt.Errorf("FrameOption %q is not DENY or SAMEORIGIN", config.Value)
	}
	return config, nil
}

func parseReferrerPolicy(raw json.RawMessage) (*ReferrerPolicy, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	config := &ReferrerPolicy{}
	for _, key := range sortedKeys(properties) {
		switch key {
		case "ReferrerPolicy":
			if err := json.Unmarshal(properties[key], &config.Value); err != nil {
				return nil, err
			}
		case propertyOverride:
			if err := json.Unmarshal(properties[key], &config.Override); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("ReferrerPolicy property %q is not understood", key)
		}
	}
	return config, nil
}

//nolint:dupl // the case labels are the CloudFront HSTS fields
func parseStrictTransportSecurity(raw json.RawMessage) (*StrictTransportSecurity, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	config := &StrictTransportSecurity{}
	for _, key := range sortedKeys(properties) {
		switch key {
		case "AccessControlMaxAgeSec":
			if err := json.Unmarshal(properties[key], &config.MaxAgeSeconds); err != nil {
				return nil, err
			}
		case "IncludeSubdomains":
			if err := json.Unmarshal(properties[key], &config.IncludeSubdomains); err != nil {
				return nil, err
			}
		case "Preload":
			if err := json.Unmarshal(properties[key], &config.Preload); err != nil {
				return nil, err
			}
		case propertyOverride:
			if err := json.Unmarshal(properties[key], &config.Override); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("StrictTransportSecurity property %q is not understood", key)
		}
	}
	return config, nil
}

//nolint:dupl // the case labels are the CloudFront X-XSS-Protection fields
func parseXSSProtection(raw json.RawMessage) (*XSSProtection, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	config := &XSSProtection{}
	for _, key := range sortedKeys(properties) {
		switch key {
		case "ModeBlock":
			if err := json.Unmarshal(properties[key], &config.ModeBlock); err != nil {
				return nil, err
			}
		case propertyOverride:
			if err := json.Unmarshal(properties[key], &config.Override); err != nil {
				return nil, err
			}
		case "Protection":
			if err := json.Unmarshal(properties[key], &config.Protection); err != nil {
				return nil, err
			}
		case "ReportUri":
			if err := json.Unmarshal(properties[key], &config.ReportURI); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("XSSProtection property %q is not understood", key)
		}
	}
	return config, nil
}

//nolint:gocyclo // the switch names each custom header field
func parseCustomHeaders(raw json.RawMessage) ([]CustomHeader, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	var items []json.RawMessage
	for _, key := range sortedKeys(properties) {
		switch key {
		case propertyItems:
			if err := json.Unmarshal(properties[key], &items); err != nil {
				return nil, err
			}
		case propertyQuantity:
			// CloudFormation includes Quantity beside Items; it is redundant.
		default:
			return nil, fmt.Errorf("CustomHeadersConfig property %q is not understood", key)
		}
	}
	headers := make([]CustomHeader, 0, len(items))
	for position, item := range items {
		fields, err := decodeObject(item)
		if err != nil {
			return nil, fmt.Errorf("items[%d]: %w", position, err)
		}
		header := CustomHeader{}
		for _, key := range sortedKeys(fields) {
			switch key {
			case "Header":
				if err := json.Unmarshal(fields[key], &header.Name); err != nil {
					return nil, err
				}
			case "Value":
				if err := json.Unmarshal(fields[key], &header.Value); err != nil {
					return nil, err
				}
			case propertyOverride:
				if err := json.Unmarshal(fields[key], &header.Override); err != nil {
					return nil, err
				}
			default:
				return nil, fmt.Errorf("custom header property %q is not understood", key)
			}
		}
		if header.Name == "" {
			return nil, fmt.Errorf("items[%d] has no header", position)
		}
		headers = append(headers, header)
	}
	return headers, nil
}

func parseRemoveHeaders(raw json.RawMessage) ([]string, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	var items []json.RawMessage
	for _, key := range sortedKeys(properties) {
		switch key {
		case propertyItems:
			if err := json.Unmarshal(properties[key], &items); err != nil {
				return nil, err
			}
		case propertyQuantity:
			// CloudFormation includes Quantity beside Items; it is redundant.
		default:
			return nil, fmt.Errorf("RemoveHeadersConfig property %q is not understood", key)
		}
	}
	headers := make([]string, 0, len(items))
	for position, item := range items {
		fields, err := decodeObject(item)
		if err != nil {
			return nil, fmt.Errorf("items[%d]: %w", position, err)
		}
		var name string
		for key, value := range fields {
			if key != "Header" {
				return nil, fmt.Errorf("remove header property %q is not understood", key)
			}
			if err := json.Unmarshal(value, &name); err != nil {
				return nil, err
			}
		}
		if name == "" {
			return nil, fmt.Errorf("items[%d] has no header", position)
		}
		headers = append(headers, strings.ToLower(name))
	}
	return headers, nil
}

func parseStringItems(raw json.RawMessage) ([]string, error) {
	var direct []string
	if err := json.Unmarshal(raw, &direct); err == nil {
		return direct, nil
	}
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	var items []string
	for key, value := range properties {
		if key != propertyItems && key != propertyQuantity {
			return nil, fmt.Errorf("list property %q is not understood", key)
		}
		if key == propertyItems {
			if err := json.Unmarshal(value, &items); err != nil {
				return nil, err
			}
		}
	}
	return items, nil
}
