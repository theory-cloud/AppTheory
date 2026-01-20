package apptheory

type PolicyDecision struct {
	Code    string
	Message string
	Headers map[string][]string
}

type PolicyHook func(*Context) (*PolicyDecision, error)
