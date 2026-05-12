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
	SessionID   string          `theorydb:"pk,attr:sessionId" json:"sessionId"`
	EventID     string          `theorydb:"sk,attr:eventId" json:"eventId"`
	StreamID    string          `theorydb:"attr:streamId" json:"streamId"`
	Kind        string          `theorydb:"attr:kind" json:"kind"`
	CreatedAt   time.Time       `theorydb:"attr:createdAt" json:"createdAt"`
	ExpiresAt   int64           `theorydb:"ttl,attr:expiresAt" json:"expiresAt"`
	DataBytes   int64           `theorydb:"attr:dataBytes,omitempty" json:"dataBytes,omitempty"`
	DataSHA256  string          `theorydb:"attr:dataSha256,omitempty" json:"dataSha256,omitempty"`
	DataRef     string          `theorydb:"attr:dataRef,omitempty" json:"dataRef,omitempty"`
	DataStorage string          `theorydb:"attr:dataStorage,omitempty" json:"dataStorage,omitempty"`
	NextSeq     int64           `theorydb:"attr:nextSeq,omitempty" json:"nextSeq,omitempty"`
	Closed      bool            `theorydb:"attr:closed,omitempty" json:"closed,omitempty"`
	Deleted     bool            `theorydb:"attr:deleted,omitempty" json:"deleted,omitempty"`
	Data        json.RawMessage `theorydb:"attr:data,omitempty" json:"data,omitempty"`
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
	db             tablecore.DB
	idGen          apptheory.IDGenerator
	now            func() time.Time
	pollInterval   time.Duration
	batchSize      int
	spillStore     dynamoStreamSpillStore
	inlineMaxBytes int
	maxEventBytes  int
}

var _ StreamStore = (*DynamoStreamStore)(nil)

var errDynamoStreamSessionDeleted = errors.New("stream session deleted")

type dynamoStreamTransactWriter interface {
	TransactWrite(context.Context, func(tablecore.TransactionBuilder) error) error
}

// NewDynamoStreamStore creates a DynamoDB-backed StreamStore.
func NewDynamoStreamStore(db tablecore.DB) StreamStore {
	return &DynamoStreamStore{
		db:             db,
		idGen:          apptheory.RandomIDGenerator{},
		now:            func() time.Time { return time.Now().UTC() },
		pollInterval:   defaultDynamoStreamPollInterval,
		batchSize:      defaultDynamoStreamBatchSize,
		spillStore:     newDynamoStreamSpillStoreFromEnv(),
		inlineMaxBytes: dynamoStreamSpillInlineMaxBytes(),
		maxEventBytes:  dynamoStreamMaxEventBytes(),
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
	sessionID, streamID, meta, err := d.appendTarget(ctx, sessionID, streamID)
	if err != nil {
		return "", err
	}
	if preflightErr := d.preflightStreamPayloadSize(data); preflightErr != nil {
		return "", preflightErr
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

	if activeErr := d.requireAppendSessionActive(ctx, sessionID); activeErr != nil {
		return "", activeErr
	}

	expiresAt := d.expiresAtUnix(now)
	meta.ExpiresAt = expiresAt
	record, spilled, err := d.newStreamEventRecord(ctx, sessionID, streamID, eventID, payload, now, expiresAt)
	if err != nil {
		return "", err
	}

	if err := d.createStreamEventRecord(ctx, sessionID, meta, record, spilled); err != nil {
		return "", err
	}
	return eventID, nil
}

func (d *DynamoStreamStore) appendTarget(
	ctx context.Context,
	sessionID string,
	streamID string,
) (string, string, *dynamoStreamRecord, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", "", nil, errors.New("missing session id")
	}
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return "", "", nil, errors.New("missing stream id")
	}

	meta, err := d.getStreamMetadata(ctx, sessionID, streamID)
	if err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return "", "", nil, ErrStreamNotFound
		}
		return "", "", nil, err
	}
	return sessionID, streamID, meta, nil
}

