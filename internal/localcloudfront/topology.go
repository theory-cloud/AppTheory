package localcloudfront

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// CloudFormation resource types the reader understands.
const (
	typeCloudFrontDistribution = "AWS::CloudFront::Distribution"
	typeCloudFrontFunction     = "AWS::CloudFront::Function"
	typeCachePolicy            = "AWS::CloudFront::CachePolicy"
	typeOriginRequestPolicy    = "AWS::CloudFront::OriginRequestPolicy"
	typeResponseHeadersPolicy  = "AWS::CloudFront::ResponseHeadersPolicy"
	typeOriginAccessControl    = "AWS::CloudFront::OriginAccessControl"
	typeFunctionURL            = "AWS::Lambda::Url"
	typeS3Bucket               = "AWS::S3::Bucket"
	typeLambdaFunction         = "AWS::Lambda::Function"
	typeLambdaVersion          = "AWS::Lambda::Version"
	typePublicKey              = "AWS::CloudFront::PublicKey"
	typeKeyGroup               = "AWS::CloudFront::KeyGroup"
	typeKeyValueStore          = "AWS::CloudFront::KeyValueStore"
	typeFLEConfig              = "AWS::CloudFront::FieldLevelEncryptionConfig"
	typeFLEProfile             = "AWS::CloudFront::FieldLevelEncryptionProfile"

	runtimeJS10 = "cloudfront-js-1.0"
	runtimeJS20 = "cloudfront-js-2.0"
)

// Distribution is one AWS::CloudFront::Distribution the gateway can serve.
type Distribution struct {
	LogicalID         string                `json:"logicalId"`
	Stack             string                `json:"stack"`
	Comment           string                `json:"comment,omitempty"`
	Enabled           bool                  `json:"enabled"`
	Aliases           []string              `json:"aliases,omitempty"`
	DefaultRootObject string                `json:"defaultRootObject,omitempty"`
	DefaultBehavior   *Behavior             `json:"defaultBehavior"`
	CacheBehaviors    []*Behavior           `json:"cacheBehaviors,omitempty"`
	Origins           []*DistributionOrigin `json:"origins"`
	OriginGroups      []*OriginGroup        `json:"originGroups,omitempty"`
	// CustomErrorResponses are the distribution's CustomErrorResponses, in the
	// template's order.
	CustomErrorResponses []CustomErrorResponse `json:"customErrorResponses,omitempty"`
	// GeoRestriction is DistributionConfig Restrictions.GeoRestriction.
	GeoRestriction *GeoRestriction `json:"geoRestriction,omitempty"`
	Reported       []string        `json:"reported,omitempty"`
	Refusals       []string        `json:"refusals,omitempty"`
}

// CustomErrorResponse is one DistributionConfig CustomErrorResponses entry.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html
type CustomErrorResponse struct {
	ErrorCode int `json:"errorCode"`
	// ResponsePagePath is the path CloudFront fetches when the origin answers
	// ErrorCode. It is resolved through the distribution's cache behaviors:
	// "CloudFront finds the first cache behavior in your distribution that has
	// a path pattern that matches the path of the custom error page" and "The
	// CloudFront edge location sends a request for the custom error page to the
	// origin that is specified in the cache behavior."
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
	ResponsePagePath string `json:"responsePagePath,omitempty"`
	// ResponseCode is the status served with the custom page; 0 keeps the
	// origin's status when no page is served.
	ResponseCode int `json:"responseCode,omitempty"`
	// ErrorCachingMinTTL is how long the error response is cached. It is a
	// pointer so an explicit 0 (which disables error caching for a custom
	// origin, and means one second for an S3 origin) is distinguished from an
	// omitted value (the 10 second default). The page: "If you have caching
	// enabled for an S3 bucket origin, and you configure an error caching
	// minimum TTL of 0 seconds ... you will still see an error caching minimum
	// TTL of 1 second for S3 origin errors ... This doesn't apply to other types
	// of origins."
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
	ErrorCachingMinTTL *int `json:"errorCachingMinTtl,omitempty"`
}

// CustomErrorResponseFor returns the configured error response for a status.
func (d *Distribution) CustomErrorResponseFor(status int) (CustomErrorResponse, bool) {
	for _, response := range d.CustomErrorResponses {
		if response.ErrorCode == status {
			return response, true
		}
	}
	return CustomErrorResponse{}, false
}

// Servable reports whether every property the distribution uses is either
// implemented or reported without changing routing or response content.
func (d *Distribution) Servable() bool { return len(d.Refusals) == 0 }

// BehaviorForURI selects the cache behavior CloudFront would select for the
// original viewer URI: cache behaviors in listed order, then the default.
func (d *Distribution) BehaviorForURI(uri string) *Behavior {
	for _, behavior := range d.CacheBehaviors {
		if MatchPathPattern(behavior.PathPattern, uri) {
			return behavior
		}
	}
	return d.DefaultBehavior
}

// ExplicitBehaviorForURI reports the configured cache behavior (not the default
// behavior) whose path pattern matches uri. CloudFront's custom-error-page note
// distinguishes a cache behavior configured for the page path from the default
// behavior: "If you also configured a cache behavior for the same custom error
// page, CloudFront uses the cache behavior TTL instead."
func (d *Distribution) ExplicitBehaviorForURI(uri string) (*Behavior, bool) {
	for _, behavior := range d.CacheBehaviors {
		if MatchPathPattern(behavior.PathPattern, uri) {
			return behavior, true
		}
	}
	return nil, false
}

// Origin returns an origin by id.
func (d *Distribution) Origin(id string) (*DistributionOrigin, bool) {
	for _, origin := range d.Origins {
		if origin.ID == id {
			return origin, true
		}
	}
	return nil, false
}

// OriginGroup returns an origin group by id.
func (d *Distribution) OriginGroup(id string) (*OriginGroup, bool) {
	for _, group := range d.OriginGroups {
		if group.ID == id {
			return group, true
		}
	}
	return nil, false
}

// Behavior is one cache behavior.
type Behavior struct {
	PathPattern            string   `json:"pathPattern"`
	TargetOriginID         string   `json:"targetOriginId"`
	AllowedMethods         []string `json:"allowedMethods"`
	CachedMethods          []string `json:"cachedMethods,omitempty"`
	ViewerProtocolPolicy   string   `json:"viewerProtocolPolicy,omitempty"`
	CachePolicy            *Policy  `json:"cachePolicy,omitempty"`
	OriginRequestPolicy    *Policy  `json:"originRequestPolicy,omitempty"`
	ResponseHeadersPolicy  *Policy  `json:"responseHeadersPolicy,omitempty"`
	ViewerRequestFunction  string   `json:"viewerRequestFunction,omitempty"`
	ViewerResponseFunction string   `json:"viewerResponseFunction,omitempty"`
	// EdgeLambdas are the behavior's LambdaFunctionAssociations, keyed by event
	// type.
	EdgeLambdas map[string]*EdgeFunction `json:"edgeLambdas,omitempty"`
	// TrustedKeyGroups requires a signed URL or signed cookie for every request
	// except OPTIONS.
	TrustedKeyGroups *TrustedKeyGroups `json:"trustedKeyGroups,omitempty"`
	// FieldLevelEncryptionID names the AWS::CloudFront::FieldLevelEncryptionConfig
	// the behavior applies.
	FieldLevelEncryptionID string   `json:"fieldLevelEncryptionId,omitempty"`
	Compress               bool     `json:"compress,omitempty"`
	Reported               []string `json:"reported,omitempty"`
	Refusals               []string `json:"refusals,omitempty"`
}

