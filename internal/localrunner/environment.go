package localrunner

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// resourceValue is a local value the runner derived (or provisioned) for one
// template resource. Empty fields mean the value is unavailable.
type resourceValue struct {
	Type      string
	Name      string
	ARN       string
	KeyID     string
	URL       string
	StreamARN string
}

// keySchemaAttribute is one provisioned DynamoDB key attribute.
type keySchemaAttribute struct {
	Name string
	Type string
}

// tableInfo is the provisioned state a session needs to read and write a table
// and to build a DynamoDB stream record from the stored image.
type tableInfo struct {
	Name           string
	KeySchema      []keySchemaAttribute
	StreamARN      string
	StreamViewType string
}

// resolveEnvironment replaces every supported CloudFormation expression in a
// served function's environment with a deterministic local value. An
// unsupported or unavailable reference fails closed: the runner never injects
// an empty or invented AWS value.
func (r *Runner) resolveEnvironment(spec *Spec, targets []string) error {
	resources := spec.resourceIndex()
	provisioned := r.resourceValues
	if provisioned == nil {
		provisioned = map[string]resourceValue{}
	}
	served := map[string]struct{}{}
	for _, id := range targets {
		served[id] = struct{}{}
	}
	for index := range spec.Functions {
		function := &spec.Functions[index]
		if _, ok := served[function.LogicalID]; !ok {
			continue
		}
		if len(function.EnvironmentExpressions) > 0 {
			for name, raw := range function.EnvironmentExpressions {
				value, err := r.resolveExpression(raw, function.Stack, resources, provisioned)
				if err != nil {
					return fmt.Errorf("function %s: environment %s: %w", function.LogicalID, name, err)
				}
				function.Environment[name] = value
			}
		}
		for name, value := range function.Environment {
			resolved, err := r.resolveDynamicSecret(function.LogicalID, name, value)
			if err != nil {
				return fmt.Errorf("function %s: environment %s: %w", function.LogicalID, name, err)
			}
			function.Environment[name] = resolved
		}
		function.UnresolvedEnvironment = nil
		function.EnvironmentExpressions = nil
	}
	return nil
}

// resourceValues holds the values provisioning created in the local backends,
// keyed by "stack/logicalId".
type resourceValues map[string]resourceValue

// resourceIndex groups a spec's resources by stack and logical id.
func (s *Spec) resourceIndex() map[string]map[string]ResourceSpec {
	index := map[string]map[string]ResourceSpec{}
	for _, resource := range s.Resources {
		byID := index[resource.Stack]
		if byID == nil {
			byID = map[string]ResourceSpec{}
			index[resource.Stack] = byID
		}
		byID[resource.LogicalID] = resource
	}
	return index
}

func (r *Runner) resolveExpression(raw, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues) (string, error) {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "", fmt.Errorf("expression is not valid JSON: %w", err)
	}
	return r.evaluate(value, stack, resources, provisioned)
}

func (r *Runner) evaluate(value any, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues) (string, error) {
	switch typed := value.(type) {
	case string:
		return typed, nil
	case map[string]any:
		if id, ok := typed["Ref"].(string); ok && id != "" {
			return r.resolveRef(id, stack, resources, provisioned)
		}
		if rawGetAtt, ok := typed["Fn::GetAtt"]; ok {
			id, attr, err := parseGetAtt(rawGetAtt)
			if err != nil {
				return "", err
			}
			return r.resolveGetAtt(id, attr, stack, resources, provisioned)
		}
		if rawJoin, ok := typed["Fn::Join"]; ok {
			return r.resolveJoin(rawJoin, stack, resources, provisioned)
		}
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		return "", fmt.Errorf("unsupported CloudFormation expression (%s)", strings.Join(keys, ", "))
	default:
		return "", fmt.Errorf("unsupported environment value type %T", value)
	}
}

func (r *Runner) resolveJoin(raw any, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues) (string, error) {
	parts, ok := raw.([]any)
	if !ok || len(parts) != 2 {
		return "", fmt.Errorf("Fn::Join must be [delimiter, parts]")
	}
	delimiter, ok := parts[0].(string)
	if !ok {
		return "", fmt.Errorf("Fn::Join delimiter must be a string")
	}
	items, ok := parts[1].([]any)
	if !ok {
		return "", fmt.Errorf("Fn::Join parts must be an array")
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		value, err := r.evaluate(item, stack, resources, provisioned)
		if err != nil {
			return "", err
		}
		values = append(values, value)
	}
	return strings.Join(values, delimiter), nil
}

