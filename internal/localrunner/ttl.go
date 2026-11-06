package localrunner

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// DynamoDB Time to Live is performed by DynamoDB itself in AWS: an item whose
// TTL attribute is a number no later than the current time is deleted in the
// background, and the delete appears on the table's stream with a service
// userIdentity. DynamoDB Local accepts the TTL configuration but never expires
// an item, so the runner performs the delete on the run clock: it scans the
// table, deletes the expired item through DynamoDB Local (which produces the
// real stream record), and remembers the key so the stream deliverer can attach
// the documented userIdentity to the REMOVE record.
//
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-streams.html
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html
//
// The wall-clock timing of AWS's background TTL process is a docs/125 true
// limit; the local expiry runs on env.Clock either way, and a test clock makes
// it deterministic.

const (
	ttlSweepInterval = time.Second
	// ttlMarkerLifetime bounds how long a TTL delete is remembered for the
	// stream record that follows it. A local stream record is read within one
	// poll, so a few minutes is generous; an entry older than this is dropped
	// instead of mislabelling a later manual delete.
	ttlMarkerLifetime = 10 * time.Minute
)

// ttlTracker records the keys the runner's TTL sweep deleted.
type ttlTracker struct {
	mu      sync.Mutex
	deleted map[string]time.Time
}

func newTTLTracker() *ttlTracker {
	return &ttlTracker{deleted: map[string]time.Time{}}
}

// mark records one TTL delete.
func (t *ttlTracker) mark(table string, keys map[string]any, now time.Time) {
	if t == nil {
		return
	}
	key := ttlKeySignature(table, keys)
	if key == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.deleted[key] = now
}

// unmark drops a marker whose delete did not happen, so a later manual delete
// of the same key is not mislabelled as the TTL delete.
func (t *ttlTracker) unmark(table string, keys map[string]any) {
	if t == nil {
		return
	}
	key := ttlKeySignature(table, keys)
	if key == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.deleted, key)
}

// take reports whether a REMOVE record is the TTL delete of that key and
// consumes the marker.
func (t *ttlTracker) take(table string, keys map[string]any, now time.Time) bool {
	if t == nil {
		return false
	}
	key := ttlKeySignature(table, keys)
	if key == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	at, ok := t.deleted[key]
	if !ok {
		return false
	}
	delete(t.deleted, key)
	return now.Sub(at) <= ttlMarkerLifetime
}

func ttlKeySignature(table string, keys map[string]any) string {
	if table == "" || len(keys) == 0 {
		return ""
	}
	encoded, err := json.Marshal(keys)
	if err != nil {
		return ""
	}
	return table + "\x00" + string(encoded)
}

// ttlTable is one provisioned table with TTL enabled.
type ttlTable struct {
	Name      string
	Attribute string
	KeySchema []keySchemaAttribute
}

// startTTLSweeper starts the TTL sweep for every provisioned table that enabled
// TTL. It returns immediately; the sweep stops with the run context.
func (r *Runner) startTTLSweeper(ctx context.Context) {
	if len(r.ttlTables) == 0 || r.ttl == nil {
		return
	}
	backend, ok := r.backendForService(backendDynamoDB)
	if !ok || backend.HostURL == "" {
		return
	}
	client := newDynamoDBClient(backend.HostURL)
	tables := make([]ttlTable, 0, len(r.ttlTables))
	for _, table := range r.ttlTables {
		tables = append(tables, table)
	}
	go func() {
		for {
			for _, table := range tables {
				if ctx.Err() != nil {
					return
				}
				r.sweepTTL(ctx, client, table)
			}
			select {
			case <-ctx.Done():
				return
			case <-r.clock.After(ttlSweepInterval):
			}
		}
	}()
}

// sweepTTL deletes every item whose TTL attribute is due.
func (r *Runner) sweepTTL(ctx context.Context, client *dynamodb.Client, table ttlTable) {
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(table.Name)})
	if err != nil {
		if ctx.Err() == nil {
			r.logf("TTL sweep for %s: scan failed: %v", table.Name, err)
		}
		return
	}
	now := r.clock.Now()
	for _, item := range out.Items {
		value, ok := item[table.Attribute]
		if !ok || !ttlDue(value, now) {
			continue
		}
		key := ttlItemKey(item, table.KeySchema)
		if len(key) != len(table.KeySchema) || len(key) == 0 {
			continue
		}
		keysJSON := attributeMapJSON(key)
		// Record the marker before the delete: the stream reader can observe the
		// REMOVE as soon as DeleteItem returns, and it attaches the service
		// userIdentity only while the marker exists. Marking first is the
		// ordering invariant that gives every sweep REMOVE its userIdentity.
		// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-streams.html
		r.ttl.mark(table.Name, keysJSON, now)
		if _, err := client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(table.Name),
			Key:       key,
		}); err != nil {
			r.ttl.unmark(table.Name, keysJSON)
			if ctx.Err() == nil {
				r.logf("TTL sweep for %s: delete %s failed: %v", table.Name, tableKeyString(key), err)
			}
			continue
		}
		r.logf("TTL expired item %s in %s at %s", tableKeyString(key), table.Name, now.UTC().Format(time.RFC3339))
	}
}

// ttlDue reports whether an item's TTL attribute is at or before now. AWS TTL
// accepts a number (epoch seconds); the local runner also accepts an RFC3339
// string so a hand-written example row can read naturally.
func ttlDue(value types.AttributeValue, now time.Time) bool {
	switch typed := value.(type) {
	case *types.AttributeValueMemberN:
		seconds, err := parseIntJSON(json.RawMessage(typed.Value))
		if err != nil {
			return false
		}
		return int64(seconds) <= now.Unix()
	case *types.AttributeValueMemberS:
		parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(typed.Value))
		if err != nil {
			return false
		}
		return !parsed.After(now)
	default:
		return false
	}
}

// ttlItemKey extracts the table key from a scanned item.
func ttlItemKey(item map[string]types.AttributeValue, schema []keySchemaAttribute) map[string]types.AttributeValue {
	key := make(map[string]types.AttributeValue, len(schema))
	for _, attribute := range schema {
		value, ok := item[attribute.Name]
		if !ok {
			return map[string]types.AttributeValue{}
		}
		key[attribute.Name] = value
	}
	return key
}