// DistributionOrigin is one distribution origin.
type DistributionOrigin struct {
	ID               string     `json:"id"`
	DomainName       string     `json:"domainName,omitempty"`
	DomainExpression string     `json:"domainExpression,omitempty"`
	Kind             OriginKind `json:"kind,omitempty"`
	OriginPath       string     `json:"originPath,omitempty"`
	Bucket           string     `json:"bucket,omitempty"`
	FunctionURL      string     `json:"functionUrl,omitempty"`
	// LocalURL is the loopback URL a run flag maps an external custom origin to.
	LocalURL            string            `json:"localUrl,omitempty"`
	OriginAccessControl string            `json:"originAccessControl,omitempty"`
	Custom              *CustomOrigin     `json:"customOrigin,omitempty"`
	S3                  *S3Origin         `json:"s3Origin,omitempty"`
	CustomHeaders       map[string]string `json:"customHeaders,omitempty"`
	Reported            []string          `json:"reported,omitempty"`
	Refusals            []string          `json:"refusals,omitempty"`
}

// OriginKind names what the origin points at.
type OriginKind string

const (
	OriginS3     OriginKind = "s3"
	OriginCustom OriginKind = "custom"
)

// CustomOrigin is a CustomOriginConfig the gateway reports.
type CustomOrigin struct {
	ProtocolPolicy   string   `json:"protocolPolicy,omitempty"`
	SSLProtocols     []string `json:"sslProtocols,omitempty"`
	HTTPPort         *int     `json:"httpPort,omitempty"`
	HTTPSPort        *int     `json:"httpsPort,omitempty"`
	KeepaliveSeconds *int     `json:"keepaliveSeconds,omitempty"`
	ReadTimeout      *int     `json:"readTimeout,omitempty"`
}

// S3Origin is an S3OriginConfig the gateway reports.
type S3Origin struct {
	OriginAccessIdentity string `json:"originAccessIdentity,omitempty"`
}

// OriginGroup is an origin group. The gateway implements the documented
// failover behavior from the members and status codes.
type OriginGroup struct {
	ID                  string   `json:"id"`
	Members             []string `json:"members"`
	FailoverStatusCodes []int    `json:"failoverStatusCodes,omitempty"`
	Refusals            []string `json:"refusals,omitempty"`
}

// Function is one AWS::CloudFront::Function. Code is the exact FunctionCode
// string from the template.
type Function struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Name      string `json:"name,omitempty"`
	Comment   string `json:"comment,omitempty"`
	Runtime   string `json:"runtime"`
	Code      string `json:"-"`
	CodeBytes int    `json:"codeBytes"`
	// KeyValueStore names the AWS::CloudFront::KeyValueStore the function reads.
	KeyValueStore string   `json:"keyValueStore,omitempty"`
	Reported      []string `json:"reported,omitempty"`
	Refusals      []string `json:"refusals,omitempty"`

	store *KeyValueStore
}

// AttachStore binds the materialized key value store to the function.
func (f *Function) AttachStore(store *KeyValueStore) { f.store = store }

// Store returns the function's key value store, if any.
func (f *Function) Store() *KeyValueStore {
	if f == nil {
		return nil
	}
	return f.store
}

