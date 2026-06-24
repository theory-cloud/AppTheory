package apptheorycdk

// Resource requirements for AWS::Lambda::MicrovmImage.
type AppTheoryMicrovmImageResources struct {
	// The minimum amount of memory in MiB to allocate to the MicroVM.
	MinimumMemoryInMiB *float64 `field:"required" json:"minimumMemoryInMiB" yaml:"minimumMemoryInMiB"`
}
