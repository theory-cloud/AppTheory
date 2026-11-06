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
	// ProviderName and ProviderURL are the Cognito user pool GetAtt values.
	// LocalIssuer is the loopback issuer the runner serves for the same pool.
	ProviderName string
	ProviderURL  string
	LocalIssuer  string
	// SSMType and SSMValue are the AWS::SSM::Parameter GetAtt values.
	SSMType  string
	SSMValue string
	// ClientSecret is the Cognito user pool client GetAtt value when the client
	// has a generated secret.
	ClientSecret string
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
			template := spec.Templates[function.Stack]
			for name, raw := range function.EnvironmentExpressions {
				value, err := r.resolveExpressionWithTemplate(raw, function.Stack, resources, provisioned, template)
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

// resolveExpression is the template-free form the existing callers use; a
// template context adds parameter, condition and mapping resolution.
func (r *Runner) resolveExpression(raw, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues) (string, error) {
	return r.resolveExpressionWithTemplate(raw, stack, resources, provisioned, templateContext{})
}

func (r *Runner) resolveExpressionWithTemplate(raw, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues, template templateContext) (string, error) {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "", fmt.Errorf("expression is not valid JSON: %w", err)
	}
	return r.evaluate(value, stack, resources, provisioned, template)
}

func (r *Runner) evaluate(value any, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues, template templateContext) (string, error) {
	switch typed := value.(type) {
	case string:
		return typed, nil
	case map[string]any:
		if id, ok := typed["Ref"].(string); ok && id != "" {
			return r.resolveRef(id, stack, resources, provisioned, template)
		}
		if rawIf, ok := typed["Fn::If"]; ok {
			return r.resolveIf(rawIf, stack, resources, provisioned, template)
		}
		if rawMap, ok := typed["Fn::FindInMap"]; ok {
			resolved, err := template.findInMap(rawMap)
			if err != nil {
				return "", err
			}
			text, ok := templateString(resolved)
			if !ok {
				return "", fmt.Errorf("Fn::FindInMap resolved to a non-string value")
			}
			return text, nil
		}
		if rawGetAtt, ok := typed["Fn::GetAtt"]; ok {
			id, attr, err := parseGetAtt(rawGetAtt)
			if err != nil {
				return "", err
			}
			return r.resolveGetAtt(id, attr, stack, resources, provisioned)
		}
		if rawJoin, ok := typed["Fn::Join"]; ok {
			return r.resolveJoin(rawJoin, stack, resources, provisioned, template)
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

func (r *Runner) resolveIf(raw any, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues, template templateContext) (string, error) {
	parts, ok := raw.([]any)
	if !ok || len(parts) != 3 {
		return "", fmt.Errorf("Fn::If must be [condition, true value, false value]")
	}
	name, ok := parts[0].(string)
	if !ok || name == "" {
		return "", fmt.Errorf("Fn::If condition must be a condition name")
	}
	condition, err := template.condition(name)
	if err != nil {
		return "", err
	}
	if condition {
		return r.evaluate(parts[1], stack, resources, provisioned, template)
	}
	return r.evaluate(parts[2], stack, resources, provisioned, template)
}

func (r *Runner) resolveJoin(raw any, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues, template templateContext) (string, error) {
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
		value, err := r.evaluate(item, stack, resources, provisioned, template)
		if err != nil {
			return "", err
		}
		values = append(values, value)
	}
	return strings.Join(values, delimiter), nil
}

//nolint:gocyclo // one branch per resource type.
func (r *Runner) resolveRef(id, stack string, resources map[string]map[string]ResourceSpec, provisioned resourceValues, template templateContext) (string, error) {
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
	if _, ok := template.Parameters[id]; ok {
		value, err := template.refValue(id)
		if err != nil {
			return "", err
		}
		text, ok := templateString(value)
		if !ok {
			return "", fmt.Errorf("parameter %s is not a string value", id)
		}
		return text, nil
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
	case typeKMSAlias:
		return value.Name, nil
	case typeSQSQueue:
		return value.URL, nil
	case typeSecretsSecret, typeSNSTopic:
		return value.ARN, nil
	case typeSSMParameter, typeCognitoUserPool, typeCognitoClient,
		typeS3Bucket, typeDynamoTable, typeEventsRule, typeEventsBus, typeLambdaFunction, typeKinesisStream:
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
	case attrArn, "ImageArn", "IndexArn", "TopicArn":
		return v.ARN, v.ARN != ""
	case "Name", "QueueName", "FunctionName", "RoleName", "TopicName":
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
	case "ProviderName":
		return v.ProviderName, v.ProviderName != ""
	case "ProviderURL":
		return v.ProviderURL, v.ProviderURL != ""
	case "Type":
		return v.SSMType, v.SSMType != ""
	case "Value":
		return v.SSMValue, v.SSMValue != ""
	case "ClientSecret":
		return v.ClientSecret, v.ClientSecret != ""
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
	case typeKMSAlias:
		return resourceValue{}, fmt.Errorf(
			"%s is a KMS alias; start the moto backend (--backend moto) so the runner can create the key and alias",
			resource.LogicalID,
		)
	case typeSSMParameter:
		value.Name = ssmParameterName(resource)
		value.SSMType, value.SSMValue = ssmParameterProperties(resource)
		value.ARN = "arn:" + LocalPartition + ":ssm:" + LocalRegion + ":" + LocalAccountID + ":parameter/" +
			strings.TrimPrefix(value.Name, "/")
	case typeCognitoUserPool, typeCognitoClient:
		return resourceValue{}, fmt.Errorf(
			"%s is %s; start the moto backend (--backend moto) so the runner can create the user pool",
			resource.LogicalID,
			resource.Type,
		)
	case typeSNSTopic:
		value.ARN = "arn:" + LocalPartition + ":sns:" + LocalRegion + ":" + LocalAccountID + ":" + value.Name
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
	case typeLogGroup:
		value.ARN = "arn:" + LocalPartition + ":logs:" + LocalRegion + ":" + LocalAccountID + ":log-group:" + name + ":*"
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

// ssmParameterName returns the parameter name a template declares, or a
// deterministic local name. Parameter names must start with a slash:
// https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-paramstore-su-create.html
func ssmParameterName(resource ResourceSpec) string {
	name, err := resourceName(resource)
	if err != nil || name == "" {
		name = localPhysicalName(resource.Stack, resource.LogicalID)
	}
	if strings.HasPrefix(name, "/") {
		return name
	}
	return "/" + name
}

// ssmParameterProperties reads the literal Type and Value of an
// AWS::SSM::Parameter. A Value that is a CloudFormation expression is resolved
// during provisioning, where the rest of the assembly is available.
func ssmParameterProperties(resource ResourceSpec) (string, string) {
	var props struct {
		Type  string `json:"Type"`
		Value string `json:"Value"`
	}
	if len(resource.Properties) > 0 {
		_ = json.Unmarshal(resource.Properties, &props) //nolint:errcheck // an unparseable property is reported by provisioning
	}
	parameterType := strings.TrimSpace(props.Type)
	if parameterType == "" {
		parameterType = "String"
	}
	return parameterType, props.Value
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
	if resolved, ok := r.provisionedDynamicSecret(trimmed); ok {
		if r.localSecrets == nil {
			r.localSecrets = map[string]string{}
		}
		r.localSecrets[name] = resolved
		r.logf("function %s: resolved deploy-time secret %s from the provisioned secret", functionID, name)
		return resolved, nil
	}
	secret := "local-secret-" + stableHash(trimmed, 24)
	if r.localSecrets == nil {
		r.localSecrets = map[string]string{}
	}
	r.localSecrets[name] = secret
	r.logf("function %s: resolved deploy-time secret %s locally", functionID, name)
	return secret, nil
}

// provisionedDynamicSecret resolves a {{resolve:secretsmanager:...}} reference
// against a secret this run provisioned. The reference form is
// {{resolve:secretsmanager:secret-id:secret-string:json-key:version-stage:version-id}}:
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/dynamic-references.html
// The wave-1 placeholder is kept for a reference with no provisioned secret, so
// an existing caller sees no change.
func (r *Runner) provisionedDynamicSecret(reference string) (string, bool) {
	body := strings.TrimSuffix(strings.TrimPrefix(reference, "{{resolve:secretsmanager:"), "}}")
	// The secret id is an ARN and contains colons; the four segments after it
	// are secret-string, json-key, version-stage and version-id.
	parts := strings.Split(body, ":")
	if len(parts) < 5 {
		return "", false
	}
	secretID := strings.TrimSpace(strings.Join(parts[:len(parts)-4], ":"))
	value, ok := r.secretValues[secretID]
	if !ok {
		for key, candidate := range r.secretValues {
			if key == secretID || strings.HasSuffix(key, ":"+secretID) {
				value, ok = candidate, true
				break
			}
		}
	}
	if !ok {
		return "", false
	}
	jsonKey := strings.TrimSpace(parts[len(parts)-3])
	if jsonKey == "" {
		return value, true
	}
	var object map[string]any
	if err := json.Unmarshal([]byte(value), &object); err != nil {
		return "", false
	}
	switch typed := object[jsonKey].(type) {
	case string:
		return typed, true
	case float64, bool:
		return fmt.Sprint(typed), true
	default:
		return "", false
	}
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
		TopicName    string `json:"TopicName"`
		UserPoolName string `json:"UserPoolName"`
		ClientName   string `json:"ClientName"`
		AliasName    string `json:"AliasName"`
	}
	if len(resource.Properties) == 0 {
		return ""
	}
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return ""
	}
	for _, candidate := range []string{
		props.TableName,
		props.QueueName,
		props.BucketName,
		props.Name,
		props.FunctionName,
		props.LogGroupName,
		props.TopicName,
		props.UserPoolName,
		props.ClientName,
		props.AliasName,
	} {
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
