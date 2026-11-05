package localcloudfront

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha1" //nolint:gosec // CloudFront's default signed-URL hash algorithm is SHA-1
	"crypto/sha256"
	"crypto/x509"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Signed URLs and signed cookies.
//
// A cache behavior whose TrustedKeyGroups is enabled requires every request
// except OPTIONS to carry a valid signed URL or signed cookie:
// "A distribution requires signed URLs or cookies only for files that are
// associated with the corresponding cache behaviors" and "When you add a
// signer, CloudFront rejects requests that don't include a valid signed URL or
// signed cookie".
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html

// PublicKey is one AWS::CloudFront::PublicKey. ID is the local Key-Pair-Id the
// runner assigns deterministically from the assembly, printed by plan and
// session describe so an application can sign.
type PublicKey struct {
	LogicalID  string   `json:"logicalId"`
	Stack      string   `json:"stack"`
	Name       string   `json:"name,omitempty"`
	Comment    string   `json:"comment,omitempty"`
	EncodedKey string   `json:"-"`
	ID         string   `json:"keyPairId"`
	Reported   []string `json:"reported,omitempty"`
	Refusals   []string `json:"refusals,omitempty"`

	key crypto.PublicKey
}

// Servable reports whether the public key parsed.
func (k *PublicKey) Servable() bool { return k != nil && len(k.Refusals) == 0 }

// PublicKey identifies the crypto key for verification.
func (k *PublicKey) PublicKey() crypto.PublicKey { return k.key }

// KeyGroup is one AWS::CloudFront::KeyGroup.
type KeyGroup struct {
	LogicalID string   `json:"logicalId"`
	Stack     string   `json:"stack"`
	Name      string   `json:"name,omitempty"`
	Comment   string   `json:"comment,omitempty"`
	Items     []string `json:"items,omitempty"`
	Reported  []string `json:"reported,omitempty"`
	Refusals  []string `json:"refusals,omitempty"`
}

// Servable reports whether the key group can be used.
func (g *KeyGroup) Servable() bool { return g != nil && len(g.Refusals) == 0 }

// TrustedKeyGroups is the behavior's TrustedKeyGroups setting.
type TrustedKeyGroups struct {
	Enabled bool     `json:"enabled"`
	Items   []string `json:"items,omitempty"`
}

// localPublicKeyID derives the deterministic local Key-Pair-Id for a public
// key. CloudFront public key ids look like K2JCJMDEHXQW5F; the local id keeps
// the same shape so a signer treats it the same way.
func localPublicKeyID(logicalID string) string {
	sum := sha256.Sum256([]byte("cloudfront-public-key:" + logicalID))
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])
	return "K" + encoded[:13]
}

func parsePublicKey(stack, id string, resource Resource, index *resourceIndex) (*PublicKey, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	key := &PublicKey{LogicalID: index.qualified(stack, id), Stack: stack}
	configRaw, ok := properties["PublicKeyConfig"]
	if !ok {
		key.Refusals = append(key.Refusals, "PublicKeyConfig is missing")
		return key, nil
	}
	config, err := decodeObject(configRaw)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: PublicKeyConfig: %w", stack, id, err)
	}
	for _, name := range sortedKeys(config) {
		switch name {
		case "CallerReference":
			key.Reported = append(key.Reported, reportProperty("public key", name))
		case propertyComment:
			if err := json.Unmarshal(config[name], &key.Comment); err != nil {
				return nil, fmt.Errorf("%s/%s: PublicKeyConfig.Comment: %w", stack, id, err)
			}
			key.Reported = append(key.Reported, reportProperty("public key", name))
		case "EncodedKey":
			if err := json.Unmarshal(config[name], &key.EncodedKey); err != nil {
				return nil, fmt.Errorf("%s/%s: PublicKeyConfig.EncodedKey: %w", stack, id, err)
			}
		case propertyName:
			if err := json.Unmarshal(config[name], &key.Name); err != nil {
				return nil, fmt.Errorf("%s/%s: PublicKeyConfig.Name: %w", stack, id, err)
			}
			key.Reported = append(key.Reported, reportProperty("public key", name))
		default:
			key.Refusals = append(key.Refusals, fmt.Sprintf("PublicKeyConfig property %q is not understood", name))
		}
	}
	key.ID = localPublicKeyID(key.LogicalID)
	parsed, problem := parsePublicKeyPEM(key.EncodedKey)
	if problem != "" {
		key.Refusals = append(key.Refusals, problem)
		return key, nil
	}
	key.key = parsed
	return key, nil
}