func (r *Runner) resolveRef(id, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues) (string, error) {
	switch id {
	case "AWS::Partition":
		return LocalPartition, nil
	case "AWS::Region":
		return LocalRegion, nil
	case "AWS::AccountId":
		return LocalAccountID, nil
	case "AWS::StackName":
		return stack, nil
	case "AWS::NoValue":
		return "", nil
	}
	resource, ok := resources[stack][id]
	if !ok {
		return "", fmt.Errorf("ref %s names no resource in stack %s", id, stack)
	}
	value, err := r.localResourceValue(resource, provisioned)
	if err != nil {
		return "", err
	}
	switch resource.Type {
	case typeKMSKey:
		return value.KeyID, nil
	case typeSQSQueue:
		return value.URL, nil
	case typeSecretsSecret:
		return value.ARN, nil
	case typeS3Bucket, typeDynamoTable, typeEventsRule, typeLambdaFunction, typeKinesisStream:
		return value.Name, nil
	default:
		return "", fmt.Errorf("ref to %s (%s) is not resolvable locally", id, resource.Type)
	}
}

func (r *Runner) resolveGetAtt(id, attr, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues) (string, error) {
	resource, ok := resources[stack][id]
	if !ok {
		return "", fmt.Errorf("Fn::GetAtt %s names no resource in stack %s", id, stack)
	}
	value, err := r.localResourceValue(resource, provisioned)
	if err != nil {
		return "", err
	}
	if resolved, ok := value.attribute(attr); ok {
		return resolved, nil
	}
	return "", fmt.Errorf("Fn::GetAtt %s.%s is not resolvable locally for %s", id, attr, resource.Type)
}

const attrArn = "Arn"

// attribute returns the GetAtt attributes the local resource value supports.
func (v resourceValue) attribute(attr string) (string, bool) {
	switch attr {
	case attrArn, "ImageArn", "IndexArn":
		return v.ARN, v.ARN != ""
	case "Name", "QueueName", "FunctionName", "RoleName":
		return v.Name, v.Name != ""
	case "KeyId":
		return v.KeyID, v.KeyID != ""
	case "QueueUrl":
		return v.URL, v.URL != ""
	case "StreamArn":
		return v.StreamARN, v.StreamARN != ""
	case "ApiEndpoint":
		return v.URL, v.URL != ""
	case "DomainName":
		return v.Name + ".s3.amazonaws.com", v.Name != ""
	case "RegionalDomainName":
		return v.Name + ".s3." + LocalRegion + ".amazonaws.com", v.Name != ""
	default:
		return "", false
	}
}

// localResourceValue derives the deterministic local name for a resource and,
// for a KMS key, S3 bucket, DynamoDB table or SQS queue the run started a
// backend for, the value provisioning created.
//
//nolint:gocyclo // one case per supported template resource type.
func (r *Runner) localResourceValue(resource ResourceSpec, provisioned resourceValues) (resourceValue, error) {
	key := resource.Stack + "/" + resource.LogicalID
	if value, ok := provisioned[key]; ok {
		return value, nil
	}
	name, err := resourceName(resource)
	if err != nil {
		return resourceValue{}, err
	}
	value := resourceValue{Type: resource.Type, Name: name}
	switch resource.Type {
	case typeKMSKey:
		return resourceValue{}, fmt.Errorf(
			"%s is a KMS key; start the moto backend (--backend moto) so the runner can create the key",
			resource.LogicalID,
		)
	case typeS3Bucket:
		return resourceValue{}, fmt.Errorf(
			"%s is an S3 bucket; start the s3proxy backend (--backend s3proxy) so the runner can create the bucket",
			resource.LogicalID,
		)
	case typeSQSQueue:
		value.URL = r.queueURL(name)
		value.ARN = "arn:" + LocalPartition + ":sqs:" + LocalRegion + ":" + LocalAccountID + ":" + name
	case typeDynamoTable:
		value.ARN = "arn:" + LocalPartition + ":dynamodb:" + LocalRegion + ":" + LocalAccountID + ":table/" + name
		value.StreamARN = value.ARN + "/stream/local"
	case typeEventsRule:
		value.ARN = "arn:" + LocalPartition + ":events:" + LocalRegion + ":" + LocalAccountID + ":rule/" + name
	case typeKinesisStream:
		value.ARN = "arn:" + LocalPartition + ":kinesis:" + LocalRegion + ":" + LocalAccountID + ":stream/" + name
	case typeSecretsSecret:
		value.Name = "local-secret-" + stableHash(resource.Stack+"/"+resource.LogicalID, 24)
		value.ARN = "arn:" + LocalPartition + ":secretsmanager:" + LocalRegion + ":" + LocalAccountID + ":secret:" + value.Name
	case typeIAMRole:
		value.ARN = "arn:" + LocalPartition + ":iam::" + LocalAccountID + ":role/" + name
	case typeMicrovmImage:
		value.ARN = "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":microvm-image:" + name
	case typeS3VectorsIndex:
		indexARN, err := s3VectorsIndexARN(resource)
		if err != nil {
			return resourceValue{}, err
		}
		value.ARN = indexARN
	case typeHTTPAPI:
		value.URL = ClosedEndpoint
	case typeLambdaFunction:
		value.ARN = "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":function:" + name
	}
	return value, nil
}

