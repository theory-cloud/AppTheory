package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

// Reference to a Lambda MicroVM network connector usable by MicroVM image constructs.
type IAppTheoryMicrovmNetworkConnector interface {
	// The network connector ARN.
	NetworkConnectorArn() *string
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
