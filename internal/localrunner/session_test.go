package localrunner

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func TestMarshalItemRoundTripsJSONShapes(t *testing.T) {
	item := map[string]any{
		"pk":     "job#1",
		"count":  json.Number("2"),
		"active": true,
		"tags":   []any{"a", "b"},
		"nested": map[string]any{"value": "x"},
	}
	typed, err := marshalItem(item)
	if err != nil {
		t.Fatalf("marshal item: %v", err)
	}
	pk, ok := typed["pk"].(*types.AttributeValueMemberS)
	if !ok || pk.Value != "job#1" {
		t.Fatalf("string attribute not encoded: %+v", typed["pk"])
	}
	count, ok := typed["count"].(*types.AttributeValueMemberN)
	if !ok || count.Value != "2" {
		t.Fatalf("number attribute not encoded: %+v", typed["count"])
	}
	decoded, err := unmarshalItem(typed)
	if err != nil {
		t.Fatalf("unmarshal item: %v", err)
	}
	if decoded["pk"] != "job#1" || decoded["active"] != true {
		t.Fatalf("scalar attributes lost: %+v", decoded)
	}
	if decoded["count"] != json.Number("2") {
		t.Fatalf("number attribute lost: %+v", decoded["count"])
	}
	if len(mustSlice(t, decoded["tags"])) != 2 {
		t.Fatalf("list attribute lost: %+v", decoded["tags"])
	}
	if mustMap(t, decoded["nested"])["value"] != "x" {
		t.Fatalf("map attribute lost: %+v", decoded["nested"])
	}
}

func TestTableKeyUsesTheProvisionedSchema(t *testing.T) {
	item := map[string]types.AttributeValue{
		"pk":    &types.AttributeValueMemberS{Value: "a"},
		"sk":    &types.AttributeValueMemberS{Value: "b"},
		"extra": &types.AttributeValueMemberS{Value: "c"},
	}
	key := tableKey(item, []keySchemaAttribute{{Name: "pk"}, {Name: "sk"}})
	if len(key) != 2 || key["pk"] == nil || key["sk"] == nil {
		t.Fatalf("key schema not applied: %+v", key)
	}
	if tableKeyString(key) == "" {
		t.Fatal("key string is empty")
	}
}

func TestSessionUnknownOperationFailsClosed(t *testing.T) {
	session := &localSession{runner: &Runner{}, spec: &Spec{}}
	response := session.handle(nil, `{"op":"not-an-operation"}`) //nolint:staticcheck // handle only uses ctx for supported operations
	if response.OK || !strings.Contains(response.Error, "unknown session operation") {
		t.Fatalf("unknown operation must fail: %+v", response)
	}
}
