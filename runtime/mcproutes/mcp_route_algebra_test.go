package mcproutes

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
)

const expectationsPath = "../../contract-tests/fixtures/routing/mcp-route-algebra/expectations.json"

type routeAlgebraExpectations struct {
	Contract                 contractExpectations       `json:"contract"`
	Normalization            []normalizationExpectation `json:"normalization"`
	Derivations              []derivationExpectation    `json:"derivations"`
	Parser                   parserExpectations         `json:"parser"`
	Validation               []validationExpectation    `json:"validation"`
	WhitespaceBoundary       []whitespaceExpectation    `json:"whitespace_boundary"`
	ProtectedResourceInverse inverseExpectations        `json:"protected_resource_inverse"`
	Builders                 []builderExpectation       `json:"builders"`
}

type contractExpectations struct {
	Version                      string               `json:"version"`
	ASCIITrimCodePoints          []string             `json:"ascii_trim_code_points"`
	ExcludedWhitespaceCodePoints []string             `json:"excluded_whitespace_code_points"`
	ProtectedResourcePrefix      string               `json:"protected_resource_prefix"`
	AuthorizationServerPrefix    string               `json:"authorization_server_prefix"`
	EndpointKinds                []EndpointKind       `json:"endpoint_kinds"`
	Patterns                     []patternExpectation `json:"patterns"`
}

type patternExpectation struct {
	Kind                          EndpointKind `json:"kind"`
	MCPPattern                    string       `json:"mcp_pattern"`
	ProtectedResourcePath         string       `json:"protected_resource_path"`
	AuthorizationServerPath       string       `json:"authorization_server_path"`
	AuthorizePath                 string       `json:"authorize_path"`
	TokenPath                     string       `json:"token_path"`
	AuthorizationServerSuffixPath string       `json:"authorization_server_suffix_path"`
}

type normalizationExpectation struct {
	Name       string `json:"name"`
	Input      string `json:"input"`
	Normalized string `json:"normalized"`
}

type derivationExpectation struct {
	Name                          string `json:"name"`
	Input                         string `json:"input"`
	Normalized                    string `json:"normalized"`
	ProtectedResourcePath         string `json:"protected_resource_path"`
	AuthorizationServerPath       string `json:"authorization_server_path"`
	AuthorizePath                 string `json:"authorize_path"`
	TokenPath                     string `json:"token_path"`
	AuthorizationServerSuffixPath string `json:"authorization_server_suffix_path"`
}

type endpointExpectation struct {
	Kind            EndpointKind `json:"kind"`
	ClientNamespace string       `json:"client_namespace"`
	PartnerID       string       `json:"partner_id"`
	AgentID         string       `json:"agent_id"`
}

func (e endpointExpectation) endpointPath() EndpointPath {
	return EndpointPath(e)
}

type parserExpectations struct {
	Accept []parserAcceptExpectation `json:"accept"`
	Reject []parserRejectExpectation `json:"reject"`
}

type parserAcceptExpectation struct {
	Name     string              `json:"name"`
	Input    string              `json:"input"`
	Endpoint endpointExpectation `json:"endpoint"`
}

type parserRejectExpectation struct {
	Name  string `json:"name"`
	Input string `json:"input"`
}

type validationExpectation struct {
	Name     string              `json:"name"`
	Endpoint endpointExpectation `json:"endpoint"`
	Valid    bool                `json:"valid"`
}

type whitespaceExpectation struct {
	CodePoint          string              `json:"code_point"`
	Character          string              `json:"character"`
	InTrimSet          bool                `json:"in_trim_set"`
	NormalizationInput string              `json:"normalization_input"`
	Normalized         string              `json:"normalized"`
	ParserInput        string              `json:"parser_input"`
	ParserEndpoint     endpointExpectation `json:"parser_endpoint"`
	SegmentValid       bool                `json:"segment_valid"`
}

type inverseExpectations struct {
	Accept []inverseAcceptExpectation `json:"accept"`
	Reject []string                   `json:"reject"`
}

type inverseAcceptExpectation struct {
	Input        string `json:"input"`
	ResourcePath string `json:"resource_path"`
}

