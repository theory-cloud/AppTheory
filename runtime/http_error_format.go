package apptheory

// HTTPErrorFormat controls how AppTheory serializes HTTP error bodies.
type HTTPErrorFormat string

const (
	HTTPErrorFormatNested     HTTPErrorFormat = "nested"
	HTTPErrorFormatFlatLegacy HTTPErrorFormat = "flat_legacy"
)

func normalizeHTTPErrorFormat(format HTTPErrorFormat) HTTPErrorFormat {
	switch format {
	case HTTPErrorFormatFlatLegacy:
		return HTTPErrorFormatFlatLegacy
	default:
		return HTTPErrorFormatNested
	}
}
