package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func TestProvisionTablesReconcilesExistingTableInDataDir(t *testing.T) {
	var mu sync.Mutex
	var updates []map[string]any
	createdIndex := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		target := request.Header.Get("X-Amz-Target")
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(target, "CreateTable"):
			writer.Header().Set("x-amzn-errortype", "ResourceInUseException")
			writer.WriteHeader(http.StatusBadRequest)
			writeTestResponse(t, writer, `{"__type":"com.amazonaws.dynamodb.v20120810#ResourceInUseException","message":"Table already exists"}`)
		case strings.HasSuffix(target, "DescribeTable"):
			mu.Lock()
			indexes := `{"IndexName":"keep","IndexStatus":"ACTIVE",` +
				`"KeySchema":[{"AttributeName":"status","KeyType":"HASH"}],` +
				`"Projection":{"ProjectionType":"ALL"}},` +
				`{"IndexName":"remove","IndexStatus":"ACTIVE",` +
				`"KeySchema":[{"AttributeName":"old","KeyType":"HASH"}],` +
				`"Projection":{"ProjectionType":"ALL"}}`
			if createdIndex {
				indexes += `,{"IndexName":"add","IndexStatus":"ACTIVE",` +
					`"KeySchema":[{"AttributeName":"added","KeyType":"HASH"}],` +
					`"Projection":{"ProjectionType":"KEYS_ONLY"}}`
			}
			mu.Unlock()
			writeTestResponse(t, writer, `{"Table":{"TableName":"jobs","TableStatus":"ACTIVE",`+
				`"TableArn":"arn:aws:dynamodb:us-east-1:123456789012:table/jobs",`+
				`"AttributeDefinitions":[{"AttributeName":"pk","AttributeType":"S"},{"AttributeName":"status","AttributeType":"S"},{"AttributeName":"old","AttributeType":"S"},{"AttributeName":"added","AttributeType":"S"}],`+
				`"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],`+
				`"GlobalSecondaryIndexes":[`+indexes+`]}}`)
		case strings.HasSuffix(target, "UpdateTable"):
			var payload map[string]any
			if decodeErr := json.Unmarshal(body, &payload); decodeErr != nil {
				t.Errorf("decode update table: %v", decodeErr)
			}
			mu.Lock()
			updates = append(updates, payload)
			if strings.Contains(string(body), `"IndexName":"add"`) {
				createdIndex = true
			}
			mu.Unlock()
			writeTestResponse(t, writer, `{"TableDescription":{"TableName":"jobs","TableStatus":"ACTIVE"}}`)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"dynamodb": {
				HostURL:   server.URL,
				Endpoints: []Endpoint{{Service: "dynamodb", URL: "http://dynamodb-local:8000"}},
			},
		},
		dataDir:        testSharedDir(t),
		resourceValues: resourceValues{},
		tables:         map[string]tableInfo{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Jobs", Type: typeDynamoTable,
		Properties: json.RawMessage(`{
			"TableName":"jobs",
			"BillingMode":"PAY_PER_REQUEST",
			"AttributeDefinitions":[{"AttributeName":"pk","AttributeType":"S"},{"AttributeName":"status","AttributeType":"S"},{"AttributeName":"added","AttributeType":"S"}],
			"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],
			"GlobalSecondaryIndexes":[
				{"IndexName":"keep","KeySchema":[{"AttributeName":"status","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}},
				{"IndexName":"add","KeySchema":[{"AttributeName":"added","KeyType":"HASH"}],"Projection":{"ProjectionType":"KEYS_ONLY"}}
			]
		}`),
	}}}
	if err := runner.provisionTables(context.Background(), spec); err != nil {
		t.Fatalf("provision tables: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	var created, deleted bool
	for _, update := range updates {
		raw, _ := json.Marshal(update) //nolint:errcheck // test fixture
		text := string(raw)
		if strings.Contains(text, `"Create"`) && strings.Contains(text, `"IndexName":"add"`) {
			created = true
		}
		if strings.Contains(text, `"Delete"`) && strings.Contains(text, `"IndexName":"remove"`) {
			deleted = true
		}
		if strings.Contains(text, `"IndexName":"keep"`) && !strings.Contains(text, `"Delete"`) {
			t.Fatalf("an unchanged index was rewritten: %s", text)
		}
	}
	if !created {
		t.Fatalf("the new index was not created: %+v", updates)
	}
	if !deleted {
		t.Fatalf("the stale index was not deleted: %+v", updates)
	}
	if runner.resourceValues["Stack/Jobs"].Name != "jobs" {
		t.Fatalf("the existing table was not recorded: %+v", runner.resourceValues["Stack/Jobs"])
	}
}

func TestReconcileTableDefinitionRefusesKeySchemaChange(t *testing.T) {
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("id"), KeyType: types.KeyTypeHash}},
	}
	props := dynamoTableProperties{KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}}}
	err := reconcileTableDefinition(context.Background(), nil, "jobs", props, description)
	if err == nil {
		t.Fatal("a key-schema change was accepted")
	}
	for _, want := range []string{"different key schema", "UpdateTable", "https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not cite %q: %v", want, err)
		}
	}
}