// engineKVS renders the store for the Node executor.
func (f *Function) engineKVS() *engineKVS {
	if f == nil || f.store == nil {
		return nil
	}
	return &engineKVS{
		Values:    f.store.Values,
		CreatedAt: f.store.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: f.store.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// Servable reports whether the function can run in the executor.
func (f *Function) Servable() bool { return len(f.Refusals) == 0 }

// PolicyKind names a CloudFront policy resource kind.
type PolicyKind string

const (
	PolicyCache           PolicyKind = "cache"
	PolicyOriginRequest   PolicyKind = "origin-request"
	PolicyResponseHeaders PolicyKind = "response-headers"
)

// Policy is a cache, origin request or response headers policy. A managed
// policy is pinned by id; a custom policy keeps its logical id.
type Policy struct {
	Kind            PolicyKind             `json:"kind"`
	ID              string                 `json:"id"`
	LogicalID       string                 `json:"logicalId,omitempty"`
	Managed         bool                   `json:"managed,omitempty"`
	Cache           *CachePolicy           `json:"cache,omitempty"`
	OriginRequest   *OriginRequestPolicy   `json:"originRequest,omitempty"`
	ResponseHeaders *ResponseHeadersPolicy `json:"responseHeaders,omitempty"`
	Reported        []string               `json:"reported,omitempty"`
	Refusals        []string               `json:"refusals,omitempty"`
}

// Servable reports whether the policy can be applied without guessing.
func (p *Policy) Servable() bool { return p != nil && len(p.Refusals) == 0 }

// ForwardingMode is the CloudFront behavior for headers, cookies or query
// strings.
type ForwardingMode string

const (
	ForwardNone      ForwardingMode = "none"
	ForwardWhitelist ForwardingMode = "whitelist"
	ForwardAll       ForwardingMode = "all"
	ForwardAllExcept ForwardingMode = "allExcept"
)

// HeaderForwarding is a headers config.
type HeaderForwarding struct {
	Mode              ForwardingMode `json:"mode"`
	Names             []string       `json:"names,omitempty"`
	CloudFrontHeaders bool           `json:"cloudFrontHeaders,omitempty"`
}

// CookieForwarding is a cookies config.
type CookieForwarding struct {
	Mode  ForwardingMode `json:"mode"`
	Names []string       `json:"names,omitempty"`
}

// QueryForwarding is a query strings config.
type QueryForwarding struct {
	Mode  ForwardingMode `json:"mode"`
	Names []string       `json:"names,omitempty"`
}

// CachePolicy is a cache policy: what reaches the origin and how long the
// gateway may cache the origin response.
type CachePolicy struct {
	Headers      HeaderForwarding `json:"headers"`
	Cookies      CookieForwarding `json:"cookies"`
	QueryStrings QueryForwarding  `json:"queryStrings"`
	// MinTTL, DefaultTTL and MaxTTL are the cache policy's TTL bounds in
	// seconds. They apply as the Expiration page's table states.
	MinTTL     int `json:"minTtl"`
	DefaultTTL int `json:"defaultTtl"`
	MaxTTL     int `json:"maxTtl"`
	// CachingDisabled is the managed CachingDisabled policy: every request goes
	// to the origin.
	CachingDisabled bool `json:"cachingDisabled,omitempty"`
}

// OriginRequestPolicy is the origin request policy definition.
type OriginRequestPolicy struct {
	Headers      HeaderForwarding `json:"headers"`
	Cookies      CookieForwarding `json:"cookies"`
	QueryStrings QueryForwarding  `json:"queryStrings"`
}

// ResponseHeadersPolicy is the response headers policy definition.
type ResponseHeadersPolicy struct {
	CORS     *CORSConfig      `json:"cors,omitempty"`
	Security *SecurityHeaders `json:"security,omitempty"`
	Custom   []CustomHeader   `json:"custom,omitempty"`
	Remove   []string         `json:"remove,omitempty"`
	Reported []string         `json:"reported,omitempty"`
}

// CORSConfig is a response headers policy CORS section.
type CORSConfig struct {
	AllowCredentials bool     `json:"allowCredentials,omitempty"`
	AllowHeaders     []string `json:"allowHeaders,omitempty"`
	AllowMethods     []string `json:"allowMethods,omitempty"`
	AllowOrigins     []string `json:"allowOrigins,omitempty"`
	ExposeHeaders    []string `json:"exposeHeaders,omitempty"`
	MaxAgeSeconds    *int     `json:"maxAgeSeconds,omitempty"`
	OriginOverride   bool     `json:"originOverride,omitempty"`
}

// SecurityHeaders is a response headers policy security section.
type SecurityHeaders struct {
	ContentSecurityPolicy   *ContentSecurityPolicy   `json:"contentSecurityPolicy,omitempty"`
	ContentTypeOptions      *ContentTypeOptions      `json:"contentTypeOptions,omitempty"`
	FrameOptions            *FrameOptions            `json:"frameOptions,omitempty"`
	ReferrerPolicy          *ReferrerPolicy          `json:"referrerPolicy,omitempty"`
	StrictTransportSecurity *StrictTransportSecurity `json:"strictTransportSecurity,omitempty"`
	XSSProtection           *XSSProtection           `json:"xssProtection,omitempty"`
}

// ContentSecurityPolicy is a CSP header setting.
type ContentSecurityPolicy struct {
	Value    string `json:"value"`
	Override bool   `json:"override"`
}

// ContentTypeOptions is a X-Content-Type-Options setting.
type ContentTypeOptions struct {
	Override bool `json:"override"`
}

// FrameOptions is a X-Frame-Options setting.
type FrameOptions struct {
	Value    string `json:"value"`
	Override bool   `json:"override"`
}

// ReferrerPolicy is a Referrer-Policy setting.
type ReferrerPolicy struct {
	Value    string `json:"value"`
	Override bool   `json:"override"`
}

// StrictTransportSecurity is a Strict-Transport-Security setting.
type StrictTransportSecurity struct {
	MaxAgeSeconds     int  `json:"maxAgeSeconds"`
	IncludeSubdomains bool `json:"includeSubdomains,omitempty"`
	Preload           bool `json:"preload,omitempty"`
	Override          bool `json:"override"`
}

// XSSProtection is a X-XSS-Protection setting.
type XSSProtection struct {
	Protection bool   `json:"protection"`
	ModeBlock  bool   `json:"modeBlock,omitempty"`
	ReportURI  string `json:"reportUri,omitempty"`
	Override   bool   `json:"override"`
}

// CustomHeader is a custom response header setting.
type CustomHeader struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Override bool   `json:"override"`
}

// OriginAccessControl is an AWS::CloudFront::OriginAccessControl. The gateway
// reports it; an S3 origin applies its access model and a Function URL origin
// reproduces its SigV4 signing.
type OriginAccessControl struct {
	LogicalID       string   `json:"logicalId"`
	Stack           string   `json:"stack"`
	OriginType      string   `json:"originType,omitempty"`
	SigningBehavior string   `json:"signingBehavior,omitempty"`
	SigningProtocol string   `json:"signingProtocol,omitempty"`
	Reported        []string `json:"reported,omitempty"`
}

func sortDistributions(values []*Distribution) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortFunctions(values []*Function) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortPolicies(values []*Policy) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortOACs(values []*OriginAccessControl) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortPublicKeys(values []*PublicKey) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortKeyGroups(values []*KeyGroup) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortKeyValueStores(values []*KeyValueStore) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortFLEConfigs(values []*FieldLevelEncryptionConfig) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortFLEProfiles(values []*FieldLevelEncryptionProfile) {
	sort.Slice(values, func(i, j int) bool { return values[i].LogicalID < values[j].LogicalID })
}

func sortStrings(values []string) { sort.Strings(values) }

//nolint:gocognit,gocyclo // the switch enumerates the DistributionConfig property inventory
func parseDistribution(
	stack, id string,
	resource Resource,
	index *resourceIndex,
	topology *Topology,
) (*Distribution, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	configRaw, ok := properties["DistributionConfig"]
	if !ok {
		return nil, fmt.Errorf("%s/%s: Properties has no DistributionConfig", stack, id)
	}
	properties, err = decodeObject(configRaw)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: DistributionConfig: %w", stack, id, err)
	}
	distribution := &Distribution{
		LogicalID: index.qualified(stack, id),
		Stack:     stack,
		Enabled:   true,
	}
	seen := map[string]bool{}
	for _, key := range sortedKeys(properties) {
		raw := properties[key]
		switch key {
		case "Aliases":
			seen[key] = true
			if err := json.Unmarshal(raw, &distribution.Aliases); err != nil {
				return nil, fmt.Errorf("%s: Aliases: %w", distribution.LogicalID, err)
			}
			if len(distribution.Aliases) > 0 {
				distribution.Reported = append(distribution.Reported,
					fmt.Sprintf("distribution: Aliases %s are not served; the local URL is the distribution's loopback address", strings.Join(distribution.Aliases, ", ")))
			}
		case "CacheBehaviors":
			seen[key] = true
			behaviors, err := parseBehaviors(raw, stack, index, topology, distribution.LogicalID)
			if err != nil {
				return nil, err
			}
			distribution.CacheBehaviors = behaviors
		case propertyComment:
			seen[key] = true
			if err := json.Unmarshal(raw, &distribution.Comment); err != nil {
				return nil, fmt.Errorf("%s: Comment: %w", distribution.LogicalID, err)
			}
			distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
		case "DefaultCacheBehavior":
			seen[key] = true
			behavior, err := parseBehavior(raw, "*", stack, index, topology, distribution.LogicalID, true)
			if err != nil {
				return nil, err
			}
			distribution.DefaultBehavior = behavior
		case "DefaultRootObject":
			seen[key] = true
			if err := json.Unmarshal(raw, &distribution.DefaultRootObject); err != nil {
				return nil, fmt.Errorf("%s: DefaultRootObject: %w", distribution.LogicalID, err)
			}
			if strings.HasPrefix(distribution.DefaultRootObject, "/") {
				distribution.Refusals = append(distribution.Refusals, "distribution: DefaultRootObject must not begin with a slash")
			}
		case "Enabled":
			seen[key] = true
			if err := json.Unmarshal(raw, &distribution.Enabled); err != nil {
				return nil, fmt.Errorf("%s: Enabled: %w", distribution.LogicalID, err)
			}
			if !distribution.Enabled {
				distribution.Refusals = append(distribution.Refusals,
					"distribution: Enabled is false; CloudFront returns 403 for every request to a disabled distribution")
			}
		case "HttpVersion":
			seen[key] = true
			distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
		case "IPV6Enabled":
			seen[key] = true
			distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
		case "Logging":
			seen[key] = true
			distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
		case "OriginGroups":
			seen[key] = true
			groups, err := parseOriginGroups(raw, distribution.LogicalID)
			if err != nil {
				return nil, err
			}
			distribution.OriginGroups = groups
		case "Origins":
			seen[key] = true
			origins, err := parseOrigins(raw, stack, index, distribution.LogicalID)
			if err != nil {
				return nil, err
			}
			distribution.Origins = origins
		case "PriceClass":
			seen[key] = true
			distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
		case "Restrictions":
			seen[key] = true
			restriction, problems := parseRestrictions(raw, distribution.LogicalID)
			distribution.GeoRestriction = restriction
			distribution.Refusals = append(distribution.Refusals, problems...)
		case "Staging":
			seen[key] = true
			var staging bool
			if err := json.Unmarshal(raw, &staging); err != nil {
				return nil, fmt.Errorf("%s: Staging: %w", distribution.LogicalID, err)
			}
			if staging {
				distribution.Refusals = append(distribution.Refusals, "distribution: Staging is true and staging distributions are not modeled locally")
			} else {
				distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
			}
		case "ViewerCertificate":
			seen[key] = true
			distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
		case "WebACLId":
			seen[key] = true
			if !isEmptyValue(raw) {
				distribution.Refusals = append(distribution.Refusals, refuseProperty("distribution", key))
			} else {
				distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
			}
		case "CustomErrorResponses":
			seen[key] = true
			responses, err := parseCustomErrorResponses(raw, distribution.LogicalID)
			if err != nil {
				return nil, err
			}
			distribution.CustomErrorResponses = responses
		case "ContinuousDeploymentPolicyId":
			seen[key] = true
			if !isEmptyValue(raw) {
				distribution.Refusals = append(distribution.Refusals, refuseProperty("distribution", key))
			} else {
				distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
			}
		default:
			disposition, known := distributionPropertyInventory[key]
			if !known {
				distribution.Refusals = append(distribution.Refusals,
					fmt.Sprintf("distribution: property %q is not understood by the local gateway", key))
				continue
			}
			switch disposition {
			case Reported:
				distribution.Reported = append(distribution.Reported, reportProperty("distribution", key))
			case Refused:
				distribution.Refusals = append(distribution.Refusals, refuseProperty("distribution", key))
			case Implemented:
				distribution.Refusals = append(distribution.Refusals,
					fmt.Sprintf("distribution: property %q is classified implemented but was not parsed", key))
			}
		}
	}
	if distribution.DefaultBehavior == nil {
		return nil, fmt.Errorf("%s: DistributionConfig has no DefaultCacheBehavior", distribution.LogicalID)
	}
	if len(distribution.Origins) == 0 {
		distribution.Refusals = append(distribution.Refusals, "distribution: DistributionConfig has no Origins")
	}
	distribution.validate(topology)
	return distribution, nil
}

