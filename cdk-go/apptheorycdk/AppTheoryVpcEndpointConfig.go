package apptheorycdk

type AppTheoryVpcEndpointConfig struct {
	EnableCloudWatchLogs       *bool `field:"optional" json:"enableCloudWatchLogs" yaml:"enableCloudWatchLogs"`
	EnableCloudWatchMonitoring *bool `field:"optional" json:"enableCloudWatchMonitoring" yaml:"enableCloudWatchMonitoring"`
	EnableKms                  *bool `field:"optional" json:"enableKms" yaml:"enableKms"`
	EnableSecretsManager       *bool `field:"optional" json:"enableSecretsManager" yaml:"enableSecretsManager"`
	EnableXRay                 *bool `field:"optional" json:"enableXRay" yaml:"enableXRay"`
	PrivateDnsEnabled          *bool `field:"optional" json:"privateDnsEnabled" yaml:"privateDnsEnabled"`
}