// parsePublicKeyPEM accepts the CloudFormation EncodedKey form: the PEM text
// itself, with the BEGIN/END lines. CloudFront documents a 2048-bit RSA or
// 256-bit ECDSA key:
// "RSA 2048 or ECDSA 256 key pair ... base64-encoded PEM".
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html
func parsePublicKeyPEM(encoded string) (crypto.PublicKey, string) {
	trimmed := strings.TrimSpace(encoded)
	if trimmed == "" {
		return nil, "PublicKeyConfig.EncodedKey is empty"
	}
	block, _ := pem.Decode([]byte(trimmed))
	if block == nil {
		// CloudFront also accepts the base64 body without the PEM framing in
		// some console paths; decode it before giving up.
		if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil {
			block, _ = pem.Decode(decoded)
			if block == nil {
				if parsed, err := x509.ParsePKIXPublicKey(decoded); err == nil {
					return checkPublicKeySize(parsed)
				}
			}
		}
		if block == nil {
			return nil, "PublicKeyConfig.EncodedKey is not a PEM public key"
		}
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Sprintf("PublicKeyConfig.EncodedKey is not a PKIX public key: %v", err)
	}
	return checkPublicKeySize(parsed)
}

func checkPublicKeySize(key crypto.PublicKey) (crypto.PublicKey, string) {
	switch typed := key.(type) {
	case *rsa.PublicKey:
		if typed.N.BitLen() != 2048 {
			return nil, fmt.Sprintf("RSA public key is %d bits; CloudFront requires 2048", typed.N.BitLen())
		}
		return typed, ""
	case *ecdsa.PublicKey:
		if typed.Curve != elliptic.P256() {
			return nil, "ECDSA public key is not P-256; CloudFront requires ECDSA 256"
		}
		return typed, ""
	default:
		return nil, fmt.Sprintf("public key type %T is not RSA or ECDSA", key)
	}
}

func parseKeyGroup(stack, id string, resource Resource, index *resourceIndex) (*KeyGroup, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	group := &KeyGroup{LogicalID: index.qualified(stack, id), Stack: stack}
	configRaw, ok := properties["KeyGroupConfig"]
	if !ok {
		group.Refusals = append(group.Refusals, "KeyGroupConfig is missing")
		return group, nil
	}
	config, err := decodeObject(configRaw)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: KeyGroupConfig: %w", stack, id, err)
	}
	for _, name := range sortedKeys(config) {
		switch name {
		case propertyComment:
			if err := json.Unmarshal(config[name], &group.Comment); err != nil {
				return nil, fmt.Errorf("%s/%s: KeyGroupConfig.Comment: %w", stack, id, err)
			}
			group.Reported = append(group.Reported, reportProperty("key group", name))
		case propertyItems:
			items, problem := parseKeyGroupItems(config[name], stack, index)
			if problem != "" {
				group.Refusals = append(group.Refusals, problem)
				continue
			}
			group.Items = items
		case propertyName:
			if err := json.Unmarshal(config[name], &group.Name); err != nil {
				return nil, fmt.Errorf("%s/%s: KeyGroupConfig.Name: %w", stack, id, err)
			}
			group.Reported = append(group.Reported, reportProperty("key group", name))
		default:
			group.Refusals = append(group.Refusals, fmt.Sprintf("KeyGroupConfig property %q is not understood", name))
		}
	}
	if len(group.Items) == 0 {
		group.Refusals = append(group.Refusals, "KeyGroupConfig has no public keys")
	}
	// "up to four key groups per distribution, five public keys per key group".
	if len(group.Items) > 5 {
		group.Refusals = append(group.Refusals, fmt.Sprintf(
			"KeyGroupConfig names %d public keys; CloudFront allows five per key group", len(group.Items)))
	}
	return group, nil
}