func (d *Distribution) validate(topology *Topology) {
	if d.DefaultBehavior != nil {
		d.validateBehavior(d.DefaultBehavior, topology)
	}
	for _, behavior := range d.CacheBehaviors {
		d.validateBehavior(behavior, topology)
	}
	for _, origin := range d.Origins {
		if len(origin.Refusals) > 0 {
			for _, refusal := range origin.Refusals {
				d.Refusals = append(d.Refusals, fmt.Sprintf("origin %q: %s", origin.ID, refusal))
			}
		}
	}
	for _, group := range d.OriginGroups {
		for _, member := range group.Members {
			if _, ok := d.Origin(member); !ok {
				group.Refusals = append(group.Refusals, fmt.Sprintf("member %q names no origin", member))
			}
		}
		if len(group.Refusals) > 0 {
			for _, refusal := range group.Refusals {
				d.Refusals = append(d.Refusals, fmt.Sprintf("origin group %q: %s", group.ID, refusal))
			}
		}
	}
}

//nolint:gocyclo,gocognit // the loop accumulates refusals from each behavior and origin
func (d *Distribution) validateBehavior(behavior *Behavior, topology *Topology) {
	if behavior == nil {
		return
	}
	if behavior.TargetOriginID == "" {
		behavior.Refusals = append(behavior.Refusals, "behavior has no TargetOriginId")
	} else if _, ok := d.Origin(behavior.TargetOriginID); !ok {
		if _, groupOK := d.OriginGroup(behavior.TargetOriginID); !groupOK {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("TargetOriginId %q names no origin or origin group", behavior.TargetOriginID))
		}
	}
	if behavior.CachePolicy != nil && !behavior.CachePolicy.Servable() {
		for _, refusal := range behavior.CachePolicy.Refusals {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("cache policy: %s", refusal))
		}
	}
	if behavior.OriginRequestPolicy != nil && !behavior.OriginRequestPolicy.Servable() {
		for _, refusal := range behavior.OriginRequestPolicy.Refusals {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("origin request policy: %s", refusal))
		}
	}
	if behavior.ResponseHeadersPolicy != nil && !behavior.ResponseHeadersPolicy.Servable() {
		for _, refusal := range behavior.ResponseHeadersPolicy.Refusals {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("response headers policy: %s", refusal))
		}
	}
	for _, association := range behavior.EdgeLambdas {
		if association == nil || association.Servable() {
			continue
		}
		for _, refusal := range association.Refusals {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("Lambda@Edge %s: %s", association.EventType, refusal))
		}
	}
	// "You can't combine CloudFront Functions and Lambda@Edge in viewer events
	// (viewer request and viewer response)." Every viewer cell of the page's
	// allowed-combinations table is "Not allowed", so any CloudFront Function
	// viewer association conflicts with any Lambda@Edge viewer association,
	// not only the same-event pair.
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html
	combination := "\"You can't combine CloudFront Functions and Lambda@Edge in viewer events (viewer request and viewer response).\""
	pageURL := "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html"
	viewerFunctions := []struct {
		eventType  string
		functionID string
	}{
		{edgeViewerRequest, behavior.ViewerRequestFunction},
		{edgeViewerResponse, behavior.ViewerResponseFunction},
	}
	for _, lambdaEvent := range []string{edgeViewerRequest, edgeViewerResponse} {
		association := behavior.EdgeLambdas[lambdaEvent]
		if association == nil {
			continue
		}
		for _, viewerFunction := range viewerFunctions {
			if viewerFunction.functionID == "" {
				continue
			}
			if viewerFunction.eventType == lambdaEvent {
				behavior.Refusals = append(behavior.Refusals, fmt.Sprintf(
					"event type %s associates both the CloudFront Function %s and the Lambda@Edge function %s (version %s); %s (%s)",
					lambdaEvent, viewerFunction.functionID, association.Function, association.Version, combination, pageURL))
				continue
			}
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf(
				"event type %s associates the CloudFront Function %s and event type %s associates the Lambda@Edge function %s (version %s); %s (%s)",
				viewerFunction.eventType, viewerFunction.functionID, lambdaEvent, association.Function, association.Version, combination, pageURL))
		}
	}
	if behavior.FieldLevelEncryptionID != "" {
		config, ok := topology.FieldLevelEncryptionConfig(behavior.FieldLevelEncryptionID)
		if !ok {
			behavior.Refusals = append(behavior.Refusals,
				fmt.Sprintf("FieldLevelEncryptionId %q is not in the assembly", behavior.FieldLevelEncryptionID))
		} else {
			if !config.Servable() {
				behavior.Refusals = append(behavior.Refusals, fmt.Sprintf(
					"field-level encryption configuration %s: %s", config.LogicalID, strings.Join(config.Refusals, "; ")))
			}
			for _, profileID := range config.profileIDs() {
				profile, found := topology.FieldLevelEncryptionProfile(profileID)
				if !found {
					behavior.Refusals = append(behavior.Refusals,
						fmt.Sprintf("field-level encryption profile %q is not in the assembly", profileID))
					continue
				}
				if !profile.Servable() {
					behavior.Refusals = append(behavior.Refusals, fmt.Sprintf(
						"field-level encryption profile %s: %s", profile.LogicalID, strings.Join(profile.Refusals, "; ")))
					continue
				}
				for _, refusal := range verifyFLEKeys(profile, topology.publicKeysByID) {
					behavior.Refusals = append(behavior.Refusals, "field-level encryption: "+refusal)
				}
			}
			if config.QueryArgProfileConfig == nil {
				d.Reported = append(d.Reported, fmt.Sprintf(
					"distribution: field-level encryption: configuration %s has no QueryArgProfileConfig, so a fle-profile query argument is ignored",
					config.LogicalID))
			}
		}
		origin, _ := d.Origin(behavior.TargetOriginID)
		for _, deviation := range d.flePreconditions(behavior, origin) {
			d.Reported = append(d.Reported, "distribution: field-level encryption: "+deviation+" (reported; the local viewer is plain HTTP)")
		}
	}
	for _, functionID := range []string{behavior.ViewerRequestFunction, behavior.ViewerResponseFunction} {
		if functionID == "" {
			continue
		}
		function, ok := topology.Function(functionID)
		if !ok {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("function %q is not in the assembly", functionID))
			continue
		}
		if !function.Servable() {
			for _, refusal := range function.Refusals {
				behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("function %s: %s", functionID, refusal))
			}
		}
	}
	for _, refusal := range behavior.Refusals {
		d.Refusals = append(d.Refusals, fmt.Sprintf("behavior %q: %s", behavior.PathPattern, refusal))
	}
}

