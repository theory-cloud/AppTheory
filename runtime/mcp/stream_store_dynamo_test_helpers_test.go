package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

type fakeDynamoStreamSpillStore struct {
	mu        sync.Mutex
	objects   map[string][]byte
	gets      int
	beforePut func(string)
}

func newFakeDynamoStreamSpillStore() *fakeDynamoStreamSpillStore {
	return &fakeDynamoStreamSpillStore{objects: make(map[string][]byte)}
}

func (s *fakeDynamoStreamSpillStore) put(_ context.Context, key string, data []byte, _ int64, _ string) error {
	if s.beforePut != nil {
		s.beforePut(key)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	payload := make([]byte, len(data))
	copy(payload, data)
	s.objects[key] = payload
	return nil
}

func (s *fakeDynamoStreamSpillStore) get(_ context.Context, key string, maxBytes int) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.gets++
	payload, ok := s.objects[key]
	if !ok {
		return nil, errors.New("missing spill object")
	}
	if maxBytes > 0 && len(payload) > maxBytes {
		return nil, errors.New("stream spill object exceeds max event bytes")
	}
	out := make([]byte, len(payload))
	copy(out, payload)
	return out, nil
}

func (s *fakeDynamoStreamSpillStore) delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.objects, key)
	return nil
}

func (s *fakeDynamoStreamSpillStore) set(key string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload := make([]byte, len(data))
	copy(payload, data)
	s.objects[key] = payload
}

func (s *fakeDynamoStreamSpillStore) exists(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, ok := s.objects[key]
	return ok
}

func (s *fakeDynamoStreamSpillStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.objects)
}

func (s *fakeDynamoStreamSpillStore) getCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.gets
}

func (s *fakeDynamoStreamSpillStore) mustGet(t *testing.T, key string) []byte {
	t.Helper()

	payload, err := s.get(context.Background(), key, 0)
	require.NoError(t, err)
	return payload
}

type fakeMCPTableDB struct {
	mu                      sync.Mutex
	session                 map[string]sessionRecord
	streams                 map[string]map[string]dynamoStreamRecord
	beforeCreateStreamEvent func(dynamoStreamRecord)
	afterMatchStreamRecords func(*fakeMCPTableQuery, []dynamoStreamRecord)
}

func newFakeMCPTableDB() *fakeMCPTableDB {
	return &fakeMCPTableDB{
		session: make(map[string]sessionRecord),
		streams: make(map[string]map[string]dynamoStreamRecord),
	}
}

func (db *fakeMCPTableDB) Model(model any) tablecore.Query {
	return &fakeMCPTableQuery{
		db:    db,
		model: model,
	}
}

func (db *fakeMCPTableDB) Transaction(fn func(*tablecore.Tx) error) error {
	if fn == nil {
		return nil
	}
	return fn(nil)
}

func (db *fakeMCPTableDB) TransactWrite(ctx context.Context, fn func(tablecore.TransactionBuilder) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	builder := &fakeMCPTransactionBuilder{db: db}
	if fn != nil {
		if err := fn(builder); err != nil {
			return err
		}
	}
	return builder.execute(ctx)
}

func (db *fakeMCPTableDB) Migrate() error { return nil }

func (db *fakeMCPTableDB) AutoMigrate(models ...any) error { return nil }

func (db *fakeMCPTableDB) Close() error { return nil }

func (db *fakeMCPTableDB) WithContext(ctx context.Context) tablecore.DB { return db }

func (db *fakeMCPTableDB) getStreamRecord(sessionID, eventID string) (dynamoStreamRecord, bool) {
	db.mu.Lock()
	defer db.mu.Unlock()

	session := db.streams[sessionID]
	if session == nil {
		return dynamoStreamRecord{}, false
	}

	record, ok := session[eventID]
	return record, ok
}

