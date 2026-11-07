package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// jwtTransport builds a transport with one JWT-protected route.
func jwtTransport(t *testing.T, key *jwtTestKey, issuer jwtIssuer, scopes []string) *Transport {
	t.Helper()
	route := Route{
		Class:               APIHTTPV2,
		Method:              "GET",
		Path:                "/protected",
		RouteKey:            "GET /protected",
		AuthorizerKind:      AuthorizerKindJWT,
		AcceptedIssuers:     issuer.Accepted,
		JWKSURL:             issuer.JWKSURL,
		JWTAudience:         issuer.Audience,
		AuthorizationScopes: scopes,
		AuthorizerIdentitySources: []string{
			"$request.header.Authorization",
		},
	}
	return &Transport{
		API:      APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: "$default", Routes: []Route{route}},
		Invokers: map[string]Invoker{},
		Now:      time.Now,
		Clock:    NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
}

func TestTransportAuthorizeJWT(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	transport := jwtTransport(t, key, issuer, []string{"api/read"})
	transport.Clock = clock
	route := transport.API.Routes[0]
	token := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a", "sub": "u",
		"exp": clock.Now().Add(time.Hour).Unix(), "scope": "api/read",
	})

	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	result, err := transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Zero(t, result.Status)
	require.Equal(t, []string{"api/read"}, result.Scopes)
	require.Equal(t, "u", result.JWT["sub"])

	cases := []struct {
		name   string
		header string
		status int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"scheme", "Basic abc", http.StatusUnauthorized},
		{"bad token", "Bearer not-a-token", http.StatusUnauthorized},
	}
	for _, testCase := range cases {
		refusedRequest := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
		if testCase.header != "" {
			refusedRequest.Header.Set("Authorization", testCase.header)
		}
		refused, authorizeErr := transport.authorize(refusedRequest, route, nil, "/protected", nil, "req")
		require.NoError(t, authorizeErr)
		require.Equal(t, testCase.status, refused.Status, testCase.name)
	}

	// A token without the required scope is refused with 403.
	noScope := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a", "exp": clock.Now().Add(time.Hour).Unix(),
	})
	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+noScope)
	result, err = transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, result.Status)

	// A route without a resolved issuer fails closed once a token is present.
	broken := Route{AuthorizerKind: AuthorizerKindJWT,
		AuthorizerIdentitySources: []string{"$request.header.Authorization"}}
	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	_, err = transport.authorize(request, broken, nil, "/", nil, "req")
	require.Error(t, err)
}

func TestTransportAuthorizeJWTScopesAreAnyOf(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	transport := jwtTransport(t, key, issuer, []string{"read", "write"})
	transport.Clock = clock
	route := transport.API.Routes[0]

	// A route declaring read and write accepts a token carrying only read.
	token := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a", "scope": "read",
		"exp": clock.Now().Add(time.Hour).Unix(),
	})
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	result, err := transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Zero(t, result.Status)

	// A token carrying neither scope is refused with 403.
	noScope := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a",
		"exp": clock.Now().Add(time.Hour).Unix(),
	})
	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+noScope)
	result, err = transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, result.Status)
}

func TestTransportAuthorizeCognito(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	route := Route{
		Class:                     APIRESTV1,
		Method:                    "GET",
		Path:                      "/protected",
		AuthorizerKind:            AuthorizerKindCognito,
		AcceptedIssuers:           issuer.Accepted,
		JWKSURL:                   issuer.JWKSURL,
		AuthorizerIdentitySources: []string{"method.request.header.Authorization"},
	}
	transport := &Transport{API: APISpec{Class: APIRESTV1, LogicalID: "Rest"}, Clock: clock, Now: time.Now}
	token := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "client_id": "client-a", "token_use": "access",
		"exp": clock.Now().Add(time.Hour).Unix(), "scope": "aws.cognito.signin.user.admin",
	})

	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	result, err := transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Zero(t, result.Status)
	require.Equal(t, "access", result.Claims["token_use"])

	// A REST method's scopes are an any-of match too: read or write accepts read.
	route.AuthorizationScopes = []string{"api/read", "api/write"}
	scoped := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "client_id": "client-a", "token_use": "access",
		"exp": clock.Now().Add(time.Hour).Unix(), "scope": "api/read",
	})
	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+scoped)
	result, err = transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Zero(t, result.Status)

	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/protected", nil)
	result, err = transport.authorize(request, route, nil, "/protected", nil, "req")
	require.NoError(t, err)
	require.Equal(t, http.StatusUnauthorized, result.Status)

	// The identity source must be a request header.
	broken := route
	broken.AuthorizerIdentitySources = []string{"$context.identity.sourceIp"}
	_, err = transport.authorize(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), broken, nil, "/", nil, "req")
	require.Error(t, err)
}

