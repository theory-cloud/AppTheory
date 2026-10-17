package apptheory

import "strings"

// App is the root container for an AppTheory application.
//
// AppTheory's runtime behavior is defined by a fixture-backed, versioned contract:
// `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.
type App struct {
	router           *router
	clock            Clock
	ids              IDGenerator
	tier             Tier
	httpErrorFormat  HTTPErrorFormat
	requestIDSource  RequestIDSource
	limits           Limits
	cors             CORSConfig
	auth             AuthHook
	principalAuth    PrincipalAuthHook
	tenantClaim      string
	obs              ObservabilityHooks
	policy           PolicyHook
	secure           bool
	secureResolver   SecurePrincipalResolver
	secureRoutes     []SecureRoute
	middlewares      []Middleware
	eventMiddlewares []EventMiddleware

	sqsRoutes         []sqsRoute
	kinesisRoutes     []kinesisRoute
	snsRoutes         []snsRoute
	eventBridgeRoutes []eventBridgeRoute
	dynamoDBRoutes    []dynamoDBRoute

	webSocketEnabled       bool
	webSocketRoutes        []webSocketRoute
	webSocketClientFactory WebSocketClientFactory
}

type Option func(*App)

type Tier string

const (
	TierP0 Tier = "p0"
	TierP1 Tier = "p1"
	TierP2 Tier = "p2"
)

type Limits struct {
	MaxRequestBytes  int
	MaxResponseBytes int
}

type AuthHook func(*Context) (identity string, err error)

// New creates a new AppTheory application container.
//
// New secure applications should use NewSecure. Existing applications may
// continue to use New; its route and runtime behavior is frozen.
func New(opts ...Option) *App {
	app := &App{
		router:          newRouter(),
		clock:           RealClock{},
		ids:             RandomIDGenerator{},
		tier:            TierP2,
		httpErrorFormat: HTTPErrorFormatNested,
		requestIDSource: RequestIDSourceDefault,
		limits:          Limits{},
		cors:            CORSConfig{},
		auth:            nil,
		obs:             ObservabilityHooks{},
		policy:          nil,
	}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		opt(app)
	}

	if app.webSocketClientFactory == nil {
		app.webSocketClientFactory = defaultWebSocketClientFactory
	}

	return app
}

func WithClock(clock Clock) Option {
	return func(app *App) {
		if clock == nil {
			app.clock = RealClock{}
			return
		}
		app.clock = clock
	}
}

func WithIDGenerator(ids IDGenerator) Option {
	return func(app *App) {
		if ids == nil {
			app.ids = RandomIDGenerator{}
			return
		}
		app.ids = ids
	}
}

func WithTier(tier Tier) Option {
	return func(app *App) {
		app.tier = tier
	}
}

func WithHTTPErrorFormat(format HTTPErrorFormat) Option {
	return func(app *App) {
		app.httpErrorFormat = normalizeHTTPErrorFormat(format)
	}
}

func WithLegacyHTTPErrorShape() Option {
	return WithHTTPErrorFormat(HTTPErrorFormatFlatLegacy)
}

// WithRequestIDSource selects where an HTTP request's ID comes from.
//
// The default honors a client-supplied x-request-id header. RequestIDSourceServer
// ignores that header and issues the ID from the fallback request ID, else a
// generated ID.
func WithRequestIDSource(source RequestIDSource) Option {
	return func(app *App) {
		app.requestIDSource = normalizeRequestIDSource(source)
	}
}

func WithLimits(limits Limits) Option {
	return func(app *App) {
		app.limits = limits
	}
}

func WithAuthHook(hook AuthHook) Option {
	return func(app *App) {
		app.auth = hook
		app.principalAuth = nil
	}
}

// WithTenantClaim names the verified-principal claim that is authoritative for
// tenant. When set and a principal-aware resolver is configured, surfaces that
// bind tenant to identity derive the tenant from this claim and reject
// caller-supplied tenants that disagree with it.
func WithTenantClaim(claim string) Option {
	return func(app *App) {
		app.tenantClaim = strings.TrimSpace(claim)
	}
}

func WithObservability(hooks ObservabilityHooks) Option {
	return func(app *App) {
		app.obs = hooks
	}
}

func WithPolicyHook(hook PolicyHook) Option {
	return func(app *App) {
		app.policy = hook
	}
}