func (db *fakeMCPTableDB) sessionStreamRecords(sessionID string) []dynamoStreamRecord {
	db.mu.Lock()
	defer db.mu.Unlock()

	session := db.streams[sessionID]
	if session == nil {
		return nil
	}

	out := make([]dynamoStreamRecord, 0, len(session))
	for _, record := range session {
		out = append(out, record)
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].EventID < out[j].EventID
	})
	return out
}

func (db *fakeMCPTableDB) countNonSessionStreamRecords(sessionID string) int {
	records := db.sessionStreamRecords(sessionID)
	count := 0
	for _, record := range records {
		if record.EventID == dynamoStreamSessionStateEventID {
			continue
		}
		count++
	}
	return count
}

func expireStreamRecord(t *testing.T, db *fakeMCPTableDB, sessionID, eventID string, expiresAt int64) {
	t.Helper()

	db.mu.Lock()
	defer db.mu.Unlock()

	session := db.streams[sessionID]
	require.NotNil(t, session)
	record, ok := session[eventID]
	require.True(t, ok)
	record.ExpiresAt = expiresAt
	session[eventID] = record
}

type fakeMCPTransactionBuilder struct {
	db              *fakeMCPTableDB
	conditionChecks []fakeMCPTransactionConditionCheck
	puts            []dynamoStreamRecord
	creates         []dynamoStreamRecord
}

type fakeMCPTransactionConditionCheck struct {
	record     dynamoStreamRecord
	conditions []tablecore.TransactCondition
}

func (b *fakeMCPTransactionBuilder) Put(model any, conditions ...tablecore.TransactCondition) tablecore.TransactionBuilder {
	record, ok := extractStreamRecord(model)
	if ok {
		b.puts = append(b.puts, record)
	}
	return b
}

func (b *fakeMCPTransactionBuilder) Create(model any, _ ...tablecore.TransactCondition) tablecore.TransactionBuilder {
	record, ok := extractStreamRecord(model)
	if ok {
		b.creates = append(b.creates, record)
	}
	return b
}

func (b *fakeMCPTransactionBuilder) Update(
	_ any,
	_ []string,
	_ ...tablecore.TransactCondition,
) tablecore.TransactionBuilder {
	return b
}

func (b *fakeMCPTransactionBuilder) UpdateWithBuilder(
	_ any,
	_ func(tablecore.UpdateBuilder) error,
	_ ...tablecore.TransactCondition,
) tablecore.TransactionBuilder {
	return b
}

func (b *fakeMCPTransactionBuilder) Delete(_ any, _ ...tablecore.TransactCondition) tablecore.TransactionBuilder {
	return b
}

func (b *fakeMCPTransactionBuilder) ConditionCheck(
	model any,
	conditions ...tablecore.TransactCondition,
) tablecore.TransactionBuilder {
	record, ok := extractStreamRecord(model)
	if ok {
		b.conditionChecks = append(b.conditionChecks, fakeMCPTransactionConditionCheck{
			record:     record,
			conditions: append([]tablecore.TransactCondition(nil), conditions...),
		})
	}
	return b
}

func (b *fakeMCPTransactionBuilder) WithContext(context.Context) tablecore.TransactionBuilder {
	return b
}

func (b *fakeMCPTransactionBuilder) Execute() error {
	return b.execute(context.Background())
}

func (b *fakeMCPTransactionBuilder) ExecuteWithContext(ctx context.Context) error {
	return b.execute(ctx)
}

