package localcloudfront

import "fmt"

// Disposition says what the gateway does with a template property.
type Disposition string

const (
	// Implemented means the property changes local routing, forwarding or
	// response content and the gateway applies it.
	Implemented Disposition = "implemented"
	// Reported means the property is recorded in the distribution's report but
	// is not emulated locally.
	Reported Disposition = "reported"
	// Refused means a distribution that carries a non-empty value for the
	// property is not served.
	Refused Disposition = "refused"
)

// CloudFormation property names that appear in several parsers and reason
// switches. They are wire names, not local identifiers.
const (
	propertyComment                   = "Comment"
	propertyDefaultTTL                = "DefaultTTL"
	propertyMaxTTL                    = "MaxTTL"
	propertyMinTTL                    = "MinTTL"
	propertyName                      = "Name"
	propertyKeyValueStoreAssociations = "KeyValueStoreAssociations"
	propertyOverride                  = "Override"
	propertyItems                     = "Items"
	propertyQuantity                  = "Quantity"
	headerCookie                      = "cookie"
	headerHost                        = "host"
	propertyCustomErrorResponses      = "CustomErrorResponses"
)

// distributionPropertyInventory classifies every DistributionConfig property the
// reader understands. A property absent from this table makes the distribution
// unservable instead of being silently ignored.
var distributionPropertyInventory = map[string]Disposition{
	"Aliases":                      Reported,
	"CacheBehaviors":               Implemented,
	propertyComment:                Reported,
	"ContinuousDeploymentPolicyId": Refused,
	propertyCustomErrorResponses:   Implemented,
	"DefaultCacheBehavior":         Implemented,
	"DefaultRootObject":            Implemented,
	"Enabled":                      Implemented,
	"HttpVersion":                  Reported,
	"IPV6Enabled":                  Reported,
	"Logging":                      Reported,
	"OriginGroups":                 Implemented,
	"Origins":                      Implemented,
	"PriceClass":                   Reported,
	"Restrictions":                 Refused,
	"Staging":                      Reported,
	"ViewerCertificate":            Reported,
	"WebACLId":                     Refused,
}

var behaviorPropertyInventory = map[string]Disposition{
	"AllowedMethods":             Implemented,
	"CachePolicyId":              Implemented,
	"CachedMethods":              Implemented,
	"Compress":                   Reported,
	propertyDefaultTTL:           Reported,
	"FieldLevelEncryptionId":     Refused,
	"ForwardedValues":            Refused,
	"FunctionAssociations":       Implemented,
	"GrpcConfig":                 Refused,
	"LambdaFunctionAssociations": Refused,
	propertyMaxTTL:               Reported,
	propertyMinTTL:               Reported,
	"OriginRequestPolicyId":      Implemented,
	"PathPattern":                Implemented,
	"RealtimeLogConfigArn":       Reported,
	"ResponseHeadersPolicyId":    Implemented,
	"SmoothStreaming":            Reported,
	"TargetOriginId":             Implemented,
	"TrustedKeyGroups":           Refused,
	"TrustedSigners":             Refused,
	"ViewerProtocolPolicy":       Reported,
}

var originPropertyInventory = map[string]Disposition{
	"ConnectionAttempts":    Reported,
	"ConnectionTimeout":     Reported,
	"CustomOriginConfig":    Implemented,
	"DomainName":            Implemented,
	"Id":                    Implemented,
	"OriginAccessControlId": Implemented,
	"OriginCustomHeaders":   Implemented,
	"OriginPath":            Implemented,
	"OriginShield":          Reported,
	"S3OriginConfig":        Implemented,
}

var customOriginPropertyInventory = map[string]Disposition{
	"HTTPPort":               Reported,
	"HTTPSPort":              Reported,
	"OriginKeepaliveTimeout": Reported,
	"OriginProtocolPolicy":   Reported,
	"OriginReadTimeout":      Reported,
	"OriginSSLProtocols":     Reported,
}

var s3OriginPropertyInventory = map[string]Disposition{
	"OriginAccessIdentity": Reported,
}

