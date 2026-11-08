package localrunner

import (
	"strings"
)

// Resource-type handling.
//
// A cloud assembly declares far more resource types than the local runner
// serves. The runner's contract is that a type a real application synthesizes
// is never silently ignored: it is served, reported as deploy-time-only with a
// docs/125 true-limit reason, or refused with a named reason. This file is the
// single table behind that contract for the types the TMS and TheoryCloud.ai
// templates declare (docs/127 Problem 4), plus the custom-resource families the
// runner invokes through their real handlers.
//
// docs/125 "True limits" permits these two classes:
//   - deploy-time-only resources with no runtime behavior: reported, not
//     served;
//   - AWS-only services with no emulator: refused, with the service named.
// Anything else must be served.

// resourceHandling is what the runner does with one CloudFormation resource
// type.
type resourceHandling int

const (
	// handlingServed means the runner reproduces the type's local effect.
	handlingServed resourceHandling = iota
	// handlingDeployTimeOnly means the type has no local runtime behavior and
	// is reported with a docs/125 true-limit reason.
	handlingDeployTimeOnly
	// handlingRefused means the type's subject is an AWS-only service with no
	// emulator and the runner refuses it by name.
	handlingRefused
)

// deployTimeOnlyReason is the docs/125 true-limit reason every deploy-time-only
// report carries. The type-specific detail says why the type has no local
// runtime behavior.
//
// docs/125 "True limits": "Deploy-time-only resources with no runtime
// behavior: Route 53, ACM, RAM. These are reported, not served."
const deployTimeOnlyReason = "deploy-time-only; docs/125 true limit (no runtime behavior locally)"

// refusedMicrovmReason is the docs/125 true-limit reason for the MicroVM
// managed provider: an AWS-only service with no emulator.
//
// docs/125 "True limits": "AWS-only services with no emulator: MicroVM managed
// provider, Bedrock, S3 Vectors."
const refusedMicrovmReason = "refused; the MicroVM managed provider is an AWS-only service with no emulator (docs/125 true limit)"

// problemResourceTypes is the docs/127 Problem 4 inventory: every resource type
// the TMS and TheoryCloud.ai templates synthesize that the runner did not cover.
// The value is the type-specific half of the report; the class and the true-limit
// citation come from the class.
var problemResourceTypes = map[string]struct {
	handling resourceHandling
	detail   string
}{
	// API Gateway custom domains and mappings. A deployed domain is an edge
	// endpoint with an ACM certificate and a DNS record; nothing calls it at
	// runtime locally.
	"AWS::ApiGateway::DomainName": {
		handlingDeployTimeOnly,
		"a regional custom domain name is an edge endpoint plus an ACM certificate",
	},
	"AWS::ApiGateway::BasePathMapping": {
		handlingDeployTimeOnly,
		"a base-path mapping attaches a deployed stage to a custom domain name",
	},
	"AWS::ApiGatewayV2::DomainName": {
		handlingDeployTimeOnly,
		"an HTTP API custom domain name is an edge endpoint plus an ACM certificate",
	},
	"AWS::ApiGatewayV2::ApiMapping": {
		handlingDeployTimeOnly,
		"an API mapping attaches a deployed stage to a custom domain name",
	},
	// ACM. Issuance is a DNS or email ownership challenge owned by AWS.
	"AWS::CertificateManager::Certificate": {
		handlingDeployTimeOnly,
		"ACM issues and validates a certificate through a DNS or email challenge AWS owns",
	},
	// Route 53. Public DNS state.
	"AWS::Route53::RecordSet": {
		handlingDeployTimeOnly,
		"a Route 53 record set is public DNS state",
	},
	"AWS::Route53::RecordSetGroup": {
		handlingDeployTimeOnly,
		"a Route 53 record set group is public DNS state",
	},
	"AWS::Route53::HostedZone": {
		handlingDeployTimeOnly,
		"a Route 53 hosted zone is public DNS state",
	},
	// CloudWatch. Alarms and dashboards read AWS service metrics.
	"AWS::CloudWatch::Alarm": {
		handlingDeployTimeOnly,
		"a CloudWatch alarm evaluates AWS service metrics, which have no local source",
	},
	"AWS::CloudWatch::CompositeAlarm": {
		handlingDeployTimeOnly,
		"a composite alarm combines CloudWatch alarm states, which have no local source",
	},
	"AWS::CloudWatch::Dashboard": {
		handlingDeployTimeOnly,
		"a CloudWatch dashboard is a console view over AWS service metrics",
	},
	// Lambda networking for MicroVMs. A connector binds a MicroVM to a VPC
	// subnet and security group; it has no standalone runtime behavior.
	"AWS::Lambda::NetworkConnector": {
		handlingDeployTimeOnly,
		"a Lambda network connector binds MicroVM compute to a VPC subnet and security group",
	},
	// EC2 security groups. VPC traffic filtering, with no local VPC.
	"AWS::EC2::SecurityGroup": {
		handlingDeployTimeOnly,
		"an EC2 security group filters traffic in a real VPC",
	},
	"AWS::EC2::SecurityGroupIngress": {
		handlingDeployTimeOnly,
		"an EC2 security group ingress rule filters traffic in a real VPC",
	},
	"AWS::EC2::SecurityGroupEgress": {
		handlingDeployTimeOnly,
		"an EC2 security group egress rule filters traffic in a real VPC",
	},
	// SES identities. Verification is a DNS or email ownership handshake.
	// The receipt rule itself is served: see receipt_rules.go.
	"AWS::SES::EmailIdentity": {
		handlingDeployTimeOnly,
		"an SES identity is verified through a DNS record or an email handshake owned by AWS",
	},
	// The MicroVM managed provider.
	"AWS::Lambda::MicrovmImage": {
		handlingRefused,
		"a MicroVM image is built and run by the MicroVM managed provider",
	},
}

