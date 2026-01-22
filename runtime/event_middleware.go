package apptheory

// EventHandler is a generic handler function for non-HTTP Lambda triggers.
//
// The `event` value is trigger-specific (for example: `events.SQSMessage`, `events.DynamoDBEventRecord`,
// `events.EventBridgeEvent`).
type EventHandler func(*EventContext, any) (any, error)

// EventMiddleware wraps an EventHandler.
//
// Event middleware is opt-in: it only runs when registered via `app.UseEvents(...)`.
type EventMiddleware func(EventHandler) EventHandler

// UseEvents registers a global event middleware.
//
// Event middleware is applied in registration order:
//
//	app.UseEvents(m1).UseEvents(m2)
//
// yields the execution order:
//
//	m1 -> m2 -> event handler
func (a *App) UseEvents(mw EventMiddleware) *App {
	if a == nil || mw == nil {
		return a
	}
	a.eventMiddlewares = append(a.eventMiddlewares, mw)
	return a
}

func (a *App) applyEventMiddlewares(handler EventHandler) EventHandler {
	if a == nil || handler == nil || len(a.eventMiddlewares) == 0 {
		return handler
	}
	for i := len(a.eventMiddlewares) - 1; i >= 0; i-- {
		mw := a.eventMiddlewares[i]
		if mw == nil {
			continue
		}
		handler = mw(handler)
	}
	return handler
}