func TestDescribeNotifications(t *testing.T) {
	session := &localSession{
		runner: &Runner{},
		spec: &Spec{Notifications: []NotificationSpec{
			{LogicalID: "Bucket/notification/0", Bucket: "Bucket", BucketName: "b",
				DestinationType: notificationDestinationFunction, Destination: "Fn", Events: []string{"s3:ObjectCreated:*"}},
			{LogicalID: "Bucket/notification/1", Bucket: "Bucket", BucketName: "b",
				DestinationType: notificationDestinationQueue, Destination: "Q"},
		}},
	}
	entries := session.describeNotifications(EngineState{Sources: []DeliveryState{
		{ID: "Bucket/notification/0", Kind: DeliveryKindS3Notification, State: DeliveryPhasePolling, Delivered: 2, Filtered: 1},
	}})
	require.Len(t, entries, 2)
	require.Equal(t, int64(2), entries[0]["delivered"])
	require.Equal(t, int64(1), entries[0]["filtered"])
	events, ok := entries[0]["events"].([]string)
	require.True(t, ok)
	require.Equal(t, "s3:ObjectCreated:*", events[0])
	require.NotContains(t, entries[1], "state")
	empty := &localSession{runner: &Runner{}, spec: &Spec{}}
	require.Nil(t, empty.describeNotifications(EngineState{}))
}

func TestRunnerWebSocketHelpers(t *testing.T) {
	runner := &Runner{}
	require.Empty(t, runner.webSocketDomainName())
	require.Nil(t, runner.webSocketCertificateMounts())
	management, err := newWebSocketManagement(t.TempDir(), nil, nil)
	require.NoError(t, err)
	manager := &webSocketManagement{URL: "https://127.0.0.1:1", ContainerURL: "https://host.docker.internal:1",
		certificatePath: management.certificatePath}
	runner.webSocketManagement = manager
	require.Equal(t, "host.docker.internal:1", runner.webSocketDomainName())
	require.Len(t, runner.webSocketCertificateMounts(), 1)

	runner.resourceValues = resourceValues{"Stack/Queue": {Type: typeSQSQueue, Name: "q"}}
	value, ok := runner.provisionedResourceValue("Queue")
	require.True(t, ok)
	require.Equal(t, "q", value.Name)
	value, ok = runner.provisionedResourceValue("Stack/Queue")
	require.True(t, ok)
	require.Equal(t, "q", value.Name)
	_, ok = runner.provisionedResourceValue("Missing")
	require.False(t, ok)

	_, err = runner.deliveryS3Client()
	require.Error(t, err)
	runner.backends = map[string]backendProcess{"s3": {
		HostURL:   "http://127.0.0.1:1",
		Endpoints: []Endpoint{{Service: "s3", URL: "http://127.0.0.1:1"}},
	}}
	client, err := runner.deliveryS3Client()
	require.NoError(t, err)
	require.NotNil(t, client)
}

func TestJWTClaimHelpers(t *testing.T) {
	require.Equal(t, int64(5), mustNumeric(t, map[string]any{"exp": json.Number("5")}, "exp"))
	require.Equal(t, int64(6), mustNumeric(t, map[string]any{"exp": int64(6)}, "exp"))
	require.Equal(t, int64(7), mustNumeric(t, map[string]any{"exp": 7}, "exp"))
	_, ok := numericClaim(map[string]any{"exp": "x"}, "exp")
	require.False(t, ok)

	require.Equal(t, []string{"a", "b"}, tokenScopes(map[string]any{"scope": "a b"}))
	require.Equal(t, []string{"c"}, tokenScopes(map[string]any{"scp": []any{"c"}}))
	require.Empty(t, tokenScopes(map[string]any{}))

	require.Equal(t, []string{"aud-1"}, audienceValues(map[string]any{"aud": "aud-1"}))
	require.Equal(t, []string{"aud-1", "aud-2"}, audienceValues(map[string]any{
		"aud": []any{"aud-1", "aud-2", 5}, "client_id": "client",
	}))
	require.Equal(t, []string{"client"}, audienceValues(map[string]any{"client_id": "client"}))
	require.Empty(t, stringClaim(map[string]any{"iss": 5}, "iss"))
	require.Empty(t, missingScope(map[string]any{}, nil))
	require.Equal(t, "a or s", missingScope(map[string]any{"scope": "other"}, []string{"a", "s"}))
	require.Empty(t, missingScope(map[string]any{"scope": "a"}, []string{"a"}))
}