// parseCustomErrorResponses reads the distribution's custom error responses and
// refuses a value CloudFront itself would reject.
func parseCustomErrorResponses(raw json.RawMessage, distributionID string) ([]CustomErrorResponse, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s: CustomErrorResponses: %w", distributionID, err)
	}
	responses := make([]CustomErrorResponse, 0, len(values))
	for position, value := range values {
		response, err := parseCustomErrorResponse(value, distributionID, position)
		if err != nil {
			return nil, err
		}
		responses = append(responses, response)
	}
	return responses, nil
}

func parseCustomErrorResponse(raw json.RawMessage, distributionID string, position int) (CustomErrorResponse, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return CustomErrorResponse{}, fmt.Errorf("%s: CustomErrorResponses[%d]: %w", distributionID, position, err)
	}
	response := CustomErrorResponse{}
	for _, key := range sortedKeys(properties) {
		if err := decodeCustomErrorField(&response, key, properties[key]); err != nil {
			return CustomErrorResponse{}, fmt.Errorf("%s: CustomErrorResponses[%d].%s: %w", distributionID, position, key, err)
		}
	}
	if response.ErrorCode < 400 || response.ErrorCode > 599 {
		return CustomErrorResponse{}, fmt.Errorf("%s: CustomErrorResponses[%d].ErrorCode %d is not an HTTP error status", distributionID, position, response.ErrorCode)
	}
	if response.ResponsePagePath != "" && !strings.HasPrefix(response.ResponsePagePath, "/") {
		return CustomErrorResponse{}, fmt.Errorf("%s: CustomErrorResponses[%d].ResponsePagePath must begin with a slash", distributionID, position)
	}
	if err := validateCustomErrorPage(response, distributionID, position); err != nil {
		return CustomErrorResponse{}, err
	}
	if response.ResponseCode != 0 && (response.ResponseCode < 200 || response.ResponseCode > 599) {
		return CustomErrorResponse{}, fmt.Errorf("%s: CustomErrorResponses[%d].ResponseCode %d is not an HTTP status", distributionID, position, response.ResponseCode)
	}
	if response.ErrorCachingMinTTL != nil && *response.ErrorCachingMinTTL < 0 {
		return CustomErrorResponse{}, fmt.Errorf("%s: CustomErrorResponses[%d].ErrorCachingMinTTL is negative", distributionID, position)
	}
	return response, nil
}

// validateCustomErrorPage refuses a custom error page for the status codes that
// do not support one: "CloudFront doesn't support creating custom error pages
// for these HTTP status codes." A status-only rewrite stays accepted.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
func validateCustomErrorPage(response CustomErrorResponse, distributionID string, position int) error {
	if response.ResponsePagePath == "" || (response.ErrorCode != 412 && response.ErrorCode != 415) {
		return nil
	}
	return fmt.Errorf(
		"%s: CustomErrorResponses[%d].ErrorCode %d cannot have a ResponsePagePath: CloudFront doesn't support creating custom error pages for 412 Precondition Failed or 415 Unsupported Media Type (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html)",
		distributionID, position, response.ErrorCode)
}

func decodeCustomErrorField(response *CustomErrorResponse, key string, value json.RawMessage) error {
	switch key {
	case "ErrorCode":
		return json.Unmarshal(value, &response.ErrorCode)
	case "ResponsePagePath":
		return json.Unmarshal(value, &response.ResponsePagePath)
	case "ResponseCode":
		return json.Unmarshal(value, &response.ResponseCode)
	case "ErrorCachingMinTTL":
		return json.Unmarshal(value, &response.ErrorCachingMinTTL)
	default:
		return fmt.Errorf("property %q is not understood", key)
	}
}

func parseBehaviors(
	raw json.RawMessage,
	stack string,
	index *resourceIndex,
	topology *Topology,
	distributionID string,
) ([]*Behavior, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s: CacheBehaviors: %w", distributionID, err)
	}
	behaviors := make([]*Behavior, 0, len(values))
	for position, value := range values {
		behavior, err := parseBehavior(value, "", stack, index, topology, distributionID, false)
		if err != nil {
			return nil, err
		}
		if behavior.PathPattern == "" {
			behavior.Refusals = append(behavior.Refusals, fmt.Sprintf("CacheBehaviors[%d] has no PathPattern", position))
		}
		behaviors = append(behaviors, behavior)
	}
	return behaviors, nil
}

//nolint:gocognit,gocyclo // the switch enumerates the cache behavior property inventory
func parseBehavior(
	raw json.RawMessage,
	defaultPattern string,
	stack string,
	index *resourceIndex,
	topology *Topology,
	distributionID string,
	isDefault bool,
) (*Behavior, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: cache behavior: %w", distributionID, err)
	}
	behavior := &Behavior{
		PathPattern:    defaultPattern,
		AllowedMethods: []string{"GET", "HEAD"},
		// CloudFront caches GET and HEAD unless the behavior declares
		// CachedMethods; OPTIONS fails over only when it is cached.
		CachedMethods: []string{"GET", "HEAD"},
	}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "PathPattern":
			if err := json.Unmarshal(value, &behavior.PathPattern); err != nil {
				return nil, fmt.Errorf("%s: PathPattern: %w", distributionID, err)
			}
		case "TargetOriginId":
			if err := json.Unmarshal(value, &behavior.TargetOriginID); err != nil {
				return nil, fmt.Errorf("%s: TargetOriginId: %w", distributionID, err)
			}
		case "AllowedMethods":
			var methods []string
			if err := json.Unmarshal(value, &methods); err != nil {
				return nil, fmt.Errorf("%s: AllowedMethods: %w", distributionID, err)
			}
			behavior.AllowedMethods = normalizeMethods(methods)
		case "CachedMethods":
			var methods []string
			if err := json.Unmarshal(value, &methods); err != nil {
				return nil, fmt.Errorf("%s: CachedMethods: %w", distributionID, err)
			}
			behavior.CachedMethods = normalizeMethods(methods)
			behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
		case "ViewerProtocolPolicy":
			if err := json.Unmarshal(value, &behavior.ViewerProtocolPolicy); err != nil {
				return nil, fmt.Errorf("%s: ViewerProtocolPolicy: %w", distributionID, err)
			}
			behavior.Reported = append(behavior.Reported,
				fmt.Sprintf("ViewerProtocolPolicy %q: %s", behavior.ViewerProtocolPolicy, reportReason("ViewerProtocolPolicy")))
		case "CachePolicyId":
			policy, problem := resolvePolicyRef(value, PolicyCache, stack, index)
			if problem != "" {
				behavior.Refusals = append(behavior.Refusals, problem)
				continue
			}
			behavior.CachePolicy = lookupPolicy(policy, topology)
		case "OriginRequestPolicyId":
			policy, problem := resolvePolicyRef(value, PolicyOriginRequest, stack, index)
			if problem != "" {
				behavior.Refusals = append(behavior.Refusals, problem)
				continue
			}
			behavior.OriginRequestPolicy = lookupPolicy(policy, topology)
		case "ResponseHeadersPolicyId":
			policy, problem := resolvePolicyRef(value, PolicyResponseHeaders, stack, index)
			if problem != "" {
				behavior.Refusals = append(behavior.Refusals, problem)
				continue
			}
			behavior.ResponseHeadersPolicy = lookupPolicy(policy, topology)
		case "FunctionAssociations":
			if err := parseFunctionAssociations(value, behavior, stack, index, distributionID); err != nil {
				return nil, err
			}
		case "Compress":
			if err := json.Unmarshal(value, &behavior.Compress); err != nil {
				return nil, fmt.Errorf("%s: Compress: %w", distributionID, err)
			}
			behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
		case propertyDefaultTTL, propertyMaxTTL, propertyMinTTL, "RealtimeLogConfigArn":
			behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
		case "LambdaFunctionAssociations":
			if isEmptyArray(value) {
				behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
				continue
			}
			associations, associationErr := parseEdgeAssociations(value, stack, index, distributionID)
			if associationErr != nil {
				return nil, associationErr
			}
			behavior.EdgeLambdas = associations
		case "FieldLevelEncryptionId":
			if isEmptyValue(value) {
				behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
				continue
			}
			configID, ok := resolveResourceRef(value, stack, index)
			if !ok {
				behavior.Refusals = append(behavior.Refusals,
					"FieldLevelEncryptionId does not reference an AWS::CloudFront::FieldLevelEncryptionConfig in this assembly")
				continue
			}
			behavior.FieldLevelEncryptionID = configID
		case "ForwardedValues":
			behavior.Refusals = append(behavior.Refusals, refuseProperty("behavior", key))
		case "GrpcConfig":
			behavior.Refusals = append(behavior.Refusals, refuseProperty("behavior", key))
		case "SmoothStreaming":
			var smooth bool
			if err := json.Unmarshal(value, &smooth); err != nil {
				return nil, fmt.Errorf("%s: SmoothStreaming: %w", distributionID, err)
			}
			if smooth {
				behavior.Refusals = append(behavior.Refusals, "behavior: SmoothStreaming is true and is not emulated")
			} else {
				behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
			}
		case "TrustedKeyGroups":
			if isEmptyValue(value) {
				behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
				continue
			}
			settings, problem := parseTrustedKeyGroups(value, stack, index)
			if problem != "" {
				behavior.Refusals = append(behavior.Refusals, problem)
				continue
			}
			behavior.TrustedKeyGroups = settings
		case "TrustedSigners":
			if !isEmptyValue(value) {
				behavior.Refusals = append(behavior.Refusals,
					"TrustedSigners names AWS-account signers; that legacy signer form is not supported locally, use a trusted key group")
			} else {
				behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
			}
		default:
			disposition, known := behaviorPropertyInventory[key]
			if !known {
				behavior.Refusals = append(behavior.Refusals,
					fmt.Sprintf("behavior: property %q is not understood by the local gateway", key))
				continue
			}
			switch disposition {
			case Reported:
				behavior.Reported = append(behavior.Reported, reportProperty("behavior", key))
			case Refused:
				behavior.Refusals = append(behavior.Refusals, refuseProperty("behavior", key))
			case Implemented:
				behavior.Refusals = append(behavior.Refusals,
					fmt.Sprintf("behavior: property %q is classified implemented but was not parsed", key))
			}
		}
	}
	if behavior.CachePolicy == nil {
		behavior.Refusals = append(behavior.Refusals,
			"behavior has no CachePolicyId; the gateway does not fall back to a cache configuration")
	}
	if isDefault {
		behavior.PathPattern = "*"
	}
	return behavior, nil
}

