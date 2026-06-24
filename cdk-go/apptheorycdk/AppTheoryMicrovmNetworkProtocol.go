package apptheorycdk

// Network protocols supported by Lambda MicroVM VPC egress connectors.
type AppTheoryMicrovmNetworkProtocol string

const (
	// IPv4-only VPC egress.
	AppTheoryMicrovmNetworkProtocol_IPV4 AppTheoryMicrovmNetworkProtocol = "IPV4"
	// Dual-stack IPv4/IPv6 VPC egress.
	AppTheoryMicrovmNetworkProtocol_DUAL_STACK AppTheoryMicrovmNetworkProtocol = "DUAL_STACK"
)
