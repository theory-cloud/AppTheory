package apptheorycdk

type AppTheoryHostedZoneProps struct {
	ZoneName         *string             `field:"required" json:"zoneName" yaml:"zoneName"`
	CfnExportName    *string             `field:"optional" json:"cfnExportName" yaml:"cfnExportName"`
	Comment          *string             `field:"optional" json:"comment" yaml:"comment"`
	EnableCfnExport  *bool               `field:"optional" json:"enableCfnExport" yaml:"enableCfnExport"`
	EnableSsmExport  *bool               `field:"optional" json:"enableSsmExport" yaml:"enableSsmExport"`
	ExistingZoneId   *string             `field:"optional" json:"existingZoneId" yaml:"existingZoneId"`
	ImportIfExists   *bool               `field:"optional" json:"importIfExists" yaml:"importIfExists"`
	SsmParameterPath *string             `field:"optional" json:"ssmParameterPath" yaml:"ssmParameterPath"`
	Tags             *map[string]*string `field:"optional" json:"tags" yaml:"tags"`
}