func mustNumeric(t *testing.T, claims map[string]any, name string) int64 {
	t.Helper()
	value, ok := numericClaim(claims, name)
	require.True(t, ok)
	return value
}

func TestWebSocketHelperBranches(t *testing.T) {
	require.Nil(t, stringValues(5))
	require.Equal(t, []string{"a"}, stringValues("a"))
	require.Equal(t, []string{"a", "b"}, stringValues([]any{"a", "b", 3}))
	require.True(t, policyMatchesAction(nil))
	require.True(t, policyMatchesAction("*"))
	require.False(t, policyMatchesAction("s3:GetObject"))

	server := &WebSocketServer{}
	require.Equal(t, "", server.API.RouteSelectionExpression)
	require.False(t, server.now().IsZero())
	server.Logf = nil
	server.logf("no-op")
	require.Equal(t, webSocketDefault, server.selectRoute("{}"))
	server.Clock = NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	require.Equal(t, int64(1767225600), server.now().Unix())

	// An invoke of an unknown function fails closed.
	server.Invokers = map[string]Invoker{}
	_, err := server.invoke(context.Background(), "Missing", nil)
	require.Error(t, err)
	_, err = server.invokeRaw(context.Background(), "Missing", nil)
	require.Error(t, err)

	// A semaphore-bound invoke respects cancellation.
	server.Semaphore = make(chan struct{}, 1)
	server.Semaphore <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = server.invoke(ctx, "Missing", nil)
	require.Error(t, err)
	<-server.Semaphore
}

func TestWebSocketAPIsList(t *testing.T) {
	spec := &Spec{WebSockets: []WebSocketAPISpec{{LogicalID: "A"}}}
	require.Len(t, spec.WebSocketAPIs(), 1)
	var nilSpec *Spec
	require.Nil(t, nilSpec.WebSocketAPIs())
}

func TestS3NotificationValidationBranches(t *testing.T) {
	require.Error(t, validateNotificationSpec(NotificationSpec{
		LogicalID: "n", Events: []string{"ObjectCreated:Put"},
	}))
	require.Error(t, validateNotificationSpec(NotificationSpec{
		LogicalID: "n", Events: []string{"s3:ObjectCreated:Put"},
		FilterRules: []NotificationFilterRule{{Name: "prefix", Value: "a"}, {Name: "prefix", Value: "b"}},
	}))
	require.Error(t, validateNotificationSpec(NotificationSpec{
		LogicalID: "n", Events: []string{"s3:ObjectCreated:Put"},
		FilterRules: []NotificationFilterRule{{Name: "prefix", Value: "a"}, {Name: "suffix", Value: "b"}, {Name: "x", Value: "c"}},
	}))
	require.NoError(t, validateNotificationSpec(NotificationSpec{
		LogicalID: "n", Events: []string{"s3:ObjectCreated:Put", "s3:ObjectRemoved:*"},
	}))
	require.NoError(t, validateNotificationSpec(NotificationSpec{LogicalID: "n", EventBridge: true}))
	require.Error(t, validateNotificationSpec(NotificationSpec{LogicalID: "n"}))
	require.Equal(t, "local-"+stableHash("bucket/0", 16), notificationConfigurationID("bucket", 0))
	require.True(t, s3BucketARN("b") == "arn:aws:s3:::b")
	require.False(t, notificationMatches(NotificationSpec{Events: []string{"s3:ObjectRemoved:*"}}, s3RecordObjectCreatedPut, "k"))
	require.True(t, notificationMatches(NotificationSpec{EventBridge: true}, s3RecordObjectCreatedPut, "k"))
	encoded, err := BuildS3TestEvent("b", time.Now())
	require.NoError(t, err)
	require.NotEmpty(t, encoded)
}
