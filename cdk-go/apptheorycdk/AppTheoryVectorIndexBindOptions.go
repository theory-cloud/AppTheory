package apptheorycdk

type AppTheoryVectorIndexBindOptions struct {
	// Embedding dimensions.
	// Default: this.dimension
	//
	EmbeddingDimensions *float64 `field:"optional" json:"embeddingDimensions" yaml:"embeddingDimensions"`
	// Bedrock embedding model id.
	// Default: "amazon.titan-embed-text-v2:0"
	//
	EmbeddingModelId *string `field:"optional" json:"embeddingModelId" yaml:"embeddingModelId"`
	// Whether embedding responses should be normalized.
	// Default: true.
	//
	EmbeddingNormalize *bool `field:"optional" json:"embeddingNormalize" yaml:"embeddingNormalize"`
	// Embedding provider name.
	// Default: "bedrock".
	//
	EmbeddingProvider *string `field:"optional" json:"embeddingProvider" yaml:"embeddingProvider"`
	// Include Bedrock embedding environment variables in addition to vector index variables.
	// Default: false.
	//
	IncludeEmbedding *bool `field:"optional" json:"includeEmbedding" yaml:"includeEmbedding"`
}
