package routing

import (
	"reflect"
	"testing"
)

func TestContractConstants(t *testing.T) {
	t.Parallel()

	if ContractVersion != "m17.mcp-route-algebra/v1" {
		t.Fatalf("ContractVersion = %q", ContractVersion)
	}
	if ProtectedResourcePrefix != "/.well-known/oauth-protected-resource" {
		t.Fatalf("ProtectedResourcePrefix = %q", ProtectedResourcePrefix)
	}
	if AuthorizationServerPrefix != "/.well-known/oauth-authorization-server" {
		t.Fatalf("AuthorizationServerPrefix = %q", AuthorizationServerPrefix)
	}

	kinds := []EndpointKind{
		EndpointKindNamespace,
		EndpointKindPartnerNamespace,
		EndpointKindAgent,
		EndpointKindPartnerAgent,
	}
	wantKinds := []EndpointKind{"namespace", "partner_namespace", "agent", "partner_agent"}
	if !reflect.DeepEqual(kinds, wantKinds) {
		t.Fatalf("endpoint kinds = %#v, want %#v", kinds, wantKinds)
	}

	patterns := []string{
		NamespaceMCPPattern,
		PartnerNamespaceMCPPattern,
		AgentMCPPattern,
		PartnerAgentMCPPattern,
	}
	wantPatterns := []string{
		"/{client_namespace}/mcp",
		"/{client_namespace}/partners/{partner_id}/mcp",
		"/{client_namespace}/agents/{agent_id}/mcp",
		"/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
	}
	if !reflect.DeepEqual(patterns, wantPatterns) {
		t.Fatalf("MCP patterns = %#v, want %#v", patterns, wantPatterns)
	}
}

func TestNormalizePath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{input: "mcp", want: "/mcp"},
		{input: "/mcp/", want: "/mcp"},
		{input: "//a//b//", want: "/a/b"},
		{input: "/a/./b/../c", want: "/a/c"},
		{input: "/", want: "/"},
		{input: "  /acme/mcp/  ", want: "/acme/mcp"},
		{input: "   ", want: "/"},
		{input: "/../../a", want: "/a"},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			t.Parallel()
			if got := normalizePath(test.input); got != test.want {
				t.Fatalf("normalizePath(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestPathDerivations(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		input     string
		protected string
		server    string
		authorize string
		token     string
		suffix    string
	}{
		{
			name:      "root",
			input:     "/",
			protected: "/.well-known/oauth-protected-resource",
			server:    "/.well-known/oauth-authorization-server",
			authorize: "/.well-known/oauth-authorization-server/authorize",
			token:     "/.well-known/oauth-authorization-server/token",
			suffix:    "/.well-known/oauth-authorization-server",
		},
		{
			name:      "trailing slash",
			input:     "/acme/mcp/",
			protected: "/.well-known/oauth-protected-resource/acme/mcp",
			server:    "/.well-known/oauth-authorization-server/acme/mcp",
			authorize: "/.well-known/oauth-authorization-server/acme/mcp/authorize",
			token:     "/.well-known/oauth-authorization-server/acme/mcp/token",
			suffix:    "/acme/mcp/.well-known/oauth-authorization-server",
		},
		{
			name:      "nested normalized path",
			input:     "  //acme//partners/./pay/agents/old/../bot/mcp//  ",
			protected: "/.well-known/oauth-protected-resource/acme/partners/pay/agents/bot/mcp",
			server:    "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp",
			authorize: "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/authorize",
			token:     "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/token",
			suffix:    "/acme/partners/pay/agents/bot/mcp/.well-known/oauth-authorization-server",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := ProtectedResourcePathForResourcePath(test.input); got != test.protected {
				t.Errorf("ProtectedResourcePathForResourcePath() = %q, want %q", got, test.protected)
			}
			if got := ProtectedResourcePathFromMCPPath(test.input); got != test.protected {
				t.Errorf("ProtectedResourcePathFromMCPPath() = %q, want %q", got, test.protected)
			}
			if got := AuthorizationServerPathForResourcePath(test.input); got != test.server {
				t.Errorf("AuthorizationServerPathForResourcePath() = %q, want %q", got, test.server)
			}
			if got := AuthorizationAuthorizePathForResourcePath(test.input); got != test.authorize {
				t.Errorf("AuthorizationAuthorizePathForResourcePath() = %q, want %q", got, test.authorize)
			}
			if got := AuthorizationTokenPathForResourcePath(test.input); got != test.token {
				t.Errorf("AuthorizationTokenPathForResourcePath() = %q, want %q", got, test.token)
			}
			if got := AuthorizationServerSuffixPathForResourcePath(test.input); got != test.suffix {
				t.Errorf("AuthorizationServerSuffixPathForResourcePath() = %q, want %q", got, test.suffix)
			}
		})
	}
}