type builderExpectation struct {
	Endpoint                      endpointExpectation `json:"endpoint"`
	MCPPath                       string              `json:"mcp_path"`
	ProtectedResourcePath         string              `json:"protected_resource_path"`
	AuthorizationServerPath       string              `json:"authorization_server_path"`
	AuthorizePath                 string              `json:"authorize_path"`
	TokenPath                     string              `json:"token_path"`
	AuthorizationServerSuffixPath string              `json:"authorization_server_suffix_path"`
}

func loadExpectations(t *testing.T) routeAlgebraExpectations {
	t.Helper()
	contents, err := os.ReadFile(expectationsPath)
	if err != nil {
		t.Fatalf("read shared route-algebra expectations: %v", err)
	}
	var expectations routeAlgebraExpectations
	if err := json.Unmarshal(contents, &expectations); err != nil {
		t.Fatalf("decode shared route-algebra expectations: %v", err)
	}
	return expectations
}

func TestSharedContractConstantsAndTemplates(t *testing.T) {
	t.Parallel()
	expected := loadExpectations(t).Contract

	if ContractVersion != expected.Version {
		t.Fatalf("ContractVersion = %q, want %q", ContractVersion, expected.Version)
	}
	if ProtectedResourcePrefix != expected.ProtectedResourcePrefix {
		t.Fatalf("ProtectedResourcePrefix = %q, want %q", ProtectedResourcePrefix, expected.ProtectedResourcePrefix)
	}
	if AuthorizationServerPrefix != expected.AuthorizationServerPrefix {
		t.Fatalf("AuthorizationServerPrefix = %q, want %q", AuthorizationServerPrefix, expected.AuthorizationServerPrefix)
	}
	kinds := []EndpointKind{
		EndpointKindNamespace, EndpointKindPartnerNamespace, EndpointKindAgent, EndpointKindPartnerAgent,
	}
	if !reflect.DeepEqual(kinds, expected.EndpointKinds) {
		t.Fatalf("endpoint kinds = %#v, want %#v", kinds, expected.EndpointKinds)
	}
	patterns := []string{
		NamespaceMCPPattern, PartnerNamespaceMCPPattern, AgentMCPPattern, PartnerAgentMCPPattern,
	}
	wantPatterns := make([]string, 0, len(expected.Patterns))
	wantEndpoints := make([]EndpointTemplate, 0, len(expected.Patterns))
	wantFacades := make([]OAuthFacadeTemplate, 0, len(expected.Patterns))
	wantDiscovery := make([]OAuthDiscoveryTemplate, 0, len(expected.Patterns))
	for _, row := range expected.Patterns {
		wantPatterns = append(wantPatterns, row.MCPPattern)
		wantEndpoints = append(wantEndpoints, EndpointTemplate{
			Kind: row.Kind, MCPPattern: row.MCPPattern, ProtectedResourcePath: row.ProtectedResourcePath,
		})
		wantFacades = append(wantFacades, OAuthFacadeTemplate{
			Kind: row.Kind, AuthorizePattern: row.AuthorizePath, TokenPattern: row.TokenPath,
		})
		wantDiscovery = append(wantDiscovery, OAuthDiscoveryTemplate{
			Kind: row.Kind, CanonicalPattern: row.AuthorizationServerPath, SuffixPattern: row.AuthorizationServerSuffixPath,
		})
	}
	if !reflect.DeepEqual(patterns, wantPatterns) {
		t.Fatalf("MCP patterns = %#v, want %#v", patterns, wantPatterns)
	}
	if got := SupportedEndpointTemplates(); !reflect.DeepEqual(got, wantEndpoints) {
		t.Fatalf("SupportedEndpointTemplates() = %#v, want %#v", got, wantEndpoints)
	}
	if got := SupportedOAuthFacadeTemplates(); !reflect.DeepEqual(got, wantFacades) {
		t.Fatalf("SupportedOAuthFacadeTemplates() = %#v, want %#v", got, wantFacades)
	}
	if got := SupportedOAuthDiscoveryTemplates(); !reflect.DeepEqual(got, wantDiscovery) {
		t.Fatalf("SupportedOAuthDiscoveryTemplates() = %#v, want %#v", got, wantDiscovery)
	}
}

