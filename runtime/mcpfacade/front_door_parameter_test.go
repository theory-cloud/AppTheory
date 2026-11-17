package mcpfacade

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
)

// The well-known parameter the parameter-form tests read.
const frontDoorTestParameter = "/theorycloud/apptheory/test/fronted/origin-token" // #nosec G101 -- a parameter name, not a credential.

// stubFrontDoorReader is a credential-free parameter source: it counts reads so
// the tests can prove the cache, the TTL, and the mismatch refresh.
type stubFrontDoorReader struct {
	mu     sync.Mutex
	value  string
	err    error
	calls  int
	params []string
}

func (r *stubFrontDoorReader) read(_ context.Context, parameterName string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.params = append(r.params, parameterName)
	return r.value, r.err
}

func (r *stubFrontDoorReader) set(value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.value = value
}

func (r *stubFrontDoorReader) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func frontedParameterConfig(reader FrontDoorSecretReader, ttl time.Duration) FacadeConfig {
	config := validConfig(URLModePublicBaseURL)
	config.OriginReachability = OriginReachabilityFronted
	config.FrontDoorVerification = &FrontDoorVerification{
		HeaderName:          "x-front-door",
		SecretParameterName: frontDoorTestParameter,
	}
	config.FrontDoorSecretReader = reader
	config.FrontDoorSecretTTL = ttl
	config.TransportPosture = TransportPostureRuntimeBearer
	config.RequireBearerToken = &oauth.RequireBearerTokenOptions{
		ResourceMetadataURL: "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp",
		Validator: func(*apptheory.Context, string) error {
			return nil
		},
	}
	return config
}

// TestFrontDoorParameterRegistrationFailsClosed pins the synthesis-time
// contract: exactly one secret form is required, the parameter name must satisfy
// both Parameter Store and the CloudFormation dynamic-reference alphabet, and
// the TTL is bounded. Registration never reads Parameter Store.
// presentedFrontDoorHeader is a front-door request that also carries the
// runtime-bearer credential, so a positive case reaches the MCP handler.
func presentedFrontDoorHeader(secret string) map[string][]string {
	return map[string][]string{
		"x-front-door":  {secret},
		"authorization": {"Bearer admitted-token"},
	}
}

func TestFrontDoorParameterRegistrationFailsClosed(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*FacadeConfig)
		want   string
	}{
		{
			name: "both secret forms",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretValue = frontDoorTestSecret
			},
			want: "requires exactly one of SecretValue and SecretParameterName",
		},
		{
			name: "neither secret form",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = ""
			},
			want: "requires exactly one of SecretValue and SecretParameterName",
		},
		{
			name: "parameter name without a leading slash",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "theorycloud/apptheory/fronted"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name with a colon",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/theorycloud/apptheory:fronted"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name with an empty segment",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/theorycloud//fronted"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name with a trailing slash",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/theorycloud/apptheory/"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name in the reserved aws hierarchy",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/aws/apptheory/fronted"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name in the reserved ssm hierarchy",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/SSM/apptheory/fronted"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name deeper than fifteen levels",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/" + strings.Repeat("level/", 15) + "leaf"
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "parameter name longer than 1011 characters",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorVerification.SecretParameterName = "/" + strings.Repeat("a", 1011)
			},
			want: "SecretParameterName must be a fully qualified SSM parameter name",
		},
		{
			name: "ttl longer than one hour",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorSecretTTL = MaxFrontDoorSecretTTL + time.Second
			},
			want: "FrontDoorSecretTTL must be greater than zero and at most one hour",
		},
		{
			name: "negative ttl",
			mutate: func(config *FacadeConfig) {
				config.FrontDoorSecretTTL = -time.Second
			},
			want: "FrontDoorSecretTTL must be greater than zero and at most one hour",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			reader := &stubFrontDoorReader{value: frontDoorTestSecret}
			config := frontedParameterConfig(reader.read, 0)
			testCase.mutate(&config)
			inventory, err := RegisterMCPFacade(apptheory.New(), config)
			require.ErrorContains(t, err, testCase.want)
			require.Nil(t, inventory)
			require.Zero(t, reader.callCount(), "registration never reads the parameter")
		})
	}
}

// TestFrontDoorParameterAdmitsAndRefuses pins the request behavior: the
// well-known parameter's value admits the request, and a missing, wrong,
// unreadable, empty, or malformed parameter fails closed with the same 403 a
// direct-origin request gets.
func TestFrontDoorParameterAdmitsAndRefuses(t *testing.T) {
	reader := &stubFrontDoorReader{value: frontDoorTestSecret}
	app := apptheory.New()
	inventory, err := RegisterMCPFacade(app, frontedParameterConfig(reader.read, 0))
	require.NoError(t, err)
	pattern := inventory.Routes[0].MCPPattern

	require.Zero(t, reader.callCount(), "the first request performs the first read, lazily")
	require.Equal(t, 204, serve(app, "POST", pattern, presentedFrontDoorHeader(frontDoorTestSecret)).Status)
	require.Equal(t, 1, reader.callCount())
	require.Equal(t, []string{frontDoorTestParameter}, reader.params)

	requireForbidden(t, serve(app, "POST", pattern, nil))
	requireForbidden(t, serve(app, "GET", pattern, map[string][]string{
		"x-front-door": {strings.Repeat("b", len(frontDoorTestSecret))},
	}))
	requireForbidden(t, serve(app, "GET", pattern, map[string][]string{
		"x-front-door": {frontDoorTestSecret[:len(frontDoorTestSecret)-1]},
	}))
}

