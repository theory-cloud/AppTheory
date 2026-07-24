---
title: AppTheory 2.0 MicroVM Runtime Logging
description: Migrate Lambda MicroVM controllers to the required deployment-owned CloudWatch-or-disabled runtime logging contract.
---

# AppTheory 2.0 MicroVM Runtime Logging

AppTheory 2.0 makes Lambda MicroVM runtime logging explicit for every `RunMicrovm` operation. A deployment must choose
exactly one posture:

- send guest runtime output to CloudWatch Logs; or
- disable runtime logging explicitly.

Omission is not a default. It is invalid configuration and fails closed. The controller owns the choice for every run;
an HTTP caller cannot provide or override it.

This is a breaking change for deployments that construct an `AppTheoryMicrovmImage`, pass a structural
`IAppTheoryMicrovmImage` reference, create a real controller directly in tests, or invoke the constrained provider
surface directly.

## Why this changed

A controlled Factory EqualToAI lesser-host A/B held the image version, execution role, network connector, duration, and
log group constant. The AppTheory 1.x-shaped request that omitted the AWS `Logging` union ran without creating a stream
or delivering events. The otherwise identical request with explicit CloudWatch logging continuously delivered guest
stdout.

That result proves omission is not a deterministic logging fallback. AppTheory therefore does not inherit, guess, or
silently default the per-run posture.

## Migration checklist

1. Choose CloudWatch or explicit disabled logging for every MicroVM image.
2. Add the choice to `AppTheoryMicrovmImage.logging`.
3. If CloudWatch is selected, pass a MicroVM `executionRole` to `AppTheoryMicrovmController`.
4. Grant that execution role the required CloudWatch Logs actions and Lambda trust described below.
5. Add `logging` to every imported or structural `IAppTheoryMicrovmImage` reference.
6. Remove any request field, custom environment override, or raw SDK call that lets an HTTP caller choose logging.
7. Re-synthesize and validate through the AppTheory CDK and contract gates.
8. Have Factory run the external lesser-host acceptance check after the AppTheory milestone is ready.

Do not replace these steps with a raw AWS SDK call. If the AppTheory surface cannot express a future logging mode, grow
the shared contract first.

## CloudWatch mode

Set the image logging posture and supply the controller's MicroVM execution role:

```ts
const image = new AppTheoryMicrovmImage(this, "MicrovmImage", {
  // Other required image props omitted.
  logging: {
    cloudWatch: {
      logGroup: "/aws/lambda/microvms/my-service",
      logStream: "runtime",
    },
  },
});

new AppTheoryMicrovmController(this, "MicrovmController", {
  // Other required controller props omitted.
  microvmImage: image,
  executionRole: microvmExecutionRole,
});
```

`AppTheoryMicrovmController` serializes the normalized choice into the reserved
`APPTHEORY_MICROVM_LOGGING` environment variable. The real Go, TypeScript, and Python controllers read it and pass the
corresponding logging union to every provider `Run` request. Do not set this environment variable through
`controller.environment`; the construct rejects reserved-key overrides.

The MicroVM execution role is separate from the image build role and the controller Lambda's own role. It must:

- trust `lambda.amazonaws.com` for `sts:AssumeRole`;
- allow `sts:TagSession` in the trust policy; and
- allow `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`.

See the [AWS Lambda MicroVM security and permissions guide](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)
and the runnable role wiring in `examples/cdk/microvm-controller`.

AppTheory grants the controller permission to pass the supplied role. It does not inspect or mutate arbitrary role
policies, so synthesis cannot prove that an imported or later-mutated role contains the Logs permissions. A missing
permission remains a deployment/operator error and must be corrected on the role supplied to the AppTheory construct.

## Disabled mode

When runtime output must not be delivered, disable it explicitly:

```ts
const image = new AppTheoryMicrovmImage(this, "MicrovmImage", {
  // Other required image props omitted.
  logging: { disabled: true },
});
```