func TestResourcePathFromProtectedResourcePath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{input: "/.well-known/oauth-protected-resource", want: "/"},
		{input: " /.well-known/oauth-protected-resource/acme/mcp/ ", want: "/acme/mcp"},
		{input: "//.well-known//oauth-protected-resource//acme//mcp", want: "/acme/mcp"},
	}
	for _, test := range tests {
		got, err := ResourcePathFromProtectedResourcePath(test.input)
		if err != nil {
			t.Fatalf("ResourcePathFromProtectedResourcePath(%q): %v", test.input, err)
		}
		if got != test.want {
			t.Fatalf("ResourcePathFromProtectedResourcePath(%q) = %q, want %q", test.input, got, test.want)
		}
	}

	for _, input := range []string{
		"/",
		"/.well-known/oauth-protected-resources/acme/mcp",
		"/x/.well-known/oauth-protected-resource/acme/mcp",
	} {
		if _, err := ResourcePathFromProtectedResourcePath(input); err == nil {
			t.Errorf("ResourcePathFromProtectedResourcePath(%q) unexpectedly succeeded", input)
		}
	}
}

func TestSupportedEndpointTemplates(t *testing.T) {
	t.Parallel()

	want := []EndpointTemplate{
		{
			Kind:                  "namespace",
			MCPPattern:            "/{client_namespace}/mcp",
			ProtectedResourcePath: "/.well-known/oauth-protected-resource/{client_namespace}/mcp",
		},
		{
			Kind:                  "partner_namespace",
			MCPPattern:            "/{client_namespace}/partners/{partner_id}/mcp",
			ProtectedResourcePath: "/.well-known/oauth-protected-resource/{client_namespace}/partners/{partner_id}/mcp",
		},
		{
			Kind:                  "agent",
			MCPPattern:            "/{client_namespace}/agents/{agent_id}/mcp",
			ProtectedResourcePath: "/.well-known/oauth-protected-resource/{client_namespace}/agents/{agent_id}/mcp",
		},
		{
			Kind:                  "partner_agent",
			MCPPattern:            "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
			ProtectedResourcePath: "/.well-known/oauth-protected-resource/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
		},
	}
	if got := SupportedEndpointTemplates(); !reflect.DeepEqual(got, want) {
		t.Fatalf("SupportedEndpointTemplates() = %#v, want %#v", got, want)
	}
}

func TestSupportedOAuthFacadeTemplates(t *testing.T) {
	t.Parallel()

	want := []OAuthFacadeTemplate{
		{
			Kind:             "namespace",
			AuthorizePattern: "/.well-known/oauth-authorization-server/{client_namespace}/mcp/authorize",
			TokenPattern:     "/.well-known/oauth-authorization-server/{client_namespace}/mcp/token",
		},
		{
			Kind:             "partner_namespace",
			AuthorizePattern: "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp/authorize",
			TokenPattern:     "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp/token",
		},
		{
			Kind:             "agent",
			AuthorizePattern: "/.well-known/oauth-authorization-server/{client_namespace}/agents/{agent_id}/mcp/authorize",
			TokenPattern:     "/.well-known/oauth-authorization-server/{client_namespace}/agents/{agent_id}/mcp/token",
		},
		{
			Kind:             "partner_agent",
			AuthorizePattern: "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/authorize",
			TokenPattern:     "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/token",
		},
	}
	if got := SupportedOAuthFacadeTemplates(); !reflect.DeepEqual(got, want) {
		t.Fatalf("SupportedOAuthFacadeTemplates() = %#v, want %#v", got, want)
	}
}

func TestSupportedOAuthDiscoveryTemplates(t *testing.T) {
	t.Parallel()

	want := []OAuthDiscoveryTemplate{
		{
			Kind:             "namespace",
			CanonicalPattern: "/.well-known/oauth-authorization-server/{client_namespace}/mcp",
			SuffixPattern:    "/{client_namespace}/mcp/.well-known/oauth-authorization-server",
		},
		{
			Kind:             "partner_namespace",
			CanonicalPattern: "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp",
			SuffixPattern:    "/{client_namespace}/partners/{partner_id}/mcp/.well-known/oauth-authorization-server",
		},
		{
			Kind:             "agent",
			CanonicalPattern: "/.well-known/oauth-authorization-server/{client_namespace}/agents/{agent_id}/mcp",
			SuffixPattern:    "/{client_namespace}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server",
		},
		{
			Kind:             "partner_agent",
			CanonicalPattern: "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
			SuffixPattern:    "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server",
		},
	}
	if got := SupportedOAuthDiscoveryTemplates(); !reflect.DeepEqual(got, want) {
		t.Fatalf("SupportedOAuthDiscoveryTemplates() = %#v, want %#v", got, want)
	}
}

