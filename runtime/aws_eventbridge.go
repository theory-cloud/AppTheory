package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type EventBridgeSelector struct {
	RuleName   string
	Source     string
	DetailType string
}

func EventBridgeRule(ruleName string) EventBridgeSelector {
	return EventBridgeSelector{RuleName: strings.TrimSpace(ruleName)}
}

func EventBridgePattern(source, detailType string) EventBridgeSelector {
	return EventBridgeSelector{
		Source:     strings.TrimSpace(source),
		DetailType: strings.TrimSpace(detailType),
	}
}

type EventBridgeHandler func(*EventContext, events.EventBridgeEvent) (any, error)

type eventBridgeRoute struct {
	Selector EventBridgeSelector
	Handler  EventBridgeHandler
}

// EventBridge registers an EventBridge handler.
//
// Matching rules:
// - If selector.RuleName is set, it matches when any event resource ARN refers to that rule name.
// - Otherwise, it matches on selector.Source + selector.DetailType (when provided).
func (a *App) EventBridge(selector EventBridgeSelector, handler EventBridgeHandler) *App {
	if a == nil {
		return a
	}
	if handler == nil {
		return a
	}
	selector.RuleName = strings.TrimSpace(selector.RuleName)
	selector.Source = strings.TrimSpace(selector.Source)
	selector.DetailType = strings.TrimSpace(selector.DetailType)
	if selector.RuleName == "" && selector.Source == "" && selector.DetailType == "" {
		return a
	}
	a.eventBridgeRoutes = append(a.eventBridgeRoutes, eventBridgeRoute{Selector: selector, Handler: handler})
	return a
}

func eventBridgeRuleNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	if _, after, ok := strings.Cut(arn, ":rule/"); ok {
		after = strings.TrimPrefix(after, "/")
		if after == "" {
			return ""
		}
		if rule, _, ok := strings.Cut(after, "/"); ok {
			return rule
		}
		return after
	}
	if _, after, ok := strings.Cut(arn, "rule/"); ok {
		after = strings.TrimPrefix(after, "/")
		if after == "" {
			return ""
		}
		if rule, _, ok := strings.Cut(after, "/"); ok {
			return rule
		}
		return after
	}
	return ""
}

func (a *App) eventBridgeHandlerForEvent(event events.EventBridgeEvent) EventBridgeHandler {
	if a == nil {
		return nil
	}

	for _, route := range a.eventBridgeRoutes {
		if route.Handler == nil {
			continue
		}
		sel := route.Selector
		if sel.RuleName != "" {
			for _, resource := range event.Resources {
				if eventBridgeRuleNameFromARN(resource) == sel.RuleName {
					return route.Handler
				}
			}
			continue
		}

		if sel.Source != "" && strings.TrimSpace(event.Source) != sel.Source {
			continue
		}
		if sel.DetailType != "" && strings.TrimSpace(event.DetailType) != sel.DetailType {
			continue
		}
		return route.Handler
	}

	return nil
}

// ServeEventBridge routes an EventBridge event to the first matching handler.
//
// If no handler matches, it returns (nil, nil).
func (a *App) ServeEventBridge(ctx context.Context, event events.EventBridgeEvent) (any, error) {
	return a.serveEventBridge(ctx, event, nil)
}

func (a *App) serveEventBridge(ctx context.Context, event events.EventBridgeEvent, raw json.RawMessage) (out any, err error) {
	handler := a.eventBridgeHandlerForEvent(event)
	if handler == nil {
		return nil, nil
	}

	evtCtx := a.eventContext(ctx)
	evtCtx.rawEvent = append(json.RawMessage(nil), raw...)
	observation := eventBridgeObservation(evtCtx, event)
	defer func() {
		if recovered := recover(); recovered != nil {
			out = nil
			err = eventWorkloadFailedError()
			a.recordEventObservability(observation, "error", "app.internal")
			return
		}
		if err != nil {
			err = sanitizeEventWorkloadError(err)
			a.recordEventObservability(observation, "error", "app.internal")
			return
		}
		a.recordEventObservability(observation, "success", "")
	}()

	if a != nil && len(a.eventMiddlewares) > 0 {
		original := handler
		wrapped := a.applyEventMiddlewares(func(ctx *EventContext, event any) (any, error) {
			ev, ok := event.(events.EventBridgeEvent)
			if !ok {
				return nil, errors.New("apptheory: invalid eventbridge event type")
			}
			return original(ctx, ev)
		})
		return wrapped(evtCtx, event)
	}

	return handler(evtCtx, event)
}