func TestSharedNormalizationAndDerivations(t *testing.T) {
	t.Parallel()
	expected := loadExpectations(t)
	for _, row := range expected.Normalization {
		t.Run(row.Name, func(t *testing.T) {
			t.Parallel()
			if got := normalizePath(row.Input); got != row.Normalized {
				t.Fatalf("normalizePath(%q) = %q, want %q", row.Input, got, row.Normalized)
			}
		})
	}
	for _, row := range expected.Derivations {
		t.Run(row.Name, func(t *testing.T) {
			t.Parallel()
			if got := normalizePath(row.Input); got != row.Normalized {
				t.Errorf("normalizePath() = %q, want %q", got, row.Normalized)
			}
			if got := ProtectedResourcePathForResourcePath(row.Input); got != row.ProtectedResourcePath {
				t.Errorf("ProtectedResourcePathForResourcePath() = %q, want %q", got, row.ProtectedResourcePath)
			}
			if got := ProtectedResourcePathFromMCPPath(row.Input); got != row.ProtectedResourcePath {
				t.Errorf("ProtectedResourcePathFromMCPPath() = %q, want %q", got, row.ProtectedResourcePath)
			}
			if got := AuthorizationServerPathForResourcePath(row.Input); got != row.AuthorizationServerPath {
				t.Errorf("AuthorizationServerPathForResourcePath() = %q, want %q", got, row.AuthorizationServerPath)
			}
			if got := AuthorizationAuthorizePathForResourcePath(row.Input); got != row.AuthorizePath {
				t.Errorf("AuthorizationAuthorizePathForResourcePath() = %q, want %q", got, row.AuthorizePath)
			}
			if got := AuthorizationTokenPathForResourcePath(row.Input); got != row.TokenPath {
				t.Errorf("AuthorizationTokenPathForResourcePath() = %q, want %q", got, row.TokenPath)
			}
			if got := AuthorizationServerSuffixPathForResourcePath(row.Input); got != row.AuthorizationServerSuffixPath {
				t.Errorf("AuthorizationServerSuffixPathForResourcePath() = %q, want %q", got, row.AuthorizationServerSuffixPath)
			}
		})
	}
}

func TestSharedASCIIWhitespaceBoundary(t *testing.T) {
	t.Parallel()
	expected := loadExpectations(t)
	included := append([]string(nil), expected.Contract.ASCIITrimCodePoints...)
	excluded := append([]string(nil), expected.Contract.ExcludedWhitespaceCodePoints...)
	sort.Strings(included)
	sort.Strings(excluded)

	var gotIncluded, gotExcluded []string
	for _, row := range expected.WhitespaceBoundary {
		t.Run(row.CodePoint, func(t *testing.T) {
			t.Parallel()
			if got := normalizePath(row.NormalizationInput); got != row.Normalized {
				t.Fatalf("normalizePath(%s boundary) = %q, want %q", row.CodePoint, got, row.Normalized)
			}
			endpoint, err := ParseMCPPath(row.ParserInput)
			if err != nil {
				t.Fatalf("ParseMCPPath(%s boundary): %v", row.CodePoint, err)
			}
			if want := row.ParserEndpoint.endpointPath(); !reflect.DeepEqual(endpoint, want) {
				t.Fatalf("ParseMCPPath(%s boundary) = %#v, want %#v", row.CodePoint, endpoint, want)
			}
			if got := isPathSegment(row.Character); got != row.SegmentValid {
				t.Fatalf("isPathSegment(%s) = %v, want %v", row.CodePoint, got, row.SegmentValid)
			}
		})
		if row.InTrimSet {
			gotIncluded = append(gotIncluded, row.CodePoint)
		} else {
			gotExcluded = append(gotExcluded, row.CodePoint)
		}
	}
	sort.Strings(gotIncluded)
	sort.Strings(gotExcluded)
	if !reflect.DeepEqual(gotIncluded, included) || !reflect.DeepEqual(gotExcluded, excluded) {
		t.Fatalf("whitespace boundary rows do not cover the declared include/exclude sets")
	}
}

