package apptheorycdk

// Properties for an imported or AWS-managed MicroVM network connector reference.
type AppTheoryMicrovmNetworkConnectorReferenceProps struct {
	// The network connector ARN.
	NetworkConnectorArn *string `field:"required" json:"networkConnectorArn" yaml:"networkConnectorArn"`
	// Connector direction/type.
	// Default: undefined.
	//
	NetworkConnectorKind AppTheoryMicrovmNetworkConnectorKind `field:"optional" json:"networkConnectorKind" yaml:"networkConnectorKind"`
}