func parseKeyGroupItems(raw json.RawMessage, stack string, index *resourceIndex) ([]string, string) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		var wrapped map[string]json.RawMessage
		if decodeErr := json.Unmarshal(raw, &wrapped); decodeErr != nil {
			return nil, "KeyGroupConfig.Items is not a list"
		}
		itemsRaw, ok := wrapped[propertyItems]
		if !ok {
			return nil, "KeyGroupConfig.Items has no Items"
		}
		if err := json.Unmarshal(itemsRaw, &values); err != nil {
			return nil, "KeyGroupConfig.Items.Items is not a list"
		}
	}
	out := make([]string, 0, len(values))
	for position, value := range values {
		qualified, ok := resolveResourceRef(value, stack, index)
		if !ok {
			return nil, fmt.Sprintf("KeyGroupConfig.Items[%d] does not reference an AWS::CloudFront::PublicKey in this assembly", position)
		}
		resource, found := index.lookup(stack, strings.TrimPrefix(qualified, stack+"/"))
		if !found || resource.Type != typePublicKey {
			return nil, fmt.Sprintf("KeyGroupConfig.Items[%d] does not reference an AWS::CloudFront::PublicKey in this assembly", position)
		}
		out = append(out, qualified)
	}
	return out, ""
}

// parseTrustedKeyGroups reads a behavior's TrustedKeyGroups. A disabled entry
// or an empty list is reported; a trusted signer list is refused by name.
//
//nolint:gocognit,gocyclo // the list and object forms of the CloudFormation shape
func parseTrustedKeyGroups(raw json.RawMessage, stack string, index *resourceIndex) (*TrustedKeyGroups, string) {
	// The CDK L2 emits the list form ([{Ref: KeyGroup}, ...]); the
	// CloudFormation shape is {Enabled, Items}. Both name the same trusted
	// signers, so both are accepted.
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err == nil {
		settings := &TrustedKeyGroups{Enabled: true}
		for position, item := range values {
			qualified, ok := resolveResourceRef(item, stack, index)
			if !ok {
				return nil, fmt.Sprintf("TrustedKeyGroups[%d] does not reference an AWS::CloudFront::KeyGroup in this assembly", position)
			}
			resource, found := index.lookup(stack, strings.TrimPrefix(qualified, stack+"/"))
			if !found || resource.Type != typeKeyGroup {
				return nil, fmt.Sprintf("TrustedKeyGroups[%d] does not reference an AWS::CloudFront::KeyGroup in this assembly", position)
			}
			settings.Items = append(settings.Items, qualified)
		}
		if len(settings.Items) == 0 {
			return nil, ""
		}
		if len(settings.Items) > 4 {
			return nil, fmt.Sprintf("TrustedKeyGroups names %d key groups; CloudFront allows four per distribution", len(settings.Items))
		}
		return settings, ""
	}
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, "TrustedKeyGroups is not an object"
	}
	settings := &TrustedKeyGroups{}
	for _, name := range sortedKeys(properties) {
		switch name {
		case "Enabled":
			if err := json.Unmarshal(properties[name], &settings.Enabled); err != nil {
				return nil, "TrustedKeyGroups.Enabled is not a boolean"
			}
		case propertyItems:
			var items []json.RawMessage
			if err := json.Unmarshal(properties[name], &items); err != nil {
				return nil, "TrustedKeyGroups.Items is not a list"
			}
			for position, item := range items {
				qualified, ok := resolveResourceRef(item, stack, index)
				if !ok {
					return nil, fmt.Sprintf("TrustedKeyGroups.Items[%d] does not reference an AWS::CloudFront::KeyGroup in this assembly", position)
				}
				resource, found := index.lookup(stack, strings.TrimPrefix(qualified, stack+"/"))
				if !found || resource.Type != typeKeyGroup {
					return nil, fmt.Sprintf("TrustedKeyGroups.Items[%d] does not reference an AWS::CloudFront::KeyGroup in this assembly", position)
				}
				settings.Items = append(settings.Items, qualified)
			}
		default:
			return nil, fmt.Sprintf("TrustedKeyGroups property %q is not understood", name)
		}
	}
	if !settings.Enabled {
		return nil, ""
	}
	if len(settings.Items) == 0 {
		return nil, "TrustedKeyGroups is enabled but names no key group"
	}
	if len(settings.Items) > 4 {
		return nil, fmt.Sprintf("TrustedKeyGroups names %d key groups; CloudFront allows four per distribution", len(settings.Items))
	}
	return settings, ""
}

