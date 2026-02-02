package apptheorycdk

type AppTheorySpaRewriteMode string

const (
	// Rewrite extensionless routes to `index.html` within the SPA prefix.
	AppTheorySpaRewriteMode_SPA AppTheorySpaRewriteMode = "SPA"
	// Do not rewrite routes.
	//
	// Useful for multi-page/static sites.
	AppTheorySpaRewriteMode_NONE AppTheorySpaRewriteMode = "NONE"
)
