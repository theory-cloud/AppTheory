package localrunner

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	cognitotypes "github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"
	kinestypes "github.com/aws/aws-sdk-go-v2/service/kinesis/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

// The moto-backed services are provisioned from the same cloud assembly as the
// DynamoDB, SQS, S3 and KMS resources wave 1 created. Each Create call is the
// documented CloudFormation create for its resource; the reference each
// template resolves is the resource's documented return value:
//
//   - AWS::SSM::Parameter: Ref = parameter name, GetAtt Type/Value.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ssm-parameter.html
//   - AWS::SecretsManager::Secret: Ref = secret ARN.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html
//   - AWS::SNS::Topic: Ref = topic ARN, GetAtt TopicName/TopicArn.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-topic.html
//   - AWS::Kinesis::Stream: Ref = stream name, GetAtt Arn.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kinesis-stream.html
//   - AWS::Cognito::UserPool: Ref = pool id, GetAtt Arn/ProviderName/ProviderURL.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html
//   - AWS::Cognito::UserPoolClient: Ref = client id.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolclient.html
//   - AWS::KMS::Alias: Ref = alias name.
//     https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kms-alias.html

// provisionSSMParameters creates one parameter per AWS::SSM::Parameter through
// moto's SSM API. SecureString is created with the same PutParameter call; moto
// returns it with WithDecryption, which is the local counterpart of the default
// aws/ssm KMS key. The runner never stores a decrypted value in plan output.
//
//nolint:gocyclo // one branch per declared parameter type and its error path.
func (r *Runner) provisionSSMParameters(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService(backendSSM)
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the ssm backend has no loopback endpoint for the runner to provision parameters")
	}
	client := newSSMClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeSSMParameter {
			continue
		}
		var props struct {
			Name        string          `json:"Name"`
			Type        string          `json:"Type"`
			Value       json.RawMessage `json:"Value"`
			Description string          `json:"Description"`
			Tier        string          `json:"Tier"`
			DataType    string          `json:"DataType"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse SSM parameter %s properties: %w", resource.LogicalID, err)
			}
		}
		name := strings.TrimSpace(props.Name)
		if name == "" {
			name = ssmParameterName(resource)
		}
		if !strings.HasPrefix(name, "/") {
			return fmt.Errorf("SSM parameter %s name %q must start with /", resource.LogicalID, name)
		}
		parameterType := strings.TrimSpace(props.Type)
		if parameterType == "" {
			parameterType = string(ssmtypes.ParameterTypeString)
		}
		switch ssmtypes.ParameterType(parameterType) {
		case ssmtypes.ParameterTypeString, ssmtypes.ParameterTypeStringList, ssmtypes.ParameterTypeSecureString:
		default:
			return fmt.Errorf("SSM parameter %s has unsupported Type %q", resource.LogicalID, parameterType)
		}
		value, err := r.resolveProvisionString(props.Value, resource.Stack, spec)
		if err != nil {
			return fmt.Errorf("SSM parameter %s Value: %w", resource.LogicalID, err)
		}
		if value == "" {
			return fmt.Errorf("SSM parameter %s has no Value", resource.LogicalID)
		}
		input := &ssm.PutParameterInput{
			Name:      aws.String(name),
			Value:     aws.String(value),
			Type:      ssmtypes.ParameterType(parameterType),
			Overwrite: aws.Bool(true),
		}
		if description := strings.TrimSpace(props.Description); description != "" {
			input.Description = aws.String(description)
		}
		if tier := strings.TrimSpace(props.Tier); tier != "" {
			input.Tier = ssmtypes.ParameterTier(tier)
		}
		if dataType := strings.TrimSpace(props.DataType); dataType != "" {
			input.DataType = aws.String(dataType)
		}
		if _, err := client.PutParameter(ctx, input); err != nil {
			return fmt.Errorf("create local SSM parameter %s for %s: %w", name, resource.LogicalID, err)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type:     typeSSMParameter,
			Name:     name,
			ARN:      "arn:" + LocalPartition + ":ssm:" + LocalRegion + ":" + LocalAccountID + ":parameter/" + strings.TrimPrefix(name, "/"),
			SSMType:  parameterType,
			SSMValue: value,
		}
		r.logf("provisioned SSM parameter %s (%s) for %s", name, parameterType, resource.LogicalID)
	}
	return nil
}

// secretProperties is the subset of AWS::SecretsManager::Secret the runner
// implements. GenerateSecretString follows
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-secretsmanager-secret-generatesecretstring.html
type secretProperties struct {
	Name                 string                `json:"Name"`
	Description          string                `json:"Description"`
	KmsKeyID             json.RawMessage       `json:"KmsKeyId"`
	SecretString         string                `json:"SecretString"`
	GenerateSecretString *generateSecretString `json:"GenerateSecretString"`
}

type generateSecretString struct {
	SecretStringTemplate    string `json:"SecretStringTemplate"`
	GenerateStringKey       string `json:"GenerateStringKey"`
	PasswordLength          int    `json:"PasswordLength"`
	ExcludeCharacters       string `json:"ExcludeCharacters"`
	ExcludeLowercase        bool   `json:"ExcludeLowercase"`
	ExcludeUppercase        bool   `json:"ExcludeUppercase"`
	ExcludeNumbers          bool   `json:"ExcludeNumbers"`
	ExcludePunctuation      bool   `json:"ExcludePunctuation"`
	IncludeSpace            bool   `json:"IncludeSpace"`
	RequireEachIncludedType *bool  `json:"RequireEachIncludedType"`
}

// provisionSecrets creates one secret per AWS::SecretsManager::Secret. A
// SecretString is stored verbatim. GenerateSecretString is generated locally and
// deterministically from the CDK definition (documented in
// docs/examples/local-runner.md); the generated value is what GetSecretValue
// returns and what a deploy-time dynamic reference to the same secret resolves
// to.
//
//nolint:gocognit,gocyclo // one branch per secret form and its error path.
func (r *Runner) provisionSecrets(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService(backendSecretsManager)
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the secretsmanager backend has no loopback endpoint for the runner to provision secrets")
	}
	client := newSecretsManagerClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeSecretsSecret {
			continue
		}
		var props secretProperties
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse Secrets Manager secret %s properties: %w", resource.LogicalID, err)
			}
		}
		name := strings.TrimSpace(props.Name)
		if name == "" {
			name = secretLocalName(resource)
		}
		value := strings.TrimSpace(props.SecretString)
		if value == "" {
			if props.GenerateSecretString == nil {
				return fmt.Errorf(
					"secret %s declares neither SecretString nor GenerateSecretString",
					resource.LogicalID,
				)
			}
			generated, err := generateSecretValue(*props.GenerateSecretString, resource.Stack+"/"+resource.LogicalID)
			if err != nil {
				return fmt.Errorf("secret %s GenerateSecretString: %w", resource.LogicalID, err)
			}
			value = generated
		}
		input := &secretsmanager.CreateSecretInput{
			Name:         aws.String(name),
			SecretString: aws.String(value),
		}
		if description := strings.TrimSpace(props.Description); description != "" {
			input.Description = aws.String(description)
		}
		// KmsKeyId is a CloudFormation string property, so it may be a literal
		// or a Ref/Fn::GetAtt the assembly uses to name a provisioned key
		// (https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html).
		if raw := strings.TrimSpace(string(props.KmsKeyID)); raw != "" && raw != jsonNull {
			keyID, err := r.resolveProvisionString(props.KmsKeyID, resource.Stack, spec)
			if err != nil {
				return fmt.Errorf("resolve Secrets Manager secret %s KmsKeyId: %w", resource.LogicalID, err)
			}
			if keyID = strings.TrimSpace(keyID); keyID != "" {
				input.KmsKeyId = aws.String(keyID)
			}
		}
		created, err := client.CreateSecret(ctx, input)
		arn := ""
		if err != nil {
			if !secretAlreadyExists(err) {
				return fmt.Errorf("create local secret %s for %s: %w", name, resource.LogicalID, err)
			}
			described, describeErr := client.DescribeSecret(ctx, &secretsmanager.DescribeSecretInput{SecretId: aws.String(name)})
			if describeErr != nil {
				return fmt.Errorf("find existing local secret %s for %s: %w", name, resource.LogicalID, describeErr)
			}
			arn = aws.ToString(described.ARN)
			if _, updateErr := client.PutSecretValue(ctx, &secretsmanager.PutSecretValueInput{
				SecretId:     aws.String(arn),
				SecretString: aws.String(value),
			}); updateErr != nil {
				return fmt.Errorf("update local secret %s for %s: %w", name, resource.LogicalID, updateErr)
			}
		} else {
			arn = aws.ToString(created.ARN)
		}
		if arn == "" {
			return fmt.Errorf("create local secret %s for %s returned no ARN", name, resource.LogicalID)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type: typeSecretsSecret,
			Name: name,
			ARN:  arn,
		}
		if r.secretValues == nil {
			r.secretValues = map[string]string{}
		}
		r.secretValues[arn] = value
		r.secretValues[name] = value
		r.logf("provisioned Secrets Manager secret %s for %s", name, resource.LogicalID)
	}
	return nil
}

// generateSecretValue builds the deterministic secret string GenerateSecretString
// describes. AWS does not publish its generation algorithm; this local
// counterpart uses a seeded PRNG so the same CDK definition always produces the
// same secret (moto itself is memory-only). RequireEachIncludedType defaults to
// true, as documented.
//
// GenerateStringKey is optional. The CloudFormation reference makes the pairing
// one-way: "If you specify this parameter, then you must also specify
// SecretStringTemplate" and the generated password is added to that template
// under the key. With neither, Secrets Manager's generated password is the
// whole secret string. Each half of the pair is refused rather than guessed.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-secretsmanager-secret-generatesecretstring.html
//
//nolint:gocognit,gocyclo // one branch per documented generation option.
func generateSecretValue(props generateSecretString, seed string) (string, error) {
	length := props.PasswordLength
	if length == 0 {
		length = 32
	}
	if length < 1 || length > 4096 {
		return "", fmt.Errorf("PasswordLength must be between 1 and 4096 (got %d)", length)
	}
	key := strings.TrimSpace(props.GenerateStringKey)
	template := strings.TrimSpace(props.SecretStringTemplate)
	switch {
	case key != "" && template == "":
		return "", fmt.Errorf("GenerateStringKey requires SecretStringTemplate")
	case key == "" && template != "":
		return "", fmt.Errorf("SecretStringTemplate requires GenerateStringKey")
	}
	var object map[string]any
	if key != "" {
		if err := json.Unmarshal([]byte(template), &object); err != nil || object == nil {
			return "", fmt.Errorf("SecretStringTemplate must be a JSON object")
		}
	}
	requireEach := props.RequireEachIncludedType == nil || *props.RequireEachIncludedType
	excluded := map[rune]bool{}
	for _, char := range props.ExcludeCharacters {
		excluded[char] = true
	}
	classes := []string{}
	if !props.ExcludeUppercase {
		classes = append(classes, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
	}
	if !props.ExcludeLowercase {
		classes = append(classes, "abcdefghijklmnopqrstuvwxyz")
	}
	if !props.ExcludeNumbers {
		classes = append(classes, "0123456789")
	}
	if !props.ExcludePunctuation {
		classes = append(classes, `!"#$%&'()*+,-./:;<=>?@[\]^_`+"`"+`{|}~`)
	}
	if props.IncludeSpace {
		classes = append(classes, " ")
	}
	filtered := make([]string, 0, len(classes))
	for _, class := range classes {
		var builder strings.Builder
		for _, char := range class {
			if !excluded[char] {
				builder.WriteRune(char)
			}
		}
		if builder.Len() > 0 {
			filtered = append(filtered, builder.String())
		}
	}
	if len(filtered) == 0 {
		return "", fmt.Errorf("every character class is excluded")
	}
	if requireEach && length < len(filtered) {
		return "", fmt.Errorf("passwordLength %d cannot contain one character from each of %d classes", length, len(filtered))
	}
	rng := rand.New(rand.NewSource(secretSeed(seed))) //nolint:gosec // deterministic local generation, not a security primitive
	var builder strings.Builder
	if requireEach {
		for _, class := range filtered {
			builder.WriteByte(class[rng.Intn(len(class))])
		}
	}
	all := strings.Join(filtered, "")
	for builder.Len() < length {
		builder.WriteByte(all[rng.Intn(len(all))])
	}
	// Shuffle so the required characters do not always lead, as AWS's
	// generated passwords do not reserve positions.
	password := []byte(builder.String()[:length])
	rng.Shuffle(len(password), func(i, j int) { password[i], password[j] = password[j], password[i] })
	if key == "" {
		// No template and no key: the generated password is the secret string.
		return string(password), nil
	}
	object[props.GenerateStringKey] = string(password)
	encoded, err := json.Marshal(object)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func secretSeed(value string) int64 {
	sum := sha256.Sum256([]byte(value))
	return int64(binary.BigEndian.Uint64(sum[:8])) //nolint:gosec // a deterministic PRNG seed, never used for secrets
}

// provisionTopics creates one SNS topic per AWS::SNS::Topic. Standard and FIFO
// topics use the same CreateTopic operation; FifoTopic and
// ContentBasedDeduplication are topic attributes, as documented for FIFO
// topics: https://docs.aws.amazon.com/sns/latest/dg/sns-fifo-topics.html
//
//nolint:gocognit,gocyclo // one branch per topic attribute and its error path.
func (r *Runner) provisionTopics(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService(backendSNS)
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the sns backend has no loopback endpoint for the runner to provision topics")
	}
	client := newSNSClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeSNSTopic {
			continue
		}
		var props struct {
			TopicName                 string `json:"TopicName"`
			FifoTopic                 bool   `json:"FifoTopic"`
			ContentBasedDeduplication bool   `json:"ContentBasedDeduplication"`
			DisplayName               string `json:"DisplayName"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse SNS topic %s properties: %w", resource.LogicalID, err)
			}
		}
		name := strings.TrimSpace(props.TopicName)
		if name == "" {
			name = localPhysicalName(resource.Stack, resource.LogicalID)
		}
		if props.FifoTopic && !strings.HasSuffix(name, ".fifo") {
			return fmt.Errorf("sns FIFO topic %s name %q must end in .fifo", resource.LogicalID, name)
		}
		if props.ContentBasedDeduplication && !props.FifoTopic {
			return fmt.Errorf("sns topic %s sets ContentBasedDeduplication without FifoTopic", resource.LogicalID)
		}
		attributes := map[string]string{}
		if props.FifoTopic {
			attributes["FifoTopic"] = boolTrue
		}
		if props.ContentBasedDeduplication {
			attributes["ContentBasedDeduplication"] = boolTrue
		}
		if display := strings.TrimSpace(props.DisplayName); display != "" {
			attributes["DisplayName"] = display
		}
		created, err := client.CreateTopic(ctx, &sns.CreateTopicInput{
			Name:       aws.String(name),
			Attributes: attributes,
		})
		if err != nil {
			return fmt.Errorf("create local SNS topic %s for %s: %w", name, resource.LogicalID, err)
		}
		arn := aws.ToString(created.TopicArn)
		if arn == "" {
			arn = "arn:" + LocalPartition + ":sns:" + LocalRegion + ":" + LocalAccountID + ":" + name
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type: typeSNSTopic,
			Name: name,
			ARN:  arn,
		}
		subscriptions := r.snsSubscriptionsForTopic(spec, resource)
		topic := snsTopicRuntime{
			LogicalID:                 resource.Stack + "/" + resource.LogicalID,
			ARN:                       arn,
			Name:                      name,
			FIFO:                      props.FifoTopic || strings.HasSuffix(name, snsFIFOTopicSuffix),
			ContentBasedDeduplication: props.ContentBasedDeduplication,
			SubscriptionCount:         len(subscriptions),
		}
		if len(subscriptions) > 0 {
			// The drain queue lives on the same moto container as the topic;
			// moto's SNS fan-out can only write to its own SQS.
			if err := r.provisionSNSDrain(ctx, &topic, client, newSQSClient(backend.HostURL)); err != nil {
				return err
			}
		}
		for _, index := range subscriptions {
			spec.Subscriptions[index].TopicARN = arn
			spec.Subscriptions[index].ARN = snsSubscriptionARN(arn, spec.Subscriptions[index].LogicalID)
		}
		if r.sns != nil {
			r.sns.registerTopic(topic)
		}
		r.logf("provisioned SNS topic %s for %s", name, resource.LogicalID)
	}
	return nil
}