// SigningParameters are the query parameters CloudFront reserves for signed
// URLs. A viewer request that names one is signing material, never content.
var signingParameters = map[string]bool{
	"Expires":        true,
	"Signature":      true,
	"Key-Pair-Id":    true,
	"Hash-Algorithm": true,
	"Policy":         true,
}

// signingCookies are the exact, case-sensitive signed cookie names.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html
const (
	cookieSignature     = "CloudFront-Signature"
	cookieKeyPairID     = "CloudFront-Key-Pair-Id"
	cookieHashAlgorithm = "CloudFront-Hash-Algorithm"
	cookieExpires       = "CloudFront-Expires"
	cookiePolicy        = "CloudFront-Policy"
)

// signedAccessError names why a signed request was rejected. The gateway turns
// it into the documented 403.
type signedAccessError struct {
	Reason string
}

func (e *signedAccessError) Error() string { return e.Reason }

// checkSignedAccess validates the request against the behavior's trusted key
// groups. It returns nil when the behavior has no trusted key groups, the
// method is OPTIONS, or the signature verifies.
//
// "CloudFront doesn't require a signed URL or signed cookies for OPTIONS
// requests."
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html
func (g *Gateway) checkSignedAccess(state *requestState, behavior *Behavior, now time.Time) error {
	if behavior == nil || behavior.TrustedKeyGroups == nil || !behavior.TrustedKeyGroups.Enabled {
		return nil
	}
	if state.Method == http.MethodOptions {
		return nil
	}
	keys, problem := g.trustedKeys(behavior)
	if problem != "" {
		return &signedAccessError{Reason: problem}
	}
	material, problem := signedMaterial(state)
	if problem != "" {
		return &signedAccessError{Reason: problem}
	}
	key, ok := keys[material.keyPairID]
	if !ok {
		return &signedAccessError{Reason: fmt.Sprintf(
			"Key-Pair-Id %q is not a public key in any key group trusted by cache behavior %q", material.keyPairID, behavior.PathPattern)}
	}
	return verifySignature(key, material, state, now)
}

// trustedKeys resolves the behavior's key groups to their public keys by local
// Key-Pair-Id.
func (g *Gateway) trustedKeys(behavior *Behavior) (map[string]*PublicKey, string) {
	if g.Topology == nil {
		return nil, "the gateway has no topology to resolve trusted key groups"
	}
	keys := map[string]*PublicKey{}
	for _, groupID := range behavior.TrustedKeyGroups.Items {
		group, ok := g.Topology.KeyGroup(groupID)
		if !ok {
			return nil, fmt.Sprintf("key group %q is not in the assembly", groupID)
		}
		if !group.Servable() {
			return nil, fmt.Sprintf("key group %q is refused: %s", groupID, strings.Join(group.Refusals, "; "))
		}
		for _, keyID := range group.Items {
			key, ok := g.Topology.PublicKey(keyID)
			if !ok {
				return nil, fmt.Sprintf("public key %q in key group %q is not in the assembly", keyID, groupID)
			}
			if !key.Servable() {
				return nil, fmt.Sprintf("public key %q is refused: %s", keyID, strings.Join(key.Refusals, "; "))
			}
			keys[key.ID] = key
		}
	}
	if len(keys) == 0 {
		return nil, "the behavior trusts no public key"
	}
	return keys, ""
}

// signingMaterial is one parsed signed URL or signed cookie set.
type signingMaterial struct {
	keyPairID     string
	signature     string
	hashAlgorithm string
	policy        string
	expires       string
	fromCookie    bool
}

