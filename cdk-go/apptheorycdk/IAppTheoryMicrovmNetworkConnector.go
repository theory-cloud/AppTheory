package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

// Reference to a Lambda MicroVM network connector usable by MicroVM image constructs.
type IAppTheoryMicrovmNetworkConnector interface {
	// The network connector ARN.
	NetworkConnectorArn() *string
	// Optional connector direction/type used by AppTheory constructs to fail closed when ingress, egress, or shell connector references are wired into the wrong slot.
	NetworkConnectorKind() AppTheoryMicrovmNetworkConnectorKind
}

// The jsii proxy for IAppTheoryMicrovmNetworkConnector
type jsiiProxy_IAppTheoryMicrovmNetworkConnector struct {
	_ byte // padding
}

func (j *jsiiProxy_IAppTheoryMicrovmNetworkConnector) NetworkConnectorArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"networkConnectorArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_IAppTheoryMicrovmNetworkConnector) NetworkConnectorKind() AppTheoryMicrovmNetworkConnectorKind {
	var returns AppTheoryMicrovmNetworkConnectorKind
	_jsii_.Get(
		j,
		"networkConnectorKind",
		&returns,
	)
	return returns
}
