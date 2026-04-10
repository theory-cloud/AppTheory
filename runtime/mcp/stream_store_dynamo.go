package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

const (
	defaultStreamTTLMinutes         = 60
	defaultDynamoStreamPollInterval = 100 * time.Millisecond
	defaultDynamoStreamBatchSize    = 128
	defaultDynamoStreamTableName    = "mcp-streams"
	dynamoStreamDeleteQuietPasses   = 2
	dynamoStreamEventIDWidth        = 20
	dynamoStreamFirstEventID        = "0"
	dynamoStreamMetadataEventPrefix = "!stream#"
	dynamoStreamSessionStateEventID = "!session"
	dynamoStreamRecordKindSession   = "session"
	dynamoStreamRecordKindStream    = "stream"
	dynamoStreamRecordKindEvent     = "event"
	envStreamTTLMinutes             = "MCP_STREAM_TTL_MINUTES"
	envStreamTableName              = "MCP_STREAM_TABLE"
)

type dynamoStreamRecord struct {
	SessionID string          `theorydb:"pk,attr:sessionId" json:"sessionId"`
	EventID   string          `theorydb:"sk,attr:eventId" json:"eventId"`
	StreamID  string          `theorydb:"attr:streamId" json:"streamId"`
	Kind      string          `theorydb:"attr:kind" json:"kind"`
	CreatedAt time.Time       `theorydb:"attr:createdAt" json:"createdAt"`
	ExpiresAt int64           `theorydb:"ttl,attr:expiresAt" json:"expiresAt"`
	NextSeq   int64           `theorydb:"attr:nextSeq,omitempty" json:"nextSeq,omitempty"`
	Closed    bool            `theorydb:"attr:closed,omitempty" json:"closed,omitempty"`
	Deleted   bool            `theorydb:"attr:deleted,omitempty" json:"deleted,omitempty"`
	Data      json.RawMessage `theorydb:"attr:data,omitempty" json:"data,omitempty"`
}

func (dynamoStreamRecord) TableName() string {
	if name := os.Getenv(envStreamTableName); name != "" {
		return name
	}
	return defaultDynamoStreamTableName
}

// DynamoStreamStore implements StreamStore using DynamoDB via TableTheory.
//
// Subscribe uses strongly consistent reads plus short polling so separate
// server instances can replay and continue an active stream from shared state.
type DynamoStreamStore struct {
	db           tablecore.DB
	idGen        apptheory.IDGenerator
	now          func() time.Time
	pollInterval time.Duration
	batchSize    int
}

var _ StreamStore = (*DynamoStreamStore)(nil)

var errDynamoStreamSessionDeleted = errors.New("stream session deleted")

// NewDynamoStreamStore creates a DynamoDB-backed StreamStore.
func NewDynamoStreamStore(db tablecore.DB) StreamStore {
	return &DynamoStreamStore{
		db:           db,
		idGen:        apptheory.RandomIDGenerator{},
		now:          func() time.Time { return time.Now().UTC() },
		pollInterval: defaultDynamoStreamPollInterval,
		batchSize:    defaultDynamoStreamBatchSize,
	}
}

func (d *DynamoStreamStore) Create(ctx context.Context, sessionID string) (string, error) {
	ctx = normalizeStreamContext(ctx)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", errors.New("missing session id")
	}

	if err := d.touchSessionState(ctx, sessionID); err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return "", ErrStreamNotFound
		}
		return "", err
	}

	streamID := strings.TrimSpace(d.idGen.NewID())
	if streamID == "" {
		return "", errors.New("missing stream id")
	}

	now := d.now().UTC()
	record := &dynamoStreamRecord{
		SessionID: sessionID,
		EventID:   dynamoStreamMetadataEventID(streamID),
		StreamID:  streamID,
		Kind:      dynamoStreamRecordKindStream,
		CreatedAt: now,
		ExpiresAt: d.expiresAtUnix(now),
	}

	if err := d.db.Model(record).WithContext(ctx).Create(); err != nil {
		return "", err
	}
	return streamID, nil
}