func TestParseMCPPathAcceptsCanonicalAndNormalizedPaths(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  EndpointPath
	}{
		{input: "/acme/mcp", want: EndpointPath{Kind: "namespace", ClientNamespace: "acme"}},
		{
			input: " acme//partners/pay/mcp/ ",
			want:  EndpointPath{Kind: "partner_namespace", ClientNamespace: "acme", PartnerID: "pay"},
		},
		{
			input: "/acme/old/../agents/bot/mcp",
			want:  EndpointPath{Kind: "agent", ClientNamespace: "acme", AgentID: "bot"},
		},
		{
			input: "//acme/partners/pay/agents/bot/mcp//",
			want: EndpointPath{
				Kind: "partner_agent", ClientNamespace: "acme", PartnerID: "pay", AgentID: "bot",
			},
		},
	}
	for _, test := range tests {
		got, err := ParseMCPPath(test.input)
		if err != nil {
			t.Fatalf("ParseMCPPath(%q): %v", test.input, err)
		}
		if !reflect.DeepEqual(got, test.want) {
			t.Fatalf("ParseMCPPath(%q) = %#v, want %#v", test.input, got, test.want)
		}
	}
}

func TestParseMCPPathRejectsUnsupportedAndUnsafePaths(t *testing.T) {
	t.Parallel()

	for _, input := range []string{
		"/",
		"/acme",
		"/acme/mcp/extra",
		"/acme/partners/pay/other",
		"/acme/agents/bot/other",
		"/acme/partners/pay/agents/bot/other",
		"/acme/agents/bot/agents/other/mcp",
		"/ /mcp",
		"/acme/partners/ /mcp",
		"/acme/agents/ /mcp",
		"/acme/partners/pay/agents/ /mcp",
	} {
		if _, err := ParseMCPPath(input); err == nil {
			t.Errorf("ParseMCPPath(%q) unexpectedly succeeded", input)
		}
	}
}

func TestEndpointPathValidateMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		path    EndpointPath
		wantErr bool
	}{
		{name: "namespace valid", path: EndpointPath{Kind: "namespace", ClientNamespace: "acme"}},
		{name: "namespace missing namespace", path: EndpointPath{Kind: "namespace"}, wantErr: true},
		{name: "namespace extra partner", path: EndpointPath{Kind: "namespace", ClientNamespace: "acme", PartnerID: "pay"}, wantErr: true},
		{name: "namespace extra agent", path: EndpointPath{Kind: "namespace", ClientNamespace: "acme", AgentID: "bot"}, wantErr: true},
		{name: "partner namespace valid", path: EndpointPath{Kind: "partner_namespace", ClientNamespace: "acme", PartnerID: "pay"}},
		{name: "partner namespace missing partner", path: EndpointPath{Kind: "partner_namespace", ClientNamespace: "acme"}, wantErr: true},
		{name: "partner namespace forbidden agent", path: EndpointPath{Kind: "partner_namespace", ClientNamespace: "acme", PartnerID: "pay", AgentID: "bot"}, wantErr: true},
		{name: "agent valid", path: EndpointPath{Kind: "agent", ClientNamespace: "acme", AgentID: "bot"}},
		{name: "agent missing agent", path: EndpointPath{Kind: "agent", ClientNamespace: "acme"}, wantErr: true},
		{name: "agent forbidden partner", path: EndpointPath{Kind: "agent", ClientNamespace: "acme", PartnerID: "pay", AgentID: "bot"}, wantErr: true},
		{name: "partner agent valid", path: EndpointPath{Kind: "partner_agent", ClientNamespace: "acme", PartnerID: "pay", AgentID: "bot"}},
		{name: "partner agent missing partner", path: EndpointPath{Kind: "partner_agent", ClientNamespace: "acme", AgentID: "bot"}, wantErr: true},
		{name: "partner agent missing agent", path: EndpointPath{Kind: "partner_agent", ClientNamespace: "acme", PartnerID: "pay"}, wantErr: true},
		{name: "invalid namespace slash", path: EndpointPath{Kind: "namespace", ClientNamespace: "acme/bad"}, wantErr: true},
		{name: "invalid partner slash", path: EndpointPath{Kind: "partner_namespace", ClientNamespace: "acme", PartnerID: "pay/bad"}, wantErr: true},
		{name: "invalid agent slash", path: EndpointPath{Kind: "agent", ClientNamespace: "acme", AgentID: "bot/bad"}, wantErr: true},
		{name: "unknown kind", path: EndpointPath{Kind: "other", ClientNamespace: "acme"}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := test.path.Validate()
			if (err != nil) != test.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestEndpointPathBuilders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		endpoint  EndpointPath
		mcp       string
		protected string
		server    string
		authorize string
		token     string
		suffix    string
	}{
		{
			endpoint:  EndpointPath{Kind: "namespace", ClientNamespace: "acme"},
			mcp:       "/acme/mcp",
			protected: "/.well-known/oauth-protected-resource/acme/mcp",
			server:    "/.well-known/oauth-authorization-server/acme/mcp",
			authorize: "/.well-known/oauth-authorization-server/acme/mcp/authorize",
			token:     "/.well-known/oauth-authorization-server/acme/mcp/token",
			suffix:    "/acme/mcp/.well-known/oauth-authorization-server",
		},
		{
			endpoint:  EndpointPath{Kind: "partner_namespace", ClientNamespace: "acme", PartnerID: "pay"},
			mcp:       "/acme/partners/pay/mcp",
			protected: "/.well-known/oauth-protected-resource/acme/partners/pay/mcp",
			server:    "/.well-known/oauth-authorization-server/acme/partners/pay/mcp",
			authorize: "/.well-known/oauth-authorization-server/acme/partners/pay/mcp/authorize",
			token:     "/.well-known/oauth-authorization-server/acme/partners/pay/mcp/token",
			suffix:    "/acme/partners/pay/mcp/.well-known/oauth-authorization-server",
		},
		{
			endpoint:  EndpointPath{Kind: "agent", ClientNamespace: "acme", AgentID: "bot"},
			mcp:       "/acme/agents/bot/mcp",
			protected: "/.well-known/oauth-protected-resource/acme/agents/bot/mcp",
			server:    "/.well-known/oauth-authorization-server/acme/agents/bot/mcp",
			authorize: "/.well-known/oauth-authorization-server/acme/agents/bot/mcp/authorize",
			token:     "/.well-known/oauth-authorization-server/acme/agents/bot/mcp/token",
			suffix:    "/acme/agents/bot/mcp/.well-known/oauth-authorization-server",
		},
		{
			endpoint: EndpointPath{
				Kind: "partner_agent", ClientNamespace: "acme", PartnerID: "pay", AgentID: "bot",
			},
			mcp:       "/acme/partners/pay/agents/bot/mcp",
			protected: "/.well-known/oauth-protected-resource/acme/partners/pay/agents/bot/mcp",
			server:    "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp",
			authorize: "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/authorize",
			token:     "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/token",
			suffix:    "/acme/partners/pay/agents/bot/mcp/.well-known/oauth-authorization-server",
		},
	}

	for _, test := range tests {
		assertBuilder(t, "MCPPath", test.endpoint.MCPPath, test.mcp)
		assertBuilder(t, "ProtectedResourcePath", test.endpoint.ProtectedResourcePath, test.protected)
		assertBuilder(t, "OAuthAuthorizationServerPath", test.endpoint.OAuthAuthorizationServerPath, test.server)
		assertBuilder(t, "OAuthAuthorizePath", test.endpoint.OAuthAuthorizePath, test.authorize)
		assertBuilder(t, "OAuthTokenPath", test.endpoint.OAuthTokenPath, test.token)
		assertBuilder(t, "OAuthAuthorizationServerSuffixPath", test.endpoint.OAuthAuthorizationServerSuffixPath, test.suffix)
	}
}

func TestEndpointPathBuildersRejectInvalidEndpoint(t *testing.T) {
	t.Parallel()

	invalid := EndpointPath{Kind: EndpointKindPartnerAgent, ClientNamespace: "acme", PartnerID: "pay"}
	builders := []struct {
		name string
		fn   func() (string, error)
	}{
		{name: "MCPPath", fn: invalid.MCPPath},
		{name: "ProtectedResourcePath", fn: invalid.ProtectedResourcePath},
		{name: "OAuthAuthorizationServerPath", fn: invalid.OAuthAuthorizationServerPath},
		{name: "OAuthAuthorizePath", fn: invalid.OAuthAuthorizePath},
		{name: "OAuthTokenPath", fn: invalid.OAuthTokenPath},
		{name: "OAuthAuthorizationServerSuffixPath", fn: invalid.OAuthAuthorizationServerSuffixPath},
	}
	for _, builder := range builders {
		if _, err := builder.fn(); err == nil {
			t.Errorf("%s() unexpectedly succeeded", builder.name)
		}
	}
}

func assertBuilder(t *testing.T, name string, builder func() (string, error), want string) {
	t.Helper()
	got, err := builder()
	if err != nil {
		t.Fatalf("%s(): %v", name, err)
	}
	if got != want {
		t.Fatalf("%s() = %q, want %q", name, got, want)
	}
}
