package apptheory

// App is the root container for an AppTheory application.
//
// AppTheory's runtime behavior is defined by a fixture-backed, versioned contract:
// `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.
type App struct {
	router *router
	clock  Clock
}

type Option func(*App)

// New creates a new AppTheory application container.
func New(opts ...Option) *App {
	app := &App{
		router: newRouter(),
		clock:  RealClock{},
	}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		opt(app)
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
