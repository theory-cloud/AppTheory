package localrunner

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// SES receipt rules.
//
// A receipt rule that names a Lambda action is how an application receives
// mail: SES accepts the message, applies the rule's actions in order, writes the
// raw message to the rule's S3 bucket, and invokes the function with the
// received-message event. The local runner derives the rule from the template
// and serves the same path: a session operation injects one raw message at an
// envelope recipient, the runner writes the message to the S3 action's bucket
// and invokes the Lambda action with the documented event.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ses-receiptrule.html
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda.html
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action.html
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-event-notifications.html

const (
	// receiptActionS3 writes the raw message to a bucket.
	receiptActionS3 = "s3"
	// receiptActionLambda invokes a Lambda function with the receipt event.
	receiptActionLambda = "lambda"
	// receiptActionStop stops evaluating the rule's remaining actions.
	receiptActionStop = "stop"
	// receiptInvocationEvent and receiptInvocationRequestResponse are the SES
	// LambdaAction InvocationType values.
	// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda.html
	receiptInvocationEvent           = "Event"
	receiptInvocationRequestResponse = "RequestResponse"
)

// receiptRuleProperties is the part of an AWS::SES::ReceiptRule the runner reads.
type receiptRuleProperties struct {
	RuleSetName string `json:"RuleSetName"`
	Rule        struct {
		Name        string   `json:"Name"`
		Enabled     bool     `json:"Enabled"`
		Recipients  []string `json:"Recipients"`
		ScanEnabled bool     `json:"ScanEnabled"`
		TLSRequired *bool    `json:"TlsPolicy"`
		Actions     []struct {
			S3Action *struct {
				BucketName      json.RawMessage `json:"BucketName"`
				ObjectKeyPrefix string          `json:"ObjectKeyPrefix"`
				TopicArn        json.RawMessage `json:"TopicArn"`
			} `json:"S3Action"`
			LambdaAction *struct {
				FunctionArn    json.RawMessage `json:"FunctionArn"`
				InvocationType string          `json:"InvocationType"`
			} `json:"LambdaAction"`
			StopAction *struct {
				Scope    string `json:"Scope"`
				TopicArn string `json:"TopicArn"`
			} `json:"StopAction"`
			SNSAction       *json.RawMessage `json:"SNSAction"`
			AddHeaderAction *json.RawMessage `json:"AddHeaderAction"`
			BounceAction    *json.RawMessage `json:"BounceAction"`
			ConnectAction   *json.RawMessage `json:"ConnectAction"`
			WorkmailAction  *json.RawMessage `json:"WorkmailAction"`
		} `json:"Actions"`
	} `json:"Rule"`
}

// deriveReceiptRules records every receipt rule the run serves.
//
//nolint:gocognit,gocyclo // one branch per action kind the rule can declare.
func deriveReceiptRules(spec *Spec, stacks []assemblyStack) {
	for _, stack := range stacks {
		types := stack.resourceTypes()
		for _, id := range sortedKeys(stack.Template.Resources) {
			resource := stack.Template.Resources[id]
			if resource.Type != typeSESReceiptRule {
				continue
			}
			var props receiptRuleProperties
			if len(resource.Properties) > 0 {
				if err := json.Unmarshal(resource.Properties, &props); err != nil {
					spec.Skipped = append(spec.Skipped, Skipped{
						LogicalID: id,
						Kind:      resource.Type,
						Reason:    "the receipt rule's properties are not a JSON object: " + err.Error(),
					})
					continue
				}
			}
			rule := ReceiptRuleSpec{
				LogicalID:   id,
				Stack:       stack.Name,
				RuleSetName: props.RuleSetName,
				Name:        props.Rule.Name,
				Recipients:  append([]string(nil), props.Rule.Recipients...),
				Enabled:     props.Rule.Enabled,
			}
			unserved := map[string]struct{}{}
			for position, action := range props.Rule.Actions {
				switch {
				case action.S3Action != nil:
					bucketID, ok := findRefByType(action.S3Action.BucketName, types, typeS3Bucket, "Arn")
					if !ok {
						spec.Skipped = append(spec.Skipped, Skipped{
							LogicalID: id,
							Kind:      typeSESReceiptRule,
							Reason:    fmt.Sprintf("action %d is an S3 action that does not name an AWS::S3::Bucket", position),
						})
						continue
					}
					rule.Actions = append(rule.Actions, ReceiptAction{
						Kind:            receiptActionS3,
						Bucket:          qualify(stacks, stack.Name, bucketID),
						ObjectKeyPrefix: action.S3Action.ObjectKeyPrefix,
					})
				case action.LambdaAction != nil:
					functionID, ok := findRefByType(action.LambdaAction.FunctionArn, types, typeLambdaFunction, "Arn")
					if !ok {
						spec.Skipped = append(spec.Skipped, Skipped{
							LogicalID: id,
							Kind:      typeSESReceiptRule,
							Reason:    fmt.Sprintf("action %d is a Lambda action that does not name an AWS::Lambda::Function", position),
						})
						continue
					}
					invocationType := action.LambdaAction.InvocationType
					if invocationType == "" {
						// SES documents Event as the LambdaAction default.
						// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda.html
						invocationType = receiptInvocationEvent
					}
					rule.Actions = append(rule.Actions, ReceiptAction{
						Kind:           receiptActionLambda,
						Function:       qualify(stacks, stack.Name, functionID),
						InvocationType: invocationType,
					})
				case action.StopAction != nil:
					rule.Actions = append(rule.Actions, ReceiptAction{Kind: receiptActionStop})
				default:
					kind := "unknown"
					switch {
					case action.SNSAction != nil:
						kind = "SNSAction"
					case action.AddHeaderAction != nil:
						kind = "AddHeaderAction"
					case action.BounceAction != nil:
						kind = "BounceAction"
					case action.ConnectAction != nil:
						kind = "ConnectAction"
					case action.WorkmailAction != nil:
						kind = "WorkmailAction"
					}
					unserved[kind] = struct{}{}
				}
			}
			rule.UnservedActions = sortedKeys(unserved)
			spec.ReceiptRules = append(spec.ReceiptRules, rule)
		}
	}
}

// typeSESReceiptRule is the receipt-rule resource type.
const typeSESReceiptRule = "AWS::SES::ReceiptRule"

// receiptRulesFor returns the enabled rules whose Recipients name one address.
// SES matches a recipient exactly and also accepts a domain that covers every
// address in it; the local runner matches both forms.
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-receipt-rules-console-walkthrough.html
func receiptRulesFor(rules []ReceiptRuleSpec, recipient string) []ReceiptRuleSpec {
	address := strings.ToLower(strings.TrimSpace(recipient))
	var out []ReceiptRuleSpec
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		for _, candidate := range rule.Recipients {
			candidate = strings.ToLower(strings.TrimSpace(candidate))
			if candidate == "" {
				continue
			}
			if candidate == address || strings.HasSuffix(address, "@"+candidate) {
				out = append(out, rule)
				break
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LogicalID < out[j].LogicalID })
	return out
}
