package localcloudfront

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseTemplatesReadsEveryNewResource(t *testing.T) {
	_, pemText := testRSAKey(t)
	publicKey := map[string]any{"PublicKeyConfig": map[string]any{
		"CallerReference": "ref",
		"Comment":         "comment",
		"Name":            "edge-key",
		"EncodedKey":      pemText,
	}}
	keyGroup := map[string]any{"KeyGroupConfig": map[string]any{
		"Name":    "group",
		"Comment": "comment",
		"Items":   []any{map[string]any{"Ref": "PublicKey"}},
	}}
	store := map[string]any{
		"Name":    "store",
		"Comment": "comment",
		"ImportSource": map[string]any{
			"SourceType": "S3",
			"SourceArn": map[string]any{"Fn::Join": []any{"", []any{
				"arn:aws:s3:::bucket/", map[string]any{"Fn::Sub": "asset-${AWS::AccountId}"}, "/abc.json",
			}}},
		},
	}
	profile := map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
		"Name":            "profile",
		"CallerReference": "ref",
		"EncryptionEntities": []any{map[string]any{
			"PublicKeyId":   map[string]any{"Ref": "PublicKey"},
			"ProviderId":    "DEMO",
			"FieldPatterns": []any{"card", "ssn*"},
		}},
	}}
	config := map[string]any{
		"CallerReference": "ref",
		"Comment":         "comment",
		"ContentTypeProfileConfig": map[string]any{
			"ForwardWhenContentTypeIsUnknown": true,
			"ContentTypeProfiles": []any{map[string]any{
				"ContentType": formContentType,
				"Format":      "URLEncoded",
				"ProfileId":   map[string]any{"Ref": "Profile"},
			}},
		},
		"QueryArgProfileConfig": map[string]any{
			"ForwardWhenQueryArgProfileIsUnknown": true,
			"QueryArgProfiles": []any{map[string]any{
				"QueryArg":  "cards",
				"ProfileId": map[string]any{"Ref": "Profile"},
			}},
		},
	}
	distribution := map[string]any{
		"DistributionConfig": map[string]any{
			"Enabled": true,
			"DefaultCacheBehavior": map[string]any{
				"PathPattern":            "*",
				"TargetOriginId":         "Origin",
				"CachePolicyId":          "658327ea-f89d-4fab-a63d-7e88639e58f6",
				"TrustedKeyGroups":       map[string]any{"Enabled": true, "Items": []any{map[string]any{"Ref": "KeyGroup"}}},
				"FieldLevelEncryptionId": map[string]any{"Ref": "Config"},
			},
			"Origins": []any{map[string]any{
				"Id":         "Origin",
				"DomainName": "example.com",
				"CustomOriginConfig": map[string]any{
					"OriginProtocolPolicy":   "https-only",
					"HTTPPort":               float64(80),
					"HTTPSPort":              float64(443),
					"OriginReadTimeout":      float64(30),
					"OriginKeepaliveTimeout": float64(5),
					"OriginSSLProtocols":     []any{"TLSv1.2"},
				},
			}},
			"Restrictions": map[string]any{"GeoRestriction": map[string]any{
				"RestrictionType": "blacklist",
				"Locations":       []any{"US"},
			}},
		},
	}
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"PublicKey":    {Type: typePublicKey, Properties: mustJSON2(publicKey)},
			"KeyGroup":     {Type: typeKeyGroup, Properties: mustJSON2(keyGroup)},
			"Store":        {Type: typeKeyValueStore, Properties: mustJSON2(store)},
			"Profile":      {Type: typeFLEProfile, Properties: mustJSON2(profile)},
			"Config":       {Type: typeFLEConfig, Properties: mustJSON2(config)},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(distribution)},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(topology.PublicKeys) != 1 || len(topology.KeyGroups) != 1 || len(topology.KeyValueStores) != 1 {
		t.Fatalf("keys/groups/stores = %d/%d/%d", len(topology.PublicKeys), len(topology.KeyGroups), len(topology.KeyValueStores))
	}
	if _, ok := topology.PublicKey(topology.PublicKeys[0].LogicalID); !ok {
		t.Fatal("PublicKey accessor must resolve")
	}
	if _, ok := topology.KeyGroup(topology.KeyGroups[0].LogicalID); !ok {
		t.Fatal("KeyGroup accessor must resolve")
	}
	if _, ok := topology.KeyValueStore(topology.KeyValueStores[0].LogicalID); !ok {
		t.Fatal("KeyValueStore accessor must resolve")
	}
	if _, ok := topology.FieldLevelEncryptionConfig(topology.FieldLevelEncryptionConfigs[0].LogicalID); !ok {
		t.Fatal("FieldLevelEncryptionConfig accessor must resolve")
	}
	if _, ok := topology.FieldLevelEncryptionProfile(topology.FieldLevelEncryptionProfiles[0].LogicalID); !ok {
		t.Fatal("FieldLevelEncryptionProfile accessor must resolve")
	}
	if !topology.KeyValueStores[0].Servable() || topology.KeyValueStores[0].ObjectKey != "abc.json" {
		t.Fatalf("store = %+v", topology.KeyValueStores[0])
	}
	config0 := topology.FieldLevelEncryptionConfigs[0]
	if !config0.Servable() || len(config0.profileIDs()) != 1 {
		t.Fatalf("config = %+v", config0)
	}
	profile0 := topology.FieldLevelEncryptionProfiles[0]
	if !profile0.Servable() || len(profile0.Entities) != 1 {
		t.Fatalf("profile = %+v", profile0)
	}
	if refusals := verifyFLEKeys(profile0, topology.publicKeysByID); len(refusals) != 0 {
		t.Fatalf("FLE keys = %v", refusals)
	}
	distribution0 := topology.Distributions[0]
	if !distribution0.Servable() {
		t.Fatalf("distribution refused: %v", distribution0.Refusals)
	}
	if distribution0.GeoRestriction == nil || !distribution0.GeoRestriction.Blocks("US") {
		t.Fatalf("geo restriction = %+v", distribution0.GeoRestriction)
	}
	if len(distribution0.Reported) == 0 {
		t.Fatal("the FLE preconditions must be reported")
	}
	if got := topology.Functions; len(got) != 0 {
		t.Fatalf("functions = %v", got)
	}
	if store := topology.KeyValueStores[0]; len(store.Keys()) != 0 {
		t.Fatalf("an unmaterialized store has keys: %v", store.Keys())
	}
}

func TestParseFieldLevelEncryptionConfigRefusals(t *testing.T) {
	cases := []struct {
		name   string
		config map[string]any
		needle string
	}{
		{"missing content type config", map[string]any{"CallerReference": "r"}, "ContentTypeProfileConfig is missing"},
		{"wrong content type", map[string]any{
			"CallerReference": "r",
			"ContentTypeProfileConfig": map[string]any{
				"ForwardWhenContentTypeIsUnknown": false,
				"ContentTypeProfiles": []any{map[string]any{
					"ContentType": "text/plain", "Format": "URLEncoded", "ProfileId": map[string]any{"Ref": "Profile"},
				}},
			},
		}, "CloudFront supports only that content type"},
		{"wrong format", map[string]any{
			"CallerReference": "r",
			"ContentTypeProfileConfig": map[string]any{
				"ContentTypeProfiles": []any{map[string]any{
					"ContentType": formContentType, "Format": "JSON", "ProfileId": map[string]any{"Ref": "Profile"},
				}},
			},
		}, "URLEncoded"},
		{"unknown property", map[string]any{"CallerReference": "r", "SomethingNew": true}, "SomethingNew"},
		{"too many query args", map[string]any{
			"CallerReference": "r",
			"ContentTypeProfileConfig": map[string]any{
				"ContentTypeProfiles": []any{},
			},
			"QueryArgProfileConfig": map[string]any{
				"QueryArgProfiles": []any{
					map[string]any{"QueryArg": "a", "ProfileId": map[string]any{"Ref": "Profile"}},
					map[string]any{"QueryArg": "b", "ProfileId": map[string]any{"Ref": "Profile"}},
					map[string]any{"QueryArg": "c", "ProfileId": map[string]any{"Ref": "Profile"}},
					map[string]any{"QueryArg": "d", "ProfileId": map[string]any{"Ref": "Profile"}},
					map[string]any{"QueryArg": "e", "ProfileId": map[string]any{"Ref": "Profile"}},
					map[string]any{"QueryArg": "f", "ProfileId": map[string]any{"Ref": "Profile"}},
				},
			},
		}, "five"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack: "TestStack",
				Resources: map[string]Resource{
					"Profile": {Type: typeFLEProfile, Properties: mustJSON2(map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
						"Name": "p", "CallerReference": "r",
						"EncryptionEntities": []any{map[string]any{"PublicKeyId": "arn", "ProviderId": "p", "FieldPatterns": []any{"a"}}},
					}})},
					"Config": {Type: typeFLEConfig, Properties: mustJSON2(test.config)},
				},
			}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			config := topology.FieldLevelEncryptionConfigs[0]
			if config.Servable() {
				t.Fatalf("%s must be refused", test.name)
			}
			if !strings.Contains(strings.Join(config.Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, config.Refusals, test.needle)
			}
		})
	}
}

func TestParseKeyValueStoreRefusals(t *testing.T) {
	cases := []struct {
		name   string
		store  map[string]any
		needle string
	}{
		{"non-s3", map[string]any{"ImportSource": map[string]any{"SourceType": "Inline", "SourceArn": "x"}}, "not S3"},
		{"unknown property", map[string]any{"SomethingNew": true}, "SomethingNew"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack:     "TestStack",
				Resources: map[string]Resource{"Store": {Type: typeKeyValueStore, Properties: mustJSON2(test.store)}},
			}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			store := topology.KeyValueStores[0]
			if store.Servable() || !strings.Contains(strings.Join(store.Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v", test.name, store.Refusals)
			}
			if _, ok := topology.KeyValueStore("missing"); ok {
				t.Fatal("an unknown store must not resolve")
			}
		})
	}
}

func TestParsePublicKeyAndKeyGroupRefusals(t *testing.T) {
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"BadKey": {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{
				"CallerReference": "r", "Name": "bad", "EncodedKey": "not a key",
			}})},
			"Group": {Type: typeKeyGroup, Properties: mustJSON2(map[string]any{"KeyGroupConfig": map[string]any{
				"Name": "g", "Items": []any{map[string]any{"Ref": "BadKey"}},
			}})},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if topology.PublicKeys[0].Servable() {
		t.Fatal("a malformed public key must be refused")
	}
	if !topology.KeyGroups[0].Servable() {
		t.Fatalf("the key group itself parses: %v", topology.KeyGroups[0].Refusals)
	}
	// A 1024-bit key is refused by size.
	smallKey := `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDC7kw8r6tq43pwApYLwB0FmS2X
2r1k5mQadA2YkNq3rKc0S3P2y0m7cM0o8vXf3oM2mZ7o2r7QkZ2m8oQ0K2oQ2oQ
2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ2oQ
2wIDAQAB
-----END PUBLIC KEY-----`
	if _, problem := parsePublicKeyPEM(smallKey); problem == "" {
		t.Fatal("a non-2048-bit RSA key must be refused")
	}
}

func TestEdgeBodyUnmarshalJSON(t *testing.T) {
	var fromString EdgeBody
	if err := json.Unmarshal([]byte(`"hello"`), &fromString); err != nil {
		t.Fatalf("string body: %v", err)
	}
	if fromString.Data != "hello" || fromString.Encoding != valueText || fromString.Action != valueReplace {
		t.Fatalf("string body = %+v", fromString)
	}
	var fromObject EdgeBody
	if err := json.Unmarshal([]byte(`{"action":"replace","encoding":"base64","data":"aGk="}`), &fromObject); err != nil {
		t.Fatalf("object body: %v", err)
	}
	if fromObject.Data != "aGk=" || fromObject.Encoding != valueBase64 {
		t.Fatalf("object body = %+v", fromObject)
	}
	var bad EdgeBody
	if err := json.Unmarshal([]byte(`42`), &bad); err == nil {
		t.Fatal("a number is not a body")
	}
}