// snsSubscriptionsForTopic returns the indices of the derived subscriptions
// that target one provisioned topic.
func (r *Runner) snsSubscriptionsForTopic(spec *Spec, resource ResourceSpec) []int {
	qualified := resource.Stack + "/" + resource.LogicalID
	var indices []int
	for index := range spec.Subscriptions {
		subscription := &spec.Subscriptions[index]
		if subscription.Kind != string(DeliveryKindSNS) {
			continue
		}
		if subscription.Topic == qualified || subscription.Topic == resource.LogicalID {
			indices = append(indices, index)
		}
	}
	return indices
}

// provisionStreams creates one Kinesis stream per AWS::Kinesis::Stream. The
// stream mode and retention follow CreateStream and
// IncreaseStreamRetentionPeriod:
// https://docs.aws.amazon.com/kinesis/latest/APIReference/API_CreateStream.html
// https://docs.aws.amazon.com/kinesis/latest/APIReference/API_IncreaseStreamRetentionPeriod.html
//
//nolint:gocognit,gocyclo // one branch per stream mode, retention direction and error path.
func (r *Runner) provisionStreams(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService(backendKinesis)
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the kinesis backend has no loopback endpoint for the runner to provision streams")
	}
	client := newKinesisClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeKinesisStream {
			continue
		}
		var props struct {
			Name                 string `json:"Name"`
			ShardCount           int    `json:"ShardCount"`
			RetentionPeriodHours int    `json:"RetentionPeriodHours"`
			StreamModeDetails    struct {
				StreamMode string `json:"StreamMode"`
			} `json:"StreamModeDetails"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse Kinesis stream %s properties: %w", resource.LogicalID, err)
			}
		}
		name := strings.TrimSpace(props.Name)
		if name == "" {
			name = localPhysicalName(resource.Stack, resource.LogicalID)
		}
		input := &kinesis.CreateStreamInput{StreamName: aws.String(name)}
		mode := strings.ToUpper(strings.TrimSpace(props.StreamModeDetails.StreamMode))
		switch mode {
		case "", "PROVISIONED":
			input.ShardCount = aws.Int32(int32(maxInt(props.ShardCount, 1))) //nolint:gosec // a declared shard count, clamped at one
		case "ON_DEMAND":
			input.StreamModeDetails = &kinestypes.StreamModeDetails{StreamMode: kinestypes.StreamModeOnDemand}
		default:
			return fmt.Errorf("kinesis stream %s has unsupported StreamMode %q", resource.LogicalID, mode)
		}
		if _, err := client.CreateStream(ctx, input); err != nil && !streamAlreadyExists(err) {
			return fmt.Errorf("create local Kinesis stream %s for %s: %w", name, resource.LogicalID, err)
		}
		described, err := client.DescribeStream(ctx, &kinesis.DescribeStreamInput{StreamName: aws.String(name)})
		if err != nil || described.StreamDescription == nil {
			return fmt.Errorf("describe local Kinesis stream %s for %s: %w", name, resource.LogicalID, err)
		}
		description := described.StreamDescription
		if props.RetentionPeriodHours > 0 {
			if props.RetentionPeriodHours < 24 || props.RetentionPeriodHours > 8760 {
				return fmt.Errorf("kinesis stream %s RetentionPeriodHours must be between 24 and 8760", resource.LogicalID)
			}
			current := int(aws.ToInt32(description.RetentionPeriodHours))
			switch {
			case props.RetentionPeriodHours > current:
				if _, err := client.IncreaseStreamRetentionPeriod(ctx, &kinesis.IncreaseStreamRetentionPeriodInput{
					StreamName:           aws.String(name),
					RetentionPeriodHours: aws.Int32(int32(props.RetentionPeriodHours)), //nolint:gosec // validated 24..8760
				}); err != nil {
					return fmt.Errorf("increase retention on local Kinesis stream %s: %w", name, err)
				}
			case props.RetentionPeriodHours < current:
				if _, err := client.DecreaseStreamRetentionPeriod(ctx, &kinesis.DecreaseStreamRetentionPeriodInput{
					StreamName:           aws.String(name),
					RetentionPeriodHours: aws.Int32(int32(props.RetentionPeriodHours)), //nolint:gosec // validated 24..8760
				}); err != nil {
					return fmt.Errorf("decrease retention on local Kinesis stream %s: %w", name, err)
				}
			}
		}
		arn := aws.ToString(description.StreamARN)
		if arn == "" {
			arn = "arn:" + LocalPartition + ":kinesis:" + LocalRegion + ":" + LocalAccountID + ":stream/" + name
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type: typeKinesisStream,
			Name: name,
			ARN:  arn,
		}
		r.logf("provisioned Kinesis stream %s (%s) for %s", name, mode, resource.LogicalID)
	}
	return nil
}

// provisionCognito creates one user pool per AWS::Cognito::UserPool and one
// client per AWS::Cognito::UserPoolClient. The pool id and client id are the
// documented Ref values; the pool's provider values are the documented GetAtt
// values. The local issuer the runner serves for the pool is added after the
// issuer listener starts.
//
//nolint:gocognit,gocyclo // two resource loops (pools, then clients) with explicit error paths.
func (r *Runner) provisionCognito(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService(backendCognito)
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the cognito-idp backend has no loopback endpoint for the runner to provision user pools")
	}
	client := newCognitoClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeCognitoUserPool {
			continue
		}
		var props struct {
			UserPoolName           string   `json:"UserPoolName"`
			AutoVerifiedAttributes []string `json:"AutoVerifiedAttributes"`
			UsernameAttributes     []string `json:"UsernameAttributes"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse Cognito user pool %s properties: %w", resource.LogicalID, err)
			}
		}
		name := strings.TrimSpace(props.UserPoolName)
		if name == "" {
			name = localPhysicalName(resource.Stack, resource.LogicalID)
		}
		input := &cognitoidentityprovider.CreateUserPoolInput{PoolName: aws.String(name)}
		for _, attribute := range props.AutoVerifiedAttributes {
			input.AutoVerifiedAttributes = append(input.AutoVerifiedAttributes, cognitotypes.VerifiedAttributeType(attribute))
		}
		for _, attribute := range props.UsernameAttributes {
			input.UsernameAttributes = append(input.UsernameAttributes, cognitotypes.UsernameAttributeType(attribute))
		}
		created, err := client.CreateUserPool(ctx, input)
		if err != nil {
			return fmt.Errorf("create local Cognito user pool %s for %s: %w", name, resource.LogicalID, err)
		}
		if created.UserPool == nil || aws.ToString(created.UserPool.Id) == "" {
			return fmt.Errorf("create local Cognito user pool %s returned no pool id", name)
		}
		poolID := aws.ToString(created.UserPool.Id)
		arn := aws.ToString(created.UserPool.Arn)
		if arn == "" {
			arn = "arn:" + LocalPartition + ":cognito-idp:" + LocalRegion + ":" + LocalAccountID + ":userpool/" + poolID
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type:         typeCognitoUserPool,
			Name:         poolID,
			ARN:          arn,
			ProviderName: "cognito-idp." + LocalRegion + ".amazonaws.com/" + poolID,
			ProviderURL:  "https://cognito-idp." + LocalRegion + ".amazonaws.com/" + poolID,
		}
		r.logf("provisioned Cognito user pool %s for %s", poolID, resource.LogicalID)
	}
	for _, resource := range spec.Resources {
		if resource.Type != typeCognitoClient {
			continue
		}
		var props struct {
			UserPoolID                 json.RawMessage `json:"UserPoolId"`
			ClientName                 string          `json:"ClientName"`
			GenerateSecret             bool            `json:"GenerateSecret"`
			ExplicitAuthFlows          []string        `json:"ExplicitAuthFlows"`
			AllowedOAuthFlows          []string        `json:"AllowedOAuthFlows"`
			CallbackURLs               []string        `json:"CallbackURLs"`
			LogoutURLs                 []string        `json:"LogoutURLs"`
			SupportedIdentityProviders []string        `json:"SupportedIdentityProviders"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse Cognito user pool client %s properties: %w", resource.LogicalID, err)
			}
		}
		poolRef := ""
		for _, ref := range refsIn(props.UserPoolID) {
			value, exists := r.resourceValues[resource.Stack+"/"+ref.ID]
			if exists && value.Type == typeCognitoUserPool {
				poolRef = value.Name
				break
			}
		}
		if poolRef == "" {
			var literal string
			if err := json.Unmarshal(props.UserPoolID, &literal); err == nil {
				poolRef = strings.TrimSpace(literal)
			}
		}
		if poolRef == "" {
			return fmt.Errorf("cognito user pool client %s has no user pool reference", resource.LogicalID)
		}
		name := strings.TrimSpace(props.ClientName)
		if name == "" {
			name = localPhysicalName(resource.Stack, resource.LogicalID)
		}
		input := &cognitoidentityprovider.CreateUserPoolClientInput{
			UserPoolId:     aws.String(poolRef),
			ClientName:     aws.String(name),
			GenerateSecret: props.GenerateSecret,
		}
		for _, flow := range props.ExplicitAuthFlows {
			input.ExplicitAuthFlows = append(input.ExplicitAuthFlows, cognitotypes.ExplicitAuthFlowsType(flow))
		}
		for _, flow := range props.AllowedOAuthFlows {
			input.AllowedOAuthFlows = append(input.AllowedOAuthFlows, cognitotypes.OAuthFlowType(flow))
		}
		input.CallbackURLs = append(input.CallbackURLs, props.CallbackURLs...)
		input.LogoutURLs = append(input.LogoutURLs, props.LogoutURLs...)
		input.SupportedIdentityProviders = append(input.SupportedIdentityProviders, props.SupportedIdentityProviders...)
		created, err := client.CreateUserPoolClient(ctx, input)
		if err != nil {
			return fmt.Errorf("create local Cognito user pool client %s for %s: %w", name, resource.LogicalID, err)
		}
		if created.UserPoolClient == nil || aws.ToString(created.UserPoolClient.ClientId) == "" {
			return fmt.Errorf("create local Cognito user pool client %s returned no client id", name)
		}
		clientID := aws.ToString(created.UserPoolClient.ClientId)
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type:         typeCognitoClient,
			Name:         clientID,
			ClientSecret: aws.ToString(created.UserPoolClient.ClientSecret),
		}
		r.logf("provisioned Cognito user pool client %s for %s", clientID, resource.LogicalID)
	}
	return nil
}

// provisionAliases creates one KMS alias per AWS::KMS::Alias and records the
// alias name so a Ref resolves to it. The alias is usable as a KeyId, as KMS
// documents: https://docs.aws.amazon.com/kms/latest/developerguide/alias-using.html
//
//nolint:gocyclo // one branch per alias reference form and its error path.
func (r *Runner) provisionAliases(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("kms")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the kms backend has no loopback endpoint for the runner to provision aliases")
	}
	client := newKMSClient(backend.HostURL)
	for _, resource := range spec.Resources {
		if resource.Type != typeKMSAlias {
			continue
		}
		var props struct {
			AliasName   string          `json:"AliasName"`
			TargetKeyID json.RawMessage `json:"TargetKeyId"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("parse KMS alias %s properties: %w", resource.LogicalID, err)
			}
		}
		aliasName := strings.TrimSpace(props.AliasName)
		if !strings.HasPrefix(aliasName, "alias/") {
			return fmt.Errorf("KMS alias %s name %q must start with alias/", resource.LogicalID, aliasName)
		}
		target := ""
		for _, ref := range refsIn(props.TargetKeyID) {
			if value, exists := r.resourceValues[resource.Stack+"/"+ref.ID]; exists && value.Type == typeKMSKey {
				target = value.KeyID
				break
			}
		}
		if target == "" {
			if err := json.Unmarshal(props.TargetKeyID, &target); err != nil || strings.TrimSpace(target) == "" {
				return fmt.Errorf("KMS alias %s name no provisioned target key", resource.LogicalID)
			}
		}
		if _, err := client.CreateAlias(ctx, &kms.CreateAliasInput{
			AliasName:   aws.String(aliasName),
			TargetKeyId: aws.String(target),
		}); err != nil && !aliasAlreadyExists(err) {
			return fmt.Errorf("create local KMS alias %s for %s: %w", aliasName, resource.LogicalID, err)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Type:  typeKMSAlias,
			Name:  aliasName,
			ARN:   "arn:" + LocalPartition + ":kms:" + LocalRegion + ":" + LocalAccountID + ":" + aliasName,
			KeyID: target,
		}
		r.logf("provisioned KMS alias %s for %s", aliasName, resource.LogicalID)
	}
	return nil
}