func TestReconcileTableDefinitionRefusesIndexShapeChange(t *testing.T) {
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		GlobalSecondaryIndexes: []types.GlobalSecondaryIndexDescription{{
			IndexName:  aws.String("by-status"),
			KeySchema:  []types.KeySchemaElement{{AttributeName: aws.String("status"), KeyType: types.KeyTypeHash}},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeKeysOnly},
		}},
	}
	props := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		GlobalSecondaryIndexes: []dynamoGlobalSecondaryIndex{{
			IndexName:  "by-status",
			KeySchema:  []dynamoKeySchemaElement{{AttributeName: "status", KeyType: "HASH"}},
			Projection: dynamoProjection{ProjectionType: "ALL"},
		}},
	}
	err := reconcileTableDefinition(context.Background(), nil, "jobs", props, description)
	if err == nil || !strings.Contains(err.Error(), "by-status") {
		t.Fatalf("an index shape change was not refused by name: %v", err)
	}
}

func TestSameKeySchema(t *testing.T) {
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: types.KeyTypeRange},
		},
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: types.ScalarAttributeTypeS},
		},
	}
	props := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{
			{AttributeName: "pk", KeyType: "HASH"},
			{AttributeName: "sk", KeyType: "RANGE"},
		},
		AttributeDefinitions: []dynamoAttributeDefinition{
			{AttributeName: "pk", AttributeType: "S"},
			{AttributeName: "sk", AttributeType: "S"},
		},
	}
	if !sameKeySchema(description, props) {
		t.Fatal("a matching key schema was reported as changed")
	}
	shorter := props
	shorter.KeySchema = props.KeySchema[:1]
	if sameKeySchema(description, shorter) {
		t.Fatal("a shorter key schema was reported as matching")
	}
	reordered := props
	reordered.KeySchema = []dynamoKeySchemaElement{props.KeySchema[1], props.KeySchema[0]}
	if sameKeySchema(description, reordered) {
		t.Fatal("a reordered key schema was reported as matching")
	}
	changedType := props
	changedType.KeySchema = []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "RANGE"}, props.KeySchema[1]}
	if sameKeySchema(description, changedType) {
		t.Fatal("a changed key type was reported as matching")
	}
	changedAttributeType := props
	changedAttributeType.AttributeDefinitions = []dynamoAttributeDefinition{
		{AttributeName: "pk", AttributeType: "N"},
		{AttributeName: "sk", AttributeType: "S"},
	}
	if sameKeySchema(description, changedAttributeType) {
		t.Fatal("a changed key attribute type was reported as matching")
	}
}

func TestReconcileTableDefinitionRefusesKeyAttributeTypeChange(t *testing.T) {
	description := &types.TableDescription{
		KeySchema:            []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		AttributeDefinitions: []types.AttributeDefinition{{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS}},
	}
	props := dynamoTableProperties{
		KeySchema:            []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		AttributeDefinitions: []dynamoAttributeDefinition{{AttributeName: "pk", AttributeType: "N"}},
	}
	err := reconcileTableDefinition(context.Background(), nil, "jobs", props, description)
	if err == nil {
		t.Fatal("a key attribute type change was accepted")
	}
	for _, want := range []string{"different key schema", "UpdateTable", "https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not cite %q: %v", want, err)
		}
	}
}

