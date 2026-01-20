package apptheory

import "testing"

func TestIsLambda_EnvDetection(t *testing.T) {
	t.Setenv("AWS_LAMBDA_FUNCTION_NAME", "")
	t.Setenv("AWS_LAMBDA_RUNTIME_API", "")
	t.Setenv("LAMBDA_TASK_ROOT", "")
	t.Setenv("AWS_EXECUTION_ENV", "")

	if IsLambda() {
		t.Fatalf("expected IsLambda false with empty env")
	}

	t.Setenv("AWS_LAMBDA_FUNCTION_NAME", "fn")
	if !IsLambda() {
		t.Fatalf("expected IsLambda true when function name set")
	}

	app := New()
	if !app.IsLambda() {
		t.Fatalf("expected App.IsLambda true when function name set")
	}
}
