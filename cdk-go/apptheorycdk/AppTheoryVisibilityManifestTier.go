package apptheorycdk

// The SSM parameter tier of the published visibility manifest.
type AppTheoryVisibilityManifestTier string

const (
	// Standard tier: a 4096-character value limit.
	AppTheoryVisibilityManifestTier_STANDARD AppTheoryVisibilityManifestTier = "STANDARD"
	// Advanced tier: an 8192-character value limit.
	AppTheoryVisibilityManifestTier_ADVANCED AppTheoryVisibilityManifestTier = "ADVANCED"
)