func (d *DynamoStreamStore) Append(ctx context.Context, sessionID, streamID string, data json.RawMessage) (string, error) {
	ctx = normalizeStreamContext(ctx)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", errors.New("missing session id")
	}
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return "", errors.New("missing stream id")
	}

	meta, err := d.getStreamMetadata(ctx, sessionID, streamID)
	if err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return "", ErrStreamNotFound
		}
		return "", err
	}

	now := d.now().UTC()
	eventID, err := d.nextSessionEventID(ctx, sessionID, now)
	if err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return "", ErrStreamNotFound
		}
		return "", err
	}

	payload := make([]byte, len(data))
	copy(payload, data)

	if err := d.assertSessionActive(ctx, sessionID); err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return "", ErrStreamNotFound
		}
		return "", err
	}

	meta.ExpiresAt = d.expiresAtUnix(now)
	if err := d.db.Model(meta).WithContext(ctx).CreateOrUpdate(); err != nil {
		return "", err
	}

	record := &dynamoStreamRecord{
		SessionID: sessionID,
		EventID:   eventID,
		StreamID:  streamID,
		Kind:      dynamoStreamRecordKindEvent,
		CreatedAt: now,
		ExpiresAt: d.expiresAtUnix(now),
		Data:      payload,
	}

	if err := d.db.Model(record).WithContext(ctx).Create(); err != nil {
		return "", err
	}
	return eventID, nil
}

func (d *DynamoStreamStore) Close(ctx context.Context, sessionID, streamID string) error {
	ctx = normalizeStreamContext(ctx)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return errors.New("missing session id")
	}
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return errors.New("missing stream id")
	}

	meta, err := d.getStreamMetadata(ctx, sessionID, streamID)
	if err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return nil
		}
		return err
	}

	if err := d.assertSessionActive(ctx, sessionID); err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return nil
		}
		return err
	}

	meta.Closed = true
	meta.ExpiresAt = d.expiresAtUnix(d.now().UTC())
	return d.db.Model(meta).WithContext(ctx).CreateOrUpdate()
}

func (d *DynamoStreamStore) Subscribe(ctx context.Context, sessionID, streamID, afterEventID string) (<-chan StreamEvent, error) {
	ctx = normalizeStreamContext(ctx)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, errors.New("missing session id")
	}
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return nil, errors.New("missing stream id")
	}

	afterEventID = strings.TrimSpace(afterEventID)

	if _, err := d.getStreamMetadata(ctx, sessionID, streamID); err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return nil, ErrStreamNotFound
		}
		return nil, err
	}

	out := make(chan StreamEvent)
	go d.pumpSubscription(ctx, sessionID, streamID, afterEventID, out)
	return out, nil
}

func (d *DynamoStreamStore) StreamForEvent(ctx context.Context, sessionID, eventID string) (string, error) {
	ctx = normalizeStreamContext(ctx)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", errors.New("missing session id")
	}
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return "", errors.New("missing event id")
	}

	if err := d.assertSessionActive(ctx, sessionID); err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return "", ErrEventNotFound
		}
		return "", err
	}

	var record dynamoStreamRecord
	err := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		ConsistentRead().
		Where("SessionID", "=", sessionID).
		Where("EventID", "=", eventID).
		First(&record)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return "", ErrEventNotFound
		}
		return "", err
	}
	if record.Kind != dynamoStreamRecordKindEvent {
		return "", ErrEventNotFound
	}
	return record.StreamID, nil
}