func TestSharedParserExpectations(t *testing.T) {
	t.Parallel()
	expected := loadExpectations(t).Parser
	for _, row := range expected.Accept {
		t.Run("accept "+row.Name, func(t *testing.T) {
			t.Parallel()
			got, err := ParseMCPPath(row.Input)
			if err != nil {
				t.Fatalf("ParseMCPPath(%q): %v", row.Input, err)
			}
			if want := row.Endpoint.endpointPath(); !reflect.DeepEqual(got, want) {
				t.Fatalf("ParseMCPPath(%q) = %#v, want %#v", row.Input, got, want)
			}
		})
	}
	for _, row := range expected.Reject {
		t.Run("reject "+row.Name, func(t *testing.T) {
			t.Parallel()
			if _, err := ParseMCPPath(row.Input); err == nil {
				t.Fatalf("ParseMCPPath(%q) unexpectedly succeeded", row.Input)
			}
		})
	}
}

func TestSharedValidationExpectations(t *testing.T) {
	t.Parallel()
	for _, row := range loadExpectations(t).Validation {
		t.Run(row.Name, func(t *testing.T) {
			t.Parallel()
			err := row.Endpoint.endpointPath().Validate()
			if gotValid := err == nil; gotValid != row.Valid {
				t.Fatalf("Validate() error = %v, valid = %v, want %v", err, gotValid, row.Valid)
			}
		})
	}
}

func TestSharedBuilderExpectations(t *testing.T) {
	t.Parallel()
	for _, row := range loadExpectations(t).Builders {
		endpoint := row.Endpoint.endpointPath()
		assertBuilder(t, "MCPPath", endpoint.MCPPath, row.MCPPath)
		assertBuilder(t, "ProtectedResourcePath", endpoint.ProtectedResourcePath, row.ProtectedResourcePath)
		assertBuilder(t, "OAuthAuthorizationServerPath", endpoint.OAuthAuthorizationServerPath, row.AuthorizationServerPath)
		assertBuilder(t, "OAuthAuthorizePath", endpoint.OAuthAuthorizePath, row.AuthorizePath)
		assertBuilder(t, "OAuthTokenPath", endpoint.OAuthTokenPath, row.TokenPath)
		assertBuilder(t, "OAuthAuthorizationServerSuffixPath", endpoint.OAuthAuthorizationServerSuffixPath, row.AuthorizationServerSuffixPath)
	}
}

func TestSharedProtectedResourceInverseExpectations(t *testing.T) {
	t.Parallel()
	expected := loadExpectations(t).ProtectedResourceInverse
	for _, row := range expected.Accept {
		got, err := ResourcePathFromProtectedResourcePath(row.Input)
		if err != nil {
			t.Fatalf("ResourcePathFromProtectedResourcePath(%q): %v", row.Input, err)
		}
		if got != row.ResourcePath {
			t.Fatalf("ResourcePathFromProtectedResourcePath(%q) = %q, want %q", row.Input, got, row.ResourcePath)
		}
	}
	for _, input := range expected.Reject {
		if _, err := ResourcePathFromProtectedResourcePath(input); err == nil {
			t.Fatalf("ResourcePathFromProtectedResourcePath(%q) unexpectedly succeeded", input)
		}
	}
}

func TestEndpointPathBuildersRejectInvalidEndpoint(t *testing.T) {
	t.Parallel()
	invalid := EndpointPath{Kind: EndpointKindPartnerAgent, ClientNamespace: "acme", PartnerID: "pay"}
	builders := []func() (string, error){
		invalid.MCPPath, invalid.ProtectedResourcePath, invalid.OAuthAuthorizationServerPath,
		invalid.OAuthAuthorizePath, invalid.OAuthTokenPath, invalid.OAuthAuthorizationServerSuffixPath,
	}
	for _, builder := range builders {
		if _, err := builder(); err == nil {
			t.Fatal("builder unexpectedly succeeded")
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