func TestSameGlobalSecondaryIndex(t *testing.T) {
	actual := types.GlobalSecondaryIndexDescription{
		KeySchema:  []types.KeySchemaElement{{AttributeName: aws.String("status"), KeyType: types.KeyTypeHash}},
		Projection: &types.Projection{ProjectionType: types.ProjectionTypeInclude, NonKeyAttributes: []string{"a", "b"}},
	}
	actualTypes := map[string]string{"status": "S"}
	wanted := dynamoGlobalSecondaryIndex{
		KeySchema:  []dynamoKeySchemaElement{{AttributeName: "status", KeyType: "HASH"}},
		Projection: dynamoProjection{ProjectionType: "INCLUDE", NonKeyAttributes: []string{"a", "b"}},
	}
	wantedTypes := map[string]string{"status": "S"}
	if !sameGlobalSecondaryIndex(actual, wanted, actualTypes, wantedTypes) {
		t.Fatal("a matching index was reported as changed")
	}
	changed := wanted
	changed.Projection.NonKeyAttributes = []string{"a"}
	if sameGlobalSecondaryIndex(actual, changed, actualTypes, wantedTypes) {
		t.Fatal("a changed projection was reported as matching")
	}
	changed = wanted
	changed.KeySchema = []dynamoKeySchemaElement{{AttributeName: "other", KeyType: "HASH"}}
	if sameGlobalSecondaryIndex(actual, changed, actualTypes, wantedTypes) {
		t.Fatal("a changed index key was reported as matching")
	}
	changed = wanted
	changed.KeySchema = append(changed.KeySchema, dynamoKeySchemaElement{AttributeName: "sk", KeyType: "RANGE"})
	if sameGlobalSecondaryIndex(actual, changed, actualTypes, wantedTypes) {
		t.Fatal("an added index key was reported as matching")
	}
	// A type-only change keeps the attribute name and HASH role but changes
	// the declared scalar type (S to N), which no UpdateTable call can apply.
	changed = wanted
	changedTypes := map[string]string{"status": "N"}
	if sameGlobalSecondaryIndex(actual, changed, actualTypes, changedTypes) {
		t.Fatal("a changed index key attribute type was reported as matching")
	}
	if sameGlobalSecondaryIndex(types.GlobalSecondaryIndexDescription{}, wanted, nil, wantedTypes) {
		t.Fatal("a missing projection was reported as matching")
	}
	if !sameGlobalSecondaryIndex(types.GlobalSecondaryIndexDescription{}, dynamoGlobalSecondaryIndex{}, nil, nil) {
		t.Fatal("two empty definitions were reported as different")
	}
}

func TestReconcileTableDefinitionRefusesIndexAttributeTypeChange(t *testing.T) {
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("status"), AttributeType: types.ScalarAttributeTypeS},
		},
		GlobalSecondaryIndexes: []types.GlobalSecondaryIndexDescription{{
			IndexName:  aws.String("by-status"),
			KeySchema:  []types.KeySchemaElement{{AttributeName: aws.String("status"), KeyType: types.KeyTypeHash}},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeKeysOnly},
		}},
	}
	props := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		AttributeDefinitions: []dynamoAttributeDefinition{
			{AttributeName: "pk", AttributeType: "S"},
			{AttributeName: "status", AttributeType: "N"},
		},
		GlobalSecondaryIndexes: []dynamoGlobalSecondaryIndex{{
			IndexName:  "by-status",
			KeySchema:  []dynamoKeySchemaElement{{AttributeName: "status", KeyType: "HASH"}},
			Projection: dynamoProjection{ProjectionType: "KEYS_ONLY"},
		}},
	}
	err := reconcileTableDefinition(context.Background(), nil, "jobs", props, description)
	if err == nil {
		t.Fatal("an index key attribute type change was accepted")
	}
	for _, want := range []string{
		"by-status",
		"AttributeDefinition.html",
		"different shape",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not cite %q: %v", want, err)
		}
	}
}

func TestCreateTableInputIncludesLocalSecondaryIndexes(t *testing.T) {
	// A CDK table that declares LocalSecondaryIndexes must create them with the
	// table: a local secondary index cannot be added later.
	var props dynamoTableProperties
	if err := json.Unmarshal([]byte(`{
		"TableName":"jobs",
		"BillingMode":"PAY_PER_REQUEST",
		"AttributeDefinitions":[
			{"AttributeName":"pk","AttributeType":"S"},
			{"AttributeName":"created","AttributeType":"N"}
		],
		"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],
		"LocalSecondaryIndexes":[{
			"IndexName":"by-created",
			"KeySchema":[
				{"AttributeName":"pk","KeyType":"HASH"},
				{"AttributeName":"created","KeyType":"RANGE"}
			],
			"Projection":{"ProjectionType":"KEYS_ONLY"}
		}]
	}`), &props); err != nil {
		t.Fatal(err)
	}
	input := createTableInput("jobs", props)
	if len(input.LocalSecondaryIndexes) != 1 {
		t.Fatalf("the table's local secondary index was dropped: %+v", input.LocalSecondaryIndexes)
	}
	index := input.LocalSecondaryIndexes[0]
	if aws.ToString(index.IndexName) != "by-created" {
		t.Fatalf("index name = %q", aws.ToString(index.IndexName))
	}
	if len(index.KeySchema) != 2 ||
		aws.ToString(index.KeySchema[0].AttributeName) != "pk" || index.KeySchema[0].KeyType != types.KeyTypeHash ||
		aws.ToString(index.KeySchema[1].AttributeName) != "created" || index.KeySchema[1].KeyType != types.KeyTypeRange {
		t.Fatalf("index key schema = %+v", index.KeySchema)
	}
	if index.Projection == nil || index.Projection.ProjectionType != types.ProjectionTypeKeysOnly {
		t.Fatalf("index projection = %+v", index.Projection)
	}
}