// resolveProvisionString evaluates a CloudFormation value for provisioning. It
// accepts the literal, Ref, Fn::GetAtt and Fn::Join forms the environment
// resolver already supports, using the resources provisioned so far.
func (r *Runner) resolveProvisionString(raw json.RawMessage, stack string, spec *Spec) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("value is not valid JSON: %w", err)
	}
	if literal, ok := value.(string); ok {
		return literal, nil
	}
	return r.evaluate(value, stack, spec.resourceIndex(), r.resourceValues, spec.Templates[stack])
}

func secretAlreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "resourceexistsexception") || strings.Contains(message, "already exists")
}

func streamAlreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "resourceinuseexception") || strings.Contains(message, "already exists")
}

func aliasAlreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "alreadyexistsexception") || strings.Contains(message, "already exists")
}

// secretLocalName is the friendly name a secret is created with. A CDK
// aws-cdk-lib Secret without an explicit name still exposes a generated name,
// but the local runner uses a deterministic one so plan, describe and the
// dynamic-reference resolver agree.
func secretLocalName(resource ResourceSpec) string {
	if literal := strings.TrimSpace(literalPhysicalName(resource)); literal != "" {
		return literal
	}
	return "local-secret-" + stableHash(resource.Stack+"/"+resource.LogicalID, 24)
}

func maxInt(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
