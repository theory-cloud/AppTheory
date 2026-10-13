package apptheorycdk

// Defensive snapshot of the construct's derived facade inventory.
type AppTheoryMcpServerRouteInventory struct {
	CallbackPattern                 *string                           `field:"required" json:"callbackPattern" yaml:"callbackPattern"`
	ContractVersion                 *string                           `field:"required" json:"contractVersion" yaml:"contractVersion"`
	RootAuthorizationServerAttached *bool                             `field:"required" json:"rootAuthorizationServerAttached" yaml:"rootAuthorizationServerAttached"`
	RootAuthorizationServerPattern  *string                           `field:"required" json:"rootAuthorizationServerPattern" yaml:"rootAuthorizationServerPattern"`
	Routes                          *[]*AppTheoryMcpServerFacadeRoute `field:"required" json:"routes" yaml:"routes"`
}
