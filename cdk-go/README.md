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

Each v2+ GitHub Release has two create-only Git refs at the same signed release commit:

- root runtime: `vX.Y.Z[-rc[.N]]`
- CDK Go module: `cdk-go/apptheorycdk/vX.Y.Z[-rc[.N]]`

The Go command derives the nested tag prefix from the module directory, so consumers still select the ordinary
version suffix:

```bash
go get github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2@v2.0.0
```

The serialized prerelease/stable publisher creates only absent refs, accepts an existing ref only when it already
targets the exact release commit, and refuses to move or delete a conflicting tag. It then resolves both the root and
CDK modules through direct VCS lookup and checks the returned version, tag ref, module directive, and commit hash
before the draft GitHub Release becomes public.

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
