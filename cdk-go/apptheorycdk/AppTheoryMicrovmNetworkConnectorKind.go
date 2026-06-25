package apptheorycdk

// Direction/type for a Lambda MicroVM network connector reference.
type AppTheoryMicrovmNetworkConnectorKind string

const (
	// Inbound HTTPS connector reference passed to RunMicrovm.
	AppTheoryMicrovmNetworkConnectorKind_INGRESS AppTheoryMicrovmNetworkConnectorKind = "INGRESS"
	// Outbound connector reference passed to RunMicrovm.
	AppTheoryMicrovmNetworkConnectorKind_EGRESS AppTheoryMicrovmNetworkConnectorKind = "EGRESS"
	// AWS-managed shell ingress connector required for shell-auth-token support.
	AppTheoryMicrovmNetworkConnectorKind_SHELL_INGRESS AppTheoryMicrovmNetworkConnectorKind = "SHELL_INGRESS"
)
