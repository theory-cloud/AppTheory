# AppTheory CDK Go bindings

`cdk-go/` is a nested Go module for the jsii-generated AppTheory CDK bindings.
Runtime-only Go consumers should depend on the repository root module (`github.com/theory-cloud/apptheory`) and will not pull `aws-cdk-go`, `constructs-go`, or `jsii-runtime-go` through the root `go.mod`.

Go CDK consumers keep the existing import path:

```go
import "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk"
```

Validate the nested module locally with:

```bash
cd cdk-go
go test ./...
```