Disabled mode does not require `AppTheoryMicrovmController.executionRole` for logging. Do not use `{}`, `disabled:
false`, or an omitted property as a disabled shorthand; each is invalid.

## Imported image references

`IAppTheoryMicrovmImage` now includes the normalized logging posture. Structural references must migrate from:

```ts
const image: IAppTheoryMicrovmImage = {
  microvmImageArn: importedImageArn,
};
```

to one explicit shape:

```ts
const image: IAppTheoryMicrovmImage = {
  microvmImageArn: importedImageArn,
  logging: {
    cloudWatch: {
      logGroup: "/aws/lambda/microvms/my-service",
      logStream: "runtime",
    },
  },
};
```

or:

```ts
const image: IAppTheoryMicrovmImage = {
  microvmImageArn: importedImageArn,
  logging: { disabled: true },
};
```

CloudWatch structural references have the same execution-role requirement as construct-created images.

## Direct runtime construction in tests

Production deployment stays on `AppTheoryMicrovmImage` plus `AppTheoryMicrovmController`. Tests that construct the real
controller without CDK must now provide the same union explicitly:

| Runtime | Test/configuration surface |
| --- | --- |
| Go | `microvm.WithControllerLogging(microvm.ProviderLogging{Disabled: true})` or a `CloudWatch` member paired with `WithControllerExecutionRoleArn(...)` |
| TypeScript | `createRealMicroVMController(provider, registry, { logging: { disabled: true } })` or CloudWatch logging paired with `execution_role_arn` |
| Python | `create_real_microvm_controller(provider, registry, logging={"disabled": True})` or CloudWatch logging paired with `execution_role_arn` |

Direct constrained-provider tests must also populate the required `ProviderRunInput.logging` /
`MicroVMProviderRunInput.logging` field. These are test and runtime contract surfaces, not permission to bypass the
AppTheory controller in a deployment.

## Failure modes

| Configuration | Result |
| --- | --- |
| Logging omitted | CDK synthesis or real-controller construction fails closed. |
| CloudWatch and disabled both set | Validation fails closed. |
| `disabled` set to `false` | Validation fails closed. |
| CloudWatch selected without an execution role | CDK synthesis or real-controller construction fails closed. |
| Invalid log group or stream | Validation fails closed before the provider call. |
| Caller includes logging in `POST /microvms` | The request cannot replace the deployment-owned posture. |
| `controller.environment` overrides `APPTHEORY_MICROVM_LOGGING` | CDK synthesis fails closed. |
| Execution role lacks required Logs permissions | Synthesis may pass, but live log delivery fails; fix the supplied role. |

When guest output is dark, do not infer that image-level settings were inherited. Inspect the deployed image logging
posture, the reserved controller environment value, the controller execution role, and CloudWatch permissions together.

## Acceptance and evidence boundary

Repository gates prove the fixture-backed union, cross-language provider mapping, controller ownership, CDK
serialization, and generated bindings. They do not perform a live AWS deployment.

Factory EqualToAI owns the external lesser-host acceptance run. That run should hold the image version, execution role,
network connector, duration, and destination constant while verifying that the AppTheory 2.0 CloudWatch path delivers
guest output. The existing conformance harness can scan supplied logs for leaks, but it does not provision CloudWatch
logging or independently prove delivery.

## Release and validation

AppTheory releases are immutable GitHub Releases. Pin the published `v2.0.0` release asset when it is available; do not
substitute an npm or PyPI publication path.

Validate a migrated source tree with:

```bash
./scripts/verify-contract-tests.sh
./scripts/verify-cdk-constructs.sh
./scripts/verify-cdk-go.sh
./scripts/verify-cdk-synth.sh
make rubric
```

Related guidance:

- [AWS Lambda MicroVM Golden Path](../features/lambda-microvm-contract-foundation.md)
- [Lambda MicroVM CDK Constructs](../cdk/lambda-microvm.md)
- [Operations Guide](../guides/operations.md)
