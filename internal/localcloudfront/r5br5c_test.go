package localcloudfront

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1" //nolint:gosec // CloudFront's default signed-URL hash algorithm is SHA-1
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// testRSAKey returns a 2048-bit RSA key and its PEM public key.
func testRSAKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func testECDSAKey(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ECDSA key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func signPolicy(t *testing.T, key crypto.Signer, policy string, algorithm string) string {
	t.Helper()
	var digest []byte
	switch algorithm {
	case "SHA256":
		sum := sha256.Sum256([]byte(policy))
		digest = sum[:]
	default:
		sum := sha1.Sum([]byte(policy)) //nolint:gosec // CloudFront's default signed-URL hash algorithm is SHA-1
		digest = sum[:]
	}
	var signature []byte
	var err error
	switch typed := key.(type) {
	case *rsa.PrivateKey:
		hash := crypto.SHA256
		if algorithm == "" || algorithm == "SHA1" {
			hash = crypto.SHA1
		}
		signature, err = rsa.SignPKCS1v15(rand.Reader, typed, hash, digest)
	case *ecdsa.PrivateKey:
		signature, err = ecdsa.SignASN1(rand.Reader, typed, digest)
	default:
		t.Fatalf("unsupported signer %T", key)
	}
	if err != nil {
		t.Fatalf("sign policy: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(signature)
	return strings.NewReplacer("+", "-", "=", "_", "/", "~").Replace(encoded)
}

func signingTopology(t *testing.T, keyPEM string, keyName string) (*Gateway, *Behavior) {
	t.Helper()
	publicKey := map[string]any{
		"PublicKeyConfig": map[string]any{
			"CallerReference": "test",
			"Name":            keyName,
			"EncodedKey":      keyPEM,
		},
	}
	keyGroup := map[string]any{
		"KeyGroupConfig": map[string]any{
			"Name":  "test-group",
			"Items": []any{map[string]any{"Ref": "PublicKey"}},
		},
	}
	behavior := map[string]any{
		"PathPattern":          "*",
		"TargetOriginId":       "Origin",
		"CachePolicyId":        "658327ea-f89d-4fab-a63d-7e88639e58f6",
		"TrustedKeyGroups":     map[string]any{"Enabled": true, "Items": []any{map[string]any{"Ref": "KeyGroup"}}},
		"ViewerProtocolPolicy": "redirect-to-https",
	}
	distribution := map[string]any{
		"DistributionConfig": map[string]any{
			"DefaultCacheBehavior": behavior,
			"Enabled":              true,
			"Origins": []any{map[string]any{
				"Id":         "Origin",
				"DomainName": "bucket.s3.local",
				"S3OriginConfig": map[string]any{
					"OriginAccessIdentity": "",
				},
			}},
		},
	}
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"PublicKey":    {Type: typePublicKey, Properties: mustJSON(t, publicKey)},
			"KeyGroup":     {Type: typeKeyGroup, Properties: mustJSON(t, keyGroup)},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, distribution)},
		},
	}})
	if err != nil {
		t.Fatalf("parse templates: %v", err)
	}
	dist := topology.Distributions[0]
	if !dist.Servable() {
		t.Fatalf("distribution must be servable: %v", dist.Refusals)
	}
	gateway := NewGateway(dist, topology, nil, nil, nil)
	return gateway, dist.DefaultBehavior
}

func signedRequestState(url string) *requestState {
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	return newRequestState(request, nil)
}

