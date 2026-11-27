package apptheorycdk

// The Python application a Python Web Function serves, as the runtime loads it.
type AppTheoryPythonAppProps struct {
	// The interface the callable implements.
	//
	// `ASGI` declares an async callable; `WSGI` declares a synchronous one. The interface is written
	// with the entry point (as `asgi:module:callable`), so the runtime never has to guess.
	Interface AppTheoryPythonInterface `field:"required" json:"interface" yaml:"interface"`
	// The module that holds the callable, relative to the root of the deployment package and without the `.py` extension, for example `main`.
	//
	// Must not contain a colon: the runtime's entry-point syntax is `module:callable`.
	Module *string `field:"required" json:"module" yaml:"module"`
	// The name of the callable the module exposes.
	// Default: "app".
	//
	Callable *string `field:"optional" json:"callable" yaml:"callable"`
}