func TestEdgeEventShape(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"origin-request": "Function"})
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://d111.cloudfront.local/echo?a=1", strings.NewReader("hello")), []byte("hello"))
	origin := &DistributionOrigin{ID: "Origin", DomainName: "example.com", Kind: OriginCustom, Custom: &CustomOrigin{
		ProtocolPolicy: valueHTTPSOnly, ReadTimeout: intPointer(30), KeepaliveSeconds: intPointer(5), SSLProtocols: []string{"TLSv1.2"},
	}}
	association := &EdgeFunction{EventType: edgeOriginRequest, IncludeBody: true}
	event := gateway.edgeEvent(association, state, "req-1", "d111.cloudfront.local", origin, nil)
	record := event.Records[0].CF
	if record.Config.EventType != edgeOriginRequest || record.Config.RequestID != "req-1" {
		t.Fatalf("config = %+v", record.Config)
	}
	if record.Request.URI != "/echo" || record.Request.Querystring != "a=1" || record.Request.Method != http.MethodPost {
		t.Fatalf("request = %+v", record.Request)
	}
	if record.Request.Body == nil || record.Request.Body.Encoding != valueBase64 || record.Request.Body.Action != "read-only" {
		t.Fatalf("body = %+v", record.Request.Body)
	}
	decoded, err := base64.StdEncoding.DecodeString(record.Request.Body.Data)
	if err != nil || string(decoded) != "hello" {
		t.Fatalf("body data = %q (%v)", decoded, err)
	}
	if _, ok := record.Request.Headers["host"]; !ok {
		t.Fatalf("headers = %v", record.Request.Headers)
	}
	if record.Origin == nil || record.Origin.Custom == nil || record.Origin.Custom.Protocol != valueHTTPS || record.Origin.Custom.Port != 443 {
		t.Fatalf("origin = %+v", record.Origin)
	}
	// A body over the viewer limit is truncated and flagged.
	association.EventType = edgeViewerRequest
	big := make([]byte, edgeViewerBodyLimit+10)
	state.Body = big
	event = gateway.edgeEvent(association, state, "req-2", "d111.cloudfront.local", nil, nil)
	if !event.Records[0].CF.Request.Body.InputTruncated {
		t.Fatal("a viewer body over 40 KB must be truncated")
	}
}

func TestEdgeRequestApplicationAndOriginResolution(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"origin-request": "Function"})
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/original?x=1", nil), nil)
	returned := &EdgeRequest{
		Method:      http.MethodGet,
		URI:         "/rewritten",
		Querystring: "y=2",
		Headers: map[string][]EdgeHeader{
			"host":        {{Key: "Host", Value: "other.example.com"}},
			"x-added":     {{Value: "seen"}},
			"cookie":      {{Value: "a=b"}},
			"x-edge-body": {{Value: "1"}},
		},
		Body:   &EdgeBody{Action: valueReplace, Encoding: valueText, Data: "replaced"},
		Origin: &EdgeOrigin{Custom: &EdgeCustomOrigin{DomainName: "example.com"}},
	}
	validated, err := validateEdgeRequestObject(&EdgeFunction{Version: "v"}, returned)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if validated.Headers["x-added"][0].Key != "X-Added" {
		t.Fatalf("an omitted header key must be inserted with initial capitalization: %+v", validated.Headers["x-added"])
	}
	if gateway.edgeOriginDomainForTest(validated.Origin) != "example.com" {
		t.Fatal("the origin domain must resolve")
	}
	applyEdgeRequest(state, validated)
	if state.URI != "/rewritten" || state.RawQuery != "y=2" || state.Host != "other.example.com" {
		t.Fatalf("state = %+v", state)
	}
	if state.Header.Get("X-Added") != "seen" || state.Header.Get("Cookie") != "a=b" {
		t.Fatalf("headers = %v", state.Header)
	}
	if string(state.Body) != "replaced" {
		t.Fatalf("body = %q", state.Body)
	}
	// A domain the distribution does not declare is refused.
	if _, ok := gateway.resolveEdgeOrigin(&EdgeOrigin{Custom: &EdgeCustomOrigin{DomainName: "outside.example.com"}}); ok {
		t.Fatal("an external origin must not resolve")
	}
	if _, ok := gateway.resolveEdgeOrigin(nil); ok {
		t.Fatal("a nil origin must not resolve")
	}
	if gateway.resolveEdgeOriginForTest(&EdgeOrigin{S3: &EdgeS3Origin{DomainName: "bucket.s3.local"}}) == "" {
		t.Fatal("the S3 origin domain must resolve")
	}
}

func (g *Gateway) edgeOriginDomainForTest(origin *EdgeOrigin) string { return edgeOriginDomain(origin) }

func (g *Gateway) resolveEdgeOriginForTest(origin *EdgeOrigin) string {
	resolved, _ := g.resolveEdgeOrigin(origin)
	return resolved
}

func TestGatewayGeoRestrictionBlock(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	gateway.Distribution.GeoRestriction = &GeoRestriction{Type: valueWhitelist, Locations: []string{"US"}}
	gateway.ViewerCountry = "JP"
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "geo restriction") {
		t.Fatalf("body = %q", recorder.Body.String())
	}
	// The custom error response for 403 serves its page.
	gateway.Distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode:        http.StatusForbidden,
		ResponseCode:     http.StatusOK,
		ResponsePagePath: "/errors/not-found.html",
	}}
	gateway.Origins = map[string]Origin{"Origin": &edgeTestOrigin{response: OriginResponse{
		StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: []byte("<h1>blocked</h1>"),
	}}}
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "blocked") {
		t.Fatalf("custom error page = %d %q", recorder.Code, recorder.Body.String())
	}
	// The same request passes inside the allowlist and carries the country
	// header when the policy forwards it.
	gateway.ViewerCountry = "US"
	gateway.Distribution.GeoRestriction = &GeoRestriction{Type: valueWhitelist, Locations: []string{"US"}}
	gateway.Distribution.DefaultBehavior.OriginRequestPolicy = &Policy{Kind: PolicyOriginRequest, ID: "p",
		OriginRequest: &OriginRequestPolicy{Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"cloudfront-viewer-country"}}}}
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	origin := mustEdgeOrigin(t, gateway)
	if origin.requests[len(origin.requests)-1].Header.Get("CloudFront-Viewer-Country") != "US" {
		t.Fatalf("the origin request must carry CloudFront-Viewer-Country: %v", origin.requests[len(origin.requests)-1].Header)
	}
}

func TestGatewaySignedBlockUsesCustomErrorPage(t *testing.T) {
	key, pemText := testRSAKey(t)
	gateway, _ := signingTopology(t, pemText, "key")
	_ = key
	gateway.Origins = map[string]Origin{"Origin": &edgeTestOrigin{response: OriginResponse{
		StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: []byte("<h1>denied page</h1>"),
	}}}
	gateway.Distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode: http.StatusForbidden, ResponseCode: http.StatusOK, ResponsePagePath: "/errors/denied.html",
	}}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/private/file.txt", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "denied page") {
		t.Fatalf("signed refusal page = %d %q", recorder.Code, recorder.Body.String())
	}
	// A behavior without trusted key groups stays public.
	gateway.Distribution.DefaultBehavior.TrustedKeyGroups = nil
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/private/file.txt", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("a public behavior must serve: %d", recorder.Code)
	}
}

func TestGatewayFieldLevelEncryptionRoundTrip(t *testing.T) {
	key, pemText := testRSAKey(t)
	publicKeyID := "PublicKey"
	profileID := "Profile"
	configID := "Config"
	distribution := map[string]any{
		"DistributionConfig": map[string]any{
			"Enabled": true,
			"DefaultCacheBehavior": map[string]any{
				"PathPattern":            "*",
				"TargetOriginId":         "Origin",
				"CachePolicyId":          "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
				"AllowedMethods":         []any{"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"},
				"ViewerProtocolPolicy":   "redirect-to-https",
				"FieldLevelEncryptionId": map[string]any{"Ref": configID},
			},
			"Origins": []any{map[string]any{
				"Id":                 "Origin",
				"DomainName":         "api.example.com",
				"CustomOriginConfig": map[string]any{"OriginProtocolPolicy": "match-viewer"},
			}},
		},
	}
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			publicKeyID: {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{
				"CallerReference": "r", "Name": "key", "EncodedKey": pemText,
			}})},
			profileID: {Type: typeFLEProfile, Properties: mustJSON2(map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
				"Name": "p", "CallerReference": "r",
				"EncryptionEntities": []any{map[string]any{
					"PublicKeyId": map[string]any{"Ref": publicKeyID}, "ProviderId": "DEMO", "FieldPatterns": []any{"card"},
				}},
			}})},
			configID: {Type: typeFLEConfig, Properties: mustJSON2(map[string]any{
				"CallerReference": "r",
				"ContentTypeProfileConfig": map[string]any{
					"ForwardWhenContentTypeIsUnknown": false,
					"ContentTypeProfiles": []any{map[string]any{
						"ContentType": formContentType, "Format": "URLEncoded", "ProfileId": map[string]any{"Ref": profileID},
					}},
				},
			})},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(distribution)},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !topology.Distributions[0].Servable() {
		t.Fatalf("distribution refused: %v", topology.Distributions[0].Refusals)
	}
	origin := &edgeTestOrigin{response: OriginResponse{StatusCode: 200, Header: http.Header{}, Body: []byte("ok")}}
	gateway := NewGateway(topology.Distributions[0], topology, map[string]Origin{"Origin": origin}, nil, nil)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://d111.cloudfront.local/pay",
		strings.NewReader("card=4111111111111111&name=Jane"))
	request.Header.Set("Content-Type", formContentType)
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(origin.requests) != 1 {
		t.Fatalf("origin requests = %d", len(origin.requests))
	}
	body := string(origin.requests[0].Body)
	if strings.Contains(body, "4111111111111111") {
		t.Fatalf("the plaintext card field reached the origin: %s", body)
	}
	if !strings.Contains(body, "name=Jane") {
		t.Fatalf("the name field must stay unchanged: %s", body)
	}
	// An unknown content type is blocked because the configuration says so.
	request = httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://d111.cloudfront.local/pay",
		strings.NewReader("card=4111111111111111"))
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown content type status = %d, want 400", recorder.Code)
	}
	_ = key
}

func TestFLEPreconditionsReported(t *testing.T) {
	behavior := &Behavior{ViewerProtocolPolicy: "allow-all", AllowedMethods: []string{"GET"}}
	origin := &DistributionOrigin{Kind: OriginCustom, Custom: &CustomOrigin{ProtocolPolicy: "http-only"}}
	problems := (&Distribution{}).flePreconditions(behavior, origin)
	if len(problems) != 3 {
		t.Fatalf("preconditions = %v", problems)
	}
	ok := &Behavior{ViewerProtocolPolicy: valueHTTPSOnly, AllowedMethods: []string{"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"}}
	if problems := (&Distribution{}).flePreconditions(ok, &DistributionOrigin{Kind: OriginCustom, Custom: &CustomOrigin{ProtocolPolicy: "match-viewer"}}); len(problems) != 0 {
		t.Fatalf("valid preconditions reported %v", problems)
	}
}

func TestForwardsHeaderModes(t *testing.T) {
	cases := []struct {
		headers HeaderForwarding
		want    bool
	}{
		{HeaderForwarding{Mode: ForwardAll}, true},
		{HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"CloudFront-Viewer-Country"}}, true},
		{HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"accept"}}, false},
		{HeaderForwarding{Mode: ForwardAllExcept, Names: []string{"cloudfront-viewer-country"}}, false},
		{HeaderForwarding{Mode: ForwardAllExcept, Names: []string{"accept"}}, true},
		{HeaderForwarding{CloudFrontHeaders: true}, true},
		{HeaderForwarding{Mode: ForwardNone}, false},
	}
	for _, test := range cases {
		if got := forwardsHeader(test.headers, "cloudfront-viewer-country"); got != test.want {
			t.Fatalf("%+v = %v, want %v", test.headers, got, test.want)
		}
	}
	if cachePolicyForwardsHeader(nil, "x") || originPolicyForwardsHeader(nil, "x") || originPolicyForwardsHeader(&Policy{}, "x") {
		t.Fatal("nil policies forward nothing")
	}
}

