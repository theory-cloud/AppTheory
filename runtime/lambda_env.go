package apptheory

import "os"

func IsLambda() bool {
	return isLambdaEnv()
}

func (a *App) IsLambda() bool {
	return IsLambda()
}

func isLambdaEnv() bool {
	if os.Getenv("AWS_LAMBDA_FUNCTION_NAME") != "" {
		return true
	}
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		return true
	}
	if os.Getenv("LAMBDA_TASK_ROOT") != "" {
		return true
	}
	if os.Getenv("AWS_EXECUTION_ENV") != "" {
		return true
	}
	return false
}
