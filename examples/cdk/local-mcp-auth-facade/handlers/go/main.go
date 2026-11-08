package main

// The local MCP auth-facade example: one Lambda app that mounts the framework's
// MCP auth facade with its brokered route refresh, an MCP tool surface behind
// the runtime-bearer transport posture, and a real local authorization server
// as its upstream. It runs on the local runner and is driven over real HTTP by
// scripts/local/run_examples_local.py.
//
// The example exists to replay, over real HTTP, the refresh sequences that broke
// real clients (rotation chains, a stale predecessor after a rotation, two
// concurrent refreshers on one handle, a restart mid-chain, a retry storm, a
// genuine terminal rejection, and a pre-policy record), and to assert the
// server-side family state those sequences produce. It also hosts the MCP
// surface the local real-client target drives.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-lambda-go/lambda"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/mcp"
	"github.com/theory-cloud/apptheory/v7/runtime/mcpfacade"
	"github.com/theory-cloud/apptheory/v7/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
	"github.com/theory-cloud/apptheory/v7/runtime/refusal"
)

const (
	// exampleNamespace is the client namespace the example's MCP route uses.
	exampleNamespace = "acme"
	// exampleScope is the one scope every contract endpoint kind requires.
	exampleScope = "mcp:tools"

	defaultHandleTTL   = 24 * time.Hour
	defaultAccessTTL   = 15 * time.Minute
	defaultGraceWindow = time.Second
	defaultSubject     = "example-person"
	defaultUpstreamID  = "apptheory-local-facade"
)

// exampleConfig is the deployment configuration the example's CDK stack sets.
type exampleConfig struct {
	publicBaseURL  string
	upstreamClient string
	subject        string
	handleTTL      time.Duration
	graceWindow    time.Duration
	accessTTL      time.Duration
}

// configFromEnv reads the example configuration from the environment the CDK
// stack sets. These are application settings, not framework knobs: the
// framework itself reads no environment variable.
func configFromEnv() (exampleConfig, error) {
	cfg := exampleConfig{
		publicBaseURL:  strings.TrimRight(strings.TrimSpace(os.Getenv("MCP_EXAMPLE_PUBLIC_BASE_URL")), "/"),
		upstreamClient: envOr("MCP_EXAMPLE_UPSTREAM_CLIENT_ID", defaultUpstreamID),
		subject:        envOr("MCP_EXAMPLE_SUBJECT", defaultSubject),
		handleTTL:      defaultHandleTTL,
		graceWindow:    defaultGraceWindow,
		accessTTL:      defaultAccessTTL,
	}
	if cfg.publicBaseURL == "" {
		return exampleConfig{}, errors.New("example: MCP_EXAMPLE_PUBLIC_BASE_URL is required")
	}
	for name, target := range map[string]*time.Duration{
		"MCP_EXAMPLE_HANDLE_TTL":   &cfg.handleTTL,
		"MCP_EXAMPLE_GRACE_WINDOW": &cfg.graceWindow,
		"MCP_EXAMPLE_ACCESS_TTL":   &cfg.accessTTL,
	} {
		raw := strings.TrimSpace(os.Getenv(name))
		if raw == "" {
			continue
		}
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			return exampleConfig{}, fmt.Errorf("example: %s must be a positive duration, got %q", name, raw)
		}
		*target = parsed
	}
	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// example is the composed application: the facade, its upstream, and the
// example-only inspection surface the rows read.
type example struct {
	cfg       exampleConfig
	upstream  *localUpstream
	broker    *recordingBroker
	events    *eventLog
	refusals  *eventLog
	toolCalls atomic.Int64
}

func main() {
	cfg, err := configFromEnv()
	if err != nil {
		panic(err)
	}
	app, err := buildApp(cfg)
	if err != nil {
		panic(err)
	}
	lambda.Start(app.HandleLambda)
}

// buildApp mounts the facade and the example's own routes.
func buildApp(cfg exampleConfig) (*apptheory.App, error) {
	instance, err := newExample(cfg)
	if err != nil {
		return nil, err
	}
	app := apptheory.New()
	if _, err := mcpfacade.RegisterMCPFacade(app, instance.facadeConfig()); err != nil {
		return nil, err
	}
	app.Get("/_upstream/authorize", instance.upstream.authorize)
	app.Get("/_upstream/jwks.json", func(*apptheory.Context) (*apptheory.Response, error) {
		document, err := instance.upstream.jwks()
		if err != nil {
			return nil, err
		}
		return apptheory.JSON(http.StatusOK, document)
	})
	app.Get("/_state", instance.state)
	app.Post("/_state/legacy", instance.seedLegacy)
	app.Post("/_state/revoke-upstream-grant", instance.revokeUpstream)
	return app, nil
}

