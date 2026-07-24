# AppTheory CDK Go bindings

`cdk-go/` contains the jsii-generated AppTheory CDK bindings. Runtime-only Go consumers depend on the repository root
module (`github.com/theory-cloud/apptheory/v2`) and do not pull `aws-cdk-go`, `constructs-go`, or `jsii-runtime-go`
through the root `go.mod`.

AppTheory v2 CDK consumers pin the independently tagged nested module and use its single canonical import path:

```bash
go get github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2@v2.0.0-rc
```

```go
import "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2"
```

Immutable AppTheory v1 tags retain the legacy
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk` import. AppTheory v2 does not provide an alias or alternate
module path.

Release Please still owns the checked-in package version. While `staging` prepares the next major, the checked-in v1
module layout remains drift-free; generation moves `go.mod` and `go.sum` into `cdk-go/apptheorycdk/` when the generated
release PR advances the CDK package to v2.

Validate whichever layout matches the checked-in release version with:

```bash
./scripts/verify-cdk-go.sh
```