func (d *DynamoStreamStore) DeleteSession(ctx context.Context, sessionID string) error {
	ctx = normalizeStreamContext(ctx)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return errors.New("missing session id")
	}

	if err := d.markSessionDeleted(ctx, sessionID); err != nil {
		return err
	}

	quietPasses := 0
	for {
		records, err := d.listSessionRecords(ctx, sessionID)
		if err != nil {
			if tableerrors.IsNotFound(err) {
				records = nil
			} else {
				return err
			}
		}

		deletedAny := false
		for _, record := range records {
			if record.EventID == dynamoStreamSessionStateEventID {
				continue
			}
			if err := d.deleteRecord(ctx, sessionID, record.EventID); err != nil {
				return err
			}
			deletedAny = true
		}

		if deletedAny {
			quietPasses = 0
			continue
		}

		quietPasses++
		if quietPasses >= dynamoStreamDeleteQuietPasses {
			return nil
		}

		if err := d.waitForPoll(ctx); err != nil {
			return err
		}
	}
}

func (d *DynamoStreamStore) pumpSubscription(ctx context.Context, sessionID, streamID, afterEventID string, out chan<- StreamEvent) {
	defer close(out)

	pollInterval := d.pollInterval
	if pollInterval <= 0 {
		pollInterval = defaultDynamoStreamPollInterval
	}

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	cursor := afterEventID
	for {
		records, err := d.loadEventsAfter(ctx, sessionID, cursor)
		if err != nil {
			return
		}

		for _, record := range records {
			cursor = record.EventID
			if record.StreamID != streamID {
				continue
			}

			payload := make([]byte, len(record.Data))
			copy(payload, record.Data)

			select {
			case <-ctx.Done():
				return
			case out <- StreamEvent{ID: record.EventID, Data: payload}:
			}
		}

		if len(records) >= d.queryBatchSize() {
			continue
		}

		closed, err := d.isStreamClosed(ctx, sessionID, streamID)
		if err != nil {
			if errors.Is(err, ErrStreamNotFound) {
				return
			}
			return
		}
		if closed {
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *DynamoStreamStore) loadEventsAfter(ctx context.Context, sessionID, afterEventID string) ([]dynamoStreamRecord, error) {
	query := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		ConsistentRead().
		Where("SessionID", "=", sessionID)

	if afterEventID == "" {
		query = query.Where("EventID", ">=", dynamoStreamFirstEventID)
	} else {
		query = query.Where("EventID", ">", afterEventID)
	}

	var records []dynamoStreamRecord
	err := query.
		OrderBy("EventID", "ASC").
		Limit(d.queryBatchSize()).
		All(&records)
	if err != nil {
		return nil, err
	}
	return records, nil
}

func (d *DynamoStreamStore) getStreamMetadata(ctx context.Context, sessionID, streamID string) (*dynamoStreamRecord, error) {
	if err := d.assertSessionActive(ctx, sessionID); err != nil {
		return nil, err
	}

	var record dynamoStreamRecord
	err := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		ConsistentRead().
		Where("SessionID", "=", sessionID).
		Where("EventID", "=", dynamoStreamMetadataEventID(streamID)).
		First(&record)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return nil, ErrStreamNotFound
		}
		return nil, err
	}
	if record.Kind != dynamoStreamRecordKindStream {
		return nil, ErrStreamNotFound
	}
	return &record, nil
}

func (d *DynamoStreamStore) isStreamClosed(ctx context.Context, sessionID, streamID string) (bool, error) {
	record, err := d.getStreamMetadata(ctx, sessionID, streamID)
	if err != nil {
		return false, err
	}
	return record.Closed, nil
}

func (d *DynamoStreamStore) touchSessionState(ctx context.Context, sessionID string) error {
	now := d.now().UTC()
	_, err := d.updateSessionState(ctx, sessionID, now, false)
	return err
}

func (d *DynamoStreamStore) nextSessionEventID(ctx context.Context, sessionID string, now time.Time) (string, error) {
	state, err := d.updateSessionState(ctx, sessionID, now, true)
	if err != nil {
		return "", err
	}
	return dynamoStreamEventIDForSeq(state.NextSeq), nil
}