func signedMaterial(state *requestState) (*signingMaterial, string) {
	query, err := url.ParseQuery(state.RawQuery)
	if err != nil {
		return nil, fmt.Sprintf("the query string %q is malformed: %v", state.RawQuery, err)
	}
	if signature := query.Get("Signature"); signature != "" {
		return &signingMaterial{
			keyPairID:     query.Get("Key-Pair-Id"),
			signature:     signature,
			hashAlgorithm: query.Get("Hash-Algorithm"),
			policy:        query.Get("Policy"),
			expires:       query.Get("Expires"),
		}, ""
	}
	cookies := cookieMap(state.Header)
	if signature := cookies[cookieSignature]; signature != "" {
		return &signingMaterial{
			keyPairID:     cookies[cookieKeyPairID],
			signature:     signature,
			hashAlgorithm: cookies[cookieHashAlgorithm],
			policy:        cookies[cookiePolicy],
			expires:       cookies[cookieExpires],
			fromCookie:    true,
		}, ""
	}
	return nil, "the request has no signed URL or signed cookie and the cache behavior requires one"
}

func cookieMap(header http.Header) map[string]string {
	out := map[string]string{}
	for _, pair := range parseCookiePairs(header.Values("Cookie")) {
		out[pair.Name] = pair.Value
	}
	return out
}

func verifySignature(key *PublicKey, material *signingMaterial, state *requestState, now time.Time) error {
	hashAlgorithm := strings.ToUpper(strings.TrimSpace(material.hashAlgorithm))
	var hash crypto.Hash
	switch hashAlgorithm {
	case "", "SHA1":
		hash = crypto.SHA1
	case "SHA256":
		hash = crypto.SHA256
	default:
		return &signedAccessError{Reason: fmt.Sprintf("Hash-Algorithm %q is not SHA1 or SHA256", material.hashAlgorithm)}
	}
	var policy string
	if material.policy != "" {
		decoded, err := decodeBase64URL(material.policy)
		if err != nil {
			return &signedAccessError{Reason: fmt.Sprintf("Policy is not valid base64: %v", err)}
		}
		policy = string(decoded)
	} else {
		if material.expires == "" {
			return &signedAccessError{Reason: "the signed request has neither Expires nor Policy"}
		}
		expires, parseErr := strconv.ParseInt(material.expires, 10, 64)
		if parseErr != nil {
			return &signedAccessError{Reason: fmt.Sprintf("Expires %q is not a Unix timestamp", material.expires)}
		}
		// The canned policy is canonical JSON with no whitespace. Building it
		// through encoding/json keeps the resource string escaped exactly as a
		// signer would, in the documented field order.
		canned := cannedPolicy{Statement: []cannedStatement{{
			Resource: signedRequestURL(state),
			Condition: cannedCondition{
				DateLessThan: cannedDate{EpothTime: expires},
			},
		}}}
		encoded, encodeErr := json.Marshal(canned)
		if encodeErr != nil {
			return &signedAccessError{Reason: fmt.Sprintf("the canned policy cannot be encoded: %v", encodeErr)}
		}
		policy = string(encoded)
	}
	signature, decodeErr := decodeBase64URL(material.signature)
	if decodeErr != nil {
		return &signedAccessError{Reason: fmt.Sprintf("Signature is not valid base64: %v", decodeErr)}
	}
	digest := hashBytes(hash, []byte(policy)) //nolint:gosec // the hash is the policy's chosen algorithm
	if err := verifyDigest(key.PublicKey(), hash, digest, signature); err != nil {
		return &signedAccessError{Reason: "the signature does not match the policy statement"}
	}
	statement, err := parsePolicyStatement(policy)
	if err != nil {
		return &signedAccessError{Reason: err.Error()}
	}
	return statement.evaluate(signedRequestURL(state), state.ViewerIP, now)
}

func hashBytes(hash crypto.Hash, data []byte) []byte {
	switch hash {
	case crypto.SHA1:
		sum := sha1.Sum(data) //nolint:gosec // CloudFront's default signed-URL hash algorithm is SHA-1
		return sum[:]
	default:
		sum := sha256.Sum256(data)
		return sum[:]
	}
}

func verifyDigest(publicKey crypto.PublicKey, hash crypto.Hash, digest, signature []byte) error {
	switch typed := publicKey.(type) {
	case *rsa.PublicKey:
		return rsa.VerifyPKCS1v15(typed, hash, digest, signature)
	case *ecdsa.PublicKey:
		if !ecdsa.VerifyASN1(typed, digest, signature) {
			return fmt.Errorf("ECDSA signature did not verify")
		}
		return nil
	default:
		return fmt.Errorf("unsupported public key type %T", publicKey)
	}
}