func TestReconcileTableDefinitionRefusesLocalSecondaryIndexDifferences(t *testing.T) {
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("created"), AttributeType: types.ScalarAttributeTypeN},
		},
		LocalSecondaryIndexes: []types.LocalSecondaryIndexDescription{{
			IndexName: aws.String("by-created"),
			KeySchema: []types.KeySchemaElement{
				{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
				{AttributeName: aws.String("created"), KeyType: types.KeyTypeRange},
			},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeKeysOnly},
		}},
	}
	matching := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		AttributeDefinitions: []dynamoAttributeDefinition{
			{AttributeName: "pk", AttributeType: "S"},
			{AttributeName: "created", AttributeType: "N"},
		},
		LocalSecondaryIndexes: []dynamoLocalSecondaryIndex{{
			IndexName: "by-created",
			KeySchema: []dynamoKeySchemaElement{
				{AttributeName: "pk", KeyType: "HASH"},
				{AttributeName: "created", KeyType: "RANGE"},
			},
			Projection: dynamoProjection{ProjectionType: "KEYS_ONLY"},
		}},
	}
	if err := reconcileTableDefinition(context.Background(), nil, "jobs", matching, description); err != nil {
		t.Fatalf("an unchanged local secondary index was refused: %v", err)
	}
	removed := matching
	removed.LocalSecondaryIndexes = nil
	if err := reconcileTableDefinition(context.Background(), nil, "jobs", removed, description); err == nil ||
		!strings.Contains(err.Error(), "by-created") || !strings.Contains(err.Error(), "cannot delete") ||
		!strings.Contains(err.Error(), "LSI.html") {
		t.Fatalf("a removed local secondary index was not refused by name with the creation-time rule: %v", err)
	}
	added := matching
	added.AttributeDefinitions = append(append([]dynamoAttributeDefinition(nil), matching.AttributeDefinitions...),
		dynamoAttributeDefinition{AttributeName: "updated", AttributeType: "S"})
	added.LocalSecondaryIndexes = append(append([]dynamoLocalSecondaryIndex(nil), matching.LocalSecondaryIndexes...),
		dynamoLocalSecondaryIndex{
			IndexName:  "by-updated",
			KeySchema:  []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}, {AttributeName: "updated", KeyType: "RANGE"}},
			Projection: dynamoProjection{ProjectionType: "KEYS_ONLY"},
		})
	if err := reconcileTableDefinition(context.Background(), nil, "jobs", added, description); err == nil ||
		!strings.Contains(err.Error(), "by-updated") || !strings.Contains(err.Error(), "cannot be added later") {
		t.Fatalf("an added local secondary index was not refused by name: %v", err)
	}
	changed := matching
	changed.LocalSecondaryIndexes = []dynamoLocalSecondaryIndex{{
		IndexName: "by-created",
		KeySchema: []dynamoKeySchemaElement{
			{AttributeName: "pk", KeyType: "HASH"},
			{AttributeName: "created", KeyType: "RANGE"},
		},
		Projection: dynamoProjection{ProjectionType: "ALL"},
	}}
	if err := reconcileTableDefinition(context.Background(), nil, "jobs", changed, description); err == nil ||
		!strings.Contains(err.Error(), "by-created") || !strings.Contains(err.Error(), "different shape") ||
		!strings.Contains(err.Error(), "UpdateTable") {
		t.Fatalf("a changed local secondary index was not refused by name: %v", err)
	}
	// A type-only change on the index's own sort key is invisible to the table
	// key-schema check; the index comparison must catch it.
	drifted := matching
	drifted.AttributeDefinitions = []dynamoAttributeDefinition{
		{AttributeName: "pk", AttributeType: "S"},
		{AttributeName: "created", AttributeType: "S"},
	}
	if err := reconcileTableDefinition(context.Background(), nil, "jobs", drifted, description); err == nil ||
		!strings.Contains(err.Error(), "by-created") || !strings.Contains(err.Error(), "AttributeDefinition.html") {
		t.Fatalf("a local secondary index key type change was not refused: %v", err)
	}
}