func lookupPolicy(policy *Policy, topology *Topology) *Policy {
	if policy == nil {
		return nil
	}
	if policy.Managed {
		return policy
	}
	if parsed, ok := topology.policiesByID[policy.ID]; ok {
		if parsed.Kind != policy.Kind {
			return &Policy{Kind: policy.Kind, ID: policy.ID, LogicalID: policy.ID,
				Refusals: []string{fmt.Sprintf("policy %q is a %s policy, not a %s policy", policy.ID, parsed.Kind, policy.Kind)}}
		}
		return parsed
	}
	return &Policy{Kind: policy.Kind, ID: policy.ID, LogicalID: policy.ID,
		Refusals: []string{fmt.Sprintf("policy %q is referenced but not defined in the assembly", policy.ID)}}
}

func parseFunctionAssociations(
	raw json.RawMessage,
	behavior *Behavior,
	stack string,
	index *resourceIndex,
	distributionID string,
) error {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return fmt.Errorf("%s: FunctionAssociations: %w", distributionID, err)
	}
	seen := map[string]bool{}
	for position, value := range values {
		properties, err := decodeObject(value)
		if err != nil {
			return fmt.Errorf("%s: FunctionAssociations[%d]: %w", distributionID, position, err)
		}
		var eventType, functionID string
		for _, key := range sortedKeys(properties) {
			switch key {
			case "EventType":
				if err := json.Unmarshal(properties[key], &eventType); err != nil {
					return fmt.Errorf("%s: EventType: %w", distributionID, err)
				}
			case "FunctionARN":
				resolved, ok := resolveFunctionRef(properties[key], stack, index)
				if !ok {
					behavior.Refusals = append(behavior.Refusals,
						fmt.Sprintf("FunctionAssociations[%d] does not reference an AWS::CloudFront::Function in this assembly", position))
					continue
				}
				functionID = resolved
			default:
				behavior.Refusals = append(behavior.Refusals,
					fmt.Sprintf("FunctionAssociations[%d]: property %q is not understood", position, key))
			}
		}
		if functionID == "" {
			behavior.Refusals = append(behavior.Refusals,
				fmt.Sprintf("FunctionAssociations[%d] has no resolvable FunctionARN", position))
			continue
		}
		if eventType == "" {
			behavior.Refusals = append(behavior.Refusals,
				fmt.Sprintf("FunctionAssociations[%d] has no EventType", position))
			continue
		}
		if seen[eventType] {
			behavior.Refusals = append(behavior.Refusals,
				fmt.Sprintf("more than one function is associated with event type %q", eventType))
			continue
		}
		seen[eventType] = true
		switch eventType {
		case "viewer-request":
			behavior.ViewerRequestFunction = functionID
		case "viewer-response":
			behavior.ViewerResponseFunction = functionID
		default:
			behavior.Refusals = append(behavior.Refusals,
				fmt.Sprintf("function event type %q is not run by the local gateway", eventType))
		}
	}
	return nil
}

func normalizeMethods(methods []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(methods))
	for _, method := range methods {
		method = strings.ToUpper(strings.TrimSpace(method))
		if method == "" || seen[method] {
			continue
		}
		seen[method] = true
		out = append(out, method)
	}
	if seen["GET"] && !seen["HEAD"] {
		out = append(out, "HEAD")
	}
	return out
}

func parseOrigins(raw json.RawMessage, stack string, index *resourceIndex, distributionID string) ([]*DistributionOrigin, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s: Origins: %w", distributionID, err)
	}
	origins := make([]*DistributionOrigin, 0, len(values))
	for position, value := range values {
		origin, err := parseOrigin(value, stack, index, distributionID, position)
		if err != nil {
			return nil, err
		}
		origins = append(origins, origin)
	}
	return origins, nil
}