var functionPropertyInventory = map[string]Disposition{
	"AutoPublish":                     Reported,
	"FunctionCode":                    Implemented,
	"FunctionConfig":                  Implemented,
	propertyKeyValueStoreAssociations: Refused,
	propertyName:                      Reported,
}

var functionConfigPropertyInventory = map[string]Disposition{
	propertyComment:                   Reported,
	propertyKeyValueStoreAssociations: Refused,
	"Runtime":                         Implemented,
}

var cachePolicyPropertyInventory = map[string]Disposition{
	propertyComment:    Reported,
	propertyDefaultTTL: Reported,
	propertyMaxTTL:     Reported,
	propertyMinTTL:     Reported,
	propertyName:       Reported,
	"ParametersInCacheKeyAndForwardedToOrigin": Implemented,
}

var cacheParametersPropertyInventory = map[string]Disposition{
	"CookiesConfig":              Implemented,
	"EnableAcceptEncodingBrotli": Reported,
	"EnableAcceptEncodingGzip":   Reported,
	"HeadersConfig":              Implemented,
	"QueryStringsConfig":         Implemented,
}

var originRequestPolicyPropertyInventory = map[string]Disposition{
	propertyComment:      Reported,
	"CookiesConfig":      Implemented,
	"HeadersConfig":      Implemented,
	propertyName:         Reported,
	"QueryStringsConfig": Implemented,
}

var forwardingConfigPropertyInventory = map[string]Disposition{
	"CookieBehavior":      Implemented,
	"Cookies":             Implemented,
	"HeaderBehavior":      Implemented,
	"Headers":             Implemented,
	"QueryStringBehavior": Implemented,
	"QueryStrings":        Implemented,
}

var responseHeadersPolicyPropertyInventory = map[string]Disposition{
	propertyComment:             Reported,
	"CorsConfig":                Implemented,
	"CustomHeadersConfig":       Implemented,
	propertyName:                Reported,
	"RemoveHeadersConfig":       Implemented,
	"SecurityHeadersConfig":     Implemented,
	"ServerTimingHeadersConfig": Reported,
}

var corsConfigPropertyInventory = map[string]Disposition{
	"AccessControlAllowCredentials": Implemented,
	"AccessControlAllowHeaders":     Implemented,
	"AccessControlAllowMethods":     Implemented,
	"AccessControlAllowOrigins":     Implemented,
	"AccessControlExposeHeaders":    Implemented,
	"AccessControlMaxAgeSec":        Implemented,
	"OriginOverride":                Implemented,
}

var securityHeadersPropertyInventory = map[string]Disposition{
	"ContentSecurityPolicy":   Implemented,
	"ContentTypeOptions":      Implemented,
	"FrameOptions":            Implemented,
	"ReferrerPolicy":          Implemented,
	"StrictTransportSecurity": Implemented,
	"XSSProtection":           Implemented,
}

var originAccessControlConfigPropertyInventory = map[string]Disposition{
	"Description":                   Reported,
	propertyName:                    Reported,
	"OriginAccessControlOriginType": Reported,
	"SigningBehavior":               Reported,
	"SigningProtocol":               Reported,
}

var functionAssociationPropertyInventory = map[string]Disposition{
	"EventType":   Implemented,
	"FunctionARN": Implemented,
}

// PropertyInventory returns the classification table for the properties the
// reader understands. Tests use it to prove that every property in a shipped
// template is classified.
func PropertyInventory() map[string]map[string]Disposition {
	return map[string]map[string]Disposition{
		"DistributionConfig": distributionPropertyInventory,
		"CacheBehavior":      behaviorPropertyInventory,
		"Origin":             originPropertyInventory,
		"CustomOriginConfig": customOriginPropertyInventory,
		"S3OriginConfig":     s3OriginPropertyInventory,
		"Function":           functionPropertyInventory,
		"FunctionConfig":     functionConfigPropertyInventory,
		"CachePolicyConfig":  cachePolicyPropertyInventory,
		"ParametersInCacheKeyAndForwardedToOrigin": cacheParametersPropertyInventory,
		"OriginRequestPolicyConfig":                originRequestPolicyPropertyInventory,
		"ForwardingConfig":                         forwardingConfigPropertyInventory,
		"ResponseHeadersPolicyConfig":              responseHeadersPolicyPropertyInventory,
		"CorsConfig":                               corsConfigPropertyInventory,
		"SecurityHeadersConfig":                    securityHeadersPropertyInventory,
		"OriginAccessControlConfig":                originAccessControlConfigPropertyInventory,
		"FunctionAssociation":                      functionAssociationPropertyInventory,
	}
}