func TestReconcileTableDefinitionAddsAttributeDefinitionsForANewIndex(t *testing.T) {
	var mu sync.Mutex
	var updates []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), "UpdateTable"):
			var payload map[string]any
			if decodeErr := json.Unmarshal(body, &payload); decodeErr != nil {
				t.Errorf("decode update table: %v", decodeErr)
			}
			mu.Lock()
			updates = append(updates, payload)
			mu.Unlock()
			writeTestResponse(t, writer, `{"TableDescription":{"TableName":"jobs","TableStatus":"ACTIVE"}}`)
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), "DescribeTable"):
			writeTestResponse(t, writer, `{"Table":{"TableName":"jobs","TableStatus":"ACTIVE",`+
				`"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],`+
				`"AttributeDefinitions":[{"AttributeName":"pk","AttributeType":"S"},{"AttributeName":"status","AttributeType":"S"}],`+
				`"GlobalSecondaryIndexes":[{"IndexName":"by-number","IndexStatus":"ACTIVE",`+
				`"KeySchema":[{"AttributeName":"num","KeyType":"HASH"}],`+
				`"Projection":{"ProjectionType":"KEYS_ONLY"}}]}}`)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("status"), AttributeType: types.ScalarAttributeTypeS},
		},
	}
	props := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		AttributeDefinitions: []dynamoAttributeDefinition{
			{AttributeName: "pk", AttributeType: "S"},
			{AttributeName: "num", AttributeType: "N"},
		},
		GlobalSecondaryIndexes: []dynamoGlobalSecondaryIndex{{
			IndexName:  "by-number",
			KeySchema:  []dynamoKeySchemaElement{{AttributeName: "num", KeyType: "HASH"}},
			Projection: dynamoProjection{ProjectionType: "KEYS_ONLY"},
		}},
	}
	if err := reconcileTableDefinition(context.Background(), newDynamoDBClient(server.URL), "jobs", props, description); err != nil {
		t.Fatalf("reconcile a table with a new index: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(updates) != 1 {
		t.Fatalf("update calls = %d, want 1", len(updates))
	}
	raw, _ := json.Marshal(updates[0]) //nolint:errcheck // test fixture
	if !strings.Contains(string(raw), `"AttributeDefinitions":[{"AttributeName":"num","AttributeType":"N"}]`) {
		t.Fatalf("the new index's attribute definition was not sent: %s", raw)
	}
	if !strings.Contains(string(raw), `"IndexName":"by-number"`) {
		t.Fatalf("the new index was not created: %s", raw)
	}
}

func TestReconcileTableDefinitionRefusesANewIndexOverADriftedAttributeType(t *testing.T) {
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("status"), AttributeType: types.ScalarAttributeTypeS},
		},
	}
	props := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		AttributeDefinitions: []dynamoAttributeDefinition{
			{AttributeName: "pk", AttributeType: "S"},
			{AttributeName: "status", AttributeType: "N"},
		},
		GlobalSecondaryIndexes: []dynamoGlobalSecondaryIndex{{
			IndexName:  "by-status",
			KeySchema:  []dynamoKeySchemaElement{{AttributeName: "status", KeyType: "HASH"}},
			Projection: dynamoProjection{ProjectionType: "KEYS_ONLY"},
		}},
	}
	// A nil client proves the refusal happens before any UpdateTable call.
	err := reconcileTableDefinition(context.Background(), nil, "jobs", props, description)
	if err == nil {
		t.Fatal("a new index over a drifted key attribute type was accepted")
	}
	for _, want := range []string{"by-status", "status", "AttributeDefinition.html", "UpdateTable.html"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not cite %q: %v", want, err)
		}
	}
}

func TestWaitForTableActiveHonoursCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		writeTestResponse(t, writer, `{"Table":{"TableName":"jobs","TableStatus":"CREATING"}}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := waitForTableActive(ctx, newDynamoDBClient(server.URL), "jobs"); err == nil {
		t.Fatal("an canceled wait returned no error")
	}
}

func TestWaitForIndexActiveHonoursCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		writeTestResponse(t, writer, `{"Table":{"TableName":"jobs","TableStatus":"ACTIVE",`+
			`"GlobalSecondaryIndexes":[{"IndexName":"by-status","IndexStatus":"CREATING"}]}}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForIndexActive(ctx, newDynamoDBClient(server.URL), "jobs", "by-status"); err == nil {
		t.Fatal("an canceled wait returned no error")
	}
}