func (b *fakeMCPTransactionBuilder) execute(ctx context.Context) error {
	for _, record := range append(append([]dynamoStreamRecord(nil), b.puts...), b.creates...) {
		if record.Kind == dynamoStreamRecordKindEvent && b.db.beforeCreateStreamEvent != nil {
			b.db.beforeCreateStreamEvent(record)
		}
	}

	if err := ctx.Err(); err != nil {
		return err
	}

	b.db.mu.Lock()
	defer b.db.mu.Unlock()

	for _, check := range b.conditionChecks {
		existing, exists := b.db.lockedStreamRecord(check.record.SessionID, check.record.EventID)
		for _, condition := range check.conditions {
			if !fakeMCPTransactConditionMet(existing, exists, condition) {
				return tableerrors.ErrConditionFailed
			}
		}
	}

	for _, record := range b.puts {
		if b.db.streams[record.SessionID] == nil {
			b.db.streams[record.SessionID] = make(map[string]dynamoStreamRecord)
		}
		b.db.streams[record.SessionID][record.EventID] = record
	}

	for _, record := range b.creates {
		if _, exists := b.db.lockedStreamRecord(record.SessionID, record.EventID); exists {
			return tableerrors.ErrConditionFailed
		}
		if b.db.streams[record.SessionID] == nil {
			b.db.streams[record.SessionID] = make(map[string]dynamoStreamRecord)
		}
		b.db.streams[record.SessionID][record.EventID] = record
	}

	return nil
}

func (db *fakeMCPTableDB) lockedStreamRecord(sessionID, eventID string) (dynamoStreamRecord, bool) {
	session := db.streams[sessionID]
	if session == nil {
		return dynamoStreamRecord{}, false
	}
	record, ok := session[eventID]
	return record, ok
}

type fakeMCPTableQuery struct {
	db         *fakeMCPTableDB
	model      any
	where      []fakeWhereClause
	orderField string
	order      string
	limit      int
}

type fakeWhereClause struct {
	field string
	op    string
	value any
}

type fakeMCPUpdateBuilder struct {
	query       *fakeMCPTableQuery
	sets        []fakeMCPUpdateOp
	setDefaults []fakeMCPUpdateOp
	adds        []fakeMCPUpdateOp
	conditions  []fakeMCPUpdateCondition
}

type fakeMCPUpdateOp struct {
	field string
	value any
}

type fakeMCPUpdateCondition struct {
	field    string
	operator string
	value    any
	logic    string
}

func (q *fakeMCPTableQuery) Where(field string, op string, value any) tablecore.Query {
	q.where = append(q.where, fakeWhereClause{field: field, op: op, value: value})
	return q
}

func (q *fakeMCPTableQuery) Index(indexName string) tablecore.Query { return q }

func (q *fakeMCPTableQuery) Filter(field string, op string, value any) tablecore.Query { return q }

func (q *fakeMCPTableQuery) OrFilter(field string, op string, value any) tablecore.Query { return q }

func (q *fakeMCPTableQuery) FilterGroup(fn func(tablecore.Query)) tablecore.Query {
	if fn != nil {
		fn(q)
	}
	return q
}

func (q *fakeMCPTableQuery) OrFilterGroup(fn func(tablecore.Query)) tablecore.Query {
	if fn != nil {
		fn(q)
	}
	return q
}

func (q *fakeMCPTableQuery) IfNotExists() tablecore.Query { return q }

func (q *fakeMCPTableQuery) IfExists() tablecore.Query { return q }

func (q *fakeMCPTableQuery) WithCondition(field, operator string, value any) tablecore.Query {
	return q
}

func (q *fakeMCPTableQuery) WithConditionExpression(expr string, values map[string]any) tablecore.Query {
	return q
}

func (q *fakeMCPTableQuery) OrderBy(field string, order string) tablecore.Query {
	q.orderField = field
	q.order = order
	return q
}

func (q *fakeMCPTableQuery) Limit(limit int) tablecore.Query {
	q.limit = limit
	return q
}

func (q *fakeMCPTableQuery) Offset(offset int) tablecore.Query { return q }

func (q *fakeMCPTableQuery) Select(fields ...string) tablecore.Query { return q }

func (q *fakeMCPTableQuery) ConsistentRead() tablecore.Query { return q }

func (q *fakeMCPTableQuery) WithRetry(maxRetries int, initialDelay time.Duration) tablecore.Query {
	return q
}

func (b *fakeMCPUpdateBuilder) Set(field string, value any) tablecore.UpdateBuilder {
	b.sets = append(b.sets, fakeMCPUpdateOp{field: field, value: value})
	return b
}

