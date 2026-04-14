package apptheorycdk

type AppTheorySsrSiteMode string

const (
	// Lambda Function URL is the default origin.
	//
	// Direct S3 behaviors are used only for
	// immutable assets and any explicitly configured static path patterns.
	//
	// Because this mode exposes Lambda as the default viewer surface with write methods,
	// omitted `ssrUrlAuthType` resolves to `NONE`.
	AppTheorySsrSiteMode_SSR_ONLY AppTheorySsrSiteMode = "SSR_ONLY"
	// S3 is the primary HTML origin and Lambda SSR/ISR is the fallback.
	//
	// FaceTheory hydration
	// data routes are kept on S3 and the edge rewrites extensionless paths to `/index.html`.
	AppTheorySsrSiteMode_SSG_ISR AppTheorySsrSiteMode = "SSG_ISR"
)