func TestProvisionQueueReconcilesExistingQueueInDataDir(t *testing.T) {
	var mu sync.Mutex
	var reconciled map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		target := request.Header.Get("X-Amz-Target")
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(target, "CreateQueue"):
			writer.Header().Set("x-amzn-errortype", "QueueAlreadyExists")
			writer.WriteHeader(http.StatusBadRequest)
			writeTestResponse(t, writer, `{"__type":"com.amazonaws.sqs#QueueAlreadyExists","message":"queue exists"}`)
		case strings.HasSuffix(target, "GetQueueUrl"):
			writeTestResponse(t, writer, `{"QueueUrl":"http://localhost:9324/000000000000/events"}`)
		case strings.HasSuffix(target, "SetQueueAttributes"):
			var payload struct {
				Attributes map[string]string `json:"Attributes"`
			}
			if decodeErr := json.Unmarshal(body, &payload); decodeErr != nil {
				t.Errorf("decode attributes: %v", decodeErr)
			}
			mu.Lock()
			reconciled = payload.Attributes
			mu.Unlock()
			writeTestResponse(t, writer, `{}`)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"sqs": {HostURL: server.URL, Endpoints: []Endpoint{{Service: "sqs", URL: "http://sqs:9324"}}},
		},
		dataDir:        testSharedDir(t),
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
		Properties: json.RawMessage(`{
			"QueueName":"events",
			"VisibilityTimeout":60,
			"FifoQueue":true,
			"ContentBasedDeduplication":true
		}`),
	}}}
	if err := runner.provisionQueues(context.Background(), spec); err != nil {
		t.Fatalf("provision queues: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if reconciled["VisibilityTimeout"] != "60" {
		t.Fatalf("the re-runnable attribute was not reconciled: %+v", reconciled)
	}
	if _, ok := reconciled["FifoQueue"]; ok {
		t.Fatalf("a creation-time attribute was rewritten: %+v", reconciled)
	}
	if _, ok := reconciled["ContentBasedDeduplication"]; ok {
		t.Fatalf("a creation-time attribute was rewritten: %+v", reconciled)
	}
	if got := runner.resourceValues["Stack/Events"].URL; got != "http://sqs:9324/000000000000/events" {
		t.Fatalf("queue URL = %q", got)
	}
}

func TestReconcileTableDefinitionReportsIndexFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		if strings.HasSuffix(request.Header.Get("X-Amz-Target"), "UpdateTable") {
			writer.WriteHeader(http.StatusBadRequest)
			writeTestResponse(t, writer, `{"__type":"com.amazonaws.dynamodb.v20120810#ValidationException","message":"too many indexes"}`)
			return
		}
		writer.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	client := newDynamoDBClient(server.URL)
	description := &types.TableDescription{
		KeySchema: []types.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash}},
		GlobalSecondaryIndexes: []types.GlobalSecondaryIndexDescription{{
			IndexName:  aws.String("stale"),
			KeySchema:  []types.KeySchemaElement{{AttributeName: aws.String("old"), KeyType: types.KeyTypeHash}},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeAll},
		}},
	}
	addProps := dynamoTableProperties{
		KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		GlobalSecondaryIndexes: []dynamoGlobalSecondaryIndex{{
			IndexName:  "new",
			KeySchema:  []dynamoKeySchemaElement{{AttributeName: "added", KeyType: "HASH"}},
			Projection: dynamoProjection{ProjectionType: "ALL"},
		}},
	}
	if err := reconcileTableDefinition(context.Background(), client, "jobs", addProps, description); err == nil ||
		!strings.Contains(err.Error(), "new") {
		t.Fatalf("a failed index create = %v", err)
	}
	removeProps := dynamoTableProperties{KeySchema: []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}}}
	if err := reconcileTableDefinition(context.Background(), client, "jobs", removeProps, description); err == nil ||
		!strings.Contains(err.Error(), "stale") {
		t.Fatalf("a failed index delete = %v", err)
	}
	if err := reconcileTableDefinition(context.Background(), client, "jobs", removeProps, nil); err != nil {
		t.Fatalf("a missing description = %v", err)
	}
}