func (d *DynamoStreamStore) preflightStreamPayloadSize(data json.RawMessage) error {
	if d.maxEventBytes > 0 && len(data) > d.maxEventBytes {
		return ErrStreamEventTooLarge
	}
	if d.spillStore == nil && len(data) > defaultDynamoStreamMaxInlineBytes {
		return ErrStreamEventTooLarge
	}
	return nil
}

func (d *DynamoStreamStore) requireAppendSessionActive(ctx context.Context, sessionID string) error {
	if err := d.assertSessionActive(ctx, sessionID); err != nil {
		if errors.Is(err, errDynamoStreamSessionDeleted) {
			return ErrStreamNotFound
		}
		return err
	}
	return nil
}

func (d *DynamoStreamStore) newStreamEventRecord(
	ctx context.Context,
	sessionID string,
	streamID string,
	eventID string,
	payload []byte,
	now time.Time,
	expiresAt int64,
) (*dynamoStreamRecord, bool, error) {
	record := &dynamoStreamRecord{
		SessionID:  sessionID,
		EventID:    eventID,
		StreamID:   streamID,
		Kind:       dynamoStreamRecordKindEvent,
		CreatedAt:  now,
		ExpiresAt:  expiresAt,
		DataBytes:  int64(len(payload)),
		DataSHA256: dynamoStreamPayloadSHA256(payload),
	}

	spilled := false
	if d.shouldSpillStreamData(len(payload)) {
		ref, err := d.spillStreamData(ctx, sessionID, eventID, payload, expiresAt, record.DataSHA256)
		if err != nil {
			return nil, false, err
		}
		spilled = true
		record.DataStorage = dynamoStreamDataStorageS3
		record.DataRef = ref
	} else {
		record.Data = payload
	}

	return record, spilled, nil
}

func (d *DynamoStreamStore) createStreamEventRecord(
	ctx context.Context,
	sessionID string,
	meta *dynamoStreamRecord,
	record *dynamoStreamRecord,
	spilled bool,
) error {
	if err := d.createActiveSessionStreamEvent(ctx, sessionID, meta, record); err != nil {
		return d.cleanupSpilledStreamEvent(ctx, record, spilled, err)
	}
	return nil
}

func (d *DynamoStreamStore) createActiveSessionStreamEvent(
	ctx context.Context,
	sessionID string,
	meta *dynamoStreamRecord,
	record *dynamoStreamRecord,
) error {
	if txDB, ok := d.db.(dynamoStreamTransactWriter); ok {
		state := &dynamoStreamRecord{
			SessionID: sessionID,
			EventID:   dynamoStreamSessionStateEventID,
		}
		err := txDB.TransactWrite(ctx, func(tx tablecore.TransactionBuilder) error {
			tx.ConditionCheck(state, tablecore.TransactCondition{
				Kind:     tablecore.TransactConditionKindField,
				Field:    "Deleted",
				Operator: "=",
				Value:    false,
			})
			tx.Put(meta)
			tx.Create(record)
			return nil
		})
		if err != nil {
			if tableerrors.IsConditionFailed(err) {
				return ErrStreamNotFound
			}
			return err
		}
		return nil
	}

	if activeErr := d.requireAppendSessionActive(ctx, sessionID); activeErr != nil {
		return activeErr
	}
	if metaErr := d.db.Model(meta).WithContext(ctx).CreateOrUpdate(); metaErr != nil {
		return metaErr
	}
	if activeErr := d.requireAppendSessionActive(ctx, sessionID); activeErr != nil {
		return activeErr
	}
	return d.db.Model(record).WithContext(ctx).Create()
}