func (b *fakeMCPUpdateBuilder) SetIfNotExists(field string, value any, defaultValue any) tablecore.UpdateBuilder {
	b.setDefaults = append(b.setDefaults, fakeMCPUpdateOp{field: field, value: defaultValue})
	return b
}

func (b *fakeMCPUpdateBuilder) Add(field string, value any) tablecore.UpdateBuilder {
	b.adds = append(b.adds, fakeMCPUpdateOp{field: field, value: value})
	return b
}

func (b *fakeMCPUpdateBuilder) Increment(field string) tablecore.UpdateBuilder {
	return b.Add(field, int64(1))
}

func (b *fakeMCPUpdateBuilder) Decrement(field string) tablecore.UpdateBuilder {
	return b.Add(field, int64(-1))
}

func (b *fakeMCPUpdateBuilder) Remove(field string) tablecore.UpdateBuilder { return b }

func (b *fakeMCPUpdateBuilder) Delete(field string, value any) tablecore.UpdateBuilder { return b }

func (b *fakeMCPUpdateBuilder) AppendToList(field string, values any) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) PrependToList(field string, values any) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) RemoveFromListAt(field string, index int) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) SetListElement(field string, index int, value any) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) Condition(field string, operator string, value any) tablecore.UpdateBuilder {
	b.conditions = append(b.conditions, fakeMCPUpdateCondition{
		field:    field,
		operator: operator,
		value:    value,
		logic:    "AND",
	})
	return b
}

func (b *fakeMCPUpdateBuilder) OrCondition(field string, operator string, value any) tablecore.UpdateBuilder {
	b.conditions = append(b.conditions, fakeMCPUpdateCondition{
		field:    field,
		operator: operator,
		value:    value,
		logic:    "OR",
	})
	return b
}

func (b *fakeMCPUpdateBuilder) ConditionExists(field string) tablecore.UpdateBuilder {
	return b.Condition(field, "attribute_exists", nil)
}

func (b *fakeMCPUpdateBuilder) ConditionNotExists(field string) tablecore.UpdateBuilder {
	return b.Condition(field, "attribute_not_exists", nil)
}

func (b *fakeMCPUpdateBuilder) ConditionVersion(currentVersion int64) tablecore.UpdateBuilder {
	return b.Condition("Version", "=", currentVersion)
}

func (b *fakeMCPUpdateBuilder) ReturnValues(option string) tablecore.UpdateBuilder { return b }

func (b *fakeMCPUpdateBuilder) Execute() error {
	return b.execute(nil)
}

func (b *fakeMCPUpdateBuilder) ExecuteWithResult(result any) error {
	return b.execute(result)
}

func (b *fakeMCPUpdateBuilder) execute(result any) error {
	if classifyMCPModel(b.query.model) != fakeMCPModelStream {
		return errors.New("unsupported model")
	}

	sessionID, ok := b.query.whereString("SessionID", "=")
	if !ok {
		return errors.New("missing session id")
	}
	eventID, ok := b.query.whereString("EventID", "=")
	if !ok {
		return errors.New("missing event id")
	}

	b.query.db.mu.Lock()
	defer b.query.db.mu.Unlock()

	session := b.query.db.streams[sessionID]
	existing, exists := dynamoStreamRecord{}, false
	if session != nil {
		existing, exists = session[eventID]
	}

	if !b.conditionsMet(existing, exists) {
		return tableerrors.ErrConditionFailed
	}

	updated := existing
	if !exists {
		updated.SessionID = sessionID
		updated.EventID = eventID
	}

	for _, op := range b.setDefaults {
		if fakeMCPStreamFieldExists(existing, exists, op.field) {
			continue
		}
		if err := fakeMCPSetStreamField(&updated, op.field, op.value); err != nil {
			return err
		}
	}

	for _, op := range b.adds {
		if err := fakeMCPAddStreamField(&updated, op.field, op.value); err != nil {
			return err
		}
	}

	for _, op := range b.sets {
		if err := fakeMCPSetStreamField(&updated, op.field, op.value); err != nil {
			return err
		}
	}

	if b.query.db.streams[sessionID] == nil {
		b.query.db.streams[sessionID] = make(map[string]dynamoStreamRecord)
	}
	b.query.db.streams[sessionID][eventID] = updated

	if result != nil {
		return assignStreamRecord(result, updated)
	}
	return nil
}