// newExample wires the stores, the upstream, and the facade's telemetry.
func newExample(cfg exampleConfig) (*example, error) {
	upstream, err := newUpstream(
		cfg.publicBaseURL,
		cfg.publicBaseURL+"/_upstream",
		cfg.upstreamClient,
		cfg.publicBaseURL+"/_oauth/mcp/callback",
		cfg.subject,
		cfg.accessTTL,
	)
	if err != nil {
		return nil, err
	}
	var memory oauthstore.RouteRefreshBrokerStore = oauthstore.NewMemoryRouteRefreshBrokerStore(
		oauthstore.RouteRefreshBrokerStoreOptions{TTL: cfg.handleTTL},
	)
	family, ok := memory.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	if !ok {
		return nil, errors.New("example: the reference broker store lost its family capability")
	}
	seeder, ok := memory.(oauthstore.RouteRefreshBrokerSeeder)
	if !ok {
		return nil, errors.New("example: the reference broker store lost its seeding capability")
	}
	instance := &example{
		cfg:      cfg,
		upstream: upstream,
		broker: &recordingBroker{
			RouteRefreshBrokerStore:  memory,
			RouteRefreshBrokerSeeder: seeder,
			family:                   family,
			records:                  map[string]*oauthstore.RouteRefreshBrokerRecord{},
		},
		events:   &eventLog{limit: 256},
		refusals: &eventLog{limit: 256},
	}
	return instance, nil
}

// facadeConfig is the complete facade configuration the example mounts.
func (e *example) facadeConfig() mcpfacade.FacadeConfig {
	return mcpfacade.FacadeConfig{
		// Route issuer mode: each MCP route is its own authorization server, so
		// its RFC 8414 metadata lives at the route's own well-known path — the
		// one a client derives from the issuer — instead of only at a root path a
		// client would otherwise probe and find empty.
		IssuerMode:    mcproutes.IssuerModeRoute,
		IssuerURL:     e.cfg.publicBaseURL + "/" + exampleNamespace + "/mcp",
		JWKSURI:       e.cfg.publicBaseURL + "/_upstream/jwks.json",
		URLMode:       mcpfacade.URLModePublicBaseURL,
		PublicBaseURL: e.cfg.publicBaseURL,
		Scopes: map[mcproutes.EndpointKind][]string{
			mcproutes.EndpointKindNamespace:        {exampleScope},
			mcproutes.EndpointKindPartnerNamespace: {exampleScope},
			mcproutes.EndpointKindAgent:            {exampleScope},
			mcproutes.EndpointKindPartnerAgent:     {exampleScope},
		},
		MCPHandler:       buildMCPServer(&e.toolCalls).Handler(),
		TransportPosture: mcpfacade.TransportPostureRuntimeBearer,
		RequireBearerToken: &oauth.RequireBearerTokenOptions{
			ResourceMetadataURLFunc: func(ctx *apptheory.Context) (string, error) {
				return e.resourceMetadataURL(ctx.Request.Path), nil
			},
			ClaimsValidator: e.upstream.bearerClaimsValidator,
			RequiredScopesFunc: func(*apptheory.Context) ([]string, error) {
				return []string{exampleScope}, nil
			},
		},
		Provider:         e.upstream,
		Stores:           e.stores(),
		UpstreamClientID: e.cfg.upstreamClient,
		UpstreamIssuer:   e.upstream.issuer,
		RouteRefreshPolicy: mcpfacade.RouteRefreshPolicy{
			HandleTTL:        e.cfg.handleTTL,
			GraceWindow:      e.cfg.graceWindow,
			ReuseRateCeiling: 9,
		},
		RouteRefreshEvents: func(_ context.Context, event mcpfacade.RouteRefreshEvent) {
			e.events.append(map[string]any{
				"class":      event.Class,
				"reason":     event.Reason,
				"outcome":    event.Outcome,
				"errorCode":  event.ErrorCode,
				"family":     shortHash(event.FamilyHash),
				"handle":     shortHash(event.HandleHash),
				"successor":  shortHash(event.SuccessorHandleHash),
				"generation": event.ChainGeneration,
				"statusFrom": event.StatusFrom,
				"statusTo":   event.StatusTo,
				"upstream":   event.UpstreamClass,
			})
		},
		RefusalHook: func(_ context.Context, event refusal.Event) {
			e.refusals.append(map[string]any{
				"class":     event.Class,
				"reason":    event.Reason,
				"status":    event.Status,
				"method":    event.Method,
				"path":      event.Path,
				"errorCode": event.ErrorCode,
				"challenge": event.Challenge,
			})
		},
	}
}

