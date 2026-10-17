package apptheorycdk

// Construct-id derivation for the explicit route model.
type AppTheoryMcpRouteIdMode string

const (
	// Positional ids (`Route0`, `Route1`, ...) assigned in emission order. This is the construct's historical inventory and stays byte-identical for deployed stacks. The default.
	AppTheoryMcpRouteIdMode_LEGACY AppTheoryMcpRouteIdMode = "LEGACY"
	// Ids derived from the route method and pattern, so inserting, removing, or reordering a route family never renames an unrelated route.
	//
	// Intended for
	// newly created explicit APIs: switching an existing deployed explicit API
	// from `legacy` to `semantic` in place renames every route, which is itself a
	// create-before-delete collision. Adopt it on an existing stack only through
	// the new-API swap described in `UPGRADING.md`.
	AppTheoryMcpRouteIdMode_SEMANTIC AppTheoryMcpRouteIdMode = "SEMANTIC"
)