func (b *fakeMCPUpdateBuilder) conditionsMet(record dynamoStreamRecord, exists bool) bool {
	if len(b.conditions) == 0 {
		return true
	}

	result := false
	for i, condition := range b.conditions {
		matched := fakeMCPMatchStreamCondition(record, exists, condition)
		if i == 0 {
			result = matched
			continue
		}
		if condition.logic == "OR" {
			result = result || matched
			continue
		}
		result = result && matched
	}
	return result
}

func (q *fakeMCPTableQuery) First(dest any) error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelSession:
		record, ok := q.lookupSession()
		if !ok {
			return tableerrors.ErrItemNotFound
		}
		return assignSessionRecord(dest, record)
	case fakeMCPModelStream:
		records := q.matchStreamRecords()
		if len(records) == 0 {
			return tableerrors.ErrItemNotFound
		}
		return assignStreamRecord(dest, records[0])
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) All(dest any) error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelStream:
		return assignStreamRecords(dest, q.matchStreamRecords())
	case fakeMCPModelSession:
		record, ok := q.lookupSession()
		if !ok {
			return assignSessionRecords(dest, nil)
		}
		return assignSessionRecords(dest, []sessionRecord{record})
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) AllPaginated(dest any) (*tablecore.PaginatedResult, error) {
	return nil, errors.New("not implemented")
}

func (q *fakeMCPTableQuery) Count() (int64, error) {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelStream:
		return int64(len(q.matchStreamRecords())), nil
	case fakeMCPModelSession:
		if _, ok := q.lookupSession(); ok {
			return 1, nil
		}
		return 0, nil
	default:
		return 0, errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) Create() error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelSession:
		record, ok := extractSessionRecord(q.model)
		if !ok {
			return errors.New("invalid session record")
		}
		q.db.mu.Lock()
		q.db.session[record.SessionID] = record
		q.db.mu.Unlock()
		return nil
	case fakeMCPModelStream:
		record, ok := extractStreamRecord(q.model)
		if !ok {
			return errors.New("invalid stream record")
		}
		if record.Kind == dynamoStreamRecordKindEvent && q.db.beforeCreateStreamEvent != nil {
			q.db.beforeCreateStreamEvent(record)
		}
		q.db.mu.Lock()
		if q.db.streams[record.SessionID] == nil {
			q.db.streams[record.SessionID] = make(map[string]dynamoStreamRecord)
		}
		q.db.streams[record.SessionID][record.EventID] = record
		q.db.mu.Unlock()
		return nil
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) CreateOrUpdate() error {
	return q.Create()
}

func (q *fakeMCPTableQuery) Update(fields ...string) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) UpdateBuilder() tablecore.UpdateBuilder {
	return &fakeMCPUpdateBuilder{query: q}
}

func (q *fakeMCPTableQuery) Delete() error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelSession:
		sessionID, ok := q.whereString("SessionID", "=")
		if !ok {
			return errors.New("missing session id")
		}
		q.db.mu.Lock()
		delete(q.db.session, sessionID)
		q.db.mu.Unlock()
		return nil
	case fakeMCPModelStream:
		sessionID, ok := q.whereString("SessionID", "=")
		if !ok {
			return errors.New("missing session id")
		}
		eventID, ok := q.whereString("EventID", "=")
		if !ok {
			return errors.New("missing event id")
		}
		q.db.mu.Lock()
		if q.db.streams[sessionID] != nil {
			delete(q.db.streams[sessionID], eventID)
			if len(q.db.streams[sessionID]) == 0 {
				delete(q.db.streams, sessionID)
			}
		}
		q.db.mu.Unlock()
		return nil
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) Scan(dest any) error { return errors.New("not implemented") }

