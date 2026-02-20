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
		"@theory-cloud/apptheory-cdk.AppTheoryDynamoDBStreamMapping",
		reflect.TypeOf((*AppTheoryDynamoDBStreamMapping)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
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
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandler",
		reflect.TypeOf((*AppTheoryEventBridgeHandler)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "rule", GoGetter: "Rule"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
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
		"@theory-cloud/apptheory-cdk.AppTheoryEventBusTable",
		reflect.TypeOf((*AppTheoryEventBusTable)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "table", GoGetter: "Table"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheoryEventBusTable{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
		},
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
		"@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend",
		reflect.TypeOf((*AppTheoryPathRoutedFrontend)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "certificate", GoGetter: "Certificate"},
			_jsii_.MemberProperty{JsiiProperty: "distribution", GoGetter: "Distribution"},
			_jsii_.MemberProperty{JsiiProperty: "logsBucket", GoGetter: "LogsBucket"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "spaRewriteFunction", GoGetter: "SpaRewriteFunction"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
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
		"@theory-cloud/apptheory-cdk.AppTheoryRestApi",
		reflect.TypeOf((*AppTheoryRestApi)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberMethod{JsiiMethod: "addRoute", GoMethod: "AddRoute"},
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
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
			_jsii_.MemberProperty{JsiiProperty: "certificate", GoGetter: "Certificate"},
			_jsii_.MemberProperty{JsiiProperty: "distribution", GoGetter: "Distribution"},
			_jsii_.MemberProperty{JsiiProperty: "logsBucket", GoGetter: "LogsBucket"},
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "ssrUrl", GoGetter: "SsrUrl"},
			_jsii_.MemberMethod{JsiiMethod: "toString", GoMethod: "ToString"},
		},
		func() interface{} {
			j := jsiiProxy_AppTheorySsrSite{}
			_jsii_.InitJsiiProxy(&j.Type__constructsConstruct)
			return &j
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
