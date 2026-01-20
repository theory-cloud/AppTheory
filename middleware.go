package apptheory

// Middleware wraps an AppTheory handler.
//
// Middleware is applied in registration order:
//
//	app.Use(m1).Use(m2)
//
// yields the execution order:
//
//	m1 -> m2 -> handler
type Middleware func(Handler) Handler

// Use registers a global middleware.
func (a *App) Use(mw Middleware) *App {
	if a == nil || mw == nil {
		return a
	}
	a.middlewares = append(a.middlewares, mw)
	return a
}

func (a *App) applyMiddlewares(handler Handler) Handler {
	if a == nil || handler == nil || len(a.middlewares) == 0 {
		return handler
	}
	for i := len(a.middlewares) - 1; i >= 0; i-- {
		mw := a.middlewares[i]
		if mw == nil {
			continue
		}
		handler = mw(handler)
	}
	return handler
}