func (q *fakeMCPTableQuery) ParallelScan(segment int32, totalSegments int32) tablecore.Query {
	return q
}

func (q *fakeMCPTableQuery) ScanAllSegments(dest any, totalSegments int32) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchGet(keys []any, dest any) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchGetWithOptions(keys []any, dest any, opts *tablecore.BatchGetOptions) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchGetBuilder() tablecore.BatchGetBuilder { return nil }

func (q *fakeMCPTableQuery) BatchCreate(items any) error { return errors.New("not implemented") }

func (q *fakeMCPTableQuery) BatchDelete(keys []any) error { return errors.New("not implemented") }

func (q *fakeMCPTableQuery) Cursor(cursor string) tablecore.Query { return q }

func (q *fakeMCPTableQuery) SetCursor(cursor string) error { return nil }

func (q *fakeMCPTableQuery) WithContext(ctx context.Context) tablecore.Query { return q }

func (q *fakeMCPTableQuery) BatchWrite(putItems []any, deleteKeys []any) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchUpdateWithOptions(items []any, fields []string, options ...any) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) lookupSession() (sessionRecord, bool) {
	sessionID, ok := q.whereString("SessionID", "=")
	if !ok {
		return sessionRecord{}, false
	}

	q.db.mu.Lock()
	defer q.db.mu.Unlock()

	record, ok := q.db.session[sessionID]
	return record, ok
}

func (q *fakeMCPTableQuery) matchStreamRecords() []dynamoStreamRecord {
	sessionID, ok := q.whereString("SessionID", "=")
	if !ok {
		return nil
	}

	q.db.mu.Lock()
	session := q.db.streams[sessionID]
	if session == nil {
		q.db.mu.Unlock()
		return nil
	}

	out := make([]dynamoStreamRecord, 0, len(session))
	for _, record := range session {
		if q.matchesStreamRecord(record) {
			out = append(out, record)
		}
	}
	q.db.mu.Unlock()

	sort.Slice(out, func(i, j int) bool {
		if q.orderField != "EventID" {
			return out[i].EventID < out[j].EventID
		}
		if strings.EqualFold(q.order, "DESC") {
			return out[i].EventID > out[j].EventID
		}
		return out[i].EventID < out[j].EventID
	})

	if q.limit > 0 && len(out) > q.limit {
		out = out[:q.limit]
	}

	if hook := q.db.afterMatchStreamRecords; hook != nil {
		records := append([]dynamoStreamRecord(nil), out...)
		hook(q, records)
	}

	return out
}

func (q *fakeMCPTableQuery) matchesStreamRecord(record dynamoStreamRecord) bool {
	for _, clause := range q.where {
		want, ok := clause.value.(string)
		if !ok {
			return false
		}

		switch clause.field {
		case "SessionID":
			if !compareString(record.SessionID, clause.op, want) {
				return false
			}
		case "EventID":
			if !compareString(record.EventID, clause.op, want) {
				return false
			}
		default:
			return false
		}
	}

	return true
}

func (q *fakeMCPTableQuery) whereString(field, op string) (string, bool) {
	for _, clause := range q.where {
		if clause.field == field && clause.op == op {
			value, ok := clause.value.(string)
			return value, ok
		}
	}
	return "", false
}

func fakeMCPMatchStreamCondition(record dynamoStreamRecord, exists bool, condition fakeMCPUpdateCondition) bool {
	switch condition.operator {
	case "attribute_exists":
		return fakeMCPStreamFieldExists(record, exists, condition.field)
	case "attribute_not_exists":
		return !fakeMCPStreamFieldExists(record, exists, condition.field)
	case "=":
		value, ok := fakeMCPStreamFieldValue(record, exists, condition.field)
		if !ok {
			return false
		}
		return reflect.DeepEqual(value, condition.value)
	default:
		return false
	}
}

