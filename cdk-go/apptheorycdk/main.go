// AppTheory CDK constructs (TS-first jsii)
package apptheorycdk

import (
	"reflect"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

func init() {
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
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProcessor",
		reflect.TypeOf((*AppTheoryQueueProcessor)(nil)).Elem(),
		[]_jsii_.Member{
			_jsii_.MemberProperty{JsiiProperty: "node", GoGetter: "Node"},
			_jsii_.MemberProperty{JsiiProperty: "queue", GoGetter: "Queue"},
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
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheorySecretConfig",
		reflect.TypeOf((*AppTheorySecretConfig)(nil)).Elem(),
	)
	_jsii_.RegisterStruct(
		"@theory-cloud/apptheory-cdk.AppTheorySecurityRule",
		reflect.TypeOf((*AppTheorySecurityRule)(nil)).Elem(),
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
			_jsii_.MemberProperty{JsiiProperty: "api", GoGetter: "Api"},
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
}