func s3VectorsIndexARN(resource ResourceSpec) (string, error) {
	var props struct {
		VectorBucketName string `json:"VectorBucketName"`
		IndexName        string `json:"IndexName"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return "", fmt.Errorf("parse S3 Vectors index %s properties: %w", resource.LogicalID, err)
		}
	}
	if strings.TrimSpace(props.VectorBucketName) == "" || strings.TrimSpace(props.IndexName) == "" {
		return "", fmt.Errorf("S3 Vectors index %s does not declare VectorBucketName and IndexName", resource.LogicalID)
	}
	return "arn:" + LocalPartition + ":s3vectors:" + LocalRegion + ":" + LocalAccountID +
		":bucket/" + props.VectorBucketName + "/index/" + props.IndexName, nil
}

func stableHash(value string, length int) string {
	sum := sha256.Sum256([]byte(value))
	encoded := hex.EncodeToString(sum[:])
	if length > 0 && length < len(encoded) {
		return encoded[:length]
	}
	return encoded
}

// resolveDynamicSecret replaces a deploy-time Secrets Manager dynamic reference
// with a deterministic local secret. The value is recorded for the session's
// describe operation, never written to a log or a plan document.
func (r *Runner) resolveDynamicSecret(functionID, name, value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if !strings.Contains(trimmed, "{{resolve:") {
		return value, nil
	}
	if !strings.HasPrefix(trimmed, "{{resolve:secretsmanager:") || !strings.HasSuffix(trimmed, "}}") {
		return "", fmt.Errorf("dynamic reference %q is not a Secrets Manager secret the runner can resolve locally", trimmed)
	}
	secret := "local-secret-" + stableHash(trimmed, 24)
	if r.localSecrets == nil {
		r.localSecrets = map[string]string{}
	}
	r.localSecrets[name] = secret
	r.logf("function %s: resolved deploy-time secret %s locally", functionID, name)
	return secret, nil
}

func (r *Runner) queueURL(name string) string {
	base := ClosedEndpoint
	for _, endpoint := range r.endpoints {
		if endpoint.Service == backendSQS {
			base = strings.TrimSuffix(endpoint.URL, "/")
			break
		}
	}
	return fmt.Sprintf("%s/%s/%s", base, LocalAccountID, name)
}

// resourceName returns the template's literal physical name when it has one,
// otherwise a deterministic local name.
func resourceName(resource ResourceSpec) (string, error) {
	if literal := literalPhysicalName(resource); literal != "" {
		return literal, nil
	}
	return localPhysicalName(resource.Stack, resource.LogicalID), nil
}

func literalPhysicalName(resource ResourceSpec) string {
	var props struct {
		TableName    string `json:"TableName"`
		QueueName    string `json:"QueueName"`
		BucketName   string `json:"BucketName"`
		Name         string `json:"Name"`
		FunctionName string `json:"FunctionName"`
		LogGroupName string `json:"LogGroupName"`
	}
	if len(resource.Properties) == 0 {
		return ""
	}
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return ""
	}
	for _, candidate := range []string{props.TableName, props.QueueName, props.BucketName, props.Name, props.FunctionName, props.LogGroupName} {
		if strings.TrimSpace(candidate) != "" {
			return candidate
		}
	}
	return ""
}

// localPhysicalName builds a deterministic name that is valid for DynamoDB
// tables, SQS queues, EventBridge rules and S3 buckets.
func localPhysicalName(stack, logicalID string) string {
	raw := strings.ToLower("local-" + stack + "-" + logicalID)
	var builder strings.Builder
	for _, char := range raw {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9', char == '-':
			builder.WriteRune(char)
		default:
			builder.WriteByte('-')
		}
	}
	name := strings.Trim(builder.String(), "-")
	if len(name) < 3 {
		name = "local-" + name
	}
	if len(name) > 60 {
		name = name[:49] + "-" + localPhysicalID("resource", stack+"/"+logicalID)
	}
	return name
}

func parseGetAtt(raw any) (string, string, error) {
	switch typed := raw.(type) {
	case []any:
		if len(typed) != 2 {
			return "", "", fmt.Errorf("Fn::GetAtt must have two elements")
		}
		id, ok := typed[0].(string)
		if !ok || id == "" {
			return "", "", fmt.Errorf("Fn::GetAtt resource id must be a string")
		}
		attr, ok := typed[1].(string)
		if !ok {
			return "", "", fmt.Errorf("Fn::GetAtt attribute must be a string")
		}
		return id, attr, nil
	case string:
		id, attr, found := strings.Cut(typed, ".")
		if !found || id == "" || attr == "" {
			return "", "", fmt.Errorf("Fn::GetAtt %q must be resource.attribute", typed)
		}
		return id, attr, nil
	default:
		return "", "", fmt.Errorf("Fn::GetAtt must be an array or string")
	}
}
