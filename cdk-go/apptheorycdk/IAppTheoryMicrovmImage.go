package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

// Reference to a Lambda MicroVM image usable by MicroVM controller constructs.
type IAppTheoryMicrovmImage interface {
	// The ARN of the MicroVM image.
	MicrovmImageArn() *string
}

// The jsii proxy for IAppTheoryMicrovmImage
type jsiiProxy_IAppTheoryMicrovmImage struct {
	_ byte // padding
}

func (j *jsiiProxy_IAppTheoryMicrovmImage) MicrovmImageArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"microvmImageArn",
		&returns,
	)
	return returns
}
