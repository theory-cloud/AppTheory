package apptheorycdk

// The Python application a Python Web Function serves.
//
// A Python Web Function is not a request/response handler: Lambda manages the HTTP server and
// passes each request to this application through the interface named here. The interface is part
// of the stack, so it is deployment configuration rather than a runtime knob.
type AppTheoryPythonInterface string

const (
	// An ASGI 3.0 application. Concurrent requests run on the application's single event loop.
	AppTheoryPythonInterface_ASGI AppTheoryPythonInterface = "ASGI"
	// A WSGI application.
	//
	// Concurrent requests run in the server's pool of worker threads.
	AppTheoryPythonInterface_WSGI AppTheoryPythonInterface = "WSGI"
)