// stores is the facade store set. The reference stores are deliberately
// non-durable and do not encrypt: this is a local example, not a deployment.
func (e *example) stores() oauthstore.Stores {
	return oauthstore.Stores{
		Transaction:        oauthstore.NewMemoryTransactionStore(oauthstore.TransactionStoreOptions{}),
		AuthorizationCode:  oauthstore.NewMemoryAuthorizationCodeStore(oauthstore.AuthorizationCodeStoreOptions{}),
		Client:             oauthstore.NewMemoryClientStore(oauthstore.ClientStoreOptions{}),
		RouteRefreshBroker: e.broker,
		RateLimit:          oauthstore.NewMemoryRateLimitStore(oauthstore.RateLimitStoreOptions{}),
	}
}

// resourceForMCPPath is the advertising route resource a route's clients are
// bound to.
func (e *example) resourceForMCPPath(path string) string {
	base := strings.TrimRight(e.cfg.publicBaseURL, "/")
	prefix := "/" + exampleNamespace + "/mcp"
	if index := strings.Index(path, prefix); index >= 0 {
		return base + path[index:]
	}
	return base + prefix
}

// resourceMetadataURL maps an MCP path to its route-derived RFC 9728 metadata
// URL, which is what the bearer challenge advertises.
func (e *example) resourceMetadataURL(path string) string {
	base := strings.TrimRight(e.cfg.publicBaseURL, "/")
	prefix := "/" + exampleNamespace + "/mcp"
	suffix := prefix
	if index := strings.Index(path, prefix); index >= 0 {
		suffix = path[index:]
	}
	return base + mcproutes.ProtectedResourcePathFromMCPPath(suffix)
}

func resourceForMCPPath(publicBaseURL, path string) string {
	base := strings.TrimRight(publicBaseURL, "/")
	prefix := "/" + exampleNamespace + "/mcp"
	if index := strings.Index(path, prefix); index >= 0 {
		return base + path[index:]
	}
	return base + prefix
}

// state returns the example-only inspection document: the broker records the
// rows assert, the upstream's call counters, and the redacted telemetry.
func (e *example) state(*apptheory.Context) (*apptheory.Response, error) {
	issued, refreshed, reused := e.upstream.stats()
	return apptheory.JSON(http.StatusOK, map[string]any{
		"publicBaseUrl":  e.cfg.publicBaseURL,
		"upstreamIssuer": e.upstream.issuer,
		"families":       e.broker.snapshot(),
		"upstream": map[string]int{
			"issued":    issued,
			"refreshed": refreshed,
			"reused":    reused,
		},
		"refreshEvents": e.events.snapshot(),
		"refusals":      e.refusals.snapshot(),
		"toolCalls":     e.toolCalls.Load(),
	})
}