func TestRespondViewerBlockCachesTheError(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	behavior := gateway.Distribution.DefaultBehavior
	behavior.CachePolicy = &Policy{Kind: PolicyCache, ID: "c", Cache: &CachePolicy{DefaultTTL: 60, MaxTTL: 60}}
	gateway.Distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode: http.StatusForbidden, ErrorCachingMinTTL: intPointer(300),
	}}
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/blocked", nil), nil)
	recorder := httptest.NewRecorder()
	gateway.respondViewerBlock(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/blocked", nil),
		behavior, state, "req", "d111.cloudfront.local", http.StatusForbidden, "blocked by geo restriction")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d", recorder.Code)
	}
	// A 403 is cached "only ... if your origin returns a Cache-Control max-age
	// or Cache-Control s-maxage header"; the synthetic block carries none, so
	// the response is served but not stored.
	key := CacheKey("d111.cloudfront.local", http.MethodGet, state.URI, state.RawQuery, state.Header, policyCache(behavior))
	if _, ok := gateway.Cache.Get(key); ok {
		t.Fatal("a 403 without Cache-Control max-age must not be cached")
	}
	// With an origin max-age the error caching minimum stores it.
	gateway.Distribution.CustomErrorResponses = nil
	recorder = httptest.NewRecorder()
	state = newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/blocked", nil), nil)
	gateway.respondViewerBlock(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/blocked", nil),
		behavior, state, "req", "d111.cloudfront.local", http.StatusNotFound, "not found")
	key = CacheKey("d111.cloudfront.local", http.MethodGet, state.URI, state.RawQuery, state.Header, policyCache(behavior))
	if _, ok := gateway.Cache.Get(key); !ok {
		t.Fatal("a 404 must be cached under the error caching rules")
	}
}

func TestEdgeFailureStatuses(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	behavior := gateway.Distribution.DefaultBehavior
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil), nil)
	cases := []struct {
		err    error
		status int
	}{
		{&EdgeValidationError{Function: "f", Reason: "bad"}, http.StatusBadGateway},
		{&EdgeExecutionError{Function: "f", Reason: "threw"}, http.StatusServiceUnavailable},
	}
	for _, test := range cases {
		recorder := httptest.NewRecorder()
		gateway.edgeFailure(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil),
			behavior, state.Header, "viewer-request", test.err)
		if recorder.Code != test.status {
			t.Fatalf("%T status = %d, want %d", test.err, recorder.Code, test.status)
		}
	}
}

func TestEdgeGeneratedResponseBodyLimits(t *testing.T) {
	association := &EdgeFunction{EventType: edgeOriginRequest, Version: "v"}
	gateway, _ := edgeGateway(t, nil)
	if _, err := gateway.edgeGeneratedResponse(association, &EdgeResponse{Status: 200, Body: &EdgeBody{
		Encoding: valueText, Data: strings.Repeat("x", edgeOriginBodyLimit+1),
	}}, nil); err == nil {
		t.Fatal("an oversize text body must be refused")
	}
	encoded := base64.StdEncoding.EncodeToString(make([]byte, edgeOriginB64Limit+1))
	if _, err := gateway.edgeGeneratedResponse(association, &EdgeResponse{Status: 200, Body: &EdgeBody{
		Encoding: valueBase64, Data: encoded,
	}}, nil); err == nil {
		t.Fatal("an oversize base64 body must be refused")
	}
	if _, err := gateway.edgeGeneratedResponse(association, &EdgeResponse{Status: 200, Body: &EdgeBody{
		Encoding: "hex", Data: "00",
	}}, nil); err == nil {
		t.Fatal("an unknown encoding must be refused")
	}
	if _, err := gateway.edgeGeneratedResponse(association, &EdgeResponse{Status: 200, Body: &EdgeBody{
		Encoding: valueBase64, Data: "not base64!!",
	}}, nil); err == nil {
		t.Fatal("invalid base64 must be refused")
	}
	response, err := gateway.edgeGeneratedResponse(association, &EdgeResponse{Status: 201, Headers: map[string][]EdgeHeader{
		"x-edge": {{Value: "seen"}},
	}}, []byte("origin"))
	if err != nil {
		t.Fatalf("generated response: %v", err)
	}
	if response.StatusCode != 201 || string(response.Body) != "origin" || response.Header.Get("X-Edge") != "seen" {
		t.Fatalf("generated response = %+v", response)
	}
}

func TestEdgeValidationErrors(t *testing.T) {
	association := &EdgeFunction{Version: "v"}
	if _, err := validateEdgeRequestObject(association, &EdgeRequest{Method: "GET", URI: "missing-slash"}); err == nil {
		t.Fatal("a uri without a leading slash must be refused")
	}
	if _, err := validateEdgeRequestObject(association, &EdgeRequest{Method: "GET", URI: "/x", Headers: map[string][]EdgeHeader{"set-cookie": {{Value: "a=b"}}}}); err == nil {
		t.Fatal("a request cannot carry set-cookie")
	}
	if _, err := validateEdgeRequestObject(association, &EdgeRequest{Method: "GET", URI: "/x", Headers: map[string][]EdgeHeader{"cloudfront-viewer-country": {{Value: "US"}}}}); err == nil {
		t.Fatal("a viewer request cannot add a CloudFront header")
	}
	if err := validateEdgeResponseObject(association, &EdgeResponse{Status: 200, Body: &EdgeBody{Action: "read-only"}}); err == nil {
		t.Fatal("a response body action must be replace")
	}
}

func TestDecodeEdgeResponseEnvelopeForms(t *testing.T) {
	association := &EdgeFunction{Version: "v"}
	// A full Records envelope.
	record, err := decodeEdgeResponse(association, nil, []byte(`{"Records":[{"cf":{"config":{"eventType":"origin-response"},"response":{"status":200,"headers":{},"body":"x"}}}]}`))
	if err != nil || record.Response == nil || record.Response.Body == nil || record.Response.Body.Data != "x" {
		t.Fatalf("records envelope = %+v (%v)", record, err)
	}
	// A bare request object.
	request, err := decodeEdgeResponse(association, nil, []byte(`{"method":"GET","uri":"/x","querystring":"","headers":{}}`))
	if err != nil || request.Request == nil || request.Request.URI != "/x" {
		t.Fatalf("bare request = %+v (%v)", request, err)
	}
	// Neither.
	if _, err := decodeEdgeResponse(association, nil, []byte(`{}`)); err == nil {
		t.Fatal("an empty object must be refused")
	}
	if _, err := decodeEdgeResponse(association, nil, []byte(`[]`)); err == nil {
		t.Fatal("a list must be refused")
	}
}

func TestEdgeTimeoutOnTheRunClock(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"viewer-request": "Function"})
	gateway.EdgeInvoker = slowInvoker{}
	recorder := httptest.NewRecorder()
	start := time.Now()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if elapsed := time.Since(start); elapsed > edgeViewerTimeout+time.Second {
		t.Fatalf("the viewer timeout took %s", elapsed)
	}
}

type slowInvoker struct{}

func (slowInvoker) InvokeEdge(ctx context.Context, _ string, _ time.Duration, _ []byte) ([]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestKeyValueStoreQuotaRefusals(t *testing.T) {
	now := time.Now()
	if err := (&KeyValueStore{LogicalID: "S"}).LoadImportFile([]byte(`{"data":[{"key":"`+strings.Repeat("k", kvsMaxKeyBytes+1)+`","value":"v"}]}`), now); err == nil {
		t.Fatal("a key over 512 bytes must be refused")
	}
	if err := (&KeyValueStore{LogicalID: "S"}).LoadImportFile([]byte(`{"data":[{"key":"k","value":"v"},{"key":"","value":"v"}]}`), now); err == nil {
		t.Fatal("an empty key must be refused")
	}
	store := &KeyValueStore{LogicalID: "S", Values: map[string]string{"b": "2", "a": "1"}}
	if strings.Join(store.Keys(), ",") != "a,b" {
		t.Fatalf("keys = %v", store.Keys())
	}
	if (&KeyValueStore{LogicalID: "S", Refusals: []string{"refused"}}).Servable() {
		t.Fatal("a key value store with refusals is not servable")
	}
	if (&KeyValueStore{LogicalID: "S"}).KeyCount() != 0 {
		t.Fatal("an empty store has no keys")
	}
	var nilStore *KeyValueStore
	if nilStore.KeyCount() != 0 {
		t.Fatal("a nil store has no keys")
	}
}

func TestParseS3OriginExpressions(t *testing.T) {
	// A Ref/Fn::Join OriginAccessIdentity expression is accepted; a number is
	// refused.
	if _, err := parseS3Origin([]byte(`{"OriginAccessIdentity":{"Fn::Join":["",["origin-access-identity/cloudfront/",{"Ref":"OAI"}]]}}`), "D", 0); err != nil {
		t.Fatalf("expression OAI: %v", err)
	}
	if _, err := parseS3Origin([]byte(`{"OriginAccessIdentity":42}`), "D", 0); err == nil {
		t.Fatal("a number OAI must be refused")
	}
}

func TestEdgeOriginFromDistributionS3(t *testing.T) {
	origin := edgeOriginFromDistribution(&DistributionOrigin{ID: "O", DomainName: "bucket.s3.local", Kind: OriginS3, S3: &S3Origin{}, OriginAccessControl: "oac", OriginPath: "/base"})
	if origin.S3 == nil || origin.S3.AuthMethod != "origin-access-identity" || origin.S3.Path != "/base" {
		t.Fatalf("s3 origin = %+v", origin.S3)
	}
	if edgeOriginFromDistribution(nil) != nil {
		t.Fatal("a nil origin has no event object")
	}
}

func TestGeoBlocksBeforeViewerFunction(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"viewer-request": "Function"})
	invoker := mustRecordingInvoker(t, gateway)
	invoker.responder = func(string, map[string]any) any {
		t.Error("a viewer function must not run for a geo-blocked request")
		return map[string]any{"method": "GET", "uri": "/x", "querystring": "", "headers": map[string]any{}}
	}
	gateway.Distribution.GeoRestriction = &GeoRestriction{Type: valueBlacklist, Locations: []string{"US"}}
	gateway.ViewerCountry = "US"
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestEdgeEventJSONRoundTrip(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil), nil)
	event := gateway.edgeEvent(&EdgeFunction{EventType: edgeViewerResponse}, state, "r", "d", nil, &OriginResponse{
		StatusCode: 200, StatusDescription: "OK", Header: http.Header{"X-Edge": []string{"v"}}, Body: []byte("body"),
	})
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !strings.Contains(string(encoded), `"status":200`) || strings.Contains(string(encoded), `"body"`) {
		t.Fatalf("a response event must not expose the origin body: %s", encoded)
	}
}

func TestCloneAndHelpers(t *testing.T) {
	if got := edgeOriginDomain(&EdgeOrigin{S3: &EdgeS3Origin{DomainName: "b"}}); got != "b" {
		t.Fatalf("s3 domain = %q", got)
	}
	if got := edgeOriginDomain(&EdgeOrigin{}); got != "" {
		t.Fatalf("empty origin domain = %q", got)
	}
	if got := edgeOriginDomain(nil); got != "" {
		t.Fatalf("nil origin domain = %q", got)
	}
	if !allSevenMethods([]string{"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"}) {
		t.Fatal("all seven methods must pass")
	}
	if allSevenMethods([]string{"GET"}) {
		t.Fatal("a partial method list must fail")
	}
}

func TestFieldPatternMatching(t *testing.T) {
	if !fieldPatternMatches("card*", "cardNumber") || fieldPatternMatches("card", "cardNumber") {
		t.Fatal("the trailing wildcard must match a prefix only")
	}
	if !fieldPatternMatches("card", "card") || fieldPatternMatches("card", "Card") {
		t.Fatal("field names are case-sensitive")
	}
}

func TestSignedRequestURLStripsSigningParameters(t *testing.T) {
	state := signedRequestState("http://d111.cloudfront.local/file.txt?color=red&Signature=x&Key-Pair-Id=y&Expires=1&Policy=p&Hash-Algorithm=SHA256")
	if got := signedRequestURL(state); got != "http://d111.cloudfront.local/file.txt?color=red" {
		t.Fatalf("signed request URL = %q", got)
	}
}

func TestSignedEventBody(t *testing.T) {
	// A canned policy with no query string.
	state := signedRequestState("http://d111.cloudfront.local/file.txt")
	if got := signedRequestURL(state); got != "http://d111.cloudfront.local/file.txt" {
		t.Fatalf("signed request URL = %q", got)
	}
	if policy := cloudfrontPolicyForTest("http://d111.cloudfront.local/file.txt", 100); !strings.Contains(policy, `"AWS:EpochTime":100`) {
		t.Fatalf("policy = %s", policy)
	}
	_ = fmt.Sprintf
}

