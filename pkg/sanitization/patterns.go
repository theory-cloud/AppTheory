package sanitization

import "regexp"

// PaymentXMLPatterns contains pre-configured patterns for common payment processing XML elements.
//
// It is designed for safe logging (masking/redaction), not for request validation.
var PaymentXMLPatterns = []XMLSanitizationPattern{
	{
		Name:        "AcctNum",
		Pattern:     regexp.MustCompile(`(?i)(<AcctNum>[^<]*</AcctNum>|&lt;AcctNum&gt;[^&]*&lt;/AcctNum&gt;)`),
		MaskingFunc: MaskCardNumber,
	},
	{
		Name:        "CardNum",
		Pattern:     regexp.MustCompile(`(?i)(<CardNum>[^<]*</CardNum>|&lt;CardNum&gt;[^&]*&lt;/CardNum&gt;)`),
		MaskingFunc: MaskCardNumber,
	},
	{
		Name:        "CardNumber",
		Pattern:     regexp.MustCompile(`(?i)(<CardNumber>[^<]*</CardNumber>|&lt;CardNumber&gt;[^&]*&lt;/CardNumber&gt;)`),
		MaskingFunc: MaskCardNumber,
	},
	{
		Name:        "TrackData",
		Pattern:     regexp.MustCompile(`(?i)(<TrackData>[^<]*</TrackData>|&lt;TrackData&gt;[^&]*&lt;/TrackData&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "CVV",
		Pattern:     regexp.MustCompile(`(?i)(<CVV>[^<]*</CVV>|&lt;CVV&gt;[^&]*&lt;/CVV&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "CVV2",
		Pattern:     regexp.MustCompile(`(?i)(<CVV2>[^<]*</CVV2>|&lt;CVV2&gt;[^&]*&lt;/CVV2&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "CVC",
		Pattern:     regexp.MustCompile(`(?i)(<CVC>[^<]*</CVC>|&lt;CVC&gt;[^&]*&lt;/CVC&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "ExpDate",
		Pattern:     regexp.MustCompile(`(?i)(<ExpDate>[^<]*</ExpDate>|&lt;ExpDate&gt;[^&]*&lt;/ExpDate&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "ExpiryDate",
		Pattern:     regexp.MustCompile(`(?i)(<ExpiryDate>[^<]*</ExpiryDate>|&lt;ExpiryDate&gt;[^&]*&lt;/ExpiryDate&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "Password",
		Pattern:     regexp.MustCompile(`(?i)(<Password>[^<]*</Password>|&lt;Password&gt;[^&]*&lt;/Password&gt;)`),
		MaskingFunc: MaskCompletelyFunc(redactedValue),
	},
	{
		Name:        "TransArmorToken",
		Pattern:     regexp.MustCompile(`(?i)(<TransArmorToken>[^<]*</TransArmorToken>|&lt;TransArmorToken&gt;[^&]*&lt;/TransArmorToken&gt;)`),
		MaskingFunc: MaskTokenLastFour,
	},
}

// RapidConnectXMLPatterns is an alias for PaymentXMLPatterns for compatibility with existing codebases.
var RapidConnectXMLPatterns = PaymentXMLPatterns