// seedLegacy places a pre-policy, family-less broker record with live upstream
// material, so the legacy-continuity row starts from exactly the record a
// v6.4.0-era deployment left behind. It is an example-only test seam.
func (e *example) seedLegacy(ctx *apptheory.Context) (*apptheory.Response, error) {
	var request struct {
		ClientID string `json:"client_id"`
	}
	if len(ctx.Request.Body) > 0 {
		if err := json.Unmarshal(ctx.Request.Body, &request); err != nil {
			return textResponse(http.StatusBadRequest, "invalid body"), nil
		}
	}
	if strings.TrimSpace(request.ClientID) == "" {
		return textResponse(http.StatusBadRequest, "client_id is required"), nil
	}
	resource := e.resourceForMCPPath("/" + exampleNamespace + "/mcp")
	handle := opaqueToken()
	record := &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(handle),
		Issuer:                        e.upstream.issuer,
		CanonicalResource:             resource,
		ClientNamespace:               exampleNamespace,
		EndpointKind:                  string(mcproutes.EndpointKindNamespace),
		ClientIDHash:                  oauthstore.HashKey(request.ClientID),
		SubjectIDHash:                 oauthstore.HashKey(e.cfg.subject),
		Scopes:                        []string{exampleScope},
		EncryptedUpstreamRefreshToken: e.upstream.mintRefreshForSeed(resource),
		UpstreamClientID:              e.cfg.upstreamClient,
		Status:                        oauthstore.BrokerStatusActive,
	}
	record.UpstreamRefreshTokenHash = oauthstore.HashKey(record.EncryptedUpstreamRefreshToken)
	if err := e.broker.Put(ctx.Context(), record); err != nil {
		return nil, err
	}
	return apptheory.JSON(http.StatusOK, map[string]any{"refresh_token": handle})
}

// revokeUpstream makes every upstream grant terminally dead, the local stand-in
// for a person withdrawing their authorization at the identity provider.
func (e *example) revokeUpstream(*apptheory.Context) (*apptheory.Response, error) {
	e.upstream.revokeAllGrants()
	return apptheory.JSON(http.StatusOK, map[string]any{"revoked": true})
}

// buildMCPServer is the MCP surface the facade protects: one echo tool.
func buildMCPServer(calls *atomic.Int64) *mcp.Server {
	srv := mcp.NewServer("local-mcp-auth-facade", "dev")
	_ = srv.Registry().RegisterTool(mcp.ToolDef{
		Name:        "echo",
		Description: "Echo back the provided message.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
	}, mcp.WrapTool(mcp.ToolLifecycleOptions[echoArgs]{
		Name:       "echo",
		StrictJSON: true,
		Validate: func(_ context.Context, args echoArgs) error {
			if strings.TrimSpace(args.Message) == "" {
				return errors.New("message is required")
			}
			return nil
		},
	}, func(_ context.Context, in echoArgs) (*mcp.ToolResult, error) {
		if calls != nil {
			calls.Add(1)
		}
		return &mcp.ToolResult{
			Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}},
		}, nil
	}))
	return srv
}

type echoArgs struct {
	Message string `json:"message"`
}

// eventLog is a bounded, redacted event ring the state document exposes.
type eventLog struct {
	mu     sync.Mutex
	limit  int
	events []map[string]any
}

func (l *eventLog) append(event map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
	if len(l.events) > l.limit {
		l.events = l.events[len(l.events)-l.limit:]
	}
}

func (l *eventLog) snapshot() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]map[string]any(nil), l.events...)
}

// recordingBroker decorates the reference broker store and keeps a redacted
// copy of every record it sees, so the example can report family status and
// generations without a store enumeration API.
type recordingBroker struct {
	oauthstore.RouteRefreshBrokerStore
	oauthstore.RouteRefreshBrokerSeeder
	family oauthstore.RouteRefreshBrokerTransactionalFamilyStore

	mu      sync.Mutex
	records map[string]*oauthstore.RouteRefreshBrokerRecord
}

func (b *recordingBroker) note(record *oauthstore.RouteRefreshBrokerRecord) *oauthstore.RouteRefreshBrokerRecord {
	if record == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	clone := *record
	clone.Scopes = append([]string(nil), record.Scopes...)
	b.records[record.HandleHash] = &clone
	return record
}

func (b *recordingBroker) Get(ctx context.Context, handleHash string) (*oauthstore.RouteRefreshBrokerRecord, error) {
	record, err := b.RouteRefreshBrokerStore.Get(ctx, handleHash)
	return b.note(record), err
}

func (b *recordingBroker) AcquireLock(
	ctx context.Context,
	handleHash string,
	lockOwner string,
	expectedVersion int,
) (*oauthstore.RouteRefreshBrokerRecord, error) {
	record, err := b.RouteRefreshBrokerStore.AcquireLock(ctx, handleHash, lockOwner, expectedVersion)
	return b.note(record), err
}

func (b *recordingBroker) CompareAndSwap(
	ctx context.Context,
	record *oauthstore.RouteRefreshBrokerRecord,
	expectedVersion int,
) (*oauthstore.RouteRefreshBrokerRecord, error) {
	updated, err := b.RouteRefreshBrokerStore.CompareAndSwap(ctx, record, expectedVersion)
	return b.note(updated), err
}

