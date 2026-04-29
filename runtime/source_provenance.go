package apptheory

import (
	"net/netip"
	"strings"
)

const (
	sourceProvenanceProviderAPIGatewayV2  = "apigw-v2"
	sourceProvenanceProviderLambdaURL     = "lambda-url"
	sourceProvenanceProviderAPIGatewayV1  = "apigw-v1"
	sourceProvenanceProviderUnknown       = "unknown"
	sourceProvenanceSourceProviderContext = "provider_request_context"
	sourceProvenanceSourceUnknown         = "unknown"
)

// SourceProvenance describes provider-derived HTTP source metadata.
//
// The value is derived only from trusted runtime provider context fields, such as
// API Gateway requestContext sourceIp values. It does not parse or trust
// Forwarded, X-Forwarded-For, or other client-controlled forwarding headers.
type SourceProvenance struct {
	SourceIP string `json:"source_ip"`
	Provider string `json:"provider"`
	Source   string `json:"source"`
	Valid    bool   `json:"valid"`
}

func unknownSourceProvenance() SourceProvenance {
	return SourceProvenance{
		Provider: sourceProvenanceProviderUnknown,
		Source:   sourceProvenanceSourceUnknown,
	}
}

func sourceProvenanceFromProviderRequestContext(provider, sourceIP string) SourceProvenance {
	provider = strings.TrimSpace(provider)
	if !knownSourceProvenanceProvider(provider) {
		return unknownSourceProvenance()
	}

	addr, err := netip.ParseAddr(strings.TrimSpace(sourceIP))
	if err != nil {
		return unknownSourceProvenance()
	}

	return SourceProvenance{
		SourceIP: addr.String(),
		Provider: provider,
		Source:   sourceProvenanceSourceProviderContext,
		Valid:    true,
	}
}

func normalizeSourceProvenance(in SourceProvenance) SourceProvenance {
	if !in.Valid {
		return unknownSourceProvenance()
	}

	provider := strings.TrimSpace(in.Provider)
	if !knownSourceProvenanceProvider(provider) {
		return unknownSourceProvenance()
	}

	source := strings.TrimSpace(in.Source)
	if source != sourceProvenanceSourceProviderContext {
		return unknownSourceProvenance()
	}

	addr, err := netip.ParseAddr(strings.TrimSpace(in.SourceIP))
	if err != nil {
		return unknownSourceProvenance()
	}

	return SourceProvenance{
		SourceIP: addr.String(),
		Provider: provider,
		Source:   source,
		Valid:    true,
	}
}

func knownSourceProvenanceProvider(provider string) bool {
	switch provider {
	case sourceProvenanceProviderAPIGatewayV2,
		sourceProvenanceProviderLambdaURL,
		sourceProvenanceProviderAPIGatewayV1:
		return true
	default:
		return false
	}
}