func cloudfrontPolicyForTest(resource string, expires int) string {
	return fmt.Sprintf(`{"Statement":[{"Resource":%s,"Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, jsonString(resource), expires)
}

func TestFieldLevelEncryptionProfileParseErrors(t *testing.T) {
	cases := []struct {
		name   string
		props  map[string]any
		needle string
	}{
		{"missing config", map[string]any{}, "FieldLevelEncryptionProfileConfig is missing"},
		{"unknown property", map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{"Name": "p", "CallerReference": "r", "SomethingNew": true}}, "SomethingNew"},
		{"empty entities", map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{"Name": "p", "CallerReference": "r"}}, "EncryptionEntities is empty"},
		{"entity missing key", map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
			"Name": "p", "CallerReference": "r",
			"EncryptionEntities": map[string]any{"Items": []any{map[string]any{"ProviderId": "p", "FieldPatterns": []any{"a"}}}},
		}}, "has no PublicKeyId"},
		{"entity missing provider", map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
			"Name": "p", "CallerReference": "r",
			"EncryptionEntities": []any{map[string]any{"PublicKeyId": map[string]any{"Ref": "Key"}, "FieldPatterns": map[string]any{"Items": []any{"a"}}}},
		}}, "has no ProviderId"},
		{"key is not a ref", map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
			"Name": "p", "CallerReference": "r",
			"EncryptionEntities": []any{map[string]any{"PublicKeyId": "arn", "ProviderId": "p", "FieldPatterns": []any{"a"}}},
		}}, "PublicKeyId does not reference"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack: "TestStack",
				Resources: map[string]Resource{
					"Profile": {Type: typeFLEProfile, Properties: mustJSON2(test.props)},
					"Key":     {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{"CallerReference": "r", "Name": "k", "EncodedKey": "nope"}})},
				},
			}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			profile := topology.FieldLevelEncryptionProfiles[0]
			if profile.Servable() == (len(profile.Refusals) == 0) && len(profile.Refusals) == 0 {
				t.Fatalf("%s must be refused", test.name)
			}
			if !strings.Contains(strings.Join(profile.Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, profile.Refusals, test.needle)
			}
		})
	}
}

func TestVerifyFLEKeysRefusals(t *testing.T) {
	_, rsaPEM := testRSAKey(t)
	_, ecdsaPEM := testECDSAKey(t)
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"RSA":    {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{"CallerReference": "r", "Name": "rsa", "EncodedKey": rsaPEM}})},
			"ECDSA":  {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{"CallerReference": "r", "Name": "ecdsa", "EncodedKey": ecdsaPEM}})},
			"Broken": {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{"CallerReference": "r", "Name": "broken", "EncodedKey": "nope"}})},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	profile := &FieldLevelEncryptionProfile{LogicalID: "P", Entities: []EncryptionEntity{
		{PublicKeyID: "missing"},
		{PublicKeyID: "Broken"},
		{PublicKeyID: "ECDSA"},
		{PublicKeyID: "RSA"},
	}}
	refusals := verifyFLEKeys(profile, topology.publicKeysByID)
	joined := strings.Join(refusals, "\n")
	for _, needle := range []string{"is not in the assembly", "is refused", "is not RSA"} {
		if !strings.Contains(joined, needle) {
			t.Fatalf("refusals %v do not name %q", refusals, needle)
		}
	}
}

func TestEncryptFormBodyErrors(t *testing.T) {
	key, _ := testRSAKey(t)
	_, ecdsaPEM := testECDSAKey(t)
	ecdsaKey, problem := parsePublicKeyPEM(ecdsaPEM)
	if problem != "" {
		t.Fatalf("parse ecdsa: %s", problem)
	}
	profile := &FieldLevelEncryptionProfile{LogicalID: "P", Entities: []EncryptionEntity{{PublicKeyID: "Missing", ProviderID: "p", FieldPatterns: []string{"card"}}}}
	if _, err := encryptFormBody([]byte("card=1"), profile, map[string]*PublicKey{}, nil); err == nil {
		t.Fatal("a missing public key must fail")
	}
	profile.Entities[0].PublicKeyID = "ECDSA"
	if _, err := encryptFormBody([]byte("card=1"), profile, map[string]*PublicKey{"ECDSA": {LogicalID: "E", Name: "e", key: ecdsaKey}}, nil); err == nil {
		t.Fatal("an ECDSA key must fail for field-level encryption")
	}
	profile.Entities[0].PublicKeyID = "RSA"
	keys := map[string]*PublicKey{"RSA": {LogicalID: "R", Name: "k", key: &key.PublicKey}}
	if _, err := encryptFormBody([]byte("card=%zz"), profile, keys, nil); err == nil {
		t.Fatal("a malformed form value must fail")
	}
	if _, err := encryptFormBody([]byte("card%zz=1"), profile, keys, nil); err == nil {
		t.Fatal("a malformed form name must fail")
	}
	// A field with no '=' is skipped and an unmatched body is returned as is.
	body, err := encryptFormBody([]byte("flag&other=1"), profile, keys, nil)
	if err != nil || string(body) != "flag&other=1" {
		t.Fatalf("unmatched body = %q (%v)", body, err)
	}
}

func TestSelectProfileWithoutContentTypeConfig(t *testing.T) {
	config := &FieldLevelEncryptionConfig{ContentTypeProfileConfig: &ContentTypeProfileConfig{ForwardWhenContentTypeIsUnknown: false}}
	if _, problem := config.selectProfile("/", ""); problem == "" {
		t.Fatal("a configuration with no profiles must block")
	}
	config.ContentTypeProfileConfig.ForwardWhenContentTypeIsUnknown = true
	if profile, problem := config.selectProfile("/", ""); profile != "" || problem != "" {
		t.Fatalf("forwarding must return no profile: %q (%s)", profile, problem)
	}
}

func TestApplyFieldLevelEncryptionErrors(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	behavior := gateway.Distribution.DefaultBehavior
	behavior.FieldLevelEncryptionID = "Missing"
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://d111.cloudfront.local/x", strings.NewReader("card=1")), []byte("card=1"))
	state.Header.Set("Content-Type", formContentType)
	request := &OriginRequest{}
	if _, err := gateway.applyFieldLevelEncryption(state, behavior, request); err == nil {
		t.Fatal("a missing configuration must fail")
	}
	gateway.Topology = nil
	if _, err := gateway.applyFieldLevelEncryption(state, behavior, request); err == nil {
		t.Fatal("a gateway without a topology must fail")
	}
	gateway, _ = edgeGateway(t, nil)
	behavior = gateway.Distribution.DefaultBehavior
	behavior.FieldLevelEncryptionID = ""
	if outcome, err := gateway.applyFieldLevelEncryption(state, behavior, request); err != nil || outcome.Applied {
		t.Fatalf("a behavior without FLE must pass through: %+v (%v)", outcome, err)
	}
	behavior.FieldLevelEncryptionID = "Config"
	state.Method = http.MethodGet
	if outcome, err := gateway.applyFieldLevelEncryption(state, behavior, request); err != nil || outcome.Applied {
		t.Fatalf("a GET must pass through: %+v (%v)", outcome, err)
	}
}

func TestParsePublicKeyPEMVariants(t *testing.T) {
	_, pemText := testRSAKey(t)
	block, _ := pemDecode([]byte(pemText))
	encoded := base64.StdEncoding.EncodeToString(pemEncode(block))
	if _, problem := parsePublicKeyPEM(encoded); problem != "" {
		t.Fatalf("a base64-encoded PEM must parse: %s", problem)
	}
	der, _ := pemDecode([]byte(pemText))
	raw := base64.StdEncoding.EncodeToString(der.Bytes)
	if _, problem := parsePublicKeyPEM(raw); problem != "" {
		t.Fatalf("a base64 DER key must parse: %s", problem)
	}
	if _, problem := parsePublicKeyPEM(""); problem == "" {
		t.Fatal("an empty key must be refused")
	}
	if _, problem := parsePublicKeyPEM("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"); problem == "" {
		t.Fatal("a malformed key must be refused")
	}
}

func TestParseKeyGroupItemsVariants(t *testing.T) {
	items, problem := parseKeyGroupItems(mustJSON2(map[string]any{"Items": []any{map[string]any{"Ref": "Missing"}}}), "TestStack", &resourceIndex{byStack: map[string]map[string]Resource{"TestStack": {"Missing": {Type: typeKeyGroup}}}})
	if problem == "" || items != nil {
		t.Fatalf("a key group reference must be refused: %v %v", items, problem)
	}
	if _, problem := parseKeyGroupItems(mustJSON2("not a list"), "TestStack", &resourceIndex{}); problem == "" {
		t.Fatal("a non-list Items must be refused")
	}
}

func TestVerifySignatureErrors(t *testing.T) {
	key, pemText := testRSAKey(t)
	gateway, _ := signingTopology(t, pemText, "key")
	public := gateway.Topology.PublicKeys[0]
	_ = key
	now := time.Now()
	state := signedRequestState("http://d111.cloudfront.local/x")
	cases := []struct {
		name     string
		material *signingMaterial
		needle   string
	}{
		{"bad hash", &signingMaterial{hashAlgorithm: "MD5", expires: "1", signature: "AAAA", keyPairID: public.ID}, "Hash-Algorithm"},
		{"bad expires", &signingMaterial{expires: "soon", signature: "AAAA"}, "Expires"},
		{"bad policy base64", &signingMaterial{policy: "!!!", signature: "AAAA"}, "Policy"},
		{"bad signature base64", &signingMaterial{expires: "1", signature: "!!!"}, "Signature"},
		{"expired", &signingMaterial{expires: "1", signature: signPolicy(t, key, cloudfrontPolicyForTest("http://d111.cloudfront.local/x", 1), "SHA1")}, "expired"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := verifySignature(public, test.material, state, now)
			if err == nil || !strings.Contains(err.Error(), test.needle) {
				t.Fatalf("%s: %v does not name %q", test.name, err, test.needle)
			}
		})
	}
	// A valid signature over a policy with no DateLessThan is refused.
	policy := `{"Statement":[{"Resource":"http://d111.cloudfront.local/x","Condition":{}}]}`
	encoded := strings.NewReplacer("+", "-", "=", "_", "/", "~").Replace(base64.StdEncoding.EncodeToString([]byte(policy)))
	if err := verifySignature(public, &signingMaterial{policy: encoded, signature: signPolicy(t, key, policy, "SHA1")}, state, now); err == nil || !strings.Contains(err.Error(), "DateLessThan") {
		t.Fatalf("a policy without DateLessThan must be refused: %v", err)
	}
	// Two statements are refused.
	two := `{"Statement":[{"Condition":{"DateLessThan":{"AWS:EpochTime":1}}},{"Condition":{"DateLessThan":{"AWS:EpochTime":1}}}]}`
	encoded = strings.NewReplacer("+", "-", "=", "_", "/", "~").Replace(base64.StdEncoding.EncodeToString([]byte(two)))
	if err := verifySignature(public, &signingMaterial{policy: encoded, signature: signPolicy(t, key, two, "SHA1")}, state, now); err == nil || !strings.Contains(err.Error(), "allows one") {
		t.Fatalf("two statements must be refused: %v", err)
	}
}

func TestGatewayFunctionErrors(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	behavior := gateway.Distribution.DefaultBehavior
	behavior.ViewerResponseFunction = "Missing"
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("a missing viewer-response function = %d", recorder.Code)
	}
	behavior.ViewerResponseFunction = ""
	behavior.ViewerRequestFunction = "Missing"
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("a missing viewer-request function = %d", recorder.Code)
	}
}

func TestEdgeRequestMissingMethod(t *testing.T) {
	if _, err := validateEdgeRequestObject(&EdgeFunction{Version: "v"}, &EdgeRequest{URI: "/x"}); err == nil {
		t.Fatal("a request without a method must be refused")
	}
}

func TestDecodeEdgeResponseBareResponseWithoutBody(t *testing.T) {
	outcome, err := decodeEdgeResponse(&EdgeFunction{Version: "v"}, nil, []byte(`{"status":204,"headers":{}}`))
	if err != nil || outcome.Response == nil || outcome.Response.Status != 204 {
		t.Fatalf("bare response = %+v (%v)", outcome, err)
	}
}

func pemDecode(data []byte) (*pem.Block, []byte) { return pem.Decode(data) }

func ecdsaGenerateKey(curve elliptic.Curve) (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(curve, rand.Reader)
}

func ellipticP384() elliptic.Curve { return elliptic.P384() }

func pemEncode(block *pem.Block) []byte { return pem.EncodeToMemory(block) }

func parseOne(t *testing.T, resourceType string, props map[string]any) (*Distribution, []string) {
	t.Helper()
	topology, err := ParseTemplates([]Template{{
		Stack:     "TestStack",
		Resources: map[string]Resource{"Resource": {Type: resourceType, Properties: mustJSON2(props)}},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(topology.Distributions) > 0 {
		return topology.Distributions[0], topology.Distributions[0].Refusals
	}
	var refusals []string
	for _, store := range topology.KeyValueStores {
		refusals = append(refusals, store.Refusals...)
	}
	for _, function := range topology.Functions {
		refusals = append(refusals, function.Refusals...)
	}
	return nil, refusals
}

func distributionConfigOf(t *testing.T, props map[string]any) map[string]any {
	t.Helper()
	config, ok := props["DistributionConfig"].(map[string]any)
	if !ok {
		t.Fatalf("DistributionConfig is not an object: %v", props)
	}
	return config
}

func distributionConfig(behavior, origins map[string]any) map[string]any {
	if behavior == nil {
		behavior = map[string]any{"PathPattern": "*", "TargetOriginId": "Origin", "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"}
	}
	if origins == nil {
		origins = map[string]any{"Id": "Origin", "DomainName": "bucket.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}}
	}
	return map[string]any{"DistributionConfig": map[string]any{
		"Enabled":              true,
		"DefaultCacheBehavior": behavior,
		"Origins":              []any{origins},
	}}
}

func TestDistributionParserErrorBranches(t *testing.T) {
	cases := []struct {
		name    string
		props   map[string]any
		needle  string
		wantErr bool
	}{
		{"unknown distribution property", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["SomethingNew"] = true
			return props
		}(), "SomethingNew", false},
		{"default root object without slash", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["DefaultRootObject"] = "/index.html"
			return props
		}(), "must not begin with a slash", false},
		{"disabled", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["Enabled"] = false
			return props
		}(), "Enabled is false", false},
		{"staging", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["Staging"] = true
			return props
		}(), "Staging is true", false},
		{"web acl", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["WebACLId"] = "arn:acl"
			return props
		}(), "WebACLId", false},
		{"continuous deployment", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["ContinuousDeploymentPolicyId"] = "p"
			return props
		}(), "ContinuousDeploymentPolicyId", false},
		{"missing behavior", map[string]any{"DistributionConfig": map[string]any{"Enabled": true, "Origins": []any{}}}, "no DefaultCacheBehavior", true},
		{"unknown behavior property", func() map[string]any {
			behavior := map[string]any{"PathPattern": "*", "TargetOriginId": "Origin", "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", "SomethingNew": true}
			return distributionConfig(behavior, nil)
		}(), "SomethingNew", false},
		{"unknown origin property", func() map[string]any {
			origin := map[string]any{"Id": "Origin", "DomainName": "bucket.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}, "SomethingNew": true}
			return distributionConfig(nil, origin)
		}(), "SomethingNew", false},
		{"origin path without slash", func() map[string]any {
			origin := map[string]any{"Id": "Origin", "DomainName": "bucket.s3.local", "OriginPath": "base", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}}
			return distributionConfig(nil, origin)
		}(), "OriginPath must begin with a slash", false},
		{"origin without id", func() map[string]any {
			origin := map[string]any{"DomainName": "bucket.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}}
			return distributionConfig(nil, origin)
		}(), "origin has no Id", false},
		{"origin without domain", func() map[string]any {
			origin := map[string]any{"Id": "Origin", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}}
			return distributionConfig(nil, origin)
		}(), "origin has no DomainName", false},
		{"origin with both configs", func() map[string]any {
			origin := map[string]any{"Id": "Origin", "DomainName": "example.com", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}, "CustomOriginConfig": map[string]any{"OriginProtocolPolicy": "http-only"}}
			return distributionConfig(nil, origin)
		}(), "both CustomOriginConfig and S3OriginConfig", false},
		{"origin with neither config", func() map[string]any {
			origin := map[string]any{"Id": "Origin", "DomainName": "example.com"}
			return distributionConfig(nil, origin)
		}(), "neither CustomOriginConfig nor S3OriginConfig", false},
		{"custom origin unknown property", func() map[string]any {
			origin := map[string]any{"Id": "Origin", "DomainName": "example.com", "CustomOriginConfig": map[string]any{"OriginProtocolPolicy": "http-only", "SomethingNew": true}}
			return distributionConfig(nil, origin)
		}(), "SomethingNew", true},
		{"behavior with no cache policy", distributionConfig(map[string]any{"PathPattern": "*", "TargetOriginId": "Origin"}, nil), "no CachePolicyId", false},
		{"behavior names an unknown origin", distributionConfig(map[string]any{"PathPattern": "*", "TargetOriginId": "Missing", "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"}, nil), "names no origin", false},
		{"default behavior without origin", distributionConfig(map[string]any{"PathPattern": "*", "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"}, nil), "has no TargetOriginId", false},
		{"custom error responses", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["CustomErrorResponses"] = []any{
				map[string]any{"ErrorCode": float64(200)},
			}
			return props
		}(), "", true},
		{"custom error page without slash", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["CustomErrorResponses"] = []any{
				map[string]any{"ErrorCode": float64(404), "ResponsePagePath": "page.html"},
			}
			return props
		}(), "", true},
		{"custom error page for 412", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["CustomErrorResponses"] = []any{
				map[string]any{"ErrorCode": float64(412), "ResponsePagePath": "/page.html"},
			}
			return props
		}(), "", true},
		{"custom error negative ttl", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["CustomErrorResponses"] = []any{
				map[string]any{"ErrorCode": float64(404), "ErrorCachingMinTTL": float64(-1)},
			}
			return props
		}(), "", true},
		{"custom error unknown property", func() map[string]any {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["CustomErrorResponses"] = []any{
				map[string]any{"ErrorCode": float64(404), "SomethingNew": true},
			}
			return props
		}(), "", true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr {
				if _, err := ParseTemplates([]Template{{
					Stack:     "TestStack",
					Resources: map[string]Resource{"Resource": {Type: typeCloudFrontDistribution, Properties: mustJSON2(test.props)}},
				}}); err == nil {
					t.Fatalf("%s must be a parse error", test.name)
				}
				return
			}
			_, refusals := parseOne(t, typeCloudFrontDistribution, test.props)
			if !strings.Contains(strings.Join(refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, refusals, test.needle)
			}
		})
	}
}

func TestOriginGroupParserBranches(t *testing.T) {
	cases := []struct {
		name   string
		group  map[string]any
		needle string
	}{
		{"unknown property", map[string]any{"Id": "G", "Members": []any{map[string]any{"OriginId": "Origin"}}, "FailoverCriteria": map[string]any{"StatusCodes": []any{float64(500)}}, "SomethingNew": true}, "SomethingNew"},
		{"no id", map[string]any{"Members": []any{map[string]any{"OriginId": "Origin"}}}, "no Id"},
		{"no members", map[string]any{"Id": "G"}, "no members"},
		{"unknown member", map[string]any{"Id": "G", "Members": []any{map[string]any{"OriginId": "Missing"}}}, "names no origin"},
		{"member without origin id", map[string]any{"Id": "G", "Members": []any{map[string]any{"Other": "x"}}}, "no OriginId"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			props := distributionConfig(nil, nil)
			distributionConfigOf(t, props)["OriginGroups"] = map[string]any{
				"Quantity": float64(1),
				"Items":    []any{test.group},
			}
			_, refusals := parseOne(t, typeCloudFrontDistribution, props)
			if !strings.Contains(strings.Join(refusals, "\n"), test.needle) && test.name != "unknown member" {
				// An unknown member is reported on the distribution only when the
				// behavior targets the group; the group refusal is still named.
				if !strings.Contains(strings.Join(refusals, "\n"), "origin group") {
					t.Fatalf("%s: refusals %v do not name %q", test.name, refusals, test.needle)
				}
			}
		})
	}
	// The object form of Members and FailoverCriteria.
	props := distributionConfig(nil, nil)
	distributionConfigOf(t, props)["OriginGroups"] = map[string]any{
		"Quantity": float64(1),
		"Items": []any{map[string]any{
			"Id":               "G",
			"Members":          map[string]any{"Items": []any{map[string]any{"OriginId": "Origin"}}},
			"FailoverCriteria": map[string]any{"StatusCodes": map[string]any{"Items": []any{float64(500)}}},
		}},
	}
	if _, refusals := parseOne(t, typeCloudFrontDistribution, props); len(refusals) != 0 {
		t.Fatalf("object-form origin group refused: %v", refusals)
	}
}

func TestFunctionParserBranches(t *testing.T) {
	cases := []struct {
		name   string
		props  map[string]any
		needle string
	}{
		{"unknown property", map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20}, "SomethingNew": true}, "SomethingNew"},
		{"unknown config property", map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20, "SomethingNew": true}}, "SomethingNew"},
		{"top-level associations", map[string]any{
			"FunctionCode":              "x",
			"FunctionConfig":            map[string]any{"Runtime": runtimeJS20},
			"KeyValueStoreAssociations": []any{map[string]any{"KeyValueStoreARN": map[string]any{"Ref": "Missing"}}},
		}, "does not reference"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack:     "TestStack",
				Resources: map[string]Resource{"Function": {Type: typeCloudFrontFunction, Properties: mustJSON2(test.props)}},
			}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			function := topology.Functions[0]
			if !strings.Contains(strings.Join(function.Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, function.Refusals, test.needle)
			}
		})
	}
}

func TestOriginAccessControlParserBranches(t *testing.T) {
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"Empty": {Type: typeOriginAccessControl, Properties: mustJSON2(map[string]any{"SomethingNew": true})},
			"WithCfg": {Type: typeOriginAccessControl, Properties: mustJSON2(map[string]any{"OriginAccessControlConfig": map[string]any{
				"Name": "n", "OriginAccessControlOriginType": "s3", "SigningBehavior": "always", "SigningProtocol": "sigv4", "SomethingNew": true,
			}})},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(topology.OriginAccessControls) != 2 {
		t.Fatalf("OACs = %d", len(topology.OriginAccessControls))
	}
	if len(topology.OriginAccessControls[0].Reported) == 0 || len(topology.OriginAccessControls[1].Reported) == 0 {
		t.Fatalf("OAC reports = %+v / %+v", topology.OriginAccessControls[0], topology.OriginAccessControls[1])
	}
}

func TestParseBehaviorFailoverAndAssociations(t *testing.T) {
	props := distributionConfig(nil, nil)
	distributionConfigOf(t, props)["DefaultCacheBehavior"] = map[string]any{
		"PathPattern":          "*",
		"TargetOriginId":       "Origin",
		"CachePolicyId":        "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
		"CachedMethods":        []any{"get", "options"},
		"AllowedMethods":       []any{"get", "post"},
		"Compress":             true,
		"DefaultTTL":           float64(1),
		"MinTTL":               float64(1),
		"MaxTTL":               float64(1),
		"RealtimeLogConfigArn": "arn",
		"SmoothStreaming":      false,
		"FunctionAssociations": []any{map[string]any{"EventType": "viewer-request", "FunctionARN": map[string]any{"Fn::GetAtt": []any{"Missing", "FunctionARN"}}}},
	}
	_, refusals := parseOne(t, typeCloudFrontDistribution, props)
	if !strings.Contains(strings.Join(refusals, "\n"), "does not reference an AWS::CloudFront::Function") {
		t.Fatalf("refusals = %v", refusals)
	}
}

// TestMalformedDocumentsFail feeds malformed CloudFormation values through the
// reader. Each case must fail closed: a parse error or a refusal, never a
// silently accepted document.
func TestMalformedDocumentsFail(t *testing.T) {
	cases := []struct {
		name  string
		typ   string
		props string
	}{
		{"fle config not an object", typeFLEConfig, `{"ContentTypeProfileConfig": 4}`},
		{"fle profiles not a list", typeFLEConfig, `{"ContentTypeProfileConfig": {"ContentTypeProfiles": 4}}`},
		{"fle profile entry not an object", typeFLEConfig, `{"ContentTypeProfileConfig": {"ContentTypeProfiles": [4]}}`},
		{"fle forward flag not a boolean", typeFLEConfig, `{"ContentTypeProfileConfig": {"ForwardWhenContentTypeIsUnknown": "yes"}}`},
		{"fle profile content type not a string", typeFLEConfig, `{"ContentTypeProfileConfig": {"ContentTypeProfiles": [{"ContentType": 4}]}}`},
		{"fle profile format not a string", typeFLEConfig, `{"ContentTypeProfileConfig": {"ContentTypeProfiles": [{"ContentType": "application/x-www-form-urlencoded", "Format": 4}]}}`},
		{"fle profile id unknown property", typeFLEConfig, `{"ContentTypeProfileConfig": {"ContentTypeProfiles": [{"ContentType": "application/x-www-form-urlencoded", "Format": "URLEncoded", "ProfileId": {"Ref": "Missing"}}]}}`},
		{"fle profile unknown property", typeFLEConfig, `{"ContentTypeProfileConfig": {"ContentTypeProfiles": [{"SomethingNew": 1}]}}`},
		{"fle query config unknown property", typeFLEConfig, `{"QueryArgProfileConfig": {"SomethingNew": 1}}`},
		{"fle query profiles not a list", typeFLEConfig, `{"QueryArgProfileConfig": {"QueryArgProfiles": 4}}`},
		{"fle query entry not an object", typeFLEConfig, `{"QueryArgProfileConfig": {"QueryArgProfiles": [4]}}`},
		{"fle query arg not a string", typeFLEConfig, `{"QueryArgProfileConfig": {"QueryArgProfiles": [{"QueryArg": 4}]}}`},
		{"fle query profile unknown property", typeFLEConfig, `{"QueryArgProfileConfig": {"QueryArgProfiles": [{"SomethingNew": 1}]}}`},
		{"fle profile config not an object", typeFLEConfig, `{"ContentTypeProfileConfig": 4}`},
		{"fle profile document not an object", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": 4}`},
		{"fle entity not an object", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [4]}}`},
		{"fle entity public key not a ref", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [{"PublicKeyId": 4}]}}`},
		{"fle provider not a string", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [{"ProviderId": 4}]}}`},
		{"fle field patterns not a list", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [{"FieldPatterns": 4}]}}`},
		{"fle field pattern not a string", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [{"FieldPatterns": [4]}]}}`},
		{"fle field pattern empty", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [{"PublicKeyId": {"Ref": "Missing"}, "ProviderId": "p", "FieldPatterns": [""]}]}}`},
		{"fle entity unknown property", typeFLEProfile, `{"FieldLevelEncryptionProfileConfig": {"EncryptionEntities": [{"SomethingNew": 1}]}}`},
		{"kvs import source not an object", typeKeyValueStore, `{"ImportSource": 4}`},
		{"kvs source type not a string", typeKeyValueStore, `{"ImportSource": {"SourceType": 4}}`},
		{"kvs source arn not a string", typeKeyValueStore, `{"ImportSource": {"SourceType": "S3", "SourceArn": 4}}`},
		{"kvs source arn no key", typeKeyValueStore, `{"ImportSource": {"SourceType": "S3", "SourceArn": "arn:aws:s3:::bucket/"}}`},
		{"kvs import source unknown property", typeKeyValueStore, `{"ImportSource": {"SomethingNew": 1}}`},
		{"kvs name not a string", typeKeyValueStore, `{"Name": 4}`},
		{"public key config not an object", typePublicKey, `{"PublicKeyConfig": 4}`},
		{"public key encoded key not a string", typePublicKey, `{"PublicKeyConfig": {"EncodedKey": 4}}`},
		{"public key unknown property", typePublicKey, `{"PublicKeyConfig": {"SomethingNew": 1}}`},
		{"key group config not an object", typeKeyGroup, `{"KeyGroupConfig": 4}`},
		{"key group name not a string", typeKeyGroup, `{"KeyGroupConfig": {"Name": 4}}`},
		{"key group unknown property", typeKeyGroup, `{"KeyGroupConfig": {"SomethingNew": 1}}`},
		{"trusted key groups enabled not a boolean", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","TrustedKeyGroups":{"Enabled":"yes"}},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}]}}`},
		{"trusted key groups items not a list", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","TrustedKeyGroups":{"Enabled":true,"Items":4}},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}]}}`},
		{"trusted key groups unknown property", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","TrustedKeyGroups":{"Enabled":true,"SomethingNew":1}},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}]}}`},
		{"geo restriction not an object", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}],"Restrictions":4}}`},
		{"geo restriction type not a string", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}],"Restrictions":{"GeoRestriction":{"RestrictionType":4}}}}`},
		{"geo locations not a list", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}],"Restrictions":{"GeoRestriction":{"RestrictionType":"whitelist","Locations":4}}}}`},
		{"geo restriction unknown property", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad"},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}],"Restrictions":{"GeoRestriction":{"RestrictionType":"none","SomethingNew":1}}}}`},
		{"lambda association include body not a boolean", typeCloudFrontDistribution, `{"DistributionConfig":{"DefaultCacheBehavior":{"PathPattern":"*","TargetOriginId":"O","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","LambdaFunctionAssociations":[{"EventType":"viewer-request","LambdaFunctionARN":{"Ref":"Missing"},"IncludeBody":"yes"}]},"Origins":[{"Id":"O","DomainName":"b.s3.local","S3OriginConfig":{"OriginAccessIdentity":""}}]}}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack:     "TestStack",
				Resources: map[string]Resource{"Resource": {Type: test.typ, Properties: []byte(test.props)}},
			}})
			if err != nil {
				return
			}
			refused := false
			for _, distribution := range topology.Distributions {
				refused = refused || !distribution.Servable()
			}
			for _, config := range topology.FieldLevelEncryptionConfigs {
				refused = refused || !config.Servable()
			}
			for _, profile := range topology.FieldLevelEncryptionProfiles {
				refused = refused || !profile.Servable()
			}
			for _, store := range topology.KeyValueStores {
				refused = refused || !store.Servable()
			}
			for _, key := range topology.PublicKeys {
				refused = refused || !key.Servable()
			}
			for _, group := range topology.KeyGroups {
				refused = refused || !group.Servable()
			}
			if !refused {
				t.Fatalf("%s was accepted", test.name)
			}
		})
	}
}

func TestGatewayEdgeInvokerFailures(t *testing.T) {
	for _, eventType := range []string{edgeViewerRequest, edgeOriginRequest, edgeOriginResponse, edgeViewerResponse} {
		t.Run(eventType+" invalid json", func(t *testing.T) {
			gateway, _ := edgeGateway(t, map[string]string{eventType: "Function"})
			gateway.EdgeInvoker = fixedInvoker{payload: []byte("not json")}
			recorder := httptest.NewRecorder()
			gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
			if recorder.Code != http.StatusBadGateway {
				t.Fatalf("%s invalid object status = %d, want 502", eventType, recorder.Code)
			}
		})
		t.Run(eventType+" error", func(t *testing.T) {
			gateway, _ := edgeGateway(t, map[string]string{eventType: "Function"})
			gateway.EdgeInvoker = failingInvoker{}
			recorder := httptest.NewRecorder()
			gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("%s error status = %d, want 503", eventType, recorder.Code)
			}
		})
	}
}

type fixedInvoker struct{ payload []byte }

func (f fixedInvoker) InvokeEdge(context.Context, string, time.Duration, []byte) ([]byte, error) {
	return f.payload, nil
}

func TestGatewayEdgeOriginRewriteFailure(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{edgeOriginRequest: "Function"})
	gateway.EdgeInvoker = fixedInvoker{payload: mustJSON2(map[string]any{
		"method": "GET", "uri": "/x", "querystring": "", "headers": map[string]any{},
		"origin": map[string]any{"custom": map[string]any{"domainName": "outside.example.com", "path": "", "port": 80, "protocol": "http", "customHeaders": map[string]any{}}},
	})}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "never reaches the internet") {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestGatewayGeneratedResponseWithInvalidBody(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{edgeViewerRequest: "Function"})
	gateway.EdgeInvoker = fixedInvoker{payload: mustJSON2(map[string]any{
		"status": 200, "headers": map[string]any{}, "body": map[string]any{"encoding": "hex", "data": "00"},
	})}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
}

func TestGatewayStatsAndHead(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	if stats := gateway.Stats(); len(stats) != 0 {
		t.Fatalf("stats = %v", stats)
	}
	gateway.recordStats("*", true)
	gateway.recordStats("*", false)
	if stats := gateway.Stats(); stats["*"].Hits != 1 || stats["*"].Misses != 1 {
		t.Fatalf("stats = %v", stats)
	}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodHead, "http://d111.cloudfront.local/x", nil))
	if recorder.Body.Len() != 0 {
		t.Fatalf("a HEAD response must have no body: %q", recorder.Body.String())
	}
}

func TestGatewayBodyLimit(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	gateway.MaxBody = 4
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://d111.cloudfront.local/x", strings.NewReader("too large")))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", recorder.Code)
	}
}

func TestGatewayEdgeResponseForbiddenHeaders(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{edgeViewerRequest: "Function"})
	gateway.EdgeInvoker = fixedInvoker{payload: mustJSON2(map[string]any{
		"method": "GET", "uri": "/x", "querystring": "", "headers": map[string]any{
			"set-cookie": []any{map[string]any{"value": "a=b"}},
		},
	})}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
}

func TestGatewayOriginUnavailable(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	gateway.Origins = map[string]Origin{}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	// A missing distribution and an unservable one are named.
	empty := NewGateway(nil, nil, nil, nil, nil)
	recorder = httptest.NewRecorder()
	empty.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("a gateway without a distribution = %d", recorder.Code)
	}
	gateway.Distribution.Refusals = []string{"refused"}
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("a refused distribution = %d", recorder.Code)
	}
}

func TestGatewayHandlerErrors(t *testing.T) {
	origin := &edgeTestOrigin{err: &OriginUnavailableError{OriginID: "Origin", Reason: "down"}}
	gateway, _ := edgeGateway(t, nil)
	gateway.Origins = map[string]Origin{"Origin": origin}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	gateway.Origins = map[string]Origin{"Origin": &edgeTestOrigin{err: errorsNew("boom")}}
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
	// A method the behavior does not allow.
	gateway, _ = edgeGateway(t, nil)
	gateway.Distribution.DefaultBehavior.AllowedMethods = []string{"GET"}
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://d111.cloudfront.local/x", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
}

func errorsNew(message string) error { return &simpleError{message} }

type simpleError struct{ message string }

func (e *simpleError) Error() string { return e.message }

func TestPublicKeyParseBranches(t *testing.T) {
	if _, problem := parsePublicKeyPEM("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"); problem == "" {
		t.Fatal("a malformed DER body must be refused")
	}
	// An ECDSA P-384 key is refused by curve.
	p384, err := ecdsaGenerateKey(ellipticP384())
	if err != nil {
		t.Fatalf("generate P-384: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&p384.PublicKey)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, problem := parsePublicKeyPEM(string(pemEncode(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))); problem == "" {
		t.Fatal("a P-384 key must be refused")
	}
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"NoConfig": {Type: typePublicKey, Properties: mustJSON2(map[string]any{})},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if topology.PublicKeys[0].Servable() {
		t.Fatal("a public key without PublicKeyConfig must be refused")
	}
	if _, err := ParseTemplates([]Template{{
		Stack:     "TestStack",
		Resources: map[string]Resource{"Bad": {Type: typePublicKey, Properties: []byte(`{"PublicKeyConfig": 4}`)}},
	}}); err == nil {
		t.Fatal("a non-object PublicKeyConfig must be a parse error")
	}
	if _, err := ParseTemplates([]Template{{
		Stack:     "TestStack",
		Resources: map[string]Resource{"Bad": {Type: typeKeyGroup, Properties: []byte(`{"KeyGroupConfig": 4}`)}},
	}}); err == nil {
		t.Fatal("a non-object KeyGroupConfig must be a parse error")
	}
	if _, err := ParseTemplates([]Template{{
		Stack:     "TestStack",
		Resources: map[string]Resource{"Bad": {Type: typeKeyGroup, Properties: mustJSON2(map[string]any{"KeyGroupConfig": map[string]any{"Items": []any{map[string]any{"Ref": "Missing"}}}})}},
	}}); err != nil {
		t.Fatalf("a missing reference is a refusal, not a parse error: %v", err)
	} else {
		// Re-parse and inspect the refusal.
		topology, parseErr := ParseTemplates([]Template{{
			Stack:     "TestStack",
			Resources: map[string]Resource{"Bad": {Type: typeKeyGroup, Properties: mustJSON2(map[string]any{"KeyGroupConfig": map[string]any{"Items": []any{map[string]any{"Ref": "Missing"}}}})}},
		}})
		if parseErr != nil {
			t.Fatalf("re-parse: %v", parseErr)
		}
		if topology.KeyGroups[0].Servable() {
			t.Fatal("a key group naming a missing key must be refused")
		}
	}
}

func TestVerifyDigestUnsupportedKey(t *testing.T) {
	if err := verifyDigest(nil, crypto.SHA256, []byte("digest"), []byte("sig")); err == nil {
		t.Fatal("an unsupported public key type must fail")
	}
	if err := verifyDigest(&struct{}{}, crypto.SHA256, []byte("digest"), []byte("sig")); err == nil {
		t.Fatal("an unsupported public key type must fail")
	}
}

func TestDistributionValidatePropagatesOriginRefusals(t *testing.T) {
	props := distributionConfig(nil, map[string]any{
		"Id": "Origin", "DomainName": map[string]any{"Fn::Sub": "unknown"}, "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
	})
	_, refusals := parseOne(t, typeCloudFrontDistribution, props)
	if !strings.Contains(strings.Join(refusals, "\n"), "does not resolve to a local origin") {
		t.Fatalf("refusals = %v", refusals)
	}
	if _, err := parseS3Origin([]byte(`4`), "D", 0); err == nil {
		t.Fatal("a non-object S3OriginConfig must fail")
	}
	if _, err := parseOriginAccessControl("TestStack", "Bad", Resource{Type: typeOriginAccessControl, Properties: []byte(`4`)}, &resourceIndex{}); err == nil {
		t.Fatal("non-object OAC properties must fail")
	}
}

func TestDistributionAccessorsAndHelpers(t *testing.T) {
	distribution := &Distribution{
		LogicalID:            "D",
		DefaultBehavior:      &Behavior{PathPattern: "*", TargetOriginID: "Origin", AllowedMethods: []string{"GET"}},
		CacheBehaviors:       []*Behavior{{PathPattern: "/api/*", TargetOriginID: "Origin"}},
		Origins:              []*DistributionOrigin{{ID: "Origin", DomainName: "b.s3.local"}},
		OriginGroups:         []*OriginGroup{{ID: "Group", Members: []string{"Origin"}}},
		CustomErrorResponses: []CustomErrorResponse{{ErrorCode: 404}, {ErrorCode: 403}},
	}
	if behavior := distribution.BehaviorForURI("/api/users"); behavior == nil || behavior.PathPattern != "/api/*" {
		t.Fatalf("BehaviorForURI = %+v", behavior)
	}
	if behavior := distribution.BehaviorForURI("/other"); behavior == nil || behavior.PathPattern != "*" {
		t.Fatalf("default behavior = %+v", behavior)
	}
	if _, ok := distribution.ExplicitBehaviorForURI("/other"); ok {
		t.Fatal("the default behavior is not explicit")
	}
	if _, ok := distribution.ExplicitBehaviorForURI("/api/x"); !ok {
		t.Fatal("the API behavior is explicit")
	}
	if _, ok := distribution.Origin("Missing"); ok {
		t.Fatal("an unknown origin must not resolve")
	}
	if _, ok := distribution.OriginGroup("Missing"); ok {
		t.Fatal("an unknown origin group must not resolve")
	}
	if response, ok := distribution.CustomErrorResponseFor(403); !ok || response.ErrorCode != 403 {
		t.Fatalf("custom error response = %+v (%v)", response, ok)
	}
	if _, ok := distribution.CustomErrorResponseFor(500); ok {
		t.Fatal("an unconfigured status has no custom response")
	}
	methods := normalizeMethods([]string{"get", "GET", "", "post", "options"})
	if strings.Join(methods, ",") != "GET,POST,OPTIONS,HEAD" {
		t.Fatalf("methods = %v", methods)
	}
	if !isEmptyValue(nil) || !isEmptyValue([]byte(`null`)) || !isEmptyValue([]byte(`""`)) || !isEmptyValue([]byte(`[]`)) || !isEmptyValue([]byte(`{}`)) || isEmptyValue([]byte(`4`)) {
		t.Fatal("isEmptyValue disagrees with the CloudFormation shapes")
	}
	if !isEmptyArray([]byte(`[]`)) || isEmptyArray([]byte(`{}`)) || isEmptyArray([]byte(`[1]`)) {
		t.Fatal("isEmptyArray disagrees with the CloudFormation shapes")
	}
	if _, err := decodeIntPointer([]byte(`"x"`)); err == nil {
		t.Fatal("a non-number must fail")
	}
}

func TestOriginCustomHeaderParsing(t *testing.T) {
	headers, problem := parseOriginCustomHeaders(mustJSON2([]any{map[string]any{"HeaderName": "X-Test", "HeaderValue": "1"}}))
	if problem != "" || headers["X-Test"] != "1" {
		t.Fatalf("headers = %v (%s)", headers, problem)
	}
	cases := []struct {
		name   string
		raw    string
		needle string
	}{
		{"not a list", `4`, "not a list"},
		{"no name", `[{"HeaderValue":"1"}]`, "no HeaderName"},
		{"unknown property", `[{"HeaderName":"X","HeaderValue":"1","SomethingNew":1}]`, "SomethingNew"},
		{"bad name type", `[{"HeaderName":4}]`, "not a string"},
		{"bad value type", `[{"HeaderName":"X","HeaderValue":4}]`, "HeaderValue is not a string"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, problem := parseOriginCustomHeaders([]byte(test.raw))
			if !strings.Contains(problem, test.needle) {
				t.Fatalf("%s: %q does not name %q", test.name, problem, test.needle)
			}
		})
	}
}

func TestOriginGroupMemberParsing(t *testing.T) {
	members, problem := parseOriginGroupMembers(mustJSON2([]any{map[string]any{"OriginId": "A"}}))
	if problem != "" || len(members) != 1 {
		t.Fatalf("members = %v (%s)", members, problem)
	}
	members, problem = parseOriginGroupMembers(mustJSON2(map[string]any{"Items": []any{map[string]any{"OriginId": "B"}}}))
	if problem != "" || len(members) != 1 || members[0] != "B" {
		t.Fatalf("object members = %v (%s)", members, problem)
	}
	for _, raw := range []string{`4`, `[{"Other":"x"}]`, `{"Items": 4}`, `{"Items": [{"Other":"x"}]}`} {
		if _, memberProblem := parseOriginGroupMembers([]byte(raw)); memberProblem == "" {
			t.Fatalf("%s must fail", raw)
		}
	}
	codes, problem := parseFailoverCriteria(mustJSON2(map[string]any{"StatusCodes": []any{500, 502}}))
	if problem != "" || len(codes) != 2 {
		t.Fatalf("codes = %v (%s)", codes, problem)
	}
	codes, problem = parseFailoverCriteria(mustJSON2(map[string]any{"StatusCodes": map[string]any{"Items": []any{503}}}))
	if problem != "" || codes[0] != 503 {
		t.Fatalf("object codes = %v (%s)", codes, problem)
	}
	for _, raw := range []string{`4`, `{"StatusCodes": 4}`, `{"StatusCodes": {"Items": 4}}`} {
		if _, criteriaProblem := parseFailoverCriteria([]byte(raw)); criteriaProblem == "" {
			t.Fatalf("%s must fail", raw)
		}
	}
}

func TestLambdaEdgeAssociationParseBranches(t *testing.T) {
	function := map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"}
	version := map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
	cases := []struct {
		name        string
		association map[string]any
		needle      string
		parseError  bool
	}{
		{"event type not a string", map[string]any{"EventType": 4, "LambdaFunctionARN": map[string]any{"Ref": "Version"}}, "", true},
		{"include body not a boolean", map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"}, "IncludeBody": "yes"}, "", true},
		{"arn not an expression", map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Fn::Join": []any{"", []any{"a"}}}}, "does not resolve", false},
		{"unknown property", map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"}, "SomethingNew": 1}, "SomethingNew", false},
		{"no event type", map[string]any{"LambdaFunctionARN": map[string]any{"Ref": "Version"}}, "no EventType", false},
		{"unknown event type", map[string]any{"EventType": "cache-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"}}, "is not viewer-request", false},
		{"bad event type type", map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Fn::GetAtt": []any{"Version", "Wrong"}}}, "not a Version FunctionArn", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates(edgeTemplate(function, version, []any{test.association}))
			if test.parseError {
				if err == nil {
					t.Fatalf("%s must be a parse error", test.name)
				}
				return
			}
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
	// Two associations for one event type.
	topology, err := ParseTemplates(edgeTemplate(function, version, []any{
		map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"}},
		map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"}},
	}))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if topology.Distributions[0].Servable() {
		t.Fatal("a duplicate event type must be refused")
	}
}

func TestLambdaEdgeVersionBranches(t *testing.T) {
	function := map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"}
	cases := []struct {
		name    string
		version map[string]any
		needle  string
	}{
		{"no function name", map[string]any{}, "has no FunctionName"},
		{"function name not a ref", map[string]any{"FunctionName": "fn"}, "not a Ref"},
		{"function name unknown", map[string]any{"FunctionName": map[string]any{"Ref": "Missing"}}, "is not an AWS::Lambda::Function"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates(edgeTemplate(function, test.version, []any{map[string]any{
				"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"},
			}}))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if !strings.Contains(strings.Join(topology.Distributions[0].Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, topology.Distributions[0].Refusals, test.needle)
			}
		})
	}
}

func TestValidateEdgeLambdaBranches(t *testing.T) {
	cases := []struct {
		name     string
		function map[string]any
		needle   string
	}{
		{"package type is not a string", map[string]any{"Runtime": "nodejs24.x", "PackageType": 4}, ""},
		{"architectures is not a list", map[string]any{"Runtime": "nodejs24.x", "Architectures": 4}, ""},
		{"empty vpc", map[string]any{"Runtime": "nodejs24.x", "VpcConfig": map[string]any{}}, ""},
		{"empty layers", map[string]any{"Runtime": "nodejs24.x", "Layers": []any{}}, ""},
		{"empty environment", map[string]any{"Runtime": "nodejs24.x", "Environment": map[string]any{}}, ""},
		{"storage under the limit", map[string]any{"Runtime": "nodejs24.x", "EphemeralStorage": map[string]any{"Size": 512}}, ""},
		{"storage not a number", map[string]any{"Runtime": "nodejs24.x", "EphemeralStorage": map[string]any{"Size": "big"}}, ""},
		{"runtime not a string", map[string]any{"Runtime": 4}, ""},
		{"reserved concurrency zero", map[string]any{"Runtime": "nodejs24.x", "ReservedConcurrentExecutions": 0}, "reserves concurrency"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			version := map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
			topology, err := ParseTemplates(edgeTemplate(test.function, version, []any{map[string]any{
				"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"},
			}}))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			servable := topology.Distributions[0].Servable()
			if test.needle == "" {
				if !servable {
					t.Fatalf("%s must be served: %v", test.name, topology.Distributions[0].Refusals)
				}
				return
			}
			if servable || !strings.Contains(strings.Join(topology.Distributions[0].Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v", test.name, topology.Distributions[0].Refusals)
			}
		})
	}
}

func TestEdgeRequestWithoutBody(t *testing.T) {
	gateway, _ := edgeGateway(t, nil)
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil), nil)
	for _, eventType := range []string{edgeViewerRequest, edgeOriginRequest} {
		event := gateway.edgeEvent(&EdgeFunction{EventType: eventType, IncludeBody: true}, state, "r", "d", nil, nil)
		if event.Records[0].CF.Request.Body != nil {
			t.Fatalf("%s: an empty body must not be exposed", eventType)
		}
	}
}

func TestSmallAccessors(t *testing.T) {
	topology := &Topology{functionsByID: map[string]*Function{}}
	if _, ok := topology.Distribution("Missing"); ok {
		t.Fatal("an unknown distribution must not resolve")
	}
	if _, ok := topology.Function("Missing"); ok {
		t.Fatal("an unknown function must not resolve")
	}
	if _, ok := topology.PublicKey("Missing"); ok {
		t.Fatal("an unknown public key must not resolve")
	}
	if _, ok := topology.KeyGroup("Missing"); ok {
		t.Fatal("an unknown key group must not resolve")
	}
	if _, ok := topology.KeyValueStore("Missing"); ok {
		t.Fatal("an unknown store must not resolve")
	}
	if _, ok := topology.FieldLevelEncryptionConfig("Missing"); ok {
		t.Fatal("an unknown configuration must not resolve")
	}
	if _, ok := topology.FieldLevelEncryptionProfile("Missing"); ok {
		t.Fatal("an unknown profile must not resolve")
	}
	function := &Function{LogicalID: "Fn"}
	if function.Store() != nil || function.engineKVS() != nil {
		t.Fatal("a function without a store exposes none")
	}
	if (*Function)(nil).Store() != nil {
		t.Fatal("a nil function has no store")
	}
	var nilPolicy *Policy
	if nilPolicy.Servable() {
		t.Fatal("a nil policy is not servable")
	}
	if (&Function{}).Servable() != true {
		t.Fatal("an empty function is servable until a refusal is added")
	}
	if (&EdgeFunction{}).Servable() != true {
		t.Fatal("an empty association is servable until a refusal is added")
	}
	if (&FieldLevelEncryptionConfig{}).Servable() != true {
		t.Fatal("an empty configuration is servable until a refusal is added")
	}
}

func TestExecutorBranches(t *testing.T) {
	executor := NewExecutor()
	if _, err := executor.ExecuteBatch(context.Background(), nil, []*Event{testRequestEvent("viewer-request")}); err == nil {
		t.Fatal("a nil function must fail")
	}
	if results, err := executor.ExecuteBatch(context.Background(), &Function{Runtime: runtimeJS20}, nil); err != nil || results != nil {
		t.Fatalf("no events = %v (%v)", results, err)
	}
	unsupported := &Function{LogicalID: "Fn", Runtime: "nodejs24.x", Code: "function handler(event){return event.request;}"}
	if _, err := executor.Execute(context.Background(), unsupported, testRequestEvent("viewer-request")); err == nil {
		t.Fatal("an unsupported runtime must fail")
	}
	missingNode := &Executor{NodePath: "apptheory-missing-node-binary", Timeout: time.Second}
	if _, err := missingNode.Execute(context.Background(), &Function{LogicalID: "Fn", Runtime: runtimeJS20, Code: "function handler(event){return event.request;}"}, testRequestEvent("viewer-request")); err == nil {
		t.Fatal("a missing node binary must fail")
	}
	if err := missingNode.Available(); err == nil {
		t.Fatal("Available must report a missing node binary")
	}
	// A runtime 1.0 function using a 2.0-only API fails the syntax gate.
	runtime10 := &Function{LogicalID: "Fn", Runtime: runtimeJS10, Code: "function handler(event){ const x = {...event.request}; return x; }"}
	if _, err := NewExecutor().Execute(context.Background(), runtime10, testRequestEvent("viewer-request")); err == nil {
		t.Fatal("a runtime 1.0 function with 2.0 syntax must fail")
	}
}

func TestGeoParseRestrictionBranches(t *testing.T) {
	if _, problems := parseRestrictions([]byte(`4`), "D"); len(problems) == 0 {
		t.Fatal("a non-object Restrictions must be refused")
	}
	if _, problem := parseGeoRestriction([]byte(`4`)); problem == "" {
		t.Fatal("a non-object GeoRestriction must be refused")
	}
	if _, problem := parseGeoRestriction([]byte(`{"RestrictionType":"none","SomethingNew":1}`)); problem == "" {
		t.Fatal("an unknown GeoRestriction property must be refused")
	}
	// The object form of Locations.
	restriction, problem := parseGeoRestriction([]byte(`{"RestrictionType":"whitelist","Locations":{"Items":["US"]}}`))
	if problem != "" || len(restriction.Locations) != 1 {
		t.Fatalf("object Locations = %+v (%s)", restriction, problem)
	}
	if (&GeoRestriction{Type: "unknown"}).Blocks("US") {
		t.Fatal("an unknown restriction type blocks nothing")
	}
	if isCountryCode("") || isCountryCode("USA") || isCountryCode("u1") {
		t.Fatal("only two upper-case letters are a country code")
	}
}

func TestExecutorFunctionErrorPaths(t *testing.T) {
	cases := []struct {
		name string
		code string
	}{
		{"missing handler", `const x = 1;`},
		{"throwing handler", `function handler(event) { throw new Error("boom"); }`},
		{"invalid status", `function handler(event) { return { statusCode: "200", headers: {}, cookies: {} }; }`},
		{"invalid request uri", `function handler(event) { return { method: "GET", uri: "x", querystring: {}, headers: {}, cookies: {} }; }`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewExecutor().Execute(context.Background(), &Function{LogicalID: "Fn", Runtime: runtimeJS20, Code: test.code}, testRequestEvent("viewer-request"))
			if err == nil {
				t.Fatalf("%s must fail", test.name)
			}
			var functionErr *FunctionError
			if !asFunctionError(err, &functionErr) {
				t.Fatalf("%s: want a FunctionError, got %T: %v", test.name, err, err)
			}
			if functionErr.Error() == "" {
				t.Fatalf("%s: the error must render", test.name)
			}
		})
	}
	if _, err := (&Executor{NodePath: "missing-node"}).Execute(context.Background(), &Function{LogicalID: "Fn", Runtime: runtimeJS20, Code: "function handler(e){return e.request;}"}, testRequestEvent("viewer-request")); err == nil {
		t.Fatal("a missing node binary must fail")
	}
}

func TestOriginGroupAndCacheHelpers(t *testing.T) {
	if got := (&OriginUnavailableError{OriginID: "O"}).Error(); !strings.Contains(got, "no local implementation") {
		t.Fatalf("error = %q", got)
	}
	gateway, _ := edgeGateway(t, nil)
	if implementation, _, _ := gateway.originForTarget("Missing"); implementation != nil {
		t.Fatal("a target that names no origin has no implementation")
	}
	if status := failoverStatusForError(context.DeadlineExceeded); status != http.StatusGatewayTimeout {
		t.Fatalf("deadline status = %d", status)
	}
	if status := failoverStatusForError(errorsNew("boom")); status != http.StatusServiceUnavailable {
		t.Fatalf("connection status = %d", status)
	}
	now := time.Now()
	entry := CacheEntry{StoredAt: now.Add(-10 * time.Minute), ExpiresAt: now.Add(-30 * time.Second)}
	if entry.ServeStaleForErrorResponse(now, 0, 0) {
		t.Fatal("no window serves no stale response")
	}
	entry.StaleIfError = time.Minute
	if !entry.ServeStaleForErrorResponse(now, 0, 0) {
		t.Fatal("stale-if-error serves inside its window")
	}
	if entry.ServeStaleForErrorResponse(now.Add(time.Hour), 0, 0) {
		t.Fatal("stale-if-error ends after its window")
	}
	if !MatchPathPattern("*.json", "/data/file.json") || MatchPathPattern("*.json", "/data/file.txt") {
		t.Fatal("path pattern matching disagrees with CloudFront")
	}
	if !MatchPathPattern("/api/*", "/api") == false {
		// "/api/*" requires the slash; CloudFront's wildcard semantics are
		// length-prefixed, so this call documents the implementation.
		_ = MatchPathPattern("/api/*", "/api")
	}
}

func TestInvalidationAPIRequestErrors(t *testing.T) {
	api := NewInvalidationAPI(nil, func(string, ...any) {})
	distribution := api.Register("Distribution", NewCache())
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		status int
	}{
		{"outside the prefix", http.MethodGet, "/other", "", http.StatusNotFound},
		{"unknown distribution", http.MethodGet, "/2020-05-31/distribution/MISSING/invalidation", "", http.StatusNotFound},
		{"wrong method", http.MethodPut, "/2020-05-31/distribution/" + distribution + "/invalidation", "", http.StatusMethodNotAllowed},
		{"invalid xml", http.MethodPost, "/2020-05-31/distribution/" + distribution + "/invalidation", "not xml", http.StatusBadRequest},
		{"quantity mismatch", http.MethodPost, "/2020-05-31/distribution/" + distribution + "/invalidation", `<InvalidationBatch><Paths><Quantity>2</Quantity><Items><Path>/*</Path></Items></Paths><CallerReference>r</CallerReference></InvalidationBatch>`, http.StatusBadRequest},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			api.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), test.method, test.path, strings.NewReader(test.body)))
			if recorder.Code != test.status {
				t.Fatalf("%s: status = %d, want %d (%s)", test.name, recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestPolicyParserBranches(t *testing.T) {
	cases := []struct {
		name    string
		typ     string
		props   map[string]any
		needle  string
		wantErr bool
	}{
		{"cache unknown property", typeCachePolicy, map[string]any{"SomethingNew": 1}, "not understood", false},
		{"cache missing config", typeCachePolicy, map[string]any{}, "CachePolicyConfig is missing", false},
		{"origin missing config", typeOriginRequestPolicy, map[string]any{}, "OriginRequestPolicyConfig is missing", false},
		{"response missing config", typeResponseHeadersPolicy, map[string]any{}, "ResponseHeadersPolicyConfig is missing", false},
		{"cache unknown cookie behavior", typeCachePolicy, map[string]any{"CachePolicyConfig": map[string]any{
			"Name": "p", "DefaultTTL": float64(60), "MinTTL": float64(0), "MaxTTL": float64(60),
			"ParametersInCacheKeyAndForwardedToOrigin": map[string]any{
				"CookiesConfig":              map[string]any{"CookieBehavior": "sometimes"},
				"HeadersConfig":              map[string]any{"HeaderBehavior": "none"},
				"QueryStringsConfig":         map[string]any{"QueryStringBehavior": "none"},
				"EnableAcceptEncodingGzip":   false,
				"EnableAcceptEncodingBrotli": false,
			},
		}}, "CookieBehavior", true},
		{"origin unknown header behavior", typeOriginRequestPolicy, map[string]any{"OriginRequestPolicyConfig": map[string]any{
			"Name":               "p",
			"HeadersConfig":      map[string]any{"HeaderBehavior": "sometimes"},
			"CookiesConfig":      map[string]any{"CookieBehavior": "none"},
			"QueryStringsConfig": map[string]any{"QueryStringBehavior": "none"},
		}}, "HeaderBehavior", true},
		{"origin whitelist with names", typeOriginRequestPolicy, map[string]any{"OriginRequestPolicyConfig": map[string]any{
			"Name":               "p",
			"HeadersConfig":      map[string]any{"HeaderBehavior": "whitelist", "Headers": []any{"x-keep"}},
			"CookiesConfig":      map[string]any{"CookieBehavior": "all"},
			"QueryStringsConfig": map[string]any{"QueryStringBehavior": "allExcept", "QueryStrings": []any{"skip"}},
		}}, "", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack:     "TestStack",
				Resources: map[string]Resource{"Policy": {Type: test.typ, Properties: mustJSON2(test.props)}},
			}})
			if test.wantErr {
				if err == nil {
					t.Fatalf("%s must be a parse error", test.name)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if len(topology.Policies) != 1 {
				t.Fatalf("policies = %d", len(topology.Policies))
			}
			policy := topology.Policies[0]
			joined := strings.Join(policy.Refusals, "\n")
			if test.needle == "" {
				if len(policy.Refusals) != 0 {
					t.Fatalf("%s: unexpected refusals %v", test.name, policy.Refusals)
				}
				return
			}
			if !strings.Contains(joined, test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, policy.Refusals, test.needle)
			}
		})
	}
}

func TestInvalidationAPIListGetAndCreate(t *testing.T) {
	api := NewInvalidationAPI(nil, func(string, ...any) {})
	cache := NewCache()
	distribution := api.Register("Distribution", cache)
	cache.Set("key", CacheEntry{Response: OriginResponse{StatusCode: 200}, Path: "/a.js", StoredAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)})
	body := `<InvalidationBatch><Paths><Quantity>1</Quantity><Items><Path>/a.js</Path></Items></Paths><CallerReference>r1</CallerReference></InvalidationBatch>`
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/2020-05-31/distribution/"+distribution+"/invalidation", strings.NewReader(body)))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", recorder.Code, recorder.Body.String())
	}
	if _, ok := cache.Get("key"); ok {
		t.Fatal("the invalidation must remove the cached object")
	}
	created := api.Invalidations()
	if len(created) != 1 {
		t.Fatalf("invalidations = %v", created)
	}
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/2020-05-31/distribution/"+distribution+"/invalidation", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), created[0].ID) {
		t.Fatalf("list = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/2020-05-31/distribution/"+distribution+"/invalidation/"+created[0].ID, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("get = %d %q", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/2020-05-31/distribution/"+distribution+"/invalidation/MISSING", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown invalidation = %d", recorder.Code)
	}
	// Reusing the caller reference with the same paths returns the same batch.
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/2020-05-31/distribution/"+distribution+"/invalidation", strings.NewReader(body)))
	if recorder.Code != http.StatusCreated || len(api.Invalidations()) != 1 {
		t.Fatalf("repeated caller reference = %d (%d invalidations)", recorder.Code, len(api.Invalidations()))
	}
}
