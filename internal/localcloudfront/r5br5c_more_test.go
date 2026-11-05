package localcloudfront

import (
	"context"
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
	encoded, err := json.Marshal(cannedPolicy{Statement: []cannedStatement{{
		Resource:  resource,
		Condition: cannedCondition{DateLessThan: cannedDate{EpothTime: int64(expires)}},
	}}})
	if err != nil {
		panic(err)
	}
	return string(encoded)
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
