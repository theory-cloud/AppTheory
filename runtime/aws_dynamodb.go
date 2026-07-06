package apptheory

import (
	"context"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type DynamoDBStreamHandler func(*EventContext, events.DynamoDBEventRecord) error

type dynamoDBRoute struct {
	TableName string
	Handler   DynamoDBStreamHandler
}

// DynamoDB registers a DynamoDB Streams handler by table name.
func (a *App) DynamoDB(tableName string, handler DynamoDBStreamHandler) *App {
	if a == nil {
		return a
	}
	tableName = strings.TrimSpace(tableName)
	if tableName == "" || handler == nil {
		return a
	}
	a.dynamoDBRoutes = append(a.dynamoDBRoutes, dynamoDBRoute{TableName: tableName, Handler: handler})
	return a
}

func dynamoDBTableNameFromStreamARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	if _, after, ok := strings.Cut(arn, ":table/"); ok {
		if table, _, ok := strings.Cut(after, "/stream/"); ok {
			return table
		}
		if table, _, ok := strings.Cut(after, "/"); ok {
			return table
		}
		return after
	}
	return ""
}

func (a *App) dynamoDBHandlerForEvent(event events.DynamoDBEvent) DynamoDBStreamHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		tableName := dynamoDBTableNameFromStreamARN(record.EventSourceArn)
		if tableName == "" {
			continue
		}
		for _, route := range a.dynamoDBRoutes {
			if route.TableName == tableName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

var dynamoDBBatchSpec = newBatchEventSpec[events.DynamoDBEventRecord, events.DynamoDBBatchItemFailure, events.DynamoDBEventResponse](
	"apptheory: invalid dynamodb record type",
	func(record events.DynamoDBEventRecord) string { return record.Change.SequenceNumber },
)

// ServeDynamoDBStream routes a DynamoDB Streams event to the registered table handler and returns a partial batch failure response.
//
// If the table is unrecognized, it fails closed by returning all records as failures.
func (a *App) ServeDynamoDBStream(ctx context.Context, event events.DynamoDBEvent) events.DynamoDBEventResponse {
	handler := a.dynamoDBHandlerForEvent(event)
	handler = wrapEventRecordHandler(a, handler, dynamoDBBatchSpec.coerce, dynamoDBBatchSpec.invalidTypeError)

	evtCtx := a.eventContext(ctx)
	failures := make([]events.DynamoDBBatchItemFailure, 0, len(event.Records))
	for _, record := range event.Records {
		recordCtx := evtCtx.cloneForRecord()
		err := runDynamoDBStreamRecordHandler(recordCtx, record, handler)
		if err != nil {
			id := strings.TrimSpace(dynamoDBBatchSpec.recordID(record))
			if id != "" {
				failures = append(failures, dynamoDBBatchSpec.failureForID(id))
			}
			a.recordEventObservability(dynamoDBStreamObservation(recordCtx, record), "error", "app.internal")
			continue
		}
		a.recordEventObservability(dynamoDBStreamObservation(recordCtx, record), "success", "")
	}
	return dynamoDBBatchSpec.responseForFailures(failures)
}

func runDynamoDBStreamRecordHandler(
	ctx *EventContext,
	record events.DynamoDBEventRecord,
	handler func(*EventContext, events.DynamoDBEventRecord) error,
) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = eventWorkloadFailedError()
		}
	}()
	if handler == nil {
		return eventWorkloadFailedError()
	}
	return handler(ctx, record)
}