func reportProperty(context, key string) string {
	return fmt.Sprintf("%s: %s (%s)", context, key, reportReason(key))
}

func refuseProperty(context, key string) string {
	return fmt.Sprintf("%s: %s (%s)", context, key, refusalReason(key))
}

//nolint:gocyclo // the switch names each reported CloudFront property
func reportReason(key string) string {
	switch key {
	case "Aliases", "ViewerCertificate":
		return "the local gateway serves plain HTTP on a loopback address with no certificate or alias"
	case propertyComment:
		return "metadata only"
	case "Compress":
		return "response compression is not emulated; origin bytes are served as received"
	case propertyDefaultTTL, propertyMinTTL, propertyMaxTTL:
		return "behavior-level TTLs apply only with ForwardedValues, which the local gateway refuses; a cache policy's TTLs are applied"
	case "HttpVersion":
		return "the local gateway serves HTTP/1.1"
	case "IPV6Enabled", "PriceClass":
		return "does not change local routing or response content"
	case "Logging":
		return "CloudFront access logging is not emulated"
	case "RealtimeLogConfigArn":
		return "real-time logs are not emulated"
	case "Staging":
		return "staging distributions are not modeled locally"
	case "ConnectionAttempts", "ConnectionTimeout":
		return "the local origin is in-process, not a network connection"
	case "OriginShield":
		return "an origin shield has no local equivalent"
	case "HTTPPort", "HTTPSPort", "OriginKeepaliveTimeout", "OriginReadTimeout", "OriginSSLProtocols":
		return "the local origin protocol and connection are chosen by the origin implementation"
	case "OriginProtocolPolicy":
		return "the local URL is plain HTTP; the origin protocol is reported, not enforced"
	case "OriginAccessIdentity":
		return "legacy origin access identity signing is not enforced by the local origin"
	case "AutoPublish", propertyName:
		return "function publication metadata only"
	case "EnableAcceptEncodingBrotli", "EnableAcceptEncodingGzip":
		return "the local gateway does not normalize Accept-Encoding"
	case "ServerTimingHeadersConfig":
		return "CloudFront Server-Timing metrics are not emulated"
	case "Description":
		return "metadata only"
	case "OriginAccessControlOriginType", "SigningBehavior", "SigningProtocol":
		return "origin access control signing is not enforced locally"
	default:
		return "not emulated locally"
	}
}

func refusalReason(key string) string {
	switch key {
	case "ContinuousDeploymentPolicyId":
		return "continuous deployment policies are not supported locally"
	case "Restrictions":
		return "geo restriction decides which requests are served and is not emulated"
	case "WebACLId":
		return "a WAF web ACL decides which requests are served and is not emulated"
	case "FieldLevelEncryptionId":
		return "field-level encryption is not emulated"
	case "ForwardedValues":
		return "legacy ForwardedValues cache policies are not supported; use a cache policy and an origin request policy"
	case "GrpcConfig":
		return "gRPC is not supported locally"
	case "LambdaFunctionAssociations":
		return "Lambda@Edge associations are not executed by the local gateway"
	case "TrustedKeyGroups", "TrustedSigners":
		return "signed URLs and signed cookies are not verified locally"
	case propertyKeyValueStoreAssociations:
		return "CloudFront KeyValueStore associations are not available locally"
	default:
		return "not supported locally"
	}
}