func fakeMCPTransactConditionMet(record dynamoStreamRecord, exists bool, condition tablecore.TransactCondition) bool {
	kind := condition.Kind
	if kind == "" {
		kind = tablecore.TransactConditionKindField
	}

	switch kind {
	case tablecore.TransactConditionKindField:
		return fakeMCPMatchStreamCondition(record, exists, fakeMCPUpdateCondition{
			field:    condition.Field,
			operator: condition.Operator,
			value:    condition.Value,
		})
	case tablecore.TransactConditionKindPrimaryKeyExists:
		return exists
	case tablecore.TransactConditionKindPrimaryKeyNotExists:
		return !exists
	default:
		return false
	}
}

func fakeMCPStreamFieldExists(record dynamoStreamRecord, exists bool, field string) bool {
	if !exists {
		return false
	}

	switch field {
	case "SessionID", "EventID":
		return true
	case "StreamID":
		return record.StreamID != ""
	case "Kind":
		return record.Kind != ""
	case "CreatedAt":
		return !record.CreatedAt.IsZero()
	case "ExpiresAt":
		return record.ExpiresAt != 0
	case "DataBytes":
		return record.DataBytes != 0
	case "DataSHA256":
		return record.DataSHA256 != ""
	case "DataRef":
		return record.DataRef != ""
	case "DataStorage":
		return record.DataStorage != ""
	case "NextSeq":
		return record.Kind == dynamoStreamRecordKindSession
	case "Closed":
		return record.Kind == dynamoStreamRecordKindStream
	case "Deleted":
		return record.Kind == dynamoStreamRecordKindSession
	case "Data":
		return len(record.Data) > 0
	default:
		return false
	}
}

func fakeMCPStreamFieldValue(record dynamoStreamRecord, exists bool, field string) (any, bool) {
	if !fakeMCPStreamFieldExists(record, exists, field) {
		return nil, false
	}

	switch field {
	case "SessionID":
		return record.SessionID, true
	case "EventID":
		return record.EventID, true
	case "StreamID":
		return record.StreamID, true
	case "Kind":
		return record.Kind, true
	case "CreatedAt":
		return record.CreatedAt, true
	case "ExpiresAt":
		return record.ExpiresAt, true
	case "DataBytes":
		return record.DataBytes, true
	case "DataSHA256":
		return record.DataSHA256, true
	case "DataRef":
		return record.DataRef, true
	case "DataStorage":
		return record.DataStorage, true
	case "NextSeq":
		return record.NextSeq, true
	case "Closed":
		return record.Closed, true
	case "Deleted":
		return record.Deleted, true
	case "Data":
		return record.Data, true
	default:
		return nil, false
	}
}

func fakeMCPSetStreamField(record *dynamoStreamRecord, field string, value any) error {
	if record == nil {
		return errors.New("missing record")
	}

	switch field {
	case "SessionID":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected SessionID to be a string")
		}
		record.SessionID = v
	case "EventID":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected EventID to be a string")
		}
		record.EventID = v
	case "StreamID":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected StreamID to be a string")
		}
		record.StreamID = v
	case "Kind":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected Kind to be a string")
		}
		record.Kind = v
	case "CreatedAt":
		v, ok := value.(time.Time)
		if !ok {
			return errors.New("expected CreatedAt to be a time")
		}
		record.CreatedAt = v
	case "ExpiresAt":
		v, ok := fakeMCPInt64(value)
		if !ok {
			return errors.New("expected ExpiresAt to be numeric")
		}
		record.ExpiresAt = v
	case "DataBytes":
		v, ok := fakeMCPInt64(value)
		if !ok {
			return errors.New("expected DataBytes to be numeric")
		}
		record.DataBytes = v
	case "DataSHA256":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected DataSHA256 to be a string")
		}
		record.DataSHA256 = v
	case "DataRef":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected DataRef to be a string")
		}
		record.DataRef = v
	case "DataStorage":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected DataStorage to be a string")
		}
		record.DataStorage = v
	case "NextSeq":
		v, ok := fakeMCPInt64(value)
		if !ok {
			return errors.New("expected NextSeq to be numeric")
		}
		record.NextSeq = v
	case "Closed":
		v, ok := value.(bool)
		if !ok {
			return errors.New("expected Closed to be a bool")
		}
		record.Closed = v
	case "Deleted":
		v, ok := value.(bool)
		if !ok {
			return errors.New("expected Deleted to be a bool")
		}
		record.Deleted = v
	case "Data":
		v, ok := value.(json.RawMessage)
		if !ok {
			return errors.New("expected Data to be json.RawMessage")
		}
		record.Data = append(record.Data[:0], v...)
	default:
		return errors.New("unsupported stream field")
	}
	return nil
}

