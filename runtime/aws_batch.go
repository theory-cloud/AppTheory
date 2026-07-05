package apptheory

import (
	"context"
	"errors"
	"strings"
)

func batchItemFailures[Record any, Failure any](
	records []Record,
	handler func(Record) error,
	recordID func(Record) string,
	failureForID func(string) Failure,
) []Failure {
	failures := make([]Failure, 0, len(records))
	for _, record := range records {
		if handler != nil {
			if err := handler(record); err == nil {
				continue
			}
		}

		id := strings.TrimSpace(recordID(record))
		if id == "" {
			continue
		}
		failures = append(failures, failureForID(id))
	}
	return failures
}

func serveBatchItemFailures[Record any, Failure any](
	ctx context.Context,
	a *App,
	records []Record,
	handler func(*EventContext, Record) error,
	recordID func(Record) string,
	failureForID func(string) Failure,
) []Failure {
	var runner func(Record) error
	if handler != nil {
		evtCtx := a.eventContext(ctx)
		runner = func(record Record) error {
			return handler(evtCtx.cloneForRecord(), record)
		}
	}
	return batchItemFailures(records, runner, recordID, failureForID)
}

func wrapEventRecordHandler[Record any](
	a *App,
	handler func(*EventContext, Record) error,
	coerce func(any) (Record, bool),
	invalidTypeError string,
) func(*EventContext, Record) error {
	if a == nil || handler == nil || len(a.eventMiddlewares) == 0 || coerce == nil {
		return handler
	}

	wrapped := a.applyEventMiddlewares(func(ctx *EventContext, event any) (any, error) {
		record, ok := coerce(event)
		if !ok {
			return nil, errors.New(invalidTypeError)
		}
		return nil, handler(ctx, record)
	})

	return func(ctx *EventContext, record Record) error {
		_, err := wrapped(ctx, record)
		return err
	}
}

func wrapEventRecordHandlerWithOutput[Record any](
	a *App,
	handler func(*EventContext, Record) (any, error),
	coerce func(any) (Record, bool),
	invalidTypeError string,
) func(*EventContext, Record) (any, error) {
	if a == nil || handler == nil || len(a.eventMiddlewares) == 0 || coerce == nil {
		return handler
	}

	wrapped := a.applyEventMiddlewares(func(ctx *EventContext, event any) (any, error) {
		record, ok := coerce(event)
		if !ok {
			return nil, errors.New(invalidTypeError)
		}
		return handler(ctx, record)
	})

	return func(ctx *EventContext, record Record) (any, error) {
		return wrapped(ctx, record)
	}
}

type batchEventSpec[Record any, Failure any, Response any] struct {
	coerce              func(any) (Record, bool)
	invalidTypeError    string
	recordID            func(Record) string
	failureForID        func(string) Failure
	responseForFailures func([]Failure) Response
}

type batchItemFailure interface {
	~struct {
		ItemIdentifier string `json:"itemIdentifier"`
	}
}

type batchItemFailuresResponse[Failure any] interface {
	~struct {
		BatchItemFailures []Failure `json:"batchItemFailures"`
	}
}

func newBatchEventSpec[Record any, Failure batchItemFailure, Response batchItemFailuresResponse[Failure]](
	invalidTypeError string,
	recordID func(Record) string,
) batchEventSpec[Record, Failure, Response] {
	return batchEventSpec[Record, Failure, Response]{
		coerce: func(event any) (Record, bool) {
			record, ok := event.(Record)
			return record, ok
		},
		invalidTypeError: invalidTypeError,
		recordID:         recordID,
		failureForID: func(id string) Failure {
			return Failure{ItemIdentifier: id}
		},
		responseForFailures: func(failures []Failure) Response {
			return Response{BatchItemFailures: failures}
		},
	}
}

func serveBatchEvent[Record any, Failure any, Response any](
	ctx context.Context,
	a *App,
	records []Record,
	handler func(*EventContext, Record) error,
	spec batchEventSpec[Record, Failure, Response],
) Response {
	handler = wrapEventRecordHandler(a, handler, spec.coerce, spec.invalidTypeError)
	failures := serveBatchItemFailures(ctx, a, records, handler, spec.recordID, spec.failureForID)
	return spec.responseForFailures(failures)
}