//nolint:gocognit,gocyclo // the switch enumerates the origin property inventory
func parseOrigin(
	raw json.RawMessage,
	stack string,
	index *resourceIndex,
	distributionID string,
	position int,
) (*DistributionOrigin, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: Origins[%d]: %w", distributionID, position, err)
	}
	origin := &DistributionOrigin{}
	domainSeen := false
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "Id":
			if err := json.Unmarshal(value, &origin.ID); err != nil {
				return nil, fmt.Errorf("%s: Origins[%d].Id: %w", distributionID, position, err)
			}
		case "DomainName":
			domainSeen = true
			domain, err := resolveOriginDomain(value, stack, index)
			if err != nil {
				return nil, err
			}
			origin.DomainName = domain.DomainName
			origin.Bucket = domain.Bucket
			origin.FunctionURL = domain.Function
			if domain.Kind == refUnresolved {
				origin.DomainExpression = domain.Expression
				origin.Refusals = append(origin.Refusals,
					fmt.Sprintf("DomainName expression %s does not resolve to a local origin", domain.Expression))
			}
		case "OriginPath":
			if err := json.Unmarshal(value, &origin.OriginPath); err != nil {
				return nil, fmt.Errorf("%s: Origins[%d].OriginPath: %w", distributionID, position, err)
			}
			if origin.OriginPath != "" && !strings.HasPrefix(origin.OriginPath, "/") {
				origin.Refusals = append(origin.Refusals, "OriginPath must begin with a slash")
			}
		case "CustomOriginConfig":
			custom, err := parseCustomOrigin(value, distributionID, position)
			if err != nil {
				return nil, err
			}
			origin.Custom = custom
		case "S3OriginConfig":
			s3Origin, err := parseS3Origin(value, distributionID, position)
			if err != nil {
				return nil, err
			}
			origin.S3 = s3Origin
		case "OriginAccessControlId":
			oacID, ok := resolveResourceRef(value, stack, index)
			if !ok {
				origin.Refusals = append(origin.Refusals, "OriginAccessControlId does not reference an origin access control in this assembly")
				continue
			}
			origin.OriginAccessControl = oacID
			origin.Reported = append(origin.Reported,
				fmt.Sprintf("origin access control %s: signing is not enforced by the local origin", oacID))
		case "OriginCustomHeaders":
			headers, problem := parseOriginCustomHeaders(value)
			if problem != "" {
				origin.Refusals = append(origin.Refusals, problem)
				continue
			}
			origin.CustomHeaders = headers
		case "ConnectionAttempts", "ConnectionTimeout", "OriginShield":
			origin.Reported = append(origin.Reported, reportProperty("origin", key))
		default:
			disposition, known := originPropertyInventory[key]
			if !known {
				origin.Refusals = append(origin.Refusals,
					fmt.Sprintf("origin: property %q is not understood by the local gateway", key))
				continue
			}
			switch disposition {
			case Reported:
				origin.Reported = append(origin.Reported, reportProperty("origin", key))
			case Refused:
				origin.Refusals = append(origin.Refusals, refuseProperty("origin", key))
			case Implemented:
				origin.Refusals = append(origin.Refusals,
					fmt.Sprintf("origin: property %q is classified implemented but was not parsed", key))
			}
		}
	}
	if origin.ID == "" {
		origin.Refusals = append(origin.Refusals, "origin has no Id")
	}
	if !domainSeen {
		origin.Refusals = append(origin.Refusals, "origin has no DomainName")
	}
	switch {
	case origin.Custom != nil && origin.S3 != nil:
		origin.Refusals = append(origin.Refusals, "origin has both CustomOriginConfig and S3OriginConfig")
	case origin.Custom != nil:
		origin.Kind = OriginCustom
	case origin.S3 != nil:
		origin.Kind = OriginS3
	default:
		origin.Refusals = append(origin.Refusals, "origin has neither CustomOriginConfig nor S3OriginConfig")
	}
	return origin, nil
}

//nolint:gocyclo // the switch enumerates the origin property inventory
func parseCustomOrigin(raw json.RawMessage, distributionID string, position int) (*CustomOrigin, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: Origins[%d].CustomOriginConfig: %w", distributionID, position, err)
	}
	custom := &CustomOrigin{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "OriginProtocolPolicy":
			if err := json.Unmarshal(value, &custom.ProtocolPolicy); err != nil {
				return nil, fmt.Errorf("%s: OriginProtocolPolicy: %w", distributionID, err)
			}
		case "OriginSSLProtocols":
			if err := json.Unmarshal(value, &custom.SSLProtocols); err != nil {
				return nil, fmt.Errorf("%s: OriginSSLProtocols: %w", distributionID, err)
			}
		case "HTTPPort":
			port, err := decodeIntPointer(value)
			if err != nil {
				return nil, fmt.Errorf("%s: HTTPPort: %w", distributionID, err)
			}
			custom.HTTPPort = port
		case "HTTPSPort":
			port, err := decodeIntPointer(value)
			if err != nil {
				return nil, fmt.Errorf("%s: HTTPSPort: %w", distributionID, err)
			}
			custom.HTTPSPort = port
		case "OriginKeepaliveTimeout":
			seconds, err := decodeIntPointer(value)
			if err != nil {
				return nil, fmt.Errorf("%s: OriginKeepaliveTimeout: %w", distributionID, err)
			}
			custom.KeepaliveSeconds = seconds
		case "OriginReadTimeout":
			seconds, err := decodeIntPointer(value)
			if err != nil {
				return nil, fmt.Errorf("%s: OriginReadTimeout: %w", distributionID, err)
			}
			custom.ReadTimeout = seconds
		default:
			if _, known := customOriginPropertyInventory[key]; !known {
				return nil, fmt.Errorf("%s: CustomOriginConfig property %q is not understood", distributionID, key)
			}
		}
	}
	return custom, nil
}

func parseS3Origin(raw json.RawMessage, distributionID string, position int) (*S3Origin, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: Origins[%d].S3OriginConfig: %w", distributionID, position, err)
	}
	origin := &S3Origin{}
	for _, key := range sortedKeys(properties) {
		if key != "OriginAccessIdentity" {
			if _, known := s3OriginPropertyInventory[key]; !known {
				return nil, fmt.Errorf("%s: S3OriginConfig property %q is not understood", distributionID, key)
			}
			continue
		}
		// The value is either the identity's cloudfront id or a Ref/Fn::Join
		// expression; only its presence matters locally.
		if err := json.Unmarshal(properties[key], &origin.OriginAccessIdentity); err != nil {
			if _, isExpression := decodeObjectOrNil(properties[key]); !isExpression {
				return nil, fmt.Errorf("%s: OriginAccessIdentity is not a string or an expression", distributionID)
			}
			origin.OriginAccessIdentity = "origin-access-identity"
		}
	}
	return origin, nil
}

func parseOriginCustomHeaders(raw json.RawMessage) (map[string]string, string) {
	var values []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, "OriginCustomHeaders is not a list"
	}
	headers := map[string]string{}
	for position, value := range values {
		var name, headerValue string
		for key, field := range value {
			switch key {
			case "HeaderName":
				if err := json.Unmarshal(field, &name); err != nil {
					return nil, fmt.Sprintf("OriginCustomHeaders[%d].HeaderName is not a string", position)
				}
			case "HeaderValue":
				if err := json.Unmarshal(field, &headerValue); err != nil {
					return nil, fmt.Sprintf("OriginCustomHeaders[%d].HeaderValue is not a string", position)
				}
			default:
				return nil, fmt.Sprintf("OriginCustomHeaders[%d] property %q is not understood", position, key)
			}
		}
		if name == "" {
			return nil, fmt.Sprintf("OriginCustomHeaders[%d] has no HeaderName", position)
		}
		headers[name] = headerValue
	}
	return headers, ""
}

func parseOriginGroups(raw json.RawMessage, distributionID string) ([]*OriginGroup, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: OriginGroups: %w", distributionID, err)
	}
	for key := range properties {
		if key != propertyQuantity && key != propertyItems {
			return nil, fmt.Errorf("%s: OriginGroups property %q is not understood", distributionID, key)
		}
	}
	var items []json.RawMessage
	if rawItems, ok := properties[propertyItems]; ok {
		if err := json.Unmarshal(rawItems, &items); err != nil {
			return nil, fmt.Errorf("%s: OriginGroups.Items: %w", distributionID, err)
		}
	}
	groups := make([]*OriginGroup, 0, len(items))
	for position, item := range items {
		group, err := parseOriginGroup(item, distributionID, position)
		if err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, nil
}