func (b *recordingBroker) Revoke(ctx context.Context, handleHash string) (*oauthstore.RouteRefreshBrokerRecord, error) {
	record, err := b.RouteRefreshBrokerStore.Revoke(ctx, handleHash)
	return b.note(record), err
}

func (b *recordingBroker) Put(ctx context.Context, record *oauthstore.RouteRefreshBrokerRecord) error {
	if err := b.RouteRefreshBrokerSeeder.Put(ctx, record); err != nil {
		return err
	}
	b.note(record)
	return nil
}

func (b *recordingBroker) ListFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	records, err := b.family.ListFamily(ctx, familyHash)
	for _, record := range records {
		b.note(record)
	}
	return records, err
}

func (b *recordingBroker) RevokeFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	records, err := b.family.RevokeFamily(ctx, familyHash)
	for _, record := range records {
		b.note(record)
	}
	return records, err
}

func (b *recordingBroker) CreateFamily(
	ctx context.Context,
	root *oauthstore.RouteRefreshBrokerRecord,
) (*oauthstore.RouteRefreshBrokerRecord, error) {
	record, err := b.family.CreateFamily(ctx, root)
	return b.note(record), err
}

func (b *recordingBroker) RotateFamily(
	ctx context.Context,
	rotation oauthstore.RouteRefreshFamilyRotation,
) (*oauthstore.RouteRefreshBrokerRecord, error) {
	record, err := b.family.RotateFamily(ctx, rotation)
	if err == nil {
		// The rotation updates the presented record as well as creating the
		// successor, and it returns only the successor.
		if presented, getErr := b.RouteRefreshBrokerStore.Get(ctx, rotation.PresentedHandleHash); getErr == nil {
			b.note(presented)
		}
	}
	return b.note(record), err
}

// snapshot groups the recorded handles into families with their status and
// generations. It carries hashes only, never a handle or a credential.
func (b *recordingBroker) snapshot() []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	grouped := map[string][]*oauthstore.RouteRefreshBrokerRecord{}
	order := []string{}
	for _, record := range b.records {
		key := record.FamilyHash
		if key == "" {
			key = "legacy"
		}
		if _, seen := grouped[key]; !seen {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], record)
	}
	families := make([]map[string]any, 0, len(grouped))
	for _, key := range order {
		records := grouped[key]
		liveHead := ""
		highest := -1
		members := make([]map[string]any, 0, len(records))
		for _, record := range records {
			status := record.Status
			if status == "" {
				status = oauthstore.BrokerStatusIssued
			}
			live := record.GraceExpiresAt.IsZero() &&
				status != oauthstore.BrokerStatusRevoked &&
				record.ChainGeneration >= 1
			if live && record.ChainGeneration > highest {
				highest = record.ChainGeneration
				liveHead = record.HandleHash
			}
		}
		for _, record := range records {
			status := record.Status
			if status == "" {
				status = oauthstore.BrokerStatusIssued
			}
			members = append(members, map[string]any{
				"handle":     shortHash(record.HandleHash),
				"generation": record.ChainGeneration,
				"status":     status,
				"grace":      !record.GraceExpiresAt.IsZero(),
				"liveHead":   record.HandleHash == liveHead,
				"accessLive": !record.GraceAccessTokenExpiresAt.IsZero(),
			})
		}
		families = append(families, map[string]any{
			"family":  shortHash(key),
			"legacy":  key == "legacy",
			"head":    shortHash(liveHead),
			"revoked": familyRevoked(records),
			"members": members,
		})
	}
	return families
}

func familyRevoked(records []*oauthstore.RouteRefreshBrokerRecord) bool {
	for _, record := range records {
		if record.Status == oauthstore.BrokerStatusRevoked {
			return true
		}
	}
	return false
}

// shortHash keeps a hash recognisable in the state document.
func shortHash(value string) string {
	if len(value) <= 12 {
		return value
	}
	return value[:12]
}

func textResponse(status int, body string) *apptheory.Response {
	return apptheory.Text(status, body)
}

func redirectResponse(location string) *apptheory.Response {
	return &apptheory.Response{
		Status:  http.StatusFound,
		Headers: map[string][]string{"location": {location}},
	}
}
