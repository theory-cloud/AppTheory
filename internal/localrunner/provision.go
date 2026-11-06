package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmsTypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// provisionResources creates the local resources a served function's
// environment references and a local session drives: one KMS key per
// AWS::KMS::Key, one S3 bucket per AWS::S3::Bucket, one DynamoDB table per
// AWS::DynamoDB::Table (key schema, GSIs, streams and TTL) and one SQS queue per
// AWS::SQS::Queue (including its redrive policy). Nothing is created when the
// corresponding backend is not configured; resolution then fails closed if a
// function needs the value.
func (r *Runner) provisionResources(ctx context.Context, spec *Spec) error {
	r.resourceValues = resourceValues{}
	r.tables = map[string]tableInfo{}
	r.secretValues = map[string]string{}
	if err := r.provisionLogGroups(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionBuckets(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionDeployments(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionKeys(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionAliases(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionTables(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionQueues(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionSSMParameters(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionSecrets(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionTopics(ctx, spec); err != nil {
		return err
	}
	if err := r.provisionStreams(ctx, spec); err != nil {
		return err
	}
	return r.provisionCognito(ctx, spec)
}

// provisionLogGroups creates one log group per AWS::Logs::LogGroup so a
// declared group exists for the application and a subscription filter can read
// it. Streams are created on demand by the writer.
func (r *Runner) provisionLogGroups(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService(logsService)
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the logs backend has no loopback endpoint for the runner to provision log groups")
	}
	client := newCloudWatchLogsClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeLogGroup {
			continue
		}
		name := logGroupResourceName(spec, resource)
		if err := client.CreateLogGroup(ctx, name); err != nil {
			return fmt.Errorf("create local log group %s for %s: %w", name, resource.LogicalID, err)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type: typeLogGroup,
			Name: name,
			ARN:  "arn:" + LocalPartition + ":logs:" + LocalRegion + ":" + LocalAccountID + ":log-group:" + name + ":*",
		}
		r.logf("provisioned log group %s for %s", name, resource.LogicalID)
	}
	return nil
}

// logGroupResourceName resolves a log group's LogGroupName. CDK expresses a
// function's default group as {"Fn::Join":["",["/aws/lambda/",{"Ref":"Fn"}]]},
// so the physical function name must be resolved first.
func logGroupResourceName(spec *Spec, resource ResourceSpec) string {
	var props struct {
		LogGroupName json.RawMessage `json:"LogGroupName"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fallbackLogGroupName(spec, resource)
		}
	}
	var value any
	if err := json.Unmarshal(props.LogGroupName, &value); err != nil {
		return fallbackLogGroupName(spec, resource)
	}
	if name := flattenLogGroupValueInSpec(spec, resource.Stack, value); name != "" {
		return name
	}
	return fallbackLogGroupName(spec, resource)
}

func fallbackLogGroupName(_ *Spec, resource ResourceSpec) string {
	name, err := resourceName(resource)
	if err != nil {
		return localPhysicalName(resource.Stack, resource.LogicalID)
	}
	return name
}

func flattenLogGroupValueInSpec(spec *Spec, stack string, value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		if id, ok := typed["Ref"].(string); ok {
			for _, resource := range spec.Resources {
				if resource.Stack != stack || resource.LogicalID != id {
					continue
				}
				switch resource.Type {
				case typeLambdaFunction:
					// The Join already supplies the /aws/lambda/ prefix.
					return fallbackLogGroupName(spec, resource)
				case typeLogGroup:
					return logGroupResourceName(spec, resource)
				}
			}
			return ""
		}
		join, ok := typed["Fn::Join"].([]any)
		if !ok || len(join) != 2 {
			return ""
		}
		delimiter, ok := join[0].(string)
		if !ok {
			return ""
		}
		parts, ok := join[1].([]any)
		if !ok {
			return ""
		}
		var builder strings.Builder
		for _, part := range parts {
			resolved := flattenLogGroupValueInSpec(spec, stack, part)
			if resolved == "" {
				return ""
			}
			builder.WriteString(resolved)
			builder.WriteString(delimiter)
		}
		return strings.TrimSuffix(builder.String(), delimiter)
	default:
		return ""
	}
}

func (r *Runner) provisionBuckets(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("s3")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the s3 backend has no loopback endpoint for the runner to provision buckets")
	}
	client := newS3Client(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeS3Bucket {
			continue
		}
		name, err := resourceName(resource)
		if err != nil {
			return err
		}
		if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(name)}); err != nil && !alreadyExists(err) {
			return fmt.Errorf("create local bucket %s for %s: %w", name, resource.LogicalID, err)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type: typeS3Bucket,
			Name: name,
			ARN:  "arn:" + LocalPartition + ":s3:::" + name,
		}
		r.logf("provisioned s3 bucket %s for %s", name, resource.LogicalID)
	}
	return nil
}

func (r *Runner) provisionKeys(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("kms")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the kms backend has no loopback endpoint for the runner to provision keys")
	}
	client := newKMSClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeKMSKey {
			continue
		}
		description, err := resourceDescription(resource)
		if err != nil {
			return err
		}
		input := &kms.CreateKeyInput{Description: aws.String(description)}
		var props struct {
			KeySpec  string `json:"KeySpec"`
			KeyUsage string `json:"KeyUsage"`
		}
		if len(resource.Properties) > 0 {
			if parseErr := json.Unmarshal(resource.Properties, &props); parseErr != nil {
				return fmt.Errorf("parse KMS key %s properties: %w", resource.LogicalID, parseErr)
			}
		}
		if spec := strings.TrimSpace(props.KeySpec); spec != "" {
			input.KeySpec = kmsTypes.KeySpec(spec)
		}
		if usage := strings.TrimSpace(props.KeyUsage); usage != "" {
			input.KeyUsage = kmsTypes.KeyUsageType(usage)
		}
		created, err := client.CreateKey(ctx, input)
		if err != nil {
			return fmt.Errorf("create local KMS key for %s: %w", resource.LogicalID, err)
		}
		if created.KeyMetadata == nil || aws.ToString(created.KeyMetadata.KeyId) == "" {
			return fmt.Errorf("create local KMS key for %s returned no key id", resource.LogicalID)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type:  typeKMSKey,
			Name:  aws.ToString(created.KeyMetadata.KeyId),
			KeyID: aws.ToString(created.KeyMetadata.KeyId),
			ARN:   aws.ToString(created.KeyMetadata.Arn),
		}
		r.logf("provisioned KMS key %s for %s", aws.ToString(created.KeyMetadata.KeyId), resource.LogicalID)
	}
	return nil
}

type dynamoAttributeDefinition struct {
	AttributeName string `json:"AttributeName"`
	AttributeType string `json:"AttributeType"`
}

type dynamoKeySchemaElement struct {
	AttributeName string `json:"AttributeName"`
	KeyType       string `json:"KeyType"`
}

type dynamoProjection struct {
	ProjectionType   string   `json:"ProjectionType"`
	NonKeyAttributes []string `json:"NonKeyAttributes"`
}

type dynamoProvisionedThroughput struct {
	ReadCapacityUnits  int64 `json:"ReadCapacityUnits"`
	WriteCapacityUnits int64 `json:"WriteCapacityUnits"`
}

type dynamoGlobalSecondaryIndex struct {
	IndexName             string                      `json:"IndexName"`
	KeySchema             []dynamoKeySchemaElement    `json:"KeySchema"`
	Projection            dynamoProjection            `json:"Projection"`
	ProvisionedThroughput dynamoProvisionedThroughput `json:"ProvisionedThroughput"`
}

type dynamoStreamSpecification struct {
	StreamEnabled  bool   `json:"StreamEnabled"`
	StreamViewType string `json:"StreamViewType"`
}

type dynamoTimeToLive struct {
	AttributeName string `json:"AttributeName"`
	Enabled       bool   `json:"Enabled"`
}

type dynamoTableProperties struct {
	AttributeDefinitions    []dynamoAttributeDefinition  `json:"AttributeDefinitions"`
	KeySchema               []dynamoKeySchemaElement     `json:"KeySchema"`
	GlobalSecondaryIndexes  []dynamoGlobalSecondaryIndex `json:"GlobalSecondaryIndexes"`
	BillingMode             string                       `json:"BillingMode"`
	ProvisionedThroughput   dynamoProvisionedThroughput  `json:"ProvisionedThroughput"`
	StreamSpecification     dynamoStreamSpecification    `json:"StreamSpecification"`
	TimeToLiveSpecification dynamoTimeToLive             `json:"TimeToLiveSpecification"`
	TableName               string                       `json:"TableName"`
}

//nolint:gocyclo,gocognit // one provisioning step per table resource.
func (r *Runner) provisionTables(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("dynamodb")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the dynamodb backend has no loopback endpoint for the runner to provision tables")
	}
	client := newDynamoDBClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeDynamoTable {
			continue
		}
		var props dynamoTableProperties
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse DynamoDB table %s properties: %w", resource.LogicalID, err)
			}
		}
		name, err := resourceName(resource)
		if err != nil {
			return err
		}
		input := createTableInput(name, props)
		_, createErr := client.CreateTable(ctx, input)
		existed := createErr != nil && tableAlreadyExists(createErr)
		if createErr != nil && !existed {
			return fmt.Errorf("create local DynamoDB table %s for %s: %w", name, resource.LogicalID, createErr)
		}
		description, err := waitForTableActive(ctx, client, name)
		if err != nil {
			return fmt.Errorf("wait for local DynamoDB table %s: %w", name, err)
		}
		if existed && r.dataDir != "" {
			if reconcileErr := reconcileTableDefinition(ctx, client, name, props, description); reconcileErr != nil {
				return fmt.Errorf("reconcile local DynamoDB table %s for %s: %w", name, resource.LogicalID, reconcileErr)
			}
			description, err = waitForTableActive(ctx, client, name)
			if err != nil {
				return fmt.Errorf("wait for reconciled local DynamoDB table %s: %w", name, err)
			}
		}
		keySchema := make([]keySchemaAttribute, 0, len(props.KeySchema))
		for _, key := range props.KeySchema {
			keyType, ok := attributeType(props.AttributeDefinitions, key.AttributeName)
			if !ok {
				return fmt.Errorf("DynamoDB table %s key %s has no attribute definition", name, key.AttributeName)
			}
			keySchema = append(keySchema, keySchemaAttribute{Name: key.AttributeName, Type: keyType})
		}
		value := resourceValue{
			Type:      typeDynamoTable,
			Name:      name,
			ARN:       aws.ToString(description.TableArn),
			StreamARN: normalizeDynamoStreamARN(aws.ToString(description.LatestStreamArn), name),
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = value
		r.tables[resource.Stack+"/"+resource.LogicalID] = tableInfo{
			Name:           name,
			KeySchema:      keySchema,
			StreamARN:      value.StreamARN,
			StreamViewType: props.StreamSpecification.StreamViewType,
		}
		if props.TimeToLiveSpecification.Enabled && strings.TrimSpace(props.TimeToLiveSpecification.AttributeName) != "" {
			if _, err := client.UpdateTimeToLive(ctx, &dynamodb.UpdateTimeToLiveInput{
				TableName: aws.String(name),
				TimeToLiveSpecification: &types.TimeToLiveSpecification{
					AttributeName: aws.String(props.TimeToLiveSpecification.AttributeName),
					Enabled:       aws.Bool(true),
				},
			}); err != nil && !ttlAlreadyEnabled(err) {
				return fmt.Errorf("enable local TTL on DynamoDB table %s: %w", name, err)
			}
			if r.ttlTables == nil {
				r.ttlTables = map[string]ttlTable{}
			}
			r.ttlTables[resource.Stack+"/"+resource.LogicalID] = ttlTable{
				Name:      name,
				Attribute: props.TimeToLiveSpecification.AttributeName,
				KeySchema: keySchema,
			}
		}
		r.logf("provisioned DynamoDB table %s for %s", name, resource.LogicalID)
	}
	return nil
}

func createTableInput(name string, props dynamoTableProperties) *dynamodb.CreateTableInput {
	input := &dynamodb.CreateTableInput{
		TableName:            aws.String(name),
		KeySchema:            make([]types.KeySchemaElement, 0, len(props.KeySchema)),
		AttributeDefinitions: make([]types.AttributeDefinition, 0, len(props.AttributeDefinitions)),
	}
	for _, key := range props.KeySchema {
		input.KeySchema = append(input.KeySchema, types.KeySchemaElement{
			AttributeName: aws.String(key.AttributeName),
			KeyType:       types.KeyType(key.KeyType),
		})
	}
	for _, attribute := range props.AttributeDefinitions {
		input.AttributeDefinitions = append(input.AttributeDefinitions, types.AttributeDefinition{
			AttributeName: aws.String(attribute.AttributeName),
			AttributeType: types.ScalarAttributeType(attribute.AttributeType),
		})
	}
	switch props.BillingMode {
	case "", string(types.BillingModeProvisioned):
		input.BillingMode = types.BillingModeProvisioned
		input.ProvisionedThroughput = &types.ProvisionedThroughput{
			ReadCapacityUnits:  aws.Int64(maxInt64(props.ProvisionedThroughput.ReadCapacityUnits, 5)),
			WriteCapacityUnits: aws.Int64(maxInt64(props.ProvisionedThroughput.WriteCapacityUnits, 5)),
		}
	default:
		input.BillingMode = types.BillingModePayPerRequest
	}
	for _, index := range props.GlobalSecondaryIndexes {
		converted := types.GlobalSecondaryIndex{
			IndexName: aws.String(index.IndexName),
			Projection: &types.Projection{
				ProjectionType:   types.ProjectionType(index.Projection.ProjectionType),
				NonKeyAttributes: append([]string(nil), index.Projection.NonKeyAttributes...),
			},
		}
		for _, key := range index.KeySchema {
			converted.KeySchema = append(converted.KeySchema, types.KeySchemaElement{
				AttributeName: aws.String(key.AttributeName),
				KeyType:       types.KeyType(key.KeyType),
			})
		}
		if input.BillingMode == types.BillingModeProvisioned {
			converted.ProvisionedThroughput = &types.ProvisionedThroughput{
				ReadCapacityUnits:  aws.Int64(maxInt64(index.ProvisionedThroughput.ReadCapacityUnits, 5)),
				WriteCapacityUnits: aws.Int64(maxInt64(index.ProvisionedThroughput.WriteCapacityUnits, 5)),
			}
		}
		input.GlobalSecondaryIndexes = append(input.GlobalSecondaryIndexes, converted)
	}
	if props.StreamSpecification.StreamEnabled || strings.TrimSpace(props.StreamSpecification.StreamViewType) != "" {
		input.StreamSpecification = &types.StreamSpecification{
			StreamEnabled:  aws.Bool(true),
			StreamViewType: types.StreamViewType(props.StreamSpecification.StreamViewType),
		}
	}
	return input
}

func waitForTableActive(ctx context.Context, client *dynamodb.Client, name string) (*types.TableDescription, error) {
	deadline := time.Now().Add(30 * time.Second)
	var last *types.TableDescription
	for {
		out, err := client.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(name)})
		if err != nil {
			return nil, err
		}
		last = out.Table
		if out.Table != nil && out.Table.TableStatus == types.TableStatusActive {
			return out.Table, nil
		}
		if time.Now().After(deadline) {
			if last == nil {
				return nil, fmt.Errorf("DescribeTable returned no table")
			}
			return nil, fmt.Errorf("table status is %s", last.TableStatus)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// reconcileTableDefinition applies a re-run's definition to a table that
// already exists in --data-dir. Key-schema changes fail closed because
// UpdateTable cannot apply them; missing or changed global secondary indexes
// are created, deleted or refused by name. Existing items are never dropped.
//
// https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html
func reconcileTableDefinition(ctx context.Context, client *dynamodb.Client, name string, props dynamoTableProperties, description *types.TableDescription) error {
	if description == nil {
		return nil
	}
	if !sameKeySchema(description, props) {
		return fmt.Errorf(
			"the table already exists with a different key schema; UpdateTable " +
				"\"Modifies the provisioned throughput settings, global secondary indexes, " +
				"DynamoDB Streams settings, or global table replica settings for a given table\", " +
				"so a key-schema change cannot be applied to existing state " +
				"(https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html)",
		)
	}
	existing := map[string]types.GlobalSecondaryIndexDescription{}
	for _, index := range description.GlobalSecondaryIndexes {
		existing[aws.ToString(index.IndexName)] = index
	}
	actualTypes := map[string]string{}
	for _, definition := range description.AttributeDefinitions {
		actualTypes[aws.ToString(definition.AttributeName)] = string(definition.AttributeType)
	}
	wantedTypes := map[string]string{}
	for _, definition := range props.AttributeDefinitions {
		wantedTypes[definition.AttributeName] = definition.AttributeType
	}
	wanted := map[string]bool{}
	for _, index := range props.GlobalSecondaryIndexes {
		wanted[index.IndexName] = true
		if current, ok := existing[index.IndexName]; ok {
			if !sameGlobalSecondaryIndex(current, index, actualTypes, wantedTypes) {
				return fmt.Errorf(
					"global secondary index %s already exists with a different shape; "+
						"a key attribute's type is part of the index definition "+
						"(https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeDefinition.html), "+
						"and the local runner refuses to recreate the index over existing table data",
					index.IndexName,
				)
			}
			continue
		}
		create := &types.CreateGlobalSecondaryIndexAction{IndexName: aws.String(index.IndexName)}
		for _, key := range index.KeySchema {
			create.KeySchema = append(create.KeySchema, types.KeySchemaElement{
				AttributeName: aws.String(key.AttributeName),
				KeyType:       types.KeyType(key.KeyType),
			})
		}
		create.Projection = &types.Projection{
			ProjectionType:   types.ProjectionType(index.Projection.ProjectionType),
			NonKeyAttributes: append([]string(nil), index.Projection.NonKeyAttributes...),
		}
		if _, err := client.UpdateTable(ctx, &dynamodb.UpdateTableInput{
			TableName: aws.String(name),
			GlobalSecondaryIndexUpdates: []types.GlobalSecondaryIndexUpdate{{
				Create: create,
			}},
		}); err != nil {
			return fmt.Errorf("create global secondary index %s: %w", index.IndexName, err)
		}
		if err := waitForIndexActive(ctx, client, name, index.IndexName); err != nil {
			return err
		}
	}
	for indexName := range existing {
		if wanted[indexName] {
			continue
		}
		if _, err := client.UpdateTable(ctx, &dynamodb.UpdateTableInput{
			TableName: aws.String(name),
			GlobalSecondaryIndexUpdates: []types.GlobalSecondaryIndexUpdate{{
				Delete: &types.DeleteGlobalSecondaryIndexAction{IndexName: aws.String(indexName)},
			}},
		}); err != nil {
			return fmt.Errorf("delete global secondary index %s: %w", indexName, err)
		}
	}
	return nil
}

// sameKeySchema compares the key attributes and their declared types. A type
// change (S to N) keeps the names and roles but cannot be applied to existing
// items, so it is refused like any other key-schema change.
func sameKeySchema(description *types.TableDescription, props dynamoTableProperties) bool {
	actual, wanted := description.KeySchema, props.KeySchema
	if len(actual) != len(wanted) {
		return false
	}
	actualTypes := map[string]string{}
	for _, definition := range description.AttributeDefinitions {
		actualTypes[aws.ToString(definition.AttributeName)] = string(definition.AttributeType)
	}
	wantedTypes := map[string]string{}
	for _, definition := range props.AttributeDefinitions {
		wantedTypes[definition.AttributeName] = definition.AttributeType
	}
	for index := range actual {
		if aws.ToString(actual[index].AttributeName) != wanted[index].AttributeName {
			return false
		}
		if string(actual[index].KeyType) != wanted[index].KeyType {
			return false
		}
		if actualTypes[wanted[index].AttributeName] != wantedTypes[wanted[index].AttributeName] {
			return false
		}
	}
	return true
}

// sameGlobalSecondaryIndex compares the index key attributes, their declared
// types and the projection. A key attribute's type is part of the index
// definition: the table's AttributeDefinitions describe the key schema for the
// table and indexes, and UpdateTable changes indexes, not the type of an
// existing key attribute
// (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeDefinition.html,
// https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateTable.html).
func sameGlobalSecondaryIndex(
	actual types.GlobalSecondaryIndexDescription,
	wanted dynamoGlobalSecondaryIndex,
	actualTypes, wantedTypes map[string]string,
) bool {
	if len(actual.KeySchema) != len(wanted.KeySchema) {
		return false
	}
	for index := range actual.KeySchema {
		name := aws.ToString(actual.KeySchema[index].AttributeName)
		if name != wanted.KeySchema[index].AttributeName ||
			string(actual.KeySchema[index].KeyType) != wanted.KeySchema[index].KeyType {
			return false
		}
		if actualTypes[name] != wantedTypes[wanted.KeySchema[index].AttributeName] {
			return false
		}
	}
	if actual.Projection == nil {
		return wanted.Projection.ProjectionType == ""
	}
	if string(actual.Projection.ProjectionType) != wanted.Projection.ProjectionType {
		return false
	}
	if len(actual.Projection.NonKeyAttributes) != len(wanted.Projection.NonKeyAttributes) {
		return false
	}
	for index := range actual.Projection.NonKeyAttributes {
		if actual.Projection.NonKeyAttributes[index] != wanted.Projection.NonKeyAttributes[index] {
			return false
		}
	}
	return true
}

func waitForIndexActive(ctx context.Context, client *dynamodb.Client, table, index string) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		out, err := client.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(table)})
		if err != nil {
			return fmt.Errorf("describe table %s while waiting for index %s: %w", table, index, err)
		}
		for _, candidate := range out.Table.GlobalSecondaryIndexes {
			if aws.ToString(candidate.IndexName) == index {
				if candidate.IndexStatus == types.IndexStatusActive {
					return nil
				}
				break
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("global secondary index %s on table %s did not become ACTIVE", index, table)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func attributeType(definitions []dynamoAttributeDefinition, name string) (string, bool) {
	for _, definition := range definitions {
		if definition.AttributeName == name {
			return definition.AttributeType, true
		}
	}
	return "", false
}

func maxInt64(value, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}

type sqsQueueProperties struct {
	QueueName                     string          `json:"QueueName"`
	VisibilityTimeout             int             `json:"VisibilityTimeout"`
	MessageRetentionPeriod        int             `json:"MessageRetentionPeriod"`
	ReceiveMessageWaitTimeSeconds int             `json:"ReceiveMessageWaitTimeSeconds"`
	DelaySeconds                  int             `json:"DelaySeconds"`
	FifoQueue                     bool            `json:"FifoQueue"`
	ContentBasedDeduplication     bool            `json:"ContentBasedDeduplication"`
	RedrivePolicy                 json.RawMessage `json:"RedrivePolicy"`
}

func (r *Runner) provisionQueues(ctx context.Context, spec *Spec) error {
	backend, networkEndpoint, client, err := r.sqsProvisioner()
	if err != nil || client == nil {
		return err
	}
	for _, resource := range spec.Resources {
		if resource.Type != typeSQSQueue {
			continue
		}
		if err := r.provisionQueue(ctx, client, networkEndpoint, resource); err != nil {
			return err
		}
	}
	return r.applyRedrivePolicies(ctx, client, backend, spec)
}

func (r *Runner) sqsProvisioner() (backendProcess, Endpoint, *sqs.Client, error) {
	backend, ok := r.backendForService(backendSQS)
	if !ok {
		return backendProcess{}, Endpoint{}, nil, nil
	}
	if backend.HostURL == "" {
		return backendProcess{}, Endpoint{}, nil, fmt.Errorf("the sqs backend has no loopback endpoint for the runner to provision queues")
	}
	networkEndpoint, ok := endpointForService(backend.Endpoints, backendSQS)
	if !ok {
		return backendProcess{}, Endpoint{}, nil, fmt.Errorf("the sqs backend has no network endpoint for function containers")
	}
	return backend, networkEndpoint, newSQSClient(backend.HostURL), nil
}

func (r *Runner) provisionQueue(ctx context.Context, client *sqs.Client, networkEndpoint Endpoint, resource ResourceSpec) error {
	var props sqsQueueProperties
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("parse SQS queue %s properties: %w", resource.LogicalID, err)
		}
	}
	name, err := resourceName(resource)
	if err != nil {
		return err
	}
	created, err := client.CreateQueue(ctx, &sqs.CreateQueueInput{
		QueueName:  aws.String(name),
		Attributes: queueAttributes(props),
	})
	existed := err != nil && queueAlreadyExists(err)
	if err != nil && !existed {
		return fmt.Errorf("create local SQS queue %s for %s: %w", name, resource.LogicalID, err)
	}
	queueURL := ""
	if created != nil {
		queueURL = aws.ToString(created.QueueUrl)
	}
	if queueURL == "" {
		found, findErr := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(name)})
		if findErr != nil {
			return fmt.Errorf("find local SQS queue %s for %s: %w", name, resource.LogicalID, findErr)
		}
		queueURL = aws.ToString(found.QueueUrl)
	}
	if existed && r.dataDir != "" {
		// Reconcile the re-runnable attributes on a queue that already holds
		// messages. CreateQueue is idempotent only when the attribute list
		// matches, so an explicit SetQueueAttributes applies a definition change
		// without deleting the queue. FifoQueue and ContentBasedDeduplication
		// are creation-time attributes and are not changed here.
		attributes := queueAttributes(props)
		delete(attributes, string(sqstypes.QueueAttributeNameFifoQueue))
		delete(attributes, string(sqstypes.QueueAttributeNameContentBasedDeduplication))
		if len(attributes) > 0 {
			if _, setErr := client.SetQueueAttributes(ctx, &sqs.SetQueueAttributesInput{
				QueueUrl:   aws.String(queueURL),
				Attributes: attributes,
			}); setErr != nil {
				return fmt.Errorf("reconcile local SQS queue %s for %s: %w", name, resource.LogicalID, setErr)
			}
		}
	}
	networkURL, err := rewriteQueueURL(queueURL, networkEndpoint.URL)
	if err != nil {
		return fmt.Errorf("rewrite local SQS queue %s URL: %w", name, err)
	}
	r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
		Type: typeSQSQueue,
		Name: name,
		URL:  networkURL,
		ARN:  localSourceARN(backendSQS, name),
	}
	r.logf("provisioned SQS queue %s for %s", name, resource.LogicalID)
	return nil
}

// applyRedrivePolicies sets redrive after every queue exists. ElasticMQ
// rewrites the ARN to its own local account; the policy is still the
// template's maxReceiveCount and target.
func (r *Runner) applyRedrivePolicies(ctx context.Context, client *sqs.Client, backend backendProcess, spec *Spec) error {
	for _, resource := range spec.Resources {
		if resource.Type != typeSQSQueue || len(resource.Properties) == 0 {
			continue
		}
		var props sqsQueueProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("parse SQS queue %s properties: %w", resource.LogicalID, err)
		}
		if len(props.RedrivePolicy) == 0 {
			continue
		}
		value, ok := r.resourceValues[resource.Stack+"/"+resource.LogicalID]
		if !ok {
			return fmt.Errorf("SQS queue %s was not provisioned", resource.LogicalID)
		}
		policy, err := r.redrivePolicy(resource, props.RedrivePolicy)
		if err != nil {
			return err
		}
		hostURL, err := hostQueueURL(value.URL, backend.HostURL)
		if err != nil {
			return fmt.Errorf("rewrite local SQS queue %s URL for the runner: %w", value.Name, err)
		}
		if _, err := client.SetQueueAttributes(ctx, &sqs.SetQueueAttributesInput{
			QueueUrl:   aws.String(hostURL),
			Attributes: policy,
		}); err != nil {
			return fmt.Errorf("set redrive policy on local SQS queue %s: %w", value.Name, err)
		}
	}
	return nil
}

func (r *Runner) redrivePolicy(resource ResourceSpec, raw json.RawMessage) (map[string]string, error) {
	var policy struct {
		DeadLetterTargetARN json.RawMessage `json:"deadLetterTargetArn"`
		MaxReceiveCount     json.RawMessage `json:"maxReceiveCount"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return nil, fmt.Errorf("parse SQS queue %s redrive policy: %w", resource.LogicalID, err)
	}
	refs := refsIn(policy.DeadLetterTargetARN)
	if len(refs) == 0 {
		return nil, fmt.Errorf("SQS queue %s redrive policy has no dead-letter queue reference", resource.LogicalID)
	}
	target, ok := r.resourceValues[resource.Stack+"/"+refs[0].ID]
	if !ok {
		return nil, fmt.Errorf("SQS queue %s redrive target %s was not provisioned", resource.LogicalID, refs[0].ID)
	}
	count, err := parseIntJSON(policy.MaxReceiveCount)
	if err != nil || count <= 0 {
		return nil, fmt.Errorf("SQS queue %s redrive maxReceiveCount is invalid", resource.LogicalID)
	}
	encoded, err := json.Marshal(map[string]any{
		"deadLetterTargetArn": target.ARN,
		"maxReceiveCount":     count,
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"RedrivePolicy": string(encoded)}, nil
}

func parseIntJSON(raw json.RawMessage) (int, error) {
	var number int
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(text))
}

func queueAttributes(props sqsQueueProperties) map[string]string {
	attributes := map[string]string{}
	if props.VisibilityTimeout > 0 {
		attributes[string(sqstypes.QueueAttributeNameVisibilityTimeout)] = strconv.Itoa(props.VisibilityTimeout)
	}
	if props.MessageRetentionPeriod > 0 {
		attributes[string(sqstypes.QueueAttributeNameMessageRetentionPeriod)] = strconv.Itoa(props.MessageRetentionPeriod)
	}
	if props.ReceiveMessageWaitTimeSeconds > 0 {
		attributes[string(sqstypes.QueueAttributeNameReceiveMessageWaitTimeSeconds)] = strconv.Itoa(props.ReceiveMessageWaitTimeSeconds)
	}
	if props.DelaySeconds > 0 {
		attributes[string(sqstypes.QueueAttributeNameDelaySeconds)] = strconv.Itoa(props.DelaySeconds)
	}
	if props.FifoQueue {
		attributes[string(sqstypes.QueueAttributeNameFifoQueue)] = boolTrue
	}
	if props.ContentBasedDeduplication {
		attributes[string(sqstypes.QueueAttributeNameContentBasedDeduplication)] = boolTrue
	}
	return attributes
}

func endpointForService(endpoints []Endpoint, service string) (Endpoint, bool) {
	for _, endpoint := range endpoints {
		if endpoint.Service == service {
			return endpoint, true
		}
	}
	return Endpoint{}, false
}

func rewriteQueueURL(raw, base string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	target, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return "", err
	}
	if target.Scheme == "" || target.Host == "" {
		return "", fmt.Errorf("base endpoint %q is not an absolute URL", base)
	}
	parsed.Scheme = target.Scheme
	parsed.Host = target.Host
	return parsed.String(), nil
}

func hostQueueURL(networkURL, hostBase string) (string, error) {
	return rewriteQueueURL(networkURL, hostBase)
}

func tableAlreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "resourceinuseexception") || strings.Contains(message, "table already exists")
}

func ttlAlreadyEnabled(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "timetolivealreadyenabled") ||
		strings.Contains(message, "timetolive is already enabled") ||
		strings.Contains(message, "time to live is already enabled")
}

func queueAlreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "queuealreadyexists") || strings.Contains(message, "queue already exists") ||
		strings.Contains(message, "queueexists")
}

func resourceDescription(resource ResourceSpec) (string, error) {
	var props struct {
		Description string `json:"Description"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return "", fmt.Errorf("parse KMS key %s properties: %w", resource.LogicalID, err)
		}
	}
	description := strings.TrimSpace(props.Description)
	if description == "" {
		description = "AppTheory local key " + resource.LogicalID
	}
	return description, nil
}

func alreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "bucketalreadyownedbyyou") ||
		strings.Contains(message, "bucketalreadyexists")
}

// backendForService returns the running backend that provides a service.
func (r *Runner) backendForService(service string) (backendProcess, bool) {
	for _, backend := range r.backends {
		for _, endpoint := range backend.Endpoints {
			if endpoint.Service == service {
				return backend, true
			}
		}
	}
	return backendProcess{}, false
}