func parseOriginGroup(raw json.RawMessage, distributionID string, position int) (*OriginGroup, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: OriginGroups.Items[%d]: %w", distributionID, position, err)
	}
	group := &OriginGroup{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "Id":
			if err := json.Unmarshal(value, &group.ID); err != nil {
				return nil, fmt.Errorf("%s: OriginGroups.Items[%d].Id: %w", distributionID, position, err)
			}
		case "Members":
			members, problem := parseOriginGroupMembers(value)
			if problem != "" {
				group.Refusals = append(group.Refusals, problem)
			}
			group.Members = members
		case "FailoverCriteria":
			codes, problem := parseFailoverCriteria(value)
			if problem != "" {
				group.Refusals = append(group.Refusals, problem)
			}
			group.FailoverStatusCodes = codes
		default:
			group.Refusals = append(group.Refusals,
				fmt.Sprintf("property %q is not understood", key))
		}
	}
	if group.ID == "" {
		group.Refusals = append(group.Refusals, "origin group has no Id")
	}
	if len(group.Members) == 0 {
		group.Refusals = append(group.Refusals, "origin group has no members")
	}
	return group, nil
}

func parseOriginGroupMembers(raw json.RawMessage) ([]string, string) {
	var members []struct {
		OriginID string `json:"OriginId"`
	}
	if err := json.Unmarshal(raw, &members); err == nil {
		out := make([]string, 0, len(members))
		for _, member := range members {
			if member.OriginID == "" {
				return nil, "origin group member has no OriginId"
			}
			out = append(out, member.OriginID)
		}
		return out, ""
	}
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, "origin group Members is not a list or object"
	}
	var items []json.RawMessage
	if rawItems, ok := properties[propertyItems]; ok {
		if err := json.Unmarshal(rawItems, &items); err != nil {
			return nil, "origin group Members.Items is not a list"
		}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		var member struct {
			OriginID string `json:"OriginId"`
		}
		if err := json.Unmarshal(item, &member); err != nil || member.OriginID == "" {
			return nil, "origin group member has no OriginId"
		}
		out = append(out, member.OriginID)
	}
	return out, ""
}

func parseFailoverCriteria(raw json.RawMessage) ([]int, string) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, "FailoverCriteria is not an object"
	}
	rawStatus, ok := properties["StatusCodes"]
	if !ok {
		return nil, ""
	}
	var codes []int
	if decodeErr := json.Unmarshal(rawStatus, &codes); decodeErr == nil {
		return codes, ""
	}
	statusProperties, err := decodeObject(rawStatus)
	if err != nil {
		return nil, "FailoverCriteria.StatusCodes is not a list or object"
	}
	if rawItems, ok := statusProperties[propertyItems]; ok {
		if err := json.Unmarshal(rawItems, &codes); err != nil {
			return nil, "FailoverCriteria.StatusCodes.Items is not a list"
		}
	}
	return codes, ""
}

//nolint:gocognit,gocyclo // the switch enumerates the function property inventory
func parseFunction(stack, id string, resource Resource, index *resourceIndex) (*Function, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	function := &Function{LogicalID: index.qualified(stack, id), Stack: stack}
	var kvsAssociations json.RawMessage
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case "AutoPublish":
			function.Reported = append(function.Reported, reportProperty("function", key))
		case "FunctionCode":
			if err := json.Unmarshal(value, &function.Code); err != nil {
				return nil, fmt.Errorf("%s/%s: FunctionCode: %w", stack, id, err)
			}
		case "FunctionConfig":
			config, err := decodeObject(value)
			if err != nil {
				return nil, fmt.Errorf("%s/%s: FunctionConfig: %w", stack, id, err)
			}
			for _, configKey := range sortedKeys(config) {
				switch configKey {
				case "Runtime":
					if err := json.Unmarshal(config[configKey], &function.Runtime); err != nil {
						return nil, fmt.Errorf("%s/%s: FunctionConfig.Runtime: %w", stack, id, err)
					}
				case propertyComment:
					if err := json.Unmarshal(config[configKey], &function.Comment); err != nil {
						return nil, fmt.Errorf("%s/%s: FunctionConfig.Comment: %w", stack, id, err)
					}
					function.Reported = append(function.Reported, reportProperty("function", propertyComment))
				case propertyKeyValueStoreAssociations:
					kvsAssociations = config[configKey]
				default:
					if _, known := functionConfigPropertyInventory[configKey]; !known {
						function.Refusals = append(function.Refusals,
							fmt.Sprintf("FunctionConfig property %q is not understood", configKey))
					}
				}
			}
		case propertyKeyValueStoreAssociations:
			kvsAssociations = value
		case propertyName:
			function.Reported = append(function.Reported, reportProperty("function", key))
		default:
			if _, known := functionPropertyInventory[key]; !known {
				function.Refusals = append(function.Refusals,
					fmt.Sprintf("function property %q is not understood", key))
			}
		}
	}
	function.CodeBytes = len(function.Code)
	if function.Code == "" {
		function.Refusals = append(function.Refusals, "FunctionCode is empty")
	}
	switch function.Runtime {
	case runtimeJS10, runtimeJS20:
	default:
		function.Refusals = append(function.Refusals,
			fmt.Sprintf("runtime %q is not a CloudFront Functions JavaScript runtime", function.Runtime))
	}
	if len(kvsAssociations) > 0 {
		stores, problems := parseKeyValueStoreAssociations(kvsAssociations, stack, index, function.Runtime)
		function.Refusals = append(function.Refusals, problems...)
		if len(stores) > 0 {
			function.KeyValueStore = stores[0]
		}
	}
	return function, nil
}

func parseOriginAccessControl(stack, id string, resource Resource, index *resourceIndex) (*OriginAccessControl, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	oac := &OriginAccessControl{LogicalID: index.qualified(stack, id), Stack: stack}
	for _, key := range sortedKeys(properties) {
		if key != "OriginAccessControlConfig" {
			oac.Reported = append(oac.Reported,
				fmt.Sprintf("origin access control property %q is not understood", key))
		}
	}
	configRaw, ok := properties["OriginAccessControlConfig"]
	if !ok {
		oac.Reported = append(oac.Reported, "origin access control has no OriginAccessControlConfig")
		return oac, nil
	}
	config, err := decodeObject(configRaw)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: OriginAccessControlConfig: %w", stack, id, err)
	}
	for _, key := range sortedKeys(config) {
		switch key {
		case "OriginAccessControlOriginType":
			if err := json.Unmarshal(config[key], &oac.OriginType); err != nil {
				return nil, fmt.Errorf("%s/%s: OriginAccessControlOriginType: %w", stack, id, err)
			}
		case "SigningBehavior":
			if err := json.Unmarshal(config[key], &oac.SigningBehavior); err != nil {
				return nil, fmt.Errorf("%s/%s: SigningBehavior: %w", stack, id, err)
			}
		case "SigningProtocol":
			if err := json.Unmarshal(config[key], &oac.SigningProtocol); err != nil {
				return nil, fmt.Errorf("%s/%s: SigningProtocol: %w", stack, id, err)
			}
		default:
			if _, known := originAccessControlConfigPropertyInventory[key]; !known {
				oac.Reported = append(oac.Reported,
					fmt.Sprintf("OriginAccessControlConfig property %q is not understood", key))
			}
		}
	}
	return oac, nil
}

func isEmptyValue(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return typed == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

func isEmptyArray(raw json.RawMessage) bool {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return false
	}
	return len(values) == 0
}

func decodeObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func decodeIntPointer(raw json.RawMessage) (*int, error) {
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

// decodeObjectOrNil reports whether raw is a JSON object.
func decodeObjectOrNil(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return value, true
}