func TestFrontDoorParameterFailsClosedWhenUnreadable(t *testing.T) {
	cases := []struct {
		name  string
		value string
		err   error
	}{
		{name: "read error", err: errors.New("ssm: AccessDeniedException")},
		{name: "empty value", value: ""},
		{name: "value outside the header alphabet", value: "contains a space and is long enough"},
		{name: "value shorter than the documented length", value: "too-short"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			reader := &stubFrontDoorReader{value: testCase.value, err: testCase.err}
			app := apptheory.New()
			inventory, err := RegisterMCPFacade(app, frontedParameterConfig(reader.read, 0))
			require.NoError(t, err, "an unreadable parameter fails at request time, not registration")
			requireForbidden(t, serve(app, "POST", inventory.Routes[0].MCPPattern, map[string][]string{
				"x-front-door": {frontDoorTestSecret},
			}))
			require.Equal(t, 403, serve(app, "GET", inventory.Routes[0].ProtectedResourcePattern, nil).Status)
		})
	}
}

// TestFrontDoorParameterRefreshesOnMismatch pins rotation without a redeploy:
// the first request carrying the rotated value forces one refresh and is
// admitted, and the refresh floor stops a caller from driving one read per
// request.
func TestFrontDoorParameterRefreshesOnMismatch(t *testing.T) {
	reader := &stubFrontDoorReader{value: frontDoorTestSecret}
	app := apptheory.New()
	inventory, err := RegisterMCPFacade(app, frontedParameterConfig(reader.read, time.Hour))
	require.NoError(t, err)
	pattern := inventory.Routes[0].MCPPattern
	rotated := "rotated-front-door-secret-0123456789-abcdef"

	require.Equal(t, 204, serve(app, "POST", pattern, presentedFrontDoorHeader(frontDoorTestSecret)).Status)
	require.Equal(t, 1, reader.callCount())

	// A rotation is picked up on the next mismatching request, bounded by the
	// documented refresh floor so a caller cannot drive one read per request.
	time.Sleep(frontDoorSecretRefreshFloor + 10*time.Millisecond)
	reader.set(rotated)
	require.Equal(t, 204, serve(app, "POST", pattern, presentedFrontDoorHeader(rotated)).Status,
		"the first request after the floor carrying the rotated value is admitted")
	require.Equal(t, 2, reader.callCount(), "a mismatch forces exactly one refresh")

	// A bogus header inside the refresh floor is refused without another read.
	requireForbidden(t, serve(app, "POST", pattern, map[string][]string{
		"x-front-door": {strings.Repeat("c", len(rotated))},
	}))
	require.Equal(t, 2, reader.callCount(), "the refresh floor bounds forced reads")

	require.Equal(t, 204, serve(app, "POST", pattern, presentedFrontDoorHeader(rotated)).Status)
}

// TestFrontDoorParameterRefreshesAfterTTL pins the TTL: a value older than
// FrontDoorSecretTTL is re-read before the comparison, so a rotation propagates
// without a mismatching request.
func TestFrontDoorParameterRefreshesAfterTTL(t *testing.T) {
	reader := &stubFrontDoorReader{value: frontDoorTestSecret}
	app := apptheory.New()
	inventory, err := RegisterMCPFacade(app, frontedParameterConfig(reader.read, 5*time.Millisecond))
	require.NoError(t, err)
	pattern := inventory.Routes[0].MCPPattern
	rotated := "rotated-front-door-secret-0123456789-abcdef"

	require.Equal(t, 204, serve(app, "POST", pattern, presentedFrontDoorHeader(frontDoorTestSecret)).Status)
	require.Equal(t, 1, reader.callCount())

	reader.set(rotated)
	time.Sleep(10 * time.Millisecond)

	require.Equal(t, 204, serve(app, "POST", pattern, presentedFrontDoorHeader(rotated)).Status)
	require.Equal(t, 2, reader.callCount(), "the TTL re-reads the parameter")
	require.Equal(t, 403, serve(app, "POST", pattern, map[string][]string{
		"x-front-door": {frontDoorTestSecret},
	}).Status, "the rotated-out value is no longer accepted")
}

func TestFrontDoorParameterDefaultTTLIsBounded(t *testing.T) {
	reader := &stubFrontDoorReader{value: frontDoorTestSecret}
	config := frontedParameterConfig(reader.read, 0)
	_, err := RegisterMCPFacade(apptheory.New(), config)
	require.NoError(t, err)
	require.Equal(t, 5*time.Minute, DefaultFrontDoorSecretTTL)
	require.Equal(t, time.Hour, MaxFrontDoorSecretTTL)
}
