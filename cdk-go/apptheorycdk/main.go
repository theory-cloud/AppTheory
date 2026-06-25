// AppTheory CDK constructs (TS-first jsii)
package apptheorycdk

import (
	"reflect"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

func init() {
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.ApiBypassConfig",
		reflect.TypeOf((*ApiBypassConfig)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryApiDomain",
		reflect.TypeOf((*AppTheoryApiDomain)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "apiMapping", GoGetter: "ApiMapping"},
			_jsii_.MemberProperty{JsiiProperty: "cnameRecord", GoGetter: "CnameRecord"},
			_jsii_.MemberProperty{JsiiProperty: "domainName", GoGetter: "DomainName"},
			_jsii_.MemberProperty{JsiiProperty: "domainString", GoGetter: "DomainString"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryApiDomain{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryApiDomainProps",
		reflect.TypeOf((*AppTheoryApiDomainProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryApp",
		reflect.TypeOf((*AppTheoryApp)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "databaseTable", GoGetter: "DatabaseTable"},
			_jsii_.MemberProperty{JsiiProperty: "domain", GoGetter: "Domain"},
			_jsii_.MemberProperty{JsiiProperty: "fn", GoGetter: "Fn"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "rateLimitTable", GoGetter: "RateLimitTable"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryApp{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryAppProps",
		reflect.TypeOf((*AppTheoryAppProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryCertificate",
		reflect.TypeOf((*AppTheoryCertificate)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addDependency", GoMethod: "AddDependency"},
			_jsii_.MemberProperty{JsiiProperty: "certificate", GoGetter: "Certificate"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryCertificate{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryCertificateProps",
		reflect.TypeOf((*AppTheoryCertificateProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsDestination",
		reflect.TypeOf((*AppTheoryCloudWatchLogsDestination)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "destination", GoGetter: "Destination"},
			_jsii_.MemberProperty{JsiiProperty: "destinationArn", GoGetter: "DestinationArn"},
			_jsii_.MemberProperty{JsiiProperty: "destinationName", GoGetter: "DestinationName"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "serviceRole", GoGetter: "ServiceRole"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryCloudWatchLogsDestination{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsDestinationProps",
		reflect.TypeOf((*AppTheoryCloudWatchLogsDestinationProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsSubscription",
		reflect.TypeOf((*AppTheoryCloudWatchLogsSubscription)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "destinationArn", GoGetter: "DestinationArn"},
			_jsii_.MemberProperty{JsiiProperty: "filterPatternText", GoGetter: "FilterPatternText"},
			_jsii_.MemberProperty{JsiiProperty: "logGroupName", GoGetter: "LogGroupName"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "roleArn", GoGetter: "RoleArn"},
			_jsii_.MemberProperty{JsiiProperty: "subscriptionFilter", GoGetter: "SubscriptionFilter"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryCloudWatchLogsSubscription{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsSubscriptionProps",
		reflect.TypeOf((*AppTheoryCloudWatchLogsSubscriptionProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunner",
		reflect.TypeOf((*AppTheoryCodeBuildJobRunner)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addToRolePolicy", GoMethod: "AddToRolePolicy"},
			_jsii_.MemberMethod{JsiiMethod: "grantDynamoRead", GoMethod: "GrantDynamoRead"},
			_jsii_.MemberMethod{JsiiMethod: "grantDynamoWrite", GoMethod: "GrantDynamoWrite"},
			_jsii_.MemberMethod{JsiiMethod: "grantS3Read", GoMethod: "GrantS3Read"},
			_jsii_.MemberMethod{JsiiMethod: "grantS3Write", GoMethod: "GrantS3Write"},
			_jsii_.MemberMethod{JsiiMethod: "grantSecretRead", GoMethod: "GrantSecretRead"},
			_jsii_.MemberProperty{JsiiProperty: "logGroup", GoGetter: "LogGroup"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "project", GoGetter: "Project"},
			_jsii_.MemberProperty{JsiiProperty: "role", GoGetter: "Role"},
			_jsii_.MemberProperty{JsiiProperty: "stateChangeRule", GoGetter: "StateChangeRule"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryCodeBuildJobRunner{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunnerProps",
		reflect.TypeOf((*AppTheoryCodeBuildJobRunnerProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryDynamoDBStreamMapping",
		reflect.TypeOf((*AppTheoryDynamoDBStreamMapping)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryDynamoDBStreamMapping{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryDynamoDBStreamMappingProps",
		reflect.TypeOf((*AppTheoryDynamoDBStreamMappingProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryDynamoTable",
		reflect.TypeOf((*AppTheoryDynamoTable)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "table", GoGetter: "Table"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryDynamoTable{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryDynamoTableGsiProps",
		reflect.TypeOf((*AppTheoryDynamoTableGsiProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryDynamoTableProps",
		reflect.TypeOf((*AppTheoryDynamoTableProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurity",
		reflect.TypeOf((*AppTheoryEnhancedSecurity)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addCustomSecurityRule", GoMethod: "AddCustomSecurityRule"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "secret", GoMethod: "Secret"},
			_jsii_.MemberProperty{JsiiProperty: "secrets", GoGetter: "Secrets"},
			_jsii_.MemberProperty{JsiiProperty: "securityGroup", GoGetter: "SecurityGroup"},
			_jsii_.MemberMethod{JsiiMethod: "securityGroupResource", GoMethod: "SecurityGroupResource"},
			_jsii_.MemberMethod{JsiiMethod: "securityMetric", GoMethod: "SecurityMetric"},
			_jsii_.MemberProperty{JsiiProperty: "securityMetrics", GoGetter: "SecurityMetrics"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "vpcEndpoint", GoMethod: "VpcEndpoint"},
			_jsii_.MemberProperty{JsiiProperty: "vpcEndpoints", GoGetter: "VpcEndpoints"},
			_jsii_.MemberProperty{JsiiProperty: "vpcFlowLogsGroup", GoGetter: "VpcFlowLogsGroup"},
			_jsii_.MemberProperty{JsiiProperty: "waf", GoGetter: "Waf"},
			_jsii_.MemberMethod{JsiiMethod: "wafWebAcl", GoMethod: "WafWebAcl"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryEnhancedSecurity{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurityProps",
		reflect.TypeOf((*AppTheoryEnhancedSecurityProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeBus",
		reflect.TypeOf((*AppTheoryEventBridgeBus)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "allowAccount", GoMethod: "AllowAccount"},
			_jsii_.MemberProperty{JsiiProperty: "eventBus", GoGetter: "EventBus"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "policies", GoGetter: "Policies"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryEventBridgeBus{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeBusProps",
		reflect.TypeOf((*AppTheoryEventBridgeBusProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandler",
		reflect.TypeOf((*AppTheoryEventBridgeHandler)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "rule", GoGetter: "Rule"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryEventBridgeHandler{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandlerProps",
		reflect.TypeOf((*AppTheoryEventBridgeHandlerProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeRuleTarget",
		reflect.TypeOf((*AppTheoryEventBridgeRuleTarget)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "rule", GoGetter: "Rule"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryEventBridgeRuleTarget{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeRuleTargetProps",
		reflect.TypeOf((*AppTheoryEventBridgeRuleTargetProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBusTable",
		reflect.TypeOf((*AppTheoryEventBusTable)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "bind", GoMethod: "Bind"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "table", GoGetter: "Table"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryEventBusTable{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBusTableBindingOptions",
		reflect.TypeOf((*AppTheoryEventBusTableBindingOptions)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBusTableProps",
		reflect.TypeOf((*AppTheoryEventBusTableProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryFunction",
		reflect.TypeOf((*AppTheoryFunction)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "fn", GoGetter: "Fn"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryFunction{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarms",
		reflect.TypeOf((*AppTheoryFunctionAlarms)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "errors", GoGetter: "Errors"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "throttles", GoGetter: "Throttles"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryFunctionAlarms{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarmsProps",
		reflect.TypeOf((*AppTheoryFunctionAlarmsProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryFunctionProps",
		reflect.TypeOf((*AppTheoryFunctionProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryHostedZone",
		reflect.TypeOf((*AppTheoryHostedZone)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addCnameRecord", GoMethod: "AddCnameRecord"},
			_jsii_.MemberMethod{JsiiMethod: "addNsRecord", GoMethod: "AddNsRecord"},
			_jsii_.MemberProperty{JsiiProperty: "hostedZone", GoGetter: "HostedZone"},
			_jsii_.MemberProperty{JsiiProperty: "hostedZoneId", GoGetter: "HostedZoneId"},
			_jsii_.MemberProperty{JsiiProperty: "isImported", GoGetter: "IsImported"},
			_jsii_.MemberMethod{JsiiMethod: "nameServers", GoMethod: "NameServers"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
			_jsii_.MemberProperty{JsiiProperty: "zoneName", GoGetter: "ZoneName"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryHostedZone{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryHostedZoneProps",
		reflect.TypeOf((*AppTheoryHostedZoneProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpApi",
		reflect.TypeOf((*AppTheoryHttpApi)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryHttpApi{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpApiProps",
		reflect.TypeOf((*AppTheoryHttpApiProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpoint",
		reflect.TypeOf((*AppTheoryHttpIngestionEndpoint)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "accessLogGroup", GoGetter: "AccessLogGroup"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "apiMapping", GoGetter: "ApiMapping"},
			_jsii_.MemberProperty{JsiiProperty: "cnameRecord", GoGetter: "CnameRecord"},
			_jsii_.MemberProperty{JsiiProperty: "domainName", GoGetter: "DomainName"},
			_jsii_.MemberProperty{JsiiProperty: "endpoint", GoGetter: "Endpoint"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "routeAuthorizer", GoGetter: "RouteAuthorizer"},
			_jsii_.MemberProperty{JsiiProperty: "stage", GoGetter: "Stage"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryHttpIngestionEndpoint{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpointDomainOptions",
		reflect.TypeOf((*AppTheoryHttpIngestionEndpointDomainOptions)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpointProps",
		reflect.TypeOf((*AppTheoryHttpIngestionEndpointProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpointStageOptions",
		reflect.TypeOf((*AppTheoryHttpIngestionEndpointStageOptions)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryJobsTable",
		reflect.TypeOf((*AppTheoryJobsTable)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "bindEnvironment", GoMethod: "BindEnvironment"},
			_jsii_.MemberMethod{JsiiMethod: "grantReadTo", GoMethod: "GrantReadTo"},
			_jsii_.MemberMethod{JsiiMethod: "grantReadWriteTo", GoMethod: "GrantReadWriteTo"},
			_jsii_.MemberMethod{JsiiMethod: "grantWriteTo", GoMethod: "GrantWriteTo"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "table", GoGetter: "Table"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryJobsTable{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryJobsTableProps",
		reflect.TypeOf((*AppTheoryJobsTableProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStream",
		reflect.TypeOf((*AppTheoryKinesisStream)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "grantRead", GoMethod: "GrantRead"},
			_jsii_.MemberMethod{JsiiMethod: "grantReadWrite", GoMethod: "GrantReadWrite"},
			_jsii_.MemberMethod{JsiiMethod: "grantWrite", GoMethod: "GrantWrite"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "stream", GoGetter: "Stream"},
			_jsii_.MemberProperty{JsiiProperty: "streamArn", GoGetter: "StreamArn"},
			_jsii_.MemberProperty{JsiiProperty: "streamName", GoGetter: "StreamName"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryKinesisStream{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStreamMapping",
		reflect.TypeOf((*AppTheoryKinesisStreamMapping)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryKinesisStreamMapping{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStreamMappingProps",
		reflect.TypeOf((*AppTheoryKinesisStreamMappingProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStreamProps",
		reflect.TypeOf((*AppTheoryKinesisStreamProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryKmsKey",
		reflect.TypeOf((*AppTheoryKmsKey)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "alias", GoGetter: "Alias"},
			_jsii_.MemberProperty{JsiiProperty: "key", GoGetter: "Key"},
			_jsii_.MemberProperty{JsiiProperty: "keyArn", GoGetter: "KeyArn"},
			_jsii_.MemberProperty{JsiiProperty: "keyId", GoGetter: "KeyId"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "ssmParameter", GoGetter: "SsmParameter"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryKmsKey{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryKmsKeyProps",
		reflect.TypeOf((*AppTheoryKmsKeyProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryLambdaRole",
		reflect.TypeOf((*AppTheoryLambdaRole)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addManagedPolicy", GoMethod: "AddManagedPolicy"},
			_jsii_.MemberMethod{JsiiMethod: "addToPolicy", GoMethod: "AddToPolicy"},
			_jsii_.MemberMethod{JsiiMethod: "grantAssumeRole", GoMethod: "GrantAssumeRole"},
			_jsii_.MemberMethod{JsiiMethod: "grantPassRole", GoMethod: "GrantPassRole"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "role", GoGetter: "Role"},
			_jsii_.MemberProperty{JsiiProperty: "roleArn", GoGetter: "RoleArn"},
			_jsii_.MemberProperty{JsiiProperty: "roleName", GoGetter: "RoleName"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryLambdaRole{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryLambdaRoleProps",
		reflect.TypeOf((*AppTheoryLambdaRoleProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource",
		reflect.TypeOf((*AppTheoryMcpProtectedResource)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMcpProtectedResource{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResourceProps",
		reflect.TypeOf((*AppTheoryMcpProtectedResourceProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServer",
		reflect.TypeOf((*AppTheoryMcpServer)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "accessLogGroup", GoGetter: "AccessLogGroup"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "apiMapping", GoGetter: "ApiMapping"},
			_jsii_.MemberProperty{JsiiProperty: "cnameRecord", GoGetter: "CnameRecord"},
			_jsii_.MemberProperty{JsiiProperty: "domainName", GoGetter: "DomainName"},
			_jsii_.MemberProperty{JsiiProperty: "endpoint", GoGetter: "Endpoint"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "sessionTable", GoGetter: "SessionTable"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMcpServer{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServerDomainOptions",
		reflect.TypeOf((*AppTheoryMcpServerDomainOptions)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServerProps",
		reflect.TypeOf((*AppTheoryMcpServerProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServerStageOptions",
		reflect.TypeOf((*AppTheoryMcpServerStageOptions)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMediaCdn",
		reflect.TypeOf((*AppTheoryMediaCdn)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "bucket", GoGetter: "Bucket"},
			_jsii_.MemberProperty{JsiiProperty: "certificate", GoGetter: "Certificate"},
			_jsii_.MemberProperty{JsiiProperty: "distribution", GoGetter: "Distribution"},
			_jsii_.MemberProperty{JsiiProperty: "keyGroup", GoGetter: "KeyGroup"},
			_jsii_.MemberProperty{JsiiProperty: "logsBucket", GoGetter: "LogsBucket"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "publicKey", GoGetter: "PublicKey"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMediaCdn{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMediaCdnProps",
		reflect.TypeOf((*AppTheoryMediaCdnProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmController",
		reflect.TypeOf((*AppTheoryMicrovmController)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "accessLogGroup", GoGetter: "AccessLogGroup"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "controllerFunction", GoGetter: "ControllerFunction"},
			_jsii_.MemberProperty{JsiiProperty: "endpoint", GoGetter: "Endpoint"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "routeAuthorizer", GoGetter: "RouteAuthorizer"},
			_jsii_.MemberProperty{JsiiProperty: "sessionTable", GoGetter: "SessionTable"},
			_jsii_.MemberProperty{JsiiProperty: "stage", GoGetter: "Stage"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMicrovmController{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmControllerFunctionProps",
		reflect.TypeOf((*AppTheoryMicrovmControllerFunctionProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmControllerProps",
		reflect.TypeOf((*AppTheoryMicrovmControllerProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmControllerStageOptions",
		reflect.TypeOf((*AppTheoryMicrovmControllerStageOptions)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmHookMode",
		reflect.TypeOf((*AppTheoryMicrovmHookMode)(nil)).Elem(),
		map[string]interface{}{
			"DISABLED": AppTheoryMicrovmHookMode_DISABLED,
			"ENABLED":  AppTheoryMicrovmHookMode_ENABLED,
		},
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage",
		reflect.TypeOf((*AppTheoryMicrovmImage)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "createdAt", GoGetter: "CreatedAt"},
			_jsii_.MemberProperty{JsiiProperty: "latestActiveImageVersion", GoGetter: "LatestActiveImageVersion"},
			_jsii_.MemberProperty{JsiiProperty: "latestFailedImageVersion", GoGetter: "LatestFailedImageVersion"},
			_jsii_.MemberProperty{JsiiProperty: "microvmImage", GoGetter: "MicrovmImage"},
			_jsii_.MemberProperty{JsiiProperty: "microvmImageArn", GoGetter: "MicrovmImageArn"},
			_jsii_.MemberProperty{JsiiProperty: "microvmImageName", GoGetter: "MicrovmImageName"},
			_jsii_.MemberProperty{JsiiProperty: "microvmImageState", GoGetter: "MicrovmImageState"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberProperty{JsiiProperty: "updatedAt", GoGetter: "UpdatedAt"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMicrovmImage{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			_jsii_.InitJsiiProxy(&j.jsiiProxy_IAppTheoryMicrovmImage)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageBuildHooks",
		reflect.TypeOf((*AppTheoryMicrovmImageBuildHooks)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageCloudWatchLogging",
		reflect.TypeOf((*AppTheoryMicrovmImageCloudWatchLogging)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageCodeArtifact",
		reflect.TypeOf((*AppTheoryMicrovmImageCodeArtifact)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageCpuArchitecture",
		reflect.TypeOf((*AppTheoryMicrovmImageCpuArchitecture)(nil)).Elem(),
		map[string]interface{}{
			"ARM_64": AppTheoryMicrovmImageCpuArchitecture_ARM_64,
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageCpuConfiguration",
		reflect.TypeOf((*AppTheoryMicrovmImageCpuConfiguration)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageEnvironmentVariable",
		reflect.TypeOf((*AppTheoryMicrovmImageEnvironmentVariable)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageHooks",
		reflect.TypeOf((*AppTheoryMicrovmImageHooks)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageLogging",
		reflect.TypeOf((*AppTheoryMicrovmImageLogging)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageOsCapability",
		reflect.TypeOf((*AppTheoryMicrovmImageOsCapability)(nil)).Elem(),
		map[string]interface{}{
			"ALL": AppTheoryMicrovmImageOsCapability_ALL,
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageProps",
		reflect.TypeOf((*AppTheoryMicrovmImageProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImageResources",
		reflect.TypeOf((*AppTheoryMicrovmImageResources)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmManagedNetworkConnector",
		reflect.TypeOf((*AppTheoryMicrovmManagedNetworkConnector)(nil)).Elem(),
		map[string]interface{}{
			"ALL_INGRESS":     AppTheoryMicrovmManagedNetworkConnector_ALL_INGRESS,
			"NO_INGRESS":      AppTheoryMicrovmManagedNetworkConnector_NO_INGRESS,
			"INTERNET_EGRESS": AppTheoryMicrovmManagedNetworkConnector_INTERNET_EGRESS,
			"SHELL_INGRESS":   AppTheoryMicrovmManagedNetworkConnector_SHELL_INGRESS,
		},
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnector",
		reflect.TypeOf((*AppTheoryMicrovmNetworkConnector)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "networkConnector", GoGetter: "NetworkConnector"},
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorArn", GoGetter: "NetworkConnectorArn"},
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorKind", GoGetter: "NetworkConnectorKind"},
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorState", GoGetter: "NetworkConnectorState"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "operatorRole", GoGetter: "OperatorRole"},
			_jsii_.MemberProperty{JsiiProperty: "securityGroupIds", GoGetter: "SecurityGroupIds"},
			_jsii_.MemberProperty{JsiiProperty: "subnetIds", GoGetter: "SubnetIds"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberProperty{JsiiProperty: "vpc", GoGetter: "Vpc"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMicrovmNetworkConnector{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			_jsii_.InitJsiiProxy(&j.jsiiProxy_IAppTheoryMicrovmNetworkConnector)
			return &j
		},
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorKind",
		reflect.TypeOf((*AppTheoryMicrovmNetworkConnectorKind)(nil)).Elem(),
		map[string]interface{}{
			"INGRESS":       AppTheoryMicrovmNetworkConnectorKind_INGRESS,
			"EGRESS":        AppTheoryMicrovmNetworkConnectorKind_EGRESS,
			"SHELL_INGRESS": AppTheoryMicrovmNetworkConnectorKind_SHELL_INGRESS,
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorProps",
		reflect.TypeOf((*AppTheoryMicrovmNetworkConnectorProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference",
		reflect.TypeOf((*AppTheoryMicrovmNetworkConnectorReference)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorArn", GoGetter: "NetworkConnectorArn"},
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorKind", GoGetter: "NetworkConnectorKind"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryMicrovmNetworkConnectorReference{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			_jsii_.InitJsiiProxy(&j.jsiiProxy_IAppTheoryMicrovmNetworkConnector)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReferenceProps",
		reflect.TypeOf((*AppTheoryMicrovmNetworkConnectorReferenceProps)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkProtocol",
		reflect.TypeOf((*AppTheoryMicrovmNetworkProtocol)(nil)).Elem(),
		map[string]interface{}{
			"IPV4":       AppTheoryMicrovmNetworkProtocol_IPV4,
			"DUAL_STACK": AppTheoryMicrovmNetworkProtocol_DUAL_STACK,
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmRuntimeHooks",
		reflect.TypeOf((*AppTheoryMicrovmRuntimeHooks)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend",
		reflect.TypeOf((*AppTheoryPathRoutedFrontend)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "certificate", GoGetter: "Certificate"},
			_jsii_.MemberProperty{JsiiProperty: "distribution", GoGetter: "Distribution"},
			_jsii_.MemberProperty{JsiiProperty: "logsBucket", GoGetter: "LogsBucket"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "spaRewriteFunction", GoGetter: "SpaRewriteFunction"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryPathRoutedFrontend{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontendProps",
		reflect.TypeOf((*AppTheoryPathRoutedFrontendProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryQueue",
		reflect.TypeOf((*AppTheoryQueue)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "deadLetterQueue", GoGetter: "DeadLetterQueue"},
			_jsii_.MemberMethod{JsiiMethod: "grantConsumeMessages", GoMethod: "GrantConsumeMessages"},
			_jsii_.MemberMethod{JsiiMethod: "grantPurge", GoMethod: "GrantPurge"},
			_jsii_.MemberMethod{JsiiMethod: "grantSendMessages", GoMethod: "GrantSendMessages"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "queue", GoGetter: "Queue"},
			_jsii_.MemberProperty{JsiiProperty: "queueArn", GoGetter: "QueueArn"},
			_jsii_.MemberProperty{JsiiProperty: "queueName", GoGetter: "QueueName"},
			_jsii_.MemberProperty{JsiiProperty: "queueUrl", GoGetter: "QueueUrl"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryQueue{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueConsumer",
		reflect.TypeOf((*AppTheoryQueueConsumer)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "consumer", GoGetter: "Consumer"},
			_jsii_.MemberMethod{JsiiMethod: "disable", GoMethod: "Disable"},
			_jsii_.MemberProperty{JsiiProperty: "eventSourceMapping", GoGetter: "EventSourceMapping"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "queue", GoGetter: "Queue"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryQueueConsumer{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueConsumerProps",
		reflect.TypeOf((*AppTheoryQueueConsumerProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProcessor",
		reflect.TypeOf((*AppTheoryQueueProcessor)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "consumerConstruct", GoGetter: "ConsumerConstruct"},
			_jsii_.MemberProperty{JsiiProperty: "deadLetterQueue", GoGetter: "DeadLetterQueue"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "queue", GoGetter: "Queue"},
			_jsii_.MemberProperty{JsiiProperty: "queueConstruct", GoGetter: "QueueConstruct"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryQueueProcessor{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProcessorProps",
		reflect.TypeOf((*AppTheoryQueueProcessorProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProps",
		reflect.TypeOf((*AppTheoryQueueProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServer",
		reflect.TypeOf((*AppTheoryRemoteMcpServer)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "endpoint", GoGetter: "Endpoint"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "router", GoGetter: "Router"},
			_jsii_.MemberProperty{JsiiProperty: "sessionTable", GoGetter: "SessionTable"},
			_jsii_.MemberProperty{JsiiProperty: "streamSpillBucket", GoGetter: "StreamSpillBucket"},
			_jsii_.MemberProperty{JsiiProperty: "streamTable", GoGetter: "StreamTable"},
			_jsii_.MemberProperty{JsiiProperty: "taskTable", GoGetter: "TaskTable"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryRemoteMcpServer{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServerProps",
		reflect.TypeOf((*AppTheoryRemoteMcpServerProps)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApi",
		reflect.TypeOf((*AppTheoryRestApi)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addRoute", GoMethod: "AddRoute"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryRestApi{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiProps",
		reflect.TypeOf((*AppTheoryRestApiProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouteOptions",
		reflect.TypeOf((*AppTheoryRestApiRouteOptions)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter",
		reflect.TypeOf((*AppTheoryRestApiRouter)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "aaaaRecord", GoGetter: "AaaaRecord"},
			_jsii_.MemberProperty{JsiiProperty: "accessLogGroup", GoGetter: "AccessLogGroup"},
			_jsii_.MemberMethod{JsiiMethod: "addLambdaIntegration", GoMethod: "AddLambdaIntegration"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "aRecord", GoGetter: "ARecord"},
			_jsii_.MemberProperty{JsiiProperty: "basePathMapping", GoGetter: "BasePathMapping"},
			_jsii_.MemberProperty{JsiiProperty: "domainName", GoGetter: "DomainName"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "stage", GoGetter: "Stage"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryRestApiRouter{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouterCorsOptions",
		reflect.TypeOf((*AppTheoryRestApiRouterCorsOptions)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouterDomainOptions",
		reflect.TypeOf((*AppTheoryRestApiRouterDomainOptions)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouterIntegrationOptions",
		reflect.TypeOf((*AppTheoryRestApiRouterIntegrationOptions)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouterProps",
		reflect.TypeOf((*AppTheoryRestApiRouterProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouterStageOptions",
		reflect.TypeOf((*AppTheoryRestApiRouterStageOptions)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryS3Ingest",
		reflect.TypeOf((*AppTheoryS3Ingest)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "bucket", GoGetter: "Bucket"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "queue", GoGetter: "Queue"},
			_jsii_.MemberProperty{JsiiProperty: "queueConstruct", GoGetter: "QueueConstruct"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryS3Ingest{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryS3IngestProps",
		reflect.TypeOf((*AppTheoryS3IngestProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheorySecretConfig",
		reflect.TypeOf((*AppTheorySecretConfig)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheorySecurityRule",
		reflect.TypeOf((*AppTheorySecurityRule)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheorySpaRewriteMode",
		reflect.TypeOf((*AppTheorySpaRewriteMode)(nil)).Elem(),
		map[string]interface{}{
			"SPA":  AppTheorySpaRewriteMode_SPA,
			"NONE": AppTheorySpaRewriteMode_NONE,
		},
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSite",
		reflect.TypeOf((*AppTheorySsrSite)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "assetsBucket", GoGetter: "AssetsBucket"},
			_jsii_.MemberProperty{JsiiProperty: "assetsKeyPrefix", GoGetter: "AssetsKeyPrefix"},
			_jsii_.MemberProperty{JsiiProperty: "assetsManifestKey", GoGetter: "AssetsManifestKey"},
			_jsii_.MemberProperty{JsiiProperty: "bearerFunctionUrls", GoGetter: "BearerFunctionUrls"},
			_jsii_.MemberProperty{JsiiProperty: "certificate", GoGetter: "Certificate"},
			_jsii_.MemberProperty{JsiiProperty: "distribution", GoGetter: "Distribution"},
			_jsii_.MemberProperty{JsiiProperty: "htmlStoreBucket", GoGetter: "HtmlStoreBucket"},
			_jsii_.MemberProperty{JsiiProperty: "htmlStoreKeyPrefix", GoGetter: "HtmlStoreKeyPrefix"},
			_jsii_.MemberProperty{JsiiProperty: "isrMetadataTable", GoGetter: "IsrMetadataTable"},
			_jsii_.MemberProperty{JsiiProperty: "logsBucket", GoGetter: "LogsBucket"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "responseHeadersPolicy", GoGetter: "ResponseHeadersPolicy"},
			_jsii_.MemberProperty{JsiiProperty: "ssrUrl", GoGetter: "SsrUrl"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheorySsrSite{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSiteBearerFunctionUrlOrigin",
		reflect.TypeOf((*AppTheorySsrSiteBearerFunctionUrlOrigin)(nil)).Elem(),
	)
	_jsii_.RegisterEnum(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSiteMode",
		reflect.TypeOf((*AppTheorySsrSiteMode)(nil)).Elem(),
		map[string]interface{}{
			"SSR_ONLY": AppTheorySsrSiteMode_SSR_ONLY,
			"SSG_ISR":  AppTheorySsrSiteMode_SSG_ISR,
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSiteProps",
		reflect.TypeOf((*AppTheorySsrSiteProps)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryVpcEndpointConfig",
		reflect.TypeOf((*AppTheoryVpcEndpointConfig)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryWafRuleConfig",
		reflect.TypeOf((*AppTheoryWafRuleConfig)(nil)).Elem(),
	)
	_jsii_.RegisterClass(
		"@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi",
		reflect.TypeOf((*AppTheoryWebSocketApi)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "accessLogGroup", GoGetter: "AccessLogGroup"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "connectionTable", GoGetter: "ConnectionTable"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "stage", GoGetter: "Stage"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
			_jsii_.MemberMethod{JsiiMethod: "with", GoMethod: "With"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryWebSocketApi{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheoryWebSocketApiProps",
		reflect.TypeOf((*AppTheoryWebSocketApiProps)(nil)).Elem(),
	)
	_jsii_.RegisterInterface(
		"@theory-cloud/apptheory-cdk.IAppTheoryMicrovmImage",
		reflect.TypeOf((*IAppTheoryMicrovmImage)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "microvmImageArn", GoGetter: "MicrovmImageArn"},
		},
		func() interface{} {
			return &jsiiProxy_IAppTheoryMicrovmImage{}
		},
	)
	_jsii_.RegisterInterface(
		"@theory-cloud/apptheory-cdk.IAppTheoryMicrovmNetworkConnector",
		reflect.TypeOf((*IAppTheoryMicrovmNetworkConnector)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorArn", GoGetter: "NetworkConnectorArn"},
			_jsii_.MemberProperty{JsiiProperty: "networkConnectorKind", GoGetter: "NetworkConnectorKind"},
		},
		func() interface{} {
			return &jsiiProxy_IAppTheoryMicrovmNetworkConnector{}
		},
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.MediaCdnDomainConfig",
		reflect.TypeOf((*MediaCdnDomainConfig)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.PathRoutedFrontendDomainConfig",
		reflect.TypeOf((*PathRoutedFrontendDomainConfig)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.PrivateMediaConfig",
		reflect.TypeOf((*PrivateMediaConfig)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.SpaOriginConfig",
		reflect.TypeOf((*SpaOriginConfig)(nil)).Elem(),
	)
}