// signedRequestURL is the raw request URL the policy Resource is matched
// against, with the signing parameters removed. "CloudFront matches the policy
// Resource against the raw (undecoded) request URL."
func signedRequestURL(state *requestState) string {
	host := state.Host
	if host == "" {
		host = "localhost"
	}
	query := baseQueryWithoutSigningParameters(state.RawQuery)
	if query == "" {
		return "http://" + host + state.URI
	}
	return "http://" + host + state.URI + "?" + query
}

func baseQueryWithoutSigningParameters(raw string) string {
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, "&")
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		name, _, _ := strings.Cut(part, "=")
		if signingParameters[name] {
			continue
		}
		kept = append(kept, part)
	}
	return strings.Join(kept, "&")
}

// cannedPolicy is the canonical canned policy CloudFront signs. The field order
// is part of the signed string.
type cannedPolicy struct {
	Statement []cannedStatement `json:"Statement"`
}

type cannedStatement struct {
	Resource  string          `json:"Resource"`
	Condition cannedCondition `json:"Condition"`
}

type cannedCondition struct {
	DateLessThan cannedDate `json:"DateLessThan"`
}

type cannedDate struct {
	EpothTime int64 `json:"AWS:EpochTime"`
}

// policyStatement is one signed policy statement.
type policyStatement struct {
	Resource  string
	Condition struct {
		DateLessThan *struct {
			EpochTime int64 `json:"AWS:EpochTime"`
		} `json:"DateLessThan"`
		DateGreaterThan *struct {
			EpochTime int64 `json:"AWS:EpochTime"`
		} `json:"DateGreaterThan"`
		IPAddress *struct {
			SourceIP string `json:"AWS:SourceIp"`
		} `json:"IpAddress"`
	} `json:"Condition"`
}

func parsePolicyStatement(policy string) (*policyStatement, error) {
	var decoded struct {
		Statement []policyStatement `json:"Statement"`
	}
	if err := json.Unmarshal([]byte(policy), &decoded); err != nil {
		return nil, fmt.Errorf("the policy statement is not valid JSON: %v", err)
	}
	if len(decoded.Statement) != 1 {
		return nil, fmt.Errorf("the policy statement has %d statements; CloudFront allows one", len(decoded.Statement))
	}
	if decoded.Statement[0].Condition.DateLessThan == nil {
		return nil, fmt.Errorf("the policy statement has no DateLessThan condition")
	}
	return &decoded.Statement[0], nil
}

// evaluate applies the policy conditions on the run clock.
func (s *policyStatement) evaluate(requestURL, viewerIP string, now time.Time) error {
	if s.Resource != "" && !matchResourcePattern(s.Resource, requestURL) {
		return &signedAccessError{Reason: fmt.Sprintf("the policy Resource %q does not match the request URL %q", s.Resource, requestURL)}
	}
	if now.Unix() >= s.Condition.DateLessThan.EpochTime {
		return &signedAccessError{Reason: "the signed URL or cookie has expired"}
	}
	if s.Condition.DateGreaterThan != nil && now.Unix() <= s.Condition.DateGreaterThan.EpochTime {
		return &signedAccessError{Reason: "the signed URL or cookie is not valid yet"}
	}
	if s.Condition.IPAddress != nil {
		if problem := matchSourceIP(s.Condition.IPAddress.SourceIP, viewerIP); problem != "" {
			return &signedAccessError{Reason: problem}
		}
	}
	return nil
}

// matchSourceIP applies the IPv4 CIDR restriction. "IP addresses in IPv6 format
// ... are not supported."
func matchSourceIP(cidr, viewerIP string) string {
	if strings.Contains(cidr, ":") {
		return fmt.Sprintf("IpAddress %q is IPv6; CloudFront does not support IPv6 in custom policies", cidr)
	}
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return fmt.Sprintf("IpAddress %q is not an IPv4 CIDR range", cidr)
	}
	address := net.ParseIP(viewerIP)
	if address == nil || address.To4() == nil {
		return fmt.Sprintf("the viewer address %q is not an IPv4 address", viewerIP)
	}
	if !network.Contains(address) {
		return fmt.Sprintf("the viewer address %s is outside the policy IpAddress %s", viewerIP, cidr)
	}
	return ""
}