func TestSignedURLCannedPolicyRSAAndSHA1Default(t *testing.T) {
	key, pemText := testRSAKey(t)
	gateway, behavior := signingTopology(t, pemText, "test-key")
	expires := time.Now().Add(time.Hour).Unix()
	url := "http://d111.cloudfront.local/private/file.txt"
	policy := fmt.Sprintf(`{"Statement":[{"Resource":%q,"Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, url, expires)
	signature := signPolicy(t, key, policy, "SHA1")
	keyID := gateway.Topology.PublicKeys[0].ID

	state := signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=%s", expires, signature, keyID))
	if err := gateway.checkSignedAccess(state, behavior, time.Now()); err != nil {
		t.Fatalf("a canned SHA-1 URL must verify: %v", err)
	}

	// The same signature with Hash-Algorithm=SHA256 must not verify.
	state = signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=%s&Hash-Algorithm=SHA256", expires, signature, keyID))
	if err := gateway.checkSignedAccess(state, behavior, time.Now()); err == nil {
		t.Fatal("a SHA-1 signature must not pass as SHA-256")
	}
}

func TestSignedURLCannedPolicySHA256AndECDSA(t *testing.T) {
	key, pemText := testECDSAKey(t)
	gateway, behavior := signingTopology(t, pemText, "ecdsa-key")
	expires := time.Now().Add(time.Hour).Unix()
	url := "http://d111.cloudfront.local/private/file.txt"
	policy := fmt.Sprintf(`{"Statement":[{"Resource":%q,"Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, url, expires)
	signature := signPolicy(t, key, policy, "SHA256")
	keyID := gateway.Topology.PublicKeys[0].ID
	state := signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=%s&Hash-Algorithm=SHA256", expires, signature, keyID))
	if err := gateway.checkSignedAccess(state, behavior, time.Now()); err != nil {
		t.Fatalf("an ECDSA SHA-256 URL must verify: %v", err)
	}
}

func TestSignedURLRejections(t *testing.T) {
	key, pemText := testRSAKey(t)
	gateway, behavior := signingTopology(t, pemText, "test-key")
	keyID := gateway.Topology.PublicKeys[0].ID
	now := time.Now()
	url := "http://d111.cloudfront.local/private/file.txt"
	expires := now.Add(time.Hour).Unix()
	canned := fmt.Sprintf(`{"Statement":[{"Resource":%q,"Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, url, expires)
	signature := signPolicy(t, key, canned, "SHA256")

	cases := []struct {
		name   string
		state  *requestState
		needle string
	}{
		{"missing", signedRequestState(url), "no signed URL or signed cookie"},
		{"wrong key", signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=K000000000000", expires, signature)), "not a public key"},
		{"expired", signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=%s&Hash-Algorithm=SHA256", now.Add(-time.Hour).Unix(), signPolicy(t, key, fmt.Sprintf(`{"Statement":[{"Resource":%q,"Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, url, now.Add(-time.Hour).Unix()), "SHA256"), keyID)), "expired"},
		{"bad signature", signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=AAAA&Key-Pair-Id=%s", expires, keyID)), "signature"},
		{"bad hash algorithm", signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=%s&Hash-Algorithm=MD5", expires, signature, keyID)), "Hash-Algorithm"},
		{"query added after signing", signedRequestState(url + fmt.Sprintf("?Expires=%d&Signature=%s&Key-Pair-Id=%s&Hash-Algorithm=SHA256&extra=1", expires, signature, keyID)), "does not match"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := gateway.checkSignedAccess(test.state, behavior, now)
			if err == nil {
				t.Fatalf("%s must be rejected", test.name)
			}
			if !strings.Contains(err.Error(), test.needle) {
				t.Fatalf("%s: %v does not name %q", test.name, err, test.needle)
			}
		})
	}
}

func TestSignedURLOPTIONSIsExempt(t *testing.T) {
	key, pemText := testRSAKey(t)
	gateway, behavior := signingTopology(t, pemText, "test-key")
	_ = key
	request := httptest.NewRequestWithContext(context.Background(), http.MethodOptions, "http://d111.cloudfront.local/private/file.txt", nil)
	state := newRequestState(request, nil)
	if err := gateway.checkSignedAccess(state, behavior, time.Now()); err != nil {
		t.Fatalf("OPTIONS must not require a signature: %v", err)
	}
}

func TestSignedCookieCustomPolicy(t *testing.T) {
	key, pemText := testRSAKey(t)
	gateway, behavior := signingTopology(t, pemText, "test-key")
	keyID := gateway.Topology.PublicKeys[0].ID
	now := time.Now()
	url := "http://d111.cloudfront.local/private/file.txt"
	expires := now.Add(time.Hour).Unix()
	policy := fmt.Sprintf(`{"Statement":[{"Resource":%q,"Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, url+"*", expires)
	signature := signPolicy(t, key, policy, "SHA256")
	encodedPolicy := strings.NewReplacer("+", "-", "=", "_", "/", "~").Replace(base64.StdEncoding.EncodeToString([]byte(policy)))

	state := signedRequestState(url)
	state.Header.Set("Cookie", fmt.Sprintf("CloudFront-Policy=%s; CloudFront-Signature=%s; CloudFront-Key-Pair-Id=%s; CloudFront-Hash-Algorithm=SHA256",
		encodedPolicy, signature, keyID))
	if err := gateway.checkSignedAccess(state, behavior, now); err != nil {
		t.Fatalf("a custom-policy signed cookie must verify: %v", err)
	}

	// Cookie names are case-sensitive.
	state = signedRequestState(url)
	state.Header.Set("Cookie", fmt.Sprintf("cloudfront-policy=%s; cloudfront-signature=%s; cloudfront-key-pair-id=%s",
		encodedPolicy, signature, keyID))
	if err := gateway.checkSignedAccess(state, behavior, now); err == nil {
		t.Fatal("lower-case cookie names are not signed cookies")
	}
}

func TestCustomPolicyConditions(t *testing.T) {
	now := time.Now()
	base := func(condition string) string {
		return fmt.Sprintf(`{"Statement":[{"Resource":"http://d111.cloudfront.local/*","Condition":%s}]}`, condition)
	}
	cases := []struct {
		name      string
		policy    string
		viewerIP  string
		wantError string
	}{
		{"valid", base(fmt.Sprintf(`{"DateLessThan":{"AWS:EpochTime":%d}}`, now.Add(time.Hour).Unix())), "203.0.113.5", ""},
		{"expired", base(fmt.Sprintf(`{"DateLessThan":{"AWS:EpochTime":%d}}`, now.Add(-time.Minute).Unix())), "203.0.113.5", "expired"},
		{"not yet valid", base(fmt.Sprintf(`{"DateLessThan":{"AWS:EpochTime":%d},"DateGreaterThan":{"AWS:EpochTime":%d}}`, now.Add(time.Hour).Unix(), now.Add(time.Minute).Unix())), "203.0.113.5", "not valid yet"},
		{"ip allowed", base(fmt.Sprintf(`{"DateLessThan":{"AWS:EpochTime":%d},"IpAddress":{"AWS:SourceIp":"192.0.2.0/24"}}`, now.Add(time.Hour).Unix())), "192.0.2.10", ""},
		{"ip denied", base(fmt.Sprintf(`{"DateLessThan":{"AWS:EpochTime":%d},"IpAddress":{"AWS:SourceIp":"192.0.2.0/24"}}`, now.Add(time.Hour).Unix())), "198.51.100.1", "outside the policy IpAddress"},
		{"ipv6 refused", base(fmt.Sprintf(`{"DateLessThan":{"AWS:EpochTime":%d},"IpAddress":{"AWS:SourceIp":"2001:db8::/32"}}`, now.Add(time.Hour).Unix())), "192.0.2.10", "IPv6"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			statement, err := parsePolicyStatement(test.policy)
			if err != nil {
				t.Fatalf("parse policy: %v", err)
			}
			err = statement.evaluate("http://d111.cloudfront.local/file.txt", test.viewerIP, now)
			if test.wantError == "" {
				if err != nil {
					t.Fatalf("policy must pass: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("want an error naming %q, got %v", test.wantError, err)
			}
		})
	}
}

func TestMatchResourcePatternSections(t *testing.T) {
	cases := []struct {
		pattern string
		url     string
		want    bool
	}{
		{"*", "http://d111.cloudfront.local/anything", true},
		{"https://www.example.com/hello*world", "https://www.example.com/helloworld", true},
		{"https://www.example.com/hello*world", "https://www.example.com/hello-world", true},
		{"https://www.example.com/hello*world", "https://www.example.net/hello?world", false},
		{"http://example.com/hello*", "http://example.com/hello?x=1", true},
		{"http://example.com*", "http://example.com/a/b?c=d", true},
		{"*example.com", "http://example.com/", true},
		{"*example.com", "http://example.com/a", false},
		{"https://*", "https://d111.cloudfront.local/training/orientation.pdf", true},
		{"https://d111.cloudfront.local/*game_download.zip*", "https://d111.cloudfront.local/example_game_download.zip?license=yes", true},
		{"http://example.com/path?c*", "http://example.com/path?cat", true},
		{"http://example.com/path?c*", "http://example.com/path?dog", false},
	}
	for _, test := range cases {
		if got := matchResourcePattern(test.pattern, test.url); got != test.want {
			t.Fatalf("%q against %q = %v, want %v", test.pattern, test.url, got, test.want)
		}
	}
}

func TestGeoRestrictionBlocks(t *testing.T) {
	allow := &GeoRestriction{Type: "whitelist", Locations: []string{"US", "DE"}}
	deny := &GeoRestriction{Type: "blacklist", Locations: []string{"US"}}
	cases := []struct {
		name      string
		restrict  *GeoRestriction
		country   string
		wantBlock bool
	}{
		{"allowlist inside", allow, "US", false},
		{"allowlist outside", allow, "JP", true},
		{"allowlist undetermined", allow, "", false},
		{"denylist inside", deny, "US", true},
		{"denylist outside", deny, "JP", false},
		{"denylist undetermined", deny, "", false},
		{"none", &GeoRestriction{Type: "none"}, "JP", false},
		{"nil", nil, "JP", false},
	}
	for _, test := range cases {
		if got := test.restrict.Blocks(test.country); got != test.wantBlock {
			t.Fatalf("%s: Blocks(%q) = %v, want %v", test.name, test.country, got, test.wantBlock)
		}
	}
}

func TestParseRestrictionsRefusals(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		needle string
	}{
		{"lowercase country", `{"GeoRestriction":{"RestrictionType":"whitelist","Locations":["us"]}}`, "ISO 3166-1 alpha-2"},
		{"unknown type", `{"GeoRestriction":{"RestrictionType":"sometimes","Locations":[]}}`, "RestrictionType"},
		{"empty allowlist", `{"GeoRestriction":{"RestrictionType":"whitelist","Locations":[]}}`, "no Locations"},
		{"other member", `{"GeoRestriction":{"RestrictionType":"none"},"SomethingElse":{}}`, "SomethingElse"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, refusals := parseRestrictions([]byte(test.raw), "TestDistribution")
			if len(refusals) == 0 {
				t.Fatalf("%s must be refused", test.name)
			}
			if !strings.Contains(strings.Join(refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, refusals, test.needle)
			}
		})
	}
}

func TestFieldLevelEncryptionProfileRules(t *testing.T) {
	patterns := func(values ...string) string {
		quoted := make([]string, 0, len(values))
		for _, value := range values {
			quoted = append(quoted, fmt.Sprintf("%q", value))
		}
		return strings.Join(quoted, ",")
	}
	cases := []struct {
		name    string
		fields  string
		refused bool
		needle  string
	}{
		{"valid", patterns("card", "ssn"), false, ""},
		{"wildcard", patterns("card*"), false, ""},
		{"too many", patterns("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"), true, "up to 10"},
		{"overlap", patterns("ABC*", "AB*"), true, "overlap"},
		{"bad character", patterns("card number"), true, "characters"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			profile := &FieldLevelEncryptionProfile{
				LogicalID: "Profile",
				Entities:  []EncryptionEntity{{PublicKeyID: "Key", ProviderID: "p", FieldPatterns: splitPatterns(test.fields)}},
			}
			validateFieldPatterns(profile)
			if test.refused {
				if len(profile.Refusals) == 0 || !strings.Contains(strings.Join(profile.Refusals, "\n"), test.needle) {
					t.Fatalf("%s: refusals %v do not name %q", test.name, profile.Refusals, test.needle)
				}
				return
			}
			if len(profile.Refusals) != 0 {
				t.Fatalf("%s: unexpected refusals %v", test.name, profile.Refusals)
			}
		})
	}
}

func splitPatterns(encoded string) []string {
	trimmed := strings.Trim(encoded, "[]")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, strings.Trim(part, `"`))
	}
	return out
}

func TestFieldLevelEncryptionSelectsProfile(t *testing.T) {
	config := &FieldLevelEncryptionConfig{
		ContentTypeProfileConfig: &ContentTypeProfileConfig{
			Profiles: []ContentTypeProfile{{ContentType: formContentType, Format: "URLEncoded", ProfileID: "Default"}},
		},
		QueryArgProfileConfig: &QueryArgProfileConfig{
			Profiles: []QueryArgProfile{{QueryArg: "cards", ProfileID: "Cards"}},
		},
	}
	if profile, problem := config.selectProfile("/", ""); profile != "Default" || problem != "" {
		t.Fatalf("content type profile = %q (%s)", profile, problem)
	}
	if profile, problem := config.selectProfile("/", "fle-profile=cards"); profile != "Cards" || problem != "" {
		t.Fatalf("query argument profile = %q (%s)", profile, problem)
	}
	if _, problem := config.selectProfile("/", "fle-profile=unknown"); problem == "" {
		t.Fatal("an unknown query argument profile must block when forwarding is disabled")
	}
	config.QueryArgProfileConfig.ForwardWhenQueryArgProfileIsUnknown = true
	if profile, problem := config.selectProfile("/", "fle-profile=unknown"); profile != "Default" || problem != "" {
		t.Fatalf("an unknown profile must fall back to the content type profile: %q (%s)", profile, problem)
	}
}

func TestFieldLevelEncryptionEncryptsMatchingFields(t *testing.T) {
	key, _ := testRSAKey(t)
	profile := &FieldLevelEncryptionProfile{
		LogicalID: "Profile",
		Entities: []EncryptionEntity{{
			PublicKeyID:   "Key",
			ProviderID:    "DEMO",
			FieldPatterns: []string{"card"},
		}},
	}
	keys := map[string]*PublicKey{"Key": {LogicalID: "Key", Name: "DEMOKEY", key: &key.PublicKey}}
	body := []byte("card=4111111111111111&name=Jane+Doe")
	encrypted, err := encryptFormBody(body, profile, keys, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if strings.Contains(string(encrypted), "4111111111111111") {
		t.Fatalf("the plaintext card number survived: %s", encrypted)
	}
	if !strings.Contains(string(encrypted), "name=Jane+Doe") {
		t.Fatalf("the name field must stay unchanged: %s", encrypted)
	}
	// The ciphertext field is base64 after URL decoding.
	_, value, _ := strings.Cut(string(encrypted), "card=")
	unescaped, err := url.QueryUnescape(strings.Split(value, "&")[0])
	if err != nil {
		t.Fatalf("the ciphertext is not URL-encoded: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(unescaped)
	if err != nil {
		t.Fatalf("the ciphertext must be base64: %v", err)
	}
	if len(decoded) < 100 || decoded[0] != esdkVersion {
		t.Fatalf("the ciphertext is not an AWS Encryption SDK message: %x", decoded[:min(4, len(decoded))])
	}
}

func TestKeyValueStoreImportFile(t *testing.T) {
	store := &KeyValueStore{LogicalID: "Store"}
	now := time.Now().UTC()
	if err := store.LoadImportFile([]byte(`{"data":[{"key":"a","value":"1"},{"key":"b","value":"2"}]}`), now); err != nil {
		t.Fatalf("load: %v", err)
	}
	if store.KeyCount() != 2 || store.Values["b"] != "2" {
		t.Fatalf("store values = %v", store.Values)
	}
	if store.CreatedAt.IsZero() || store.UpdatedAt.IsZero() {
		t.Fatal("the store needs creation and update timestamps for meta()")
	}
	cases := []struct {
		name    string
		payload string
		needle  string
	}{
		{"not json", "nope", "import file"},
		{"duplicate", `{"data":[{"key":"a","value":"1"},{"key":"a","value":"2"}]}`, "repeats key"},
		{"long value", `{"data":[{"key":"a","value":"` + strings.Repeat("x", kvsMaxValueBytes+1) + `"}]}`, "allows"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := (&KeyValueStore{LogicalID: "Store"}).LoadImportFile([]byte(test.payload), now)
			if err == nil || !strings.Contains(err.Error(), test.needle) {
				t.Fatalf("want an error naming %q, got %v", test.needle, err)
			}
		})
	}
}

// --- Lambda@Edge -----------------------------------------------------------

func edgeTemplate(fnProps map[string]any, versionProps map[string]any, associations []any) []Template {
	behavior := map[string]any{
		"PathPattern":    "*",
		"TargetOriginId": "Origin",
		"CachePolicyId":  "658327ea-f89d-4fab-a63d-7e88639e58f6",
		"AllowedMethods": []any{"GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"},
	}
	if associations != nil {
		behavior["LambdaFunctionAssociations"] = associations
	}
	distribution := map[string]any{
		"DistributionConfig": map[string]any{
			"DefaultCacheBehavior": behavior,
			"Enabled":              true,
			"Origins": []any{map[string]any{
				"Id":             "Origin",
				"DomainName":     "bucket.s3.local",
				"S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
			}},
		},
	}
	return []Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"Function":     {Type: typeLambdaFunction, Properties: mustJSON2(fnProps)},
			"Version":      {Type: typeLambdaVersion, Properties: mustJSON2(versionProps)},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(distribution)},
		},
	}}
}

func mustJSON2(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func TestLambdaEdgeAssociationRefusals(t *testing.T) {
	baseFunction := func() map[string]any {
		return map[string]any{
			"Runtime": "nodejs24.x",
			"Handler": "index.handler",
			"Code":    map[string]any{"S3Bucket": "b", "S3Key": "k"},
		}
	}
	cases := []struct {
		name        string
		function    map[string]any
		version     map[string]any
		association map[string]any
		needle      string
	}{
		{"image", mergeProps(baseFunction(), map[string]any{"PackageType": "Image"}), nil, nil, "container image"},
		{"arm64", mergeProps(baseFunction(), map[string]any{"Architectures": []any{"arm64"}}), nil, nil, "arm64"},
		{"vpc", mergeProps(baseFunction(), map[string]any{"VpcConfig": map[string]any{"SubnetIds": []any{"s"}}}), nil, nil, "VpcConfig"},
		{"dlq", mergeProps(baseFunction(), map[string]any{"DeadLetterConfig": map[string]any{"TargetArn": "arn"}}), nil, nil, "dead letter"},
		{"layers", mergeProps(baseFunction(), map[string]any{"Layers": []any{"arn:layer"}}), nil, nil, "Layers"},
		{"environment", mergeProps(baseFunction(), map[string]any{"Environment": map[string]any{"Variables": map[string]any{"A": "b"}}}), nil, nil, "environment variables"},
		{"reserved concurrency", mergeProps(baseFunction(), map[string]any{"ReservedConcurrentExecutions": 2}), nil, nil, "concurrency"},
		{"ephemeral", mergeProps(baseFunction(), map[string]any{"EphemeralStorage": map[string]any{"Size": 1024}}), nil, nil, "ephemeral"},
		{"runtime", mergeProps(baseFunction(), map[string]any{"Runtime": "java21"}), nil, nil, "Node.js or Python"},
		{"provisioned concurrency", baseFunction(), map[string]any{"ProvisionedConcurrencyConfig": map[string]any{"ProvisionedConcurrentExecutions": 2}}, nil, "provisioned concurrency"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			version := test.version
			if version == nil {
				version = map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
			} else {
				version["FunctionName"] = map[string]any{"Ref": "Function"}
			}
			templates := edgeTemplate(test.function, version, []any{map[string]any{
				"EventType":         "viewer-request",
				"LambdaFunctionARN": map[string]any{"Ref": "Version"},
				"IncludeBody":       true,
			}})
			topology, err := ParseTemplates(templates)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			distribution := topology.Distributions[0]
			if distribution.Servable() {
				t.Fatalf("%s must be refused", test.name)
			}
			if !strings.Contains(strings.Join(distribution.Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, distribution.Refusals, test.needle)
			}
		})
	}
}

func mergeProps(base, extra map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func TestLambdaEdgeLateAndAliasRefusals(t *testing.T) {
	function := map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"}
	version := map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
	cases := []struct {
		name   string
		arn    any
		needle string
	}{
		{"latest", "arn:aws:lambda:us-east-1:123456789012:function:fn:LATEST", "$LATEST"},
		{"literal", "arn:aws:lambda:us-east-1:123456789012:function:fn:3", "literal ARN"},
		{"unknown ref", map[string]any{"Ref": "Missing"}, "AWS::Lambda::Version"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates(edgeTemplate(function, version, []any{map[string]any{
				"EventType":         "viewer-request",
				"LambdaFunctionARN": test.arn,
			}}))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if topology.Distributions[0].Servable() {
				t.Fatalf("%s must be refused", test.name)
			}
			if !strings.Contains(strings.Join(topology.Distributions[0].Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, topology.Distributions[0].Refusals, test.needle)
			}
		})
	}
}

func TestLambdaEdgeIncludeBodyOnResponseIsRefused(t *testing.T) {
	function := map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"}
	version := map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
	topology, err := ParseTemplates(edgeTemplate(function, version, []any{map[string]any{
		"EventType":         "viewer-response",
		"LambdaFunctionARN": map[string]any{"Ref": "Version"},
		"IncludeBody":       true,
	}}))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(strings.Join(topology.Distributions[0].Refusals, "\n"), "IncludeBody is only valid") {
		t.Fatalf("refusals = %v", topology.Distributions[0].Refusals)
	}
}

// recordingInvoker answers each event type with a canned response and counts
// invocations per version.
type recordingInvoker struct {
	calls     map[string]int
	responder func(version string, event map[string]any) any
}

func newRecordingInvoker() *recordingInvoker {
	return &recordingInvoker{calls: map[string]int{}}
}

func (r *recordingInvoker) InvokeEdge(_ context.Context, version string, _ time.Duration, payload []byte) ([]byte, error) {
	r.calls[version]++
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		return nil, err
	}
	return json.Marshal(r.responder(version, event))
}

func cfOf(t *testing.T, event map[string]any) map[string]any {
	t.Helper()
	records, ok := event["Records"].([]any)
	if !ok || len(records) == 0 {
		t.Fatalf("event has no Records: %v", event)
	}
	record, ok := records[0].(map[string]any)
	if !ok {
		t.Fatalf("record is not an object: %v", records[0])
	}
	cf, ok := record["cf"].(map[string]any)
	if !ok {
		t.Fatalf("record has no cf object: %v", record)
	}
	return cf
}

func configOf(t *testing.T, cf map[string]any) map[string]any {
	t.Helper()
	config, ok := cf["config"].(map[string]any)
	if !ok {
		t.Fatalf("cf has no config object: %v", cf)
	}
	return config
}

func responseOf(t *testing.T, cf map[string]any) map[string]any {
	t.Helper()
	response, ok := cf["response"].(map[string]any)
	if !ok {
		t.Fatalf("cf has no response object: %v", cf)
	}
	return response
}

func mustRecordingInvoker(t *testing.T, gateway *Gateway) *recordingInvoker {
	t.Helper()
	invoker, ok := gateway.EdgeInvoker.(*recordingInvoker)
	if !ok {
		t.Fatalf("the gateway has no recording invoker: %T", gateway.EdgeInvoker)
	}
	return invoker
}

func mustEdgeOrigin(t *testing.T, gateway *Gateway) *edgeTestOrigin {
	t.Helper()
	origin, ok := gateway.Origins["Origin"].(*edgeTestOrigin)
	if !ok {
		t.Fatalf("the gateway has no test origin: %T", gateway.Origins["Origin"])
	}
	return origin
}

func edgeGateway(t *testing.T, associations map[string]string) (*Gateway, map[string]string) {
	t.Helper()
	versions := map[string]string{}
	funcs := map[string]any{}
	items := make([]any, 0, len(associations))
	position := 0
	for eventType := range associations {
		versionName := fmt.Sprintf("Version%d", position)
		versions[eventType] = versionName
		funcs[versionName] = map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
		items = append(items, map[string]any{
			"EventType":         eventType,
			"LambdaFunctionARN": map[string]any{"Ref": versionName},
		})
		position++
	}
	templates := []Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"Function": {Type: typeLambdaFunction, Properties: mustJSON2(map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"})},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(map[string]any{
				"DistributionConfig": map[string]any{
					"DefaultCacheBehavior": map[string]any{
						"PathPattern":                "*",
						"TargetOriginId":             "Origin",
						"CachePolicyId":              "658327ea-f89d-4fab-a63d-7e88639e58f6",
						"AllowedMethods":             []any{"GET", "HEAD"},
						"LambdaFunctionAssociations": items,
					},
					"Enabled": true,
					"Origins": []any{map[string]any{
						"Id":             "Origin",
						"DomainName":     "bucket.s3.local",
						"S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
					}},
				},
			})},
		},
	}}
	for name, props := range funcs {
		templates[0].Resources[name] = Resource{Type: typeLambdaVersion, Properties: mustJSON2(props)}
	}
	topology, err := ParseTemplates(templates)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	distribution := topology.Distributions[0]
	if !distribution.Servable() {
		t.Fatalf("distribution refused: %v", distribution.Refusals)
	}
	origin := &edgeTestOrigin{response: OriginResponse{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/plain"}}, Body: []byte("origin body")}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"Origin": origin}, nil, nil)
	gateway.EdgeInvoker = newRecordingInvoker()
	return gateway, versions
}

type edgeTestOrigin struct {
	response OriginResponse
	requests []OriginRequest
	err      error
}

func (o *edgeTestOrigin) Fetch(_ context.Context, request OriginRequest) (OriginResponse, error) {
	o.requests = append(o.requests, request)
	if o.err != nil {
		return OriginResponse{}, o.err
	}
	return o.response, nil
}

func TestEdgeOriginRequestGeneratedResponseIsCached(t *testing.T) {
	gateway, versions := edgeGateway(t, map[string]string{"origin-request": "Function"})
	invoker := mustRecordingInvoker(t, gateway)
	invoker.responder = func(version string, event map[string]any) any {
		return map[string]any{
			"status": 200,
			"headers": map[string]any{
				"content-type":  []any{map[string]any{"key": "Content-Type", "value": "text/plain"}},
				"cache-control": []any{map[string]any{"key": "Cache-Control", "value": "max-age=60"}},
			},
			"body": "generated body",
		}
	}
	first := httptest.NewRecorder()
	gateway.ServeHTTP(first, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/generated", nil))
	if first.Code != 200 || first.Body.String() != "generated body" {
		t.Fatalf("first response = %d %q", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	gateway.ServeHTTP(second, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/generated", nil))
	if second.Code != 200 || second.Body.String() != "generated body" {
		t.Fatalf("cached response = %d %q", second.Code, second.Body.String())
	}
	if invoker.calls[versions["origin-request"]] != 1 {
		t.Fatalf("the origin-request function ran %d times", invoker.calls[versions["origin-request"]])
	}
	origin := mustEdgeOrigin(t, gateway)
	if len(origin.requests) != 0 {
		t.Fatalf("a generated response must not reach the origin (%d requests)", len(origin.requests))
	}
}

func TestEdgeOriginResponseDoesNotRunForGeneratedResponse(t *testing.T) {
	gateway, versions := edgeGateway(t, map[string]string{
		"origin-request":  "Function",
		"origin-response": "Function",
	})
	invoker := mustRecordingInvoker(t, gateway)
	invoker.responder = func(version string, event map[string]any) any {
		cf := cfOf(t, event)
		if configOf(t, cf)["eventType"] == "origin-request" {
			return map[string]any{"status": 200, "headers": map[string]any{}, "body": "generated"}
		}
		t.Errorf("the origin-response function must not run for a generated response")
		return map[string]any{"status": 200, "headers": map[string]any{}}
	}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/generated", nil))
	if recorder.Code != 200 {
		t.Fatalf("status = %d", recorder.Code)
	}
	_ = versions
}

func TestEdgeViewerResponseRules(t *testing.T) {
	gateway, versions := edgeGateway(t, map[string]string{"viewer-response": "Function"})
	invoker := mustRecordingInvoker(t, gateway)
	invoker.responder = func(version string, event map[string]any) any {
		response := responseOf(t, cfOf(t, event))
		response["headers"] = map[string]any{"x-edge": []any{map[string]any{"value": "seen"}}}
		return response
	}
	// A 200 runs the function.
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/ok", nil))
	if recorder.Header().Get("X-Edge") != "seen" {
		t.Fatalf("viewer-response header = %q", recorder.Header().Get("X-Edge"))
	}
	// An origin 500 does not run it.
	origin := mustEdgeOrigin(t, gateway)
	origin.response.StatusCode = 500
	before := invoker.calls[versions["viewer-response"]]
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/error", nil))
	if recorder.Header().Get("X-Edge") != "" {
		t.Fatal("a viewer-response function must not run for an origin status of 400 or higher")
	}
	if invoker.calls[versions["viewer-response"]] != before {
		t.Fatal("the viewer-response function ran for an error response")
	}
}

func TestEdgeViewerResponseCannotChangeStatus(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"viewer-response": "Function"})
	invoker := mustRecordingInvoker(t, gateway)
	invoker.responder = func(version string, event map[string]any) any {
		return map[string]any{"status": 201, "headers": map[string]any{}}
	}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/ok", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
}

func TestEdgeResponseValidation(t *testing.T) {
	cases := []struct {
		name     string
		response map[string]any
		status   int
	}{
		{"204 with body", map[string]any{"status": 204, "headers": map[string]any{}, "body": "x"}, http.StatusBadGateway},
		{"status out of range", map[string]any{"status": 99, "headers": map[string]any{}}, http.StatusBadGateway},
		{"oversize body", map[string]any{"status": 200, "headers": map[string]any{}, "body": strings.Repeat("x", edgeViewerBodyLimit+1)}, http.StatusBadGateway},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			gateway, _ := edgeGateway(t, map[string]string{"viewer-request": "Function"})
			invoker := mustRecordingInvoker(t, gateway)
			invoker.responder = func(string, map[string]any) any { return test.response }
			recorder := httptest.NewRecorder()
			gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d", recorder.Code, test.status)
			}
		})
	}
}

func TestEdgeFunctionErrorIs503(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"viewer-request": "Function"})
	gateway.EdgeInvoker = failingInvoker{}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

type failingInvoker struct{}

func (failingInvoker) InvokeEdge(context.Context, string, time.Duration, []byte) ([]byte, error) {
	return nil, fmt.Errorf("the function threw")
}

func TestKeyValueStoreDriver(t *testing.T) {
	store := &KeyValueStore{LogicalID: "Store", Name: "store"}
	now := time.Now().UTC()
	if err := store.LoadImportFile([]byte(`{"data":[{"key":"target","value":"/edge/rewritten"},{"key":"config","value":"{\"variant\":\"b\"}"}]}`), now); err != nil {
		t.Fatalf("load: %v", err)
	}
	function := &Function{
		LogicalID:     "Fn",
		Runtime:       runtimeJS20,
		KeyValueStore: "Store",
		Code: `import cf from 'cloudfront';
const kvs = cf.kvs();
async function handler(event) {
  const target = await kvs.get('target');
  const config = await kvs.get('config', { format: 'json' });
  const present = await kvs.exists('target');
  const missing = await kvs.exists('nope');
  let rejected = false;
  try { await kvs.get('nope'); } catch (error) { rejected = true; }
  const meta = await kvs.meta();
  return {
    statusCode: 200,
    headers: { 'content-type': { value: 'application/json' } },
    body: { encoding: 'text', data: JSON.stringify({ target, variant: config.variant, present, missing, rejected, keyCount: meta.keyCount }) },
  };
}`,
	}
	function.AttachStore(store)
	event := testRequestEvent("viewer-request")
	result, err := NewExecutor().Execute(context.Background(), function, event)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Kind != ResultResponse {
		t.Fatalf("kind = %s", result.Kind)
	}
	var payload struct {
		Target   string `json:"target"`
		Variant  string `json:"variant"`
		Present  bool   `json:"present"`
		Missing  bool   `json:"missing"`
		Rejected bool   `json:"rejected"`
		KeyCount int    `json:"keyCount"`
	}
	body, _, err := decodeResponseBody(result.Response.Body, nil)
	if err != nil {
		t.Fatalf("body: %v", err)
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Target != "/edge/rewritten" || payload.Variant != "b" || !payload.Present || payload.Missing || !payload.Rejected || payload.KeyCount != 2 {
		t.Fatalf("key value store results = %+v", payload)
	}
}

func TestKeyValueStoreWithoutAssociationStillThrows(t *testing.T) {
	function := &Function{
		LogicalID: "Fn",
		Runtime:   runtimeJS20,
		Code: `import cf from 'cloudfront';
const kvs = cf.kvs();
function handler(event) { return event.request; }`,
	}
	if _, err := NewExecutor().Execute(context.Background(), function, testRequestEvent("viewer-request")); err == nil {
		t.Fatal("cf.kvs() without an association must fail")
	}
}
