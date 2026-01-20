// AppTheory CDK constructs (TS-first jsii)
package apptheorycdk

import (
	"reflect"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

func init() {
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