func fakeMCPAddStreamField(record *dynamoStreamRecord, field string, value any) error {
	delta, ok := fakeMCPInt64(value)
	if !ok {
		return errors.New("expected numeric delta")
	}

	switch field {
	case "NextSeq":
		record.NextSeq += delta
	default:
		return errors.New("unsupported add field")
	}
	return nil
}

func fakeMCPInt64(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int8:
		return int64(v), true
	case int16:
		return int64(v), true
	case int32:
		return int64(v), true
	case int64:
		return v, true
	default:
		return 0, false
	}
}

func compareString(got, op, want string) bool {
	switch op {
	case "=":
		return got == want
	case ">":
		return got > want
	case ">=":
		return got >= want
	case "<":
		return got < want
	case "<=":
		return got <= want
	default:
		return false
	}
}

type fakeMCPModel int

const (
	fakeMCPModelUnknown fakeMCPModel = iota
	fakeMCPModelSession
	fakeMCPModelStream
)

func classifyMCPModel(model any) fakeMCPModel {
	switch model.(type) {
	case sessionRecord, *sessionRecord:
		return fakeMCPModelSession
	case dynamoStreamRecord, *dynamoStreamRecord:
		return fakeMCPModelStream
	default:
		return fakeMCPModelUnknown
	}
}

func extractSessionRecord(model any) (sessionRecord, bool) {
	switch v := model.(type) {
	case sessionRecord:
		return v, true
	case *sessionRecord:
		if v == nil {
			return sessionRecord{}, false
		}
		return *v, true
	default:
		return sessionRecord{}, false
	}
}

func extractStreamRecord(model any) (dynamoStreamRecord, bool) {
	switch v := model.(type) {
	case dynamoStreamRecord:
		return v, true
	case *dynamoStreamRecord:
		if v == nil {
			return dynamoStreamRecord{}, false
		}
		return *v, true
	default:
		return dynamoStreamRecord{}, false
	}
}

func assignSessionRecord(dest any, record sessionRecord) error {
	out, ok := dest.(*sessionRecord)
	if !ok {
		return errors.New("expected *sessionRecord")
	}
	*out = record
	return nil
}

func assignSessionRecords(dest any, records []sessionRecord) error {
	out, ok := dest.(*[]sessionRecord)
	if !ok {
		return errors.New("expected *[]sessionRecord")
	}
	*out = append((*out)[:0], records...)
	return nil
}

func assignStreamRecord(dest any, record dynamoStreamRecord) error {
	out, ok := dest.(*dynamoStreamRecord)
	if !ok {
		return errors.New("expected *dynamoStreamRecord")
	}
	*out = record
	return nil
}

func assignStreamRecords(dest any, records []dynamoStreamRecord) error {
	out, ok := dest.(*[]dynamoStreamRecord)
	if !ok {
		return errors.New("expected *[]dynamoStreamRecord")
	}
	*out = append((*out)[:0], records...)
	return nil
}
