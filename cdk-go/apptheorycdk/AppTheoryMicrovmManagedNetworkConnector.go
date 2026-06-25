package apptheorycdk

// AWS-managed Lambda MicroVM network connector references.
type AppTheoryMicrovmManagedNetworkConnector string

const (
	// Enable all inbound HTTPS connectivity for a MicroVM.
	AppTheoryMicrovmManagedNetworkConnector_ALL_INGRESS AppTheoryMicrovmManagedNetworkConnector = "ALL_INGRESS"
	// Explicitly disable inbound HTTPS connectivity for a MicroVM.
	AppTheoryMicrovmManagedNetworkConnector_NO_INGRESS AppTheoryMicrovmManagedNetworkConnector = "NO_INGRESS"
	// Enable AWS-managed public internet egress for a MicroVM.
	AppTheoryMicrovmManagedNetworkConnector_INTERNET_EGRESS AppTheoryMicrovmManagedNetworkConnector = "INTERNET_EGRESS"
	// Enable shell ingress required by CreateMicrovmShellAuthToken.
	AppTheoryMicrovmManagedNetworkConnector_SHELL_INGRESS AppTheoryMicrovmManagedNetworkConnector = "SHELL_INGRESS"
)