// bookkeepingResourceTypes are the types a template synthesizes that carry no
// local runtime behaviour and that no component of the runner acts on. They are
// reported so no synthesized type is silently ignored; each reason is a
// docs/125 deploy-time-only limit.
const (
	typeS3BucketPolicy     = "AWS::S3::BucketPolicy"
	typeLogsResourcePolicy = "AWS::Logs::ResourcePolicy"
	typeLogsMetricFilter   = "AWS::Logs::MetricFilter"
	typeAPIGatewayAccount  = "AWS::ApiGateway::Account"
	typeCDKMetadata        = "AWS::CDK::Metadata"
)

var bookkeepingResourceTypes = map[string]string{
	typeLogsMetricFilter:  "a CloudWatch Logs metric filter publishes metrics from log events, and the runner has no metric source",
	typeAPIGatewayAccount: "the account's API Gateway CloudWatch role is a deploy-time setting",
	typeCDKMetadata:       "CDK assembly metadata tracks construct versions and creates no resource",
}

// classifyProblemResources reports every docs/127 Problem 4 type the assembly
// declares, and every bookkeeping type as deploy-time-only. A served type is
// left to the component that serves it; a deploy-time-only type and a refused
// type are reported so a run never gives the impression that they were
// exercised.
func classifyProblemResources(spec *Spec) {
	for _, resource := range spec.Resources {
		if detail, ok := bookkeepingResourceTypes[resource.Type]; ok {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: resource.LogicalID,
				Kind:      resource.Type,
				Reason:    detail + "; " + deployTimeOnlyReason,
			})
			continue
		}
		entry, ok := problemResourceTypes[resource.Type]
		if !ok {
			continue
		}
		switch entry.handling {
		case handlingDeployTimeOnly:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: resource.LogicalID,
				Kind:      resource.Type,
				Reason:    entry.detail + "; " + deployTimeOnlyReason,
			})
		case handlingRefused:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: resource.LogicalID,
				Kind:      resource.Type,
				Reason:    entry.detail + "; " + refusedMicrovmReason,
			})
		case handlingServed:
			// Reported by the component that serves it.
		}
	}
}

// refusedResourceReason returns the refusal the runner records for a resource
// type whose subject it refuses, and whether the type is refused at all.
func refusedResourceReason(resourceType string) (string, bool) {
	entry, ok := problemResourceTypes[resourceType]
	if !ok || entry.handling != handlingRefused {
		return "", false
	}
	return entry.detail + "; " + refusedMicrovmReason, true
}

// customResourceType reports whether a template resource type is a
// CloudFormation custom resource the runner can invoke.
//
// A private custom resource type is `Custom::<name>`; a resource created from a
// custom resource's service token without a private type is
// `AWS::CloudFormation::CustomResource`.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html
func customResourceType(resourceType string) bool {
	return strings.HasPrefix(resourceType, "Custom::") || resourceType == typeCloudFormationCustomResource
}

// typeCloudFormationCustomResource is the generic custom-resource type a
// provider-framework construct declares when it sets no private type name.
const typeCloudFormationCustomResource = "AWS::CloudFormation::CustomResource"

// customResourceServedNatively lists the custom-resource types the runner
// serves with its own implementation instead of invoking a handler. The
// bucket-deployment handler copies an asset into a bucket; the runner performs
// that copy itself (deploy.go), so the handler never runs.
var customResourceServedNatively = map[string]string{
	typeBucketDeploy: "the runner copies the asset into the bucket itself instead of invoking the deployment handler",
	typeBucketNotifications: "the runner derives the notification configuration from the bucket's real object " +
		"state instead of invoking the notifications handler",
	// The CDK auto-delete handler empties a bucket by listing its object
	// VERSIONS, and s3proxy's filesystem store does not implement
	// ListObjectVersions. The runner performs the same effect itself: the
	// handler's delete leg is served by emptying the bucket, which is exactly
	// what the handler would do.
	typeBucketAutoDelete: "the runner empties the bucket on the handler's delete leg; the CDK handler " +
		"itself lists object versions, which s3proxy does not implement",
}
