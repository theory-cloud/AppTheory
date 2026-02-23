package apptheorycdk

type AppTheoryWafRuleConfig struct {
	EnableKnownBadInputs *bool      `field:"optional" json:"enableKnownBadInputs" yaml:"enableKnownBadInputs"`
	EnableRateLimit      *bool      `field:"optional" json:"enableRateLimit" yaml:"enableRateLimit"`
	EnableSQLiProtection *bool      `field:"optional" json:"enableSQLiProtection" yaml:"enableSQLiProtection"`
	EnableXSSProtection  *bool      `field:"optional" json:"enableXSSProtection" yaml:"enableXSSProtection"`
	GeoBlocking          *[]*string `field:"optional" json:"geoBlocking" yaml:"geoBlocking"`
	IpBlacklist          *[]*string `field:"optional" json:"ipBlacklist" yaml:"ipBlacklist"`
	IpWhitelist          *[]*string `field:"optional" json:"ipWhitelist" yaml:"ipWhitelist"`
	RateLimit            *float64   `field:"optional" json:"rateLimit" yaml:"rateLimit"`
}