func (d *DynamoStreamStore) updateSessionState(ctx context.Context, sessionID string, now time.Time, increment bool) (*dynamoStreamRecord, error) {
	query := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", sessionID).
		Where("EventID", "=", dynamoStreamSessionStateEventID)

	ub := query.UpdateBuilder().
		SetIfNotExists("Kind", nil, dynamoStreamRecordKindSession).
		SetIfNotExists("CreatedAt", nil, now).
		SetIfNotExists("Deleted", nil, false).
		Set("ExpiresAt", d.expiresAtUnix(now))

	if increment {
		ub = ub.Add("NextSeq", int64(1))
	}

	ub.ConditionNotExists("Deleted")
	ub.OrCondition("Deleted", "=", false)

	var state dynamoStreamRecord
	if err := ub.ExecuteWithResult(&state); err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, errDynamoStreamSessionDeleted
		}
		return nil, err
	}
	return &state, nil
}

func (d *DynamoStreamStore) assertSessionActive(ctx context.Context, sessionID string) error {
	state, err := d.getSessionState(ctx, sessionID)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if state != nil && state.Deleted {
		return errDynamoStreamSessionDeleted
	}
	return nil
}

func (d *DynamoStreamStore) getSessionState(ctx context.Context, sessionID string) (*dynamoStreamRecord, error) {
	var record dynamoStreamRecord
	err := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		ConsistentRead().
		Where("SessionID", "=", sessionID).
		Where("EventID", "=", dynamoStreamSessionStateEventID).
		First(&record)
	if err != nil {
		return nil, err
	}
	if record.Kind != dynamoStreamRecordKindSession {
		return nil, tableerrors.ErrItemNotFound
	}
	return &record, nil
}

func (d *DynamoStreamStore) markSessionDeleted(ctx context.Context, sessionID string) error {
	now := d.now().UTC()
	query := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", sessionID).
		Where("EventID", "=", dynamoStreamSessionStateEventID)

	return query.UpdateBuilder().
		SetIfNotExists("Kind", nil, dynamoStreamRecordKindSession).
		SetIfNotExists("CreatedAt", nil, now).
		SetIfNotExists("NextSeq", nil, int64(0)).
		Set("Deleted", true).
		Set("ExpiresAt", d.expiresAtUnix(now)).
		Execute()
}

func (d *DynamoStreamStore) listSessionRecords(ctx context.Context, sessionID string) ([]dynamoStreamRecord, error) {
	var records []dynamoStreamRecord
	err := d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		ConsistentRead().
		Where("SessionID", "=", sessionID).
		All(&records)
	if err != nil {
		return nil, err
	}
	return records, nil
}

func (d *DynamoStreamStore) deleteRecord(ctx context.Context, sessionID, eventID string) error {
	return d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", sessionID).
		Where("EventID", "=", eventID).
		Delete()
}

func (d *DynamoStreamStore) expiresAtUnix(now time.Time) int64 {
	return now.Add(streamTTL()).Unix()
}

func (d *DynamoStreamStore) queryBatchSize() int {
	if d.batchSize <= 0 {
		return defaultDynamoStreamBatchSize
	}
	return d.batchSize
}

func (d *DynamoStreamStore) waitForPoll(ctx context.Context) error {
	timer := time.NewTimer(d.effectivePollInterval())
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (d *DynamoStreamStore) effectivePollInterval() time.Duration {
	if d.pollInterval <= 0 {
		return defaultDynamoStreamPollInterval
	}
	return d.pollInterval
}

func dynamoStreamEventIDForSeq(seq int64) string {
	return fmt.Sprintf("%0*d", dynamoStreamEventIDWidth, seq)
}

func dynamoStreamMetadataEventID(streamID string) string {
	return dynamoStreamMetadataEventPrefix + streamID
}

func normalizeStreamContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func streamTTL() time.Duration {
	raw := strings.TrimSpace(os.Getenv(envStreamTTLMinutes))
	if raw != "" {
		if minutes, err := strconv.Atoi(raw); err == nil && minutes > 0 {
			return time.Duration(minutes) * time.Minute
		}
	}
	return time.Duration(defaultStreamTTLMinutes) * time.Minute
}