func (d *DynamoStreamStore) cleanupSpilledStreamEvent(
	ctx context.Context,
	record *dynamoStreamRecord,
	spilled bool,
	appendErr error,
) error {
	if spilled && record != nil {
		if cleanupErr := d.spillStore.delete(ctx, record.DataRef); cleanupErr != nil {
			return errors.Join(appendErr, cleanupErr)
		}
	}
	return appendErr
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
			if err := d.deleteRecord(ctx, record); err != nil {
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
	drainAfterClose := false
	for {
		records, err := d.loadEventsAfter(ctx, sessionID, cursor)
		if err != nil {
			return
		}

		var ok bool
		cursor, ok = d.forwardDynamoSubscriptionEvents(ctx, streamID, cursor, records, out)
		if !ok {
			return
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
			if drainAfterClose {
				return
			}
			// The stream may have closed after the previous query but before we
			// observed the metadata update. Drain one immediate post-close pass so
			// we do not drop the final result event.
			drainAfterClose = true
			continue
		}
		if drainAfterClose {
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *DynamoStreamStore) forwardDynamoSubscriptionEvents(
	ctx context.Context,
	streamID string,
	startCursor string,
	records []dynamoStreamRecord,
	out chan<- StreamEvent,
) (string, bool) {
	cursor := startCursor
	for _, record := range records {
		cursor = record.EventID
		if record.StreamID != streamID {
			continue
		}

		payload, err := d.streamRecordData(ctx, record)
		if err != nil {
			return cursor, false
		}

		select {
		case <-ctx.Done():
			return cursor, false
		case out <- StreamEvent{ID: record.EventID, Data: payload}:
		}
	}

	return cursor, true
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

func (d *DynamoStreamStore) deleteRecord(ctx context.Context, record dynamoStreamRecord) error {
	if record.DataRef != "" {
		if d.spillStore == nil {
			return errors.New("stream spill store not configured")
		}
		if err := d.spillStore.delete(ctx, record.DataRef); err != nil {
			return err
		}
	}

	return d.db.Model(&dynamoStreamRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", record.SessionID).
		Where("EventID", "=", record.EventID).
		Delete()
}

func (d *DynamoStreamStore) shouldSpillStreamData(size int) bool {
	return d.spillStore != nil && size > clampDynamoStreamSpillInlineMaxBytes(d.inlineMaxBytes)
}

func (d *DynamoStreamStore) spillStreamData(
	ctx context.Context,
	sessionID string,
	eventID string,
	payload []byte,
	expiresAt int64,
	sha256Hex string,
) (string, error) {
	if s3Store, ok := d.spillStore.(*dynamoStreamS3SpillStore); ok {
		key := s3Store.objectKey(sessionID, eventID)
		if err := s3Store.put(ctx, key, payload, expiresAt, sha256Hex); err != nil {
			return "", err
		}
		return key, nil
	}

	key := "sessions/" + dynamoStreamPayloadSHA256([]byte(sessionID)) + "/events/" + eventID + ".json"
	if err := d.spillStore.put(ctx, key, payload, expiresAt, sha256Hex); err != nil {
		return "", err
	}
	return key, nil
}

func (d *DynamoStreamStore) streamRecordData(ctx context.Context, record dynamoStreamRecord) (json.RawMessage, error) {
	if record.DataStorage == dynamoStreamDataStorageS3 || record.DataRef != "" {
		if d.spillStore == nil {
			return nil, errors.New("stream spill store not configured")
		}
		payload, err := d.spillStore.get(ctx, record.DataRef)
		if err != nil {
			return nil, err
		}
		if record.DataBytes > 0 && int64(len(payload)) != record.DataBytes {
			return nil, errors.New("stream spill payload size mismatch")
		}
		if record.DataSHA256 != "" && dynamoStreamPayloadSHA256(payload) != record.DataSHA256 {
			return nil, errors.New("stream spill payload hash mismatch")
		}
		out := make([]byte, len(payload))
		copy(out, payload)
		return json.RawMessage(out), nil
	}

	payload := make([]byte, len(record.Data))
	copy(payload, record.Data)
	return json.RawMessage(payload), nil
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