// matchResourcePattern matches a policy Resource against the raw request URL.
// The URL is split into protocol, domain, path and query sections and a
// wildcard applies only inside its section, with the four documented
// exceptions: a trailing asterisk in the path also matches the query, a
// trailing asterisk in the domain also matches the path and query, a URL that
// starts with an asterisk in the domain implies a protocol wildcard, and "*"
// alone matches any URL.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-creating-signed-url-custom-policy.html
func matchResourcePattern(pattern, requestURL string) bool {
	if pattern == "*" || pattern == "*://*" {
		return true
	}
	patternSections := splitResource(pattern)
	urlSections := splitResource(requestURL)
	if patternSections.protocol == "" && strings.HasPrefix(patternSections.domain, "*") {
		patternSections.protocol = "*"
	}
	if strings.HasSuffix(patternSections.domain, "*") && patternSections.path == "" {
		patternSections.path = "*"
		patternSections.query = "*"
	}
	if strings.HasSuffix(patternSections.path, "*") && patternSections.query == "" {
		patternSections.query = "*"
	}
	if patternSections.path == "" {
		patternSections.path = "/"
	}
	if urlSections.path == "" {
		urlSections.path = "/"
	}
	if patternSections.protocol == "" {
		// Without a protocol section the pattern still has to match the URL's
		// protocol ("A URL in the policy can omit the protocol section and
		// start with an asterisk in the domain section").
		patternSections.protocol = "*"
	}
	if !globMatch(patternSections.protocol, urlSections.protocol) {
		return false
	}
	if !globMatch(patternSections.domain, urlSections.domain) {
		return false
	}
	if !globMatch(patternSections.path, urlSections.path) {
		return false
	}
	return globMatch(patternSections.query, urlSections.query)
}

type resourceSections struct {
	protocol string
	domain   string
	path     string
	query    string
}

// splitResource divides a URL into protocol://domain/path?query. A leading
// asterisk without "://" is treated as the domain section.
func splitResource(raw string) resourceSections {
	var sections resourceSections
	rest := raw
	if index := strings.Index(rest, "://"); index >= 0 {
		sections.protocol = rest[:index]
		rest = rest[index+3:]
	}
	if index := strings.IndexByte(rest, '?'); index >= 0 {
		sections.query = rest[index+1:]
		rest = rest[:index]
	}
	if index := strings.IndexByte(rest, '/'); index >= 0 {
		sections.path = rest[index:]
		rest = rest[:index]
	}
	sections.domain = rest
	return sections
}

// globMatch matches a section pattern: "*" matches zero or more characters and
// "?" exactly one. A literal semicolon is data, and the page states that a
// wildcard cannot match across it; the matcher follows that rule.
func globMatch(pattern, value string) bool {
	if pattern == "" {
		return value == ""
	}
	// Iterative glob with backtracking for a single star.
	patternIndex, valueIndex := 0, 0
	starIndex, starValue := -1, 0
	for valueIndex < len(value) {
		switch {
		case patternIndex < len(pattern) && (pattern[patternIndex] == '?' && value[valueIndex] != ';'):
			patternIndex++
			valueIndex++
		case patternIndex < len(pattern) && pattern[patternIndex] == value[valueIndex]:
			patternIndex++
			valueIndex++
		case patternIndex < len(pattern) && pattern[patternIndex] == '*':
			starIndex = patternIndex
			starValue = valueIndex
			patternIndex++
		case starIndex >= 0 && value[starValue] != ';':
			starValue++
			valueIndex = starValue
			patternIndex = starIndex + 1
		default:
			return false
		}
	}
	for patternIndex < len(pattern) && pattern[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(pattern)
}

// decodeBase64URL reverses CloudFront's base64 character replacements:
// "+" becomes "-", "=" becomes "_" and "/" becomes "~".
func decodeBase64URL(value string) ([]byte, error) {
	replaced := strings.NewReplacer("-", "+", "_", "=", "~", "/").Replace(value)
	return base64.StdEncoding.DecodeString(replaced)
}
