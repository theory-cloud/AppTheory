"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMicrovmImage = exports.AppTheoryMicrovmHookMode = exports.AppTheoryMicrovmImageCpuArchitecture = exports.AppTheoryMicrovmImageOsCapability = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = require("aws-cdk-lib/aws-iam");
const lambda = require("aws-cdk-lib/aws-lambda");
const custom_resources_1 = require("aws-cdk-lib/custom-resources");
const constructs_1 = require("constructs");
const microvm_image_prune_handler_1 = require("./private/microvm-image-prune-handler");
/**
 * Additional OS capabilities supported by Lambda MicroVM images.
 */
var AppTheoryMicrovmImageOsCapability;
(function (AppTheoryMicrovmImageOsCapability) {
    /**
     * Grants all currently supported MicroVM OS capabilities.
     */
    AppTheoryMicrovmImageOsCapability["ALL"] = "ALL";
})(AppTheoryMicrovmImageOsCapability || (exports.AppTheoryMicrovmImageOsCapability = AppTheoryMicrovmImageOsCapability = {}));
/**
 * CPU architectures supported by Lambda MicroVM images.
 */
var AppTheoryMicrovmImageCpuArchitecture;
(function (AppTheoryMicrovmImageCpuArchitecture) {
    /**
     * ARM64 MicroVM image architecture.
     */
    AppTheoryMicrovmImageCpuArchitecture["ARM_64"] = "ARM_64";
})(AppTheoryMicrovmImageCpuArchitecture || (exports.AppTheoryMicrovmImageCpuArchitecture = AppTheoryMicrovmImageCpuArchitecture = {}));
/**
 * Lifecycle hook mode for Lambda MicroVM image hooks.
 */
var AppTheoryMicrovmHookMode;
(function (AppTheoryMicrovmHookMode) {
    /**
     * Disable the lifecycle hook.
     */
    AppTheoryMicrovmHookMode["DISABLED"] = "DISABLED";
    /**
     * Enable the lifecycle hook.
     */
    AppTheoryMicrovmHookMode["ENABLED"] = "ENABLED";
})(AppTheoryMicrovmHookMode || (exports.AppTheoryMicrovmHookMode = AppTheoryMicrovmHookMode = {}));
/**
 * AppTheory CDK construct for AWS Lambda MicroVM images.
 *
 * This construct is intentionally deployment-only: it creates the CloudFormation
 * `AWS::Lambda::MicrovmImage` resource from caller-provided code artifact, base image,
 * build role, lifecycle hooks, logging configuration, resource requirements, and
 * AppTheory MicroVM network-connector references. Runtime controller behavior stays in
 * the AppTheory runtime contract.
 */
class AppTheoryMicrovmImage extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        if (props === undefined || props === null) {
            throw new Error("AppTheoryMicrovmImage requires props");
        }
        const name = normalizeName(props.name);
        const description = normalizeRequiredString(props.description, "description");
        const baseImageArn = normalizeNoWhitespaceString(props.baseImageArn, "baseImageArn", 2048);
        const baseImageVersion = normalizeNoWhitespaceString(props.baseImageVersion, "baseImageVersion", 2048);
        const buildRoleArn = normalizeBuildRoleArn(props.buildRoleArn);
        const codeArtifact = renderCodeArtifact(props.codeArtifact);
        const egressNetworkConnectors = normalizeConnectorReferences(props.egressNetworkConnectors);
        const hooks = renderHooks(props.hooks);
        const logging = normalizeLogging(props.logging);
        const resources = renderResources(props.resources);
        const additionalOsCapabilities = normalizeAdditionalOsCapabilities(props.additionalOsCapabilities);
        const cpuConfigurations = renderCpuConfigurations(props.cpuConfigurations);
        const environmentVariables = renderEnvironmentVariables(props.environmentVariables);
        const renderedImageProperties = {
            AdditionalOsCapabilities: additionalOsCapabilities,
            BaseImageArn: baseImageArn,
            BaseImageVersion: baseImageVersion,
            BuildRoleArn: buildRoleArn,
            CodeArtifact: codeArtifact,
            CpuConfigurations: cpuConfigurations,
            Description: description,
            EgressNetworkConnectors: egressNetworkConnectors,
            EnvironmentVariables: environmentVariables,
            Hooks: hooks,
            Logging: renderLogging(logging),
            Name: name,
            Resources: resources,
            Tags: renderTags(props.tags),
        };
        this.microvmImage = new aws_cdk_lib_1.CfnResource(this, "MicrovmImage", {
            type: "AWS::Lambda::MicrovmImage",
            properties: renderedImageProperties,
        });
        this.microvmImageName = this.microvmImage.ref;
        this.microvmImageArn = this.microvmImage.getAtt("ImageArn").toString();
        this.logging = logging;
        this.microvmImageState = this.microvmImage.getAtt("State").toString();
        this.latestActiveImageVersion = this.microvmImage.getAtt("LatestActiveImageVersion").toString();
        this.latestFailedImageVersion = this.microvmImage.getAtt("LatestFailedImageVersion").toString();
        this.createdAt = this.microvmImage.getAtt("CreatedAt").toString();
        this.updatedAt = this.microvmImage.getAtt("UpdatedAt").toString();
        this.wireVersionPruning(renderedImageProperties, name);
    }
    /**
     * Wires the always-on version-pruning custom resource.
     *
     * Every CloudFormation create/update that touches the image — signaled by a
     * change to the mirrored image properties — runs the prune handler BEFORE the
     * `AWS::Lambda::MicrovmImage` update creates a new version: the image resource
     * carries an explicit `DependsOn` on the prune custom resource so CloudFormation
     * orders the prune first. A list/describe failure fails the deployment loudly,
     * except a 404 on the version list (the image does not exist yet on a fresh
     * stack CREATE), which is treated as nothing to prune; a per-version delete
     * refusal is logged and skipped. On stack DELETE the handler returns success
     * without pruning because CloudFormation deletes the whole image. There are no
     * deploy-time knobs: pruning is always-on encoded behavior.
     *
     * The handler env and IAM policy reference the image ARN constructed from
     * pseudo-parameters (`Stack.formatArn`) rather than from `ImageArn` GetAtt:
     * the handler function is downstream of the prune custom resource, so a
     * GetAtt-based reference would make the handler depend on the image and close
     * a CloudFormation dependency cycle (image → prune → handler → image). The
     * ARN is built in the canonical colon form: the Lambda MicroVMs control plane
     * authorizes `arn:aws:lambda:<region>:<account>:microvm-image:<name>` only,
     * and rejects the slash form (`...:microvm-image/<name>`) with HTTP 403
     * AccessDenied regardless of IAM (live-verified).
     */
    wireVersionPruning(renderedImageProperties, imageName) {
        const pruneImageArn = aws_cdk_lib_1.Stack.of(this).formatArn({
            service: "lambda",
            resource: "microvm-image",
            resourceName: imageName,
            arnFormat: aws_cdk_lib_1.ArnFormat.COLON_RESOURCE_NAME,
        });
        const pruneHandler = new lambda.Function(this, "MicrovmImagePruneHandler", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "index.handler",
            code: lambda.Code.fromInline(microvm_image_prune_handler_1.MICROVM_IMAGE_PRUNE_HANDLER_SOURCE),
            timeout: aws_cdk_lib_1.Duration.minutes(1),
            memorySize: 128,
            environment: {
                APPTHEORY_MICROVM_IMAGE_ARN: pruneImageArn,
                APPTHEORY_MICROVM_IMAGE_REGION: aws_cdk_lib_1.Stack.of(this).region,
            },
        });
        // Exactly the two microvm list/delete actions on "*". The Lambda MicroVMs
        // control plane authorizes the canonical colon-form image ARN
        // (`...:microvm-image:<name>`); the slash form (`...:microvm-image/<name>`)
        // is rejected with HTTP 403 AccessDenied regardless of IAM (live-verified,
        // byte-identical message to the deploy failures this fix addresses).
        // Resource-level IAM scoping support remains untested, so the grant stays
        // on "*"; the handler binary itself only ever targets the single image ARN
        // from its APPTHEORY_MICROVM_IMAGE_ARN env, which is the actual constraint.
        pruneHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ["lambda:ListMicrovmImageVersions", "lambda:DeleteMicrovmImageVersion"],
            resources: ["*"],
        }));
        const pruneProvider = new custom_resources_1.Provider(this, "MicrovmImagePruneProvider", {
            onEventHandler: pruneHandler,
        });
        const prune = new aws_cdk_lib_1.CustomResource(this, "MicrovmImagePrune", {
            serviceToken: pruneProvider.serviceToken,
            properties: {
                // Mirrors the image's rendered properties so the prune custom resource
                // is re-invoked exactly when the image resource itself would be updated
                // by CloudFormation. The prune handler reads the image ARN from its own
                // environment rather than from these properties, so the custom resource
                // never creates an implicit dependency that would reverse the ordering.
                MicrovmImageProperties: renderedImageProperties,
            },
        });
        this.microvmImage.node.addDependency(prune);
    }
}
exports.AppTheoryMicrovmImage = AppTheoryMicrovmImage;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "4.2.3" };
function normalizeName(value) {
    const name = normalizeRequiredString(value, "name");
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        throw new Error("AppTheoryMicrovmImage: name must be 1-64 characters using letters, numbers, hyphens, or underscores");
    }
    return name;
}
function normalizeRequiredString(value, propName) {
    if (value === undefined || value === null) {
        throw new Error(`AppTheoryMicrovmImage requires props.${propName}`);
    }
    const normalized = String(value).trim();
    if (!normalized) {
        throw new Error(`AppTheoryMicrovmImage requires props.${propName}`);
    }
    return normalized;
}
function normalizeNoWhitespaceString(value, propName, maxLength) {
    const normalized = normalizeRequiredString(value, propName);
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && /\s/.test(normalized)) {
        throw new Error(`AppTheoryMicrovmImage: ${propName} must not contain whitespace`);
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && normalized.length > maxLength) {
        throw new Error(`AppTheoryMicrovmImage: ${propName} must be at most ${maxLength} characters`);
    }
    return normalized;
}
function normalizeBuildRoleArn(value) {
    const arn = normalizeNoWhitespaceString(value, "buildRoleArn", 2048);
    if (!aws_cdk_lib_1.Token.isUnresolved(value) &&
        !/^arn:aws[a-zA-Z-]*:iam::\d{12}:role\/?[a-zA-Z_0-9+=,.@\-_/]+$/.test(arn)) {
        throw new Error("AppTheoryMicrovmImage: buildRoleArn must be an IAM role ARN");
    }
    return arn;
}
function renderCodeArtifact(codeArtifact) {
    if (codeArtifact === undefined || codeArtifact === null) {
        throw new Error("AppTheoryMicrovmImage requires props.codeArtifact");
    }
    return {
        Uri: normalizeNoWhitespaceString(codeArtifact.uri, "codeArtifact.uri", 2048),
    };
}
function normalizeConnectorReferences(connectors) {
    if (!connectors || connectors.length === 0) {
        throw new Error("AppTheoryMicrovmImage requires at least 1 egressNetworkConnectors entry");
    }
    if (connectors.length > 10) {
        throw new Error("AppTheoryMicrovmImage supports at most 10 egressNetworkConnectors entries");
    }
    const arns = connectors.map((connector, index) => {
        if (connector === undefined || connector === null) {
            throw new Error(`AppTheoryMicrovmImage requires props.egressNetworkConnectors[${index}]`);
        }
        const arn = normalizeRequiredString(connector.networkConnectorArn, `egressNetworkConnectors[${index}].networkConnectorArn`);
        if (!aws_cdk_lib_1.Token.isUnresolved(arn) && /\s/.test(arn)) {
            throw new Error(`AppTheoryMicrovmImage: egressNetworkConnectors[${index}].networkConnectorArn must not contain whitespace`);
        }
        return arn;
    });
    assertNoDuplicates(arns, "egressNetworkConnectors networkConnectorArn");
    return arns;
}
function normalizeAdditionalOsCapabilities(values) {
    const capabilities = values ?? [AppTheoryMicrovmImageOsCapability.ALL];
    if (capabilities.length === 0) {
        throw new Error("AppTheoryMicrovmImage requires at least 1 additionalOsCapabilities entry");
    }
    const normalized = capabilities.map((capability, index) => {
        if (String(capability).trim().toUpperCase() !== AppTheoryMicrovmImageOsCapability.ALL) {
            throw new Error(`AppTheoryMicrovmImage: additionalOsCapabilities[${index}] must be ALL`);
        }
        return AppTheoryMicrovmImageOsCapability.ALL;
    });
    assertNoDuplicates(normalized, "additionalOsCapabilities");
    return normalized;
}
function renderCpuConfigurations(values) {
    const cpuConfigurations = values ?? [{ architecture: AppTheoryMicrovmImageCpuArchitecture.ARM_64 }];
    if (cpuConfigurations.length === 0) {
        throw new Error("AppTheoryMicrovmImage requires at least 1 cpuConfigurations entry");
    }
    return cpuConfigurations.map((cpu, index) => {
        if (cpu === undefined || cpu === null) {
            throw new Error(`AppTheoryMicrovmImage requires props.cpuConfigurations[${index}]`);
        }
        const architecture = String(cpu.architecture ?? AppTheoryMicrovmImageCpuArchitecture.ARM_64)
            .trim()
            .toUpperCase();
        if (architecture !== AppTheoryMicrovmImageCpuArchitecture.ARM_64) {
            throw new Error(`AppTheoryMicrovmImage: cpuConfigurations[${index}].architecture must be ARM_64`);
        }
        return { Architecture: AppTheoryMicrovmImageCpuArchitecture.ARM_64 };
    });
}
function renderEnvironmentVariables(values) {
    if ((values?.length ?? 0) > 50) {
        throw new Error("AppTheoryMicrovmImage supports at most 50 environmentVariables entries");
    }
    const rendered = (values ?? []).map((entry, index) => {
        if (entry === undefined || entry === null) {
            throw new Error(`AppTheoryMicrovmImage requires props.environmentVariables[${index}]`);
        }
        const key = normalizeNoWhitespaceString(entry.key, `environmentVariables[${index}].key`, 256);
        const value = entry.value === undefined || entry.value === null ? undefined : String(entry.value);
        if (value === undefined) {
            throw new Error(`AppTheoryMicrovmImage requires props.environmentVariables[${index}].value`);
        }
        if (!aws_cdk_lib_1.Token.isUnresolved(value) && value.length > 4096) {
            throw new Error(`AppTheoryMicrovmImage: environmentVariables[${index}].value must be at most 4096 characters`);
        }
        return { Key: key, Value: value };
    });
    assertNoDuplicates(rendered.map((entry) => entry.Key), "environmentVariables key");
    return rendered;
}
function renderHooks(hooks) {
    if (hooks === undefined || hooks === null) {
        throw new Error("AppTheoryMicrovmImage requires props.hooks");
    }
    const rendered = {};
    const microvmHooks = renderRuntimeHooks(hooks.microvmHooks);
    if (microvmHooks) {
        rendered.MicrovmHooks = microvmHooks;
    }
    const microvmImageHooks = renderImageHooks(hooks.microvmImageHooks);
    if (microvmImageHooks) {
        rendered.MicrovmImageHooks = microvmImageHooks;
    }
    const hasHookGroup = Boolean(rendered.MicrovmHooks || rendered.MicrovmImageHooks);
    if (hasHookGroup && hooks.port === undefined) {
        throw new Error("AppTheoryMicrovmImage: hooks.port is required when props.hooks.microvmHooks or props.hooks.microvmImageHooks is configured");
    }
    if (hooks.port !== undefined) {
        if (!hasHookGroup) {
            throw new Error("AppTheoryMicrovmImage: hooks.port requires props.hooks.microvmHooks or props.hooks.microvmImageHooks");
        }
        rendered.Port = normalizeIntegerInRange(hooks.port, "hooks.port", 1, 65535);
    }
    return rendered;
}
function renderRuntimeHooks(hooks) {
    if (hooks === undefined) {
        return undefined;
    }
    if (hooks === null) {
        throw new Error("AppTheoryMicrovmImage requires props.hooks.microvmHooks");
    }
    const rendered = {};
    setHookMode(rendered, "Resume", hooks.resume, "hooks.microvmHooks.resume");
    setOptionalInteger(rendered, "ResumeTimeoutInSeconds", hooks.resumeTimeoutInSeconds, "hooks.microvmHooks.resumeTimeoutInSeconds", 1, 60);
    setHookMode(rendered, "Run", hooks.run, "hooks.microvmHooks.run");
    setOptionalInteger(rendered, "RunTimeoutInSeconds", hooks.runTimeoutInSeconds, "hooks.microvmHooks.runTimeoutInSeconds", 1, 60);
    setHookMode(rendered, "Suspend", hooks.suspend, "hooks.microvmHooks.suspend");
    setOptionalInteger(rendered, "SuspendTimeoutInSeconds", hooks.suspendTimeoutInSeconds, "hooks.microvmHooks.suspendTimeoutInSeconds", 1, 60);
    setHookMode(rendered, "Terminate", hooks.terminate, "hooks.microvmHooks.terminate");
    setOptionalInteger(rendered, "TerminateTimeoutInSeconds", hooks.terminateTimeoutInSeconds, "hooks.microvmHooks.terminateTimeoutInSeconds", 1, 60);
    if (Object.keys(rendered).length === 0) {
        throw new Error("AppTheoryMicrovmImage requires at least 1 hooks.microvmHooks setting");
    }
    return rendered;
}
function renderImageHooks(hooks) {
    if (hooks === undefined) {
        return undefined;
    }
    if (hooks === null) {
        throw new Error("AppTheoryMicrovmImage requires props.hooks.microvmImageHooks");
    }
    const rendered = {};
    setHookMode(rendered, "Ready", hooks.ready, "hooks.microvmImageHooks.ready");
    setOptionalInteger(rendered, "ReadyTimeoutInSeconds", hooks.readyTimeoutInSeconds, "hooks.microvmImageHooks.readyTimeoutInSeconds", 1, 3600);
    setHookMode(rendered, "Validate", hooks.validate, "hooks.microvmImageHooks.validate");
    setOptionalInteger(rendered, "ValidateTimeoutInSeconds", hooks.validateTimeoutInSeconds, "hooks.microvmImageHooks.validateTimeoutInSeconds", 1, 3600);
    if (Object.keys(rendered).length === 0) {
        throw new Error("AppTheoryMicrovmImage requires at least 1 hooks.microvmImageHooks setting");
    }
    return rendered;
}
function setHookMode(target, key, mode, propName) {
    if (mode === undefined) {
        return;
    }
    const normalized = String(mode).trim().toUpperCase();
    if (normalized !== AppTheoryMicrovmHookMode.ENABLED && normalized !== AppTheoryMicrovmHookMode.DISABLED) {
        throw new Error(`AppTheoryMicrovmImage: ${propName} must be ENABLED or DISABLED`);
    }
    target[key] = normalized;
}
function setOptionalInteger(target, key, value, propName, min, max) {
    if (value === undefined) {
        return;
    }
    target[key] = normalizeIntegerInRange(value, propName, min, max);
}
function normalizeLogging(logging) {
    if (logging === undefined || logging === null) {
        throw new Error("AppTheoryMicrovmImage requires props.logging");
    }
    const hasCloudWatch = logging.cloudWatch !== undefined && logging.cloudWatch !== null;
    const hasDisabled = logging.disabled !== undefined;
    if (hasCloudWatch === hasDisabled) {
        throw new Error("AppTheoryMicrovmImage: logging must specify exactly one of cloudWatch or disabled");
    }
    if (hasDisabled) {
        if (logging.disabled !== true) {
            throw new Error("AppTheoryMicrovmImage: logging.disabled must be true when provided");
        }
        return { disabled: true };
    }
    return { cloudWatch: normalizeCloudWatchLogging(logging.cloudWatch) };
}
function normalizeCloudWatchLogging(logging) {
    if (logging === undefined || logging === null) {
        throw new Error("AppTheoryMicrovmImage requires props.logging.cloudWatch");
    }
    return {
        ...(logging.logGroup !== undefined ? { logGroup: normalizeLogGroup(logging.logGroup) } : {}),
        ...(logging.logStream !== undefined ? { logStream: normalizeLogStream(logging.logStream) } : {}),
    };
}
function renderLogging(logging) {
    if (logging.cloudWatch) {
        return {
            CloudWatch: {
                ...(logging.cloudWatch.logGroup !== undefined ? { LogGroup: logging.cloudWatch.logGroup } : {}),
                ...(logging.cloudWatch.logStream !== undefined ? { LogStream: logging.cloudWatch.logStream } : {}),
            },
        };
    }
    return { Disabled: true };
}
function normalizeLogGroup(value) {
    const normalized = normalizeRequiredString(value, "logging.cloudWatch.logGroup");
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && !/^[a-zA-Z0-9_\-/.#]{1,512}$/.test(normalized)) {
        throw new Error("AppTheoryMicrovmImage: logging.cloudWatch.logGroup is outside the CloudWatch Logs pattern");
    }
    return normalized;
}
function normalizeLogStream(value) {
    const normalized = normalizeRequiredString(value, "logging.cloudWatch.logStream");
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && (!/^[^:*]*$/.test(normalized) || normalized.length > 512)) {
        throw new Error("AppTheoryMicrovmImage: logging.cloudWatch.logStream is outside the CloudWatch Logs pattern");
    }
    return normalized;
}
function renderResources(resources) {
    if (!resources || resources.length === 0) {
        throw new Error("AppTheoryMicrovmImage requires exactly 1 resources entry");
    }
    if (resources.length > 1) {
        throw new Error("AppTheoryMicrovmImage supports exactly 1 resources entry");
    }
    const resource = resources[0];
    if (resource === undefined || resource === null) {
        throw new Error("AppTheoryMicrovmImage requires props.resources[0]");
    }
    return [
        {
            MinimumMemoryInMiB: normalizePositiveInteger(resource.minimumMemoryInMiB, "resources[0].minimumMemoryInMiB"),
        },
    ];
}
function normalizePositiveInteger(value, propName) {
    if (value === undefined || value === null) {
        throw new Error(`AppTheoryMicrovmImage requires props.${propName}`);
    }
    if (aws_cdk_lib_1.Token.isUnresolved(value)) {
        return value;
    }
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`AppTheoryMicrovmImage: ${propName} must be a positive integer`);
    }
    return value;
}
function normalizeIntegerInRange(value, propName, min, max) {
    if (aws_cdk_lib_1.Token.isUnresolved(value)) {
        return value;
    }
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`AppTheoryMicrovmImage: ${propName} must be an integer from ${min} to ${max}`);
    }
    return value;
}
function assertNoDuplicates(values, label) {
    const seen = new Set();
    for (const value of values) {
        if (aws_cdk_lib_1.Token.isUnresolved(value)) {
            continue;
        }
        if (seen.has(value)) {
            throw new Error(`AppTheoryMicrovmImage does not allow duplicate ${label} values`);
        }
        seen.add(value);
    }
}
function renderTags(tags) {
    const rendered = [
        { Key: "Framework", Value: "AppTheory" },
        { Key: "Component", Value: "MicrovmImage" },
    ];
    for (const [key, value] of Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const normalizedKey = key.trim();
        if (!normalizedKey) {
            throw new Error("AppTheoryMicrovmImage: tag keys cannot be empty");
        }
        rendered.push({ Key: normalizedKey, Value: value });
    }
    return rendered;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBNkY7QUFDN0YsMkNBQTJDO0FBQzNDLGlEQUFpRDtBQUNqRCxtRUFBd0Q7QUFDeEQsMkNBQXVDO0FBR3ZDLHVGQUEyRjtBQW9CM0Y7O0dBRUc7QUFDSCxJQUFZLGlDQUtYO0FBTEQsV0FBWSxpQ0FBaUM7SUFDM0M7O09BRUc7SUFDSCxnREFBVyxDQUFBO0FBQ2IsQ0FBQyxFQUxXLGlDQUFpQyxpREFBakMsaUNBQWlDLFFBSzVDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLG9DQUtYO0FBTEQsV0FBWSxvQ0FBb0M7SUFDOUM7O09BRUc7SUFDSCx5REFBaUIsQ0FBQTtBQUNuQixDQUFDLEVBTFcsb0NBQW9DLG9EQUFwQyxvQ0FBb0MsUUFLL0M7QUFFRDs7R0FFRztBQUNILElBQVksd0JBVVg7QUFWRCxXQUFZLHdCQUF3QjtJQUNsQzs7T0FFRztJQUNILGlEQUFxQixDQUFBO0lBRXJCOztPQUVHO0lBQ0gsK0NBQW1CLENBQUE7QUFDckIsQ0FBQyxFQVZXLHdCQUF3Qix3Q0FBeEIsd0JBQXdCLFFBVW5DO0FBdVFEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSxxQkFBc0IsU0FBUSxzQkFBUztJQThDbEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFpQztRQUN6RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQ0FBc0MsQ0FBQyxDQUFDO1FBQzFELENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3ZDLE1BQU0sV0FBVyxHQUFHLHVCQUF1QixDQUFDLEtBQUssQ0FB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LENBQUM7UUFDakMsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ25CLE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQztRQUNyRSxDQUFDO1FBQ0QsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUVELE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBcm5Gb3JtYXQsIENmblJlc291cmNlLCBDdXN0b21SZXNvdXJjZSwgRHVyYXRpb24sIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCB7IFByb3ZpZGVyIH0gZnJvbSBcImF3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB0eXBlIHsgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIH0gZnJvbSBcIi4vbWljcm92bS1uZXR3b3JrLWNvbm5lY3RvclwiO1xuaW1wb3J0IHsgTUlDUk9WTV9JTUFHRV9QUlVORV9IQU5ETEVSX1NPVVJDRSB9IGZyb20gXCIuL3ByaXZhdGUvbWljcm92bS1pbWFnZS1wcnVuZS1oYW5kbGVyXCI7XG5cbi8qKlxuICogUmVmZXJlbmNlIHRvIGEgTGFtYmRhIE1pY3JvVk0gaW1hZ2UgdXNhYmxlIGJ5IE1pY3JvVk0gY29udHJvbGxlciBjb25zdHJ1Y3RzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Uge1xuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbm9ybWFsaXplZCBkZXBsb3ltZW50LW93bmVkIHJ1bnRpbWUgbG9nZ2luZyBwb3N0dXJlIGZvciB0aGlzIGltYWdlLlxuICAgKlxuICAgKiBDb250cm9sbGVycyBwcm9wYWdhdGUgdGhpcyBleGFjdCBDbG91ZFdhdGNoLW9yLWRpc2FibGVkIGNob2ljZSB0byBldmVyeVxuICAgKiBgUnVuTWljcm92bWAgcmVxdWVzdC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmc7XG59XG5cbi8qKlxuICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5IHtcbiAgLyoqXG4gICAqIEdyYW50cyBhbGwgY3VycmVudGx5IHN1cHBvcnRlZCBNaWNyb1ZNIE9TIGNhcGFiaWxpdGllcy5cbiAgICovXG4gIEFMTCA9IFwiQUxMXCIsXG59XG5cbi8qKlxuICogQ1BVIGFyY2hpdGVjdHVyZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlIHtcbiAgLyoqXG4gICAqIEFSTTY0IE1pY3JvVk0gaW1hZ2UgYXJjaGl0ZWN0dXJlLlxuICAgKi9cbiAgQVJNXzY0ID0gXCJBUk1fNjRcIixcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9vayBtb2RlIGZvciBMYW1iZGEgTWljcm9WTSBpbWFnZSBob29rcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHtcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGxpZmVjeWNsZSBob29rLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcIkRJU0FCTEVEXCIsXG5cbiAgLyoqXG4gICAqIEVuYWJsZSB0aGUgbGlmZWN5Y2xlIGhvb2suXG4gICAqL1xuICBFTkFCTEVEID0gXCJFTkFCTEVEXCIsXG59XG5cbi8qKlxuICogQ29kZSBhcnRpZmFjdCBsb2NhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3Qge1xuICAvKipcbiAgICogVGhlIFVSSSBvZiB0aGUgY29kZSBhcnRpZmFjdCwgc3VjaCBhcyBhbiBBbWF6b24gUzMgcGF0aCBvciBBbWF6b24gRUNSIGltYWdlIFVSSS5cbiAgICovXG4gIHJlYWRvbmx5IHVyaTogc3RyaW5nO1xufVxuXG4vKipcbiAqIENQVSBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb24ge1xuICAvKipcbiAgICogVGhlIENQVSBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjRcbiAgICovXG4gIHJlYWRvbmx5IGFyY2hpdGVjdHVyZT86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZTtcbn1cblxuLyoqXG4gKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlIHtcbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlIGtleS5cbiAgICovXG4gIHJlYWRvbmx5IGtleTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZSB2YWx1ZS5cbiAgICovXG4gIHJlYWRvbmx5IHZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2tzIGludm9rZWQgZHVyaW5nIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3Mge1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcmVhZHkgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZHk/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlYWR5IGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSByZWFkeVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHZhbGlkYXRlIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHZhbGlkYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB2YWxpZGF0ZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rcyBpbnZva2VkIGR1cmluZyBNaWNyb1ZNIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzIHtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJlc3VtZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSByZXN1bWU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlc3VtZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzdW1lVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgcnVuIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bj86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcnVuIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSBydW5UaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBzdXNwZW5kIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmQ/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHN1c3BlbmQgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSB0ZXJtaW5hdGUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdGVybWluYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB0ZXJtaW5hdGUgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogSG9vayBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzIHtcbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rcyBmb3IgTWljcm9WTSBldmVudHMuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9va3MgZm9yIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzO1xuXG4gIC8qKlxuICAgKiBUaGUgcG9ydCBudW1iZXIgb24gd2hpY2ggdGhlIGhvb2tzIGxpc3RlbmVyIHJ1bnMuXG4gICAqL1xuICByZWFkb25seSBwb3J0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3VkV2F0Y2ggTG9ncyBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlIGxvZ2dpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcge1xuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIENsb3VkV2F0Y2ggTG9ncyBsb2cgZ3JvdXAgdG8gc2VuZCBsb2dzIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBDbG91ZFdhdGNoIExvZ3MgbG9nIHN0cmVhbSB3aXRoaW4gdGhlIGxvZyBncm91cC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ1N0cmVhbT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBMb2dnaW5nIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB7XG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBzZW5kaW5nIGxvZ3MgdG8gQW1hem9uIENsb3VkV2F0Y2ggTG9ncy5cbiAgICovXG4gIHJlYWRvbmx5IGNsb3VkV2F0Y2g/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZztcblxuICAvKipcbiAgICogU2V0IHRvIHRydWUgdG8gZGlzYWJsZSBNaWNyb1ZNIGxvZ2dpbmcuXG4gICAqL1xuICByZWFkb25seSBkaXNhYmxlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogUmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlcyB7XG4gIC8qKlxuICAgKiBUaGUgbWluaW11bSBhbW91bnQgb2YgbWVtb3J5IGluIE1pQiB0byBhbGxvY2F0ZSB0byB0aGUgTWljcm9WTS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGRlc2NyaXB0aW9uIG9mIHRoZSB2ZXJzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgYmFzZSBNaWNyb1ZNIGltYWdlIHVzZWQuXG4gICAqL1xuICByZWFkb25seSBiYXNlSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHNwZWNpZmljIHZlcnNpb24gb2YgdGhlIGJhc2UgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IGJhc2VJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgSUFNIGJ1aWxkIHJvbGUuXG4gICAqL1xuICByZWFkb25seSBidWlsZFJvbGVBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvZGUgYXJ0aWZhY3QgZm9yIHRoaXMgdmVyc2lvbi5cbiAgICovXG4gIHJlYWRvbmx5IGNvZGVBcnRpZmFjdDogQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0O1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBlZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIGF2YWlsYWJsZSB0byB0aGUgTWljcm9WTSBhdCBydW50aW1lLlxuICAgKlxuICAgKiBQYXNzIGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcmAgaW5zdGFuY2VzIG9yIGNvbXBhdGlibGUgY29ubmVjdG9yIHJlZmVyZW5jZXMuXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9vayBjb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNcyBhbmQgTWljcm9WTSBpbWFnZXMuXG4gICAqXG4gICAqIFBhc3MgYW4gZW1wdHkgb2JqZWN0IChge31gKSBmb3IgQXBwVGhlb3J5IGVuZHBvaW50LWRpc3BhdGNoZWQgTWljcm9WTSBpbWFnZXMuXG4gICAqIEFwcFRoZW9yeSB0aGVuIHN5bnRoZXNpemVzIGBIb29rczoge31gIHNvIExhbWJkYSBidWlsZHMgdGhlIGltYWdlIHdpdGhvdXRcbiAgICogQVdTLWludm9rZWQgbGlmZWN5Y2xlIGhvb2tzIGFuZCBydW50aW1lIHRyYWZmaWMgaXMgZGVsaXZlcmVkIHRocm91Z2ggdGhlXG4gICAqIE1pY3JvVk0gZW5kcG9pbnQgb24gdGhlIGRlZmF1bHQgcG9ydCA4MDgwLiBJZiBhbnkgaG9vayBpcyBjb25maWd1cmVkLCBgcG9ydGBcbiAgICogaXMgcmVxdWlyZWQgYnkgQVdTIGFuZCBBcHBUaGVvcnkgdmFsaWRhdGVzIGl0IGZhaWwtY2xvc2VkLlxuICAgKi9cbiAgcmVhZG9ubHkgaG9va3M6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNIGxvZ2dpbmcgb3V0cHV0LlxuICAgKlxuICAgKiBTcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGBjbG91ZFdhdGNoYCBvciBgZGlzYWJsZWQ6IHRydWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZztcblxuICAvKipcbiAgICogVGhlIHJlc291cmNlIHJlcXVpcmVtZW50cyBmb3IgdGhlIE1pY3JvVk0uXG4gICAqXG4gICAqIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UgY3VycmVudGx5IGFjY2VwdHMgZXhhY3RseSBvbmUgUmVzb3VyY2VzIGVudHJ5LlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2VzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VSZXNvdXJjZXNbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgZ3JhbnRlZCB0byB0aGUgTWljcm9WTSBydW50aW1lIGVudmlyb25tZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTF1cbiAgICovXG4gIHJlYWRvbmx5IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdO1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBzdXBwb3J0ZWQgQ1BVIGNvbmZpZ3VyYXRpb25zIGZvciB0aGUgTWljcm9WTS5cbiAgICpcbiAgICogQGRlZmF1bHQgW3sgYXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH1dXG4gICAqL1xuICByZWFkb25seSBjcHVDb25maWd1cmF0aW9ucz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb25bXTtcblxuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGVzIHNldCBpbiB0aGUgTWljcm9WTSBydW50aW1lIGVudmlyb25tZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZW52aXJvbm1lbnRWYXJpYWJsZXM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgQ2xvdWRGb3JtYXRpb24gdGFncyB0byBhcHBseSB0byB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSBDREsgY29uc3RydWN0IGZvciBBV1MgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIGludGVudGlvbmFsbHkgZGVwbG95bWVudC1vbmx5OiBpdCBjcmVhdGVzIHRoZSBDbG91ZEZvcm1hdGlvblxuICogYEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VgIHJlc291cmNlIGZyb20gY2FsbGVyLXByb3ZpZGVkIGNvZGUgYXJ0aWZhY3QsIGJhc2UgaW1hZ2UsXG4gKiBidWlsZCByb2xlLCBsaWZlY3ljbGUgaG9va3MsIGxvZ2dpbmcgY29uZmlndXJhdGlvbiwgcmVzb3VyY2UgcmVxdWlyZW1lbnRzLCBhbmRcbiAqIEFwcFRoZW9yeSBNaWNyb1ZNIG5ldHdvcmstY29ubmVjdG9yIHJlZmVyZW5jZXMuIFJ1bnRpbWUgY29udHJvbGxlciBiZWhhdmlvciBzdGF5cyBpblxuICogdGhlIEFwcFRoZW9yeSBydW50aW1lIGNvbnRyYWN0LlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWljcm92bUltYWdlIGV4dGVuZHMgQ29uc3RydWN0IGltcGxlbWVudHMgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBDbG91ZEZvcm1hdGlvbiBNaWNyb1ZNIGltYWdlIHJlc291cmNlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogQ2ZuUmVzb3VyY2U7XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIG5hbWUgcmV0dXJuZWQgYnkgUmVmLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZU5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5vcm1hbGl6ZWQgZGVwbG95bWVudC1vd25lZCBydW50aW1lIGxvZ2dpbmcgcG9zdHVyZSBmb3IgdGhpcyBpbWFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY3VycmVudCBpbWFnZSBzdGF0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VTdGF0ZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGF0ZXN0IGFjdGl2ZSBpbWFnZSB2ZXJzaW9uLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGF0ZXN0IGZhaWxlZCBpbWFnZSB2ZXJzaW9uLCBpZiBhbnkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB0aW1lc3RhbXAgd2hlbiB0aGUgaW1hZ2Ugd2FzIGNyZWF0ZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgY3JlYXRlZEF0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB0aW1lc3RhbXAgd2hlbiB0aGUgaW1hZ2Ugd2FzIGxhc3QgdXBkYXRlZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB1cGRhdGVkQXQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWljcm92bUltYWdlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG5cbiAgICBjb25zdCBuYW1lID0gbm9ybWFsaXplTmFtZShwcm9wcy5uYW1lKTtcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHByb3BzLmRlc2NyaXB0aW9uLCBcImRlc2NyaXB0aW9uXCIpO1xuICAgIGNvbnN0IGJhc2VJbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5iYXNlSW1hZ2VBcm4sIFwiYmFzZUltYWdlQXJuXCIsIDIwNDgpO1xuICAgIGNvbnN0IGJhc2VJbWFnZVZlcnNpb24gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMuYmFzZUltYWdlVmVyc2lvbiwgXCJiYXNlSW1hZ2VWZXJzaW9uXCIsIDIwNDgpO1xuICAgIGNvbnN0IGJ1aWxkUm9sZUFybiA9IG5vcm1hbGl6ZUJ1aWxkUm9sZUFybihwcm9wcy5idWlsZFJvbGVBcm4pO1xuICAgIGNvbnN0IGNvZGVBcnRpZmFjdCA9IHJlbmRlckNvZGVBcnRpZmFjdChwcm9wcy5jb2RlQXJ0aWZhY3QpO1xuICAgIGNvbnN0IGVncmVzc05ldHdvcmtDb25uZWN0b3JzID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyk7XG4gICAgY29uc3QgaG9va3MgPSByZW5kZXJIb29rcyhwcm9wcy5ob29rcyk7XG4gICAgY29uc3QgbG9nZ2luZyA9IG5vcm1hbGl6ZUxvZ2dpbmcocHJvcHMubG9nZ2luZyk7XG4gICAgY29uc3QgcmVzb3VyY2VzID0gcmVuZGVyUmVzb3VyY2VzKHByb3BzLnJlc291cmNlcyk7XG4gICAgY29uc3QgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzID0gbm9ybWFsaXplQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKHByb3BzLmFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyk7XG4gICAgY29uc3QgY3B1Q29uZmlndXJhdGlvbnMgPSByZW5kZXJDcHVDb25maWd1cmF0aW9ucyhwcm9wcy5jcHVDb25maWd1cmF0aW9ucyk7XG4gICAgY29uc3QgZW52aXJvbm1lbnRWYXJpYWJsZXMgPSByZW5kZXJFbnZpcm9ubWVudFZhcmlhYmxlcyhwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlcyk7XG5cbiAgICBjb25zdCByZW5kZXJlZEltYWdlUHJvcGVydGllcyA9IHtcbiAgICAgIEFkZGl0aW9uYWxPc0NhcGFiaWxpdGllczogYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzLFxuICAgICAgQmFzZUltYWdlQXJuOiBiYXNlSW1hZ2VBcm4sXG4gICAgICBCYXNlSW1hZ2VWZXJzaW9uOiBiYXNlSW1hZ2VWZXJzaW9uLFxuICAgICAgQnVpbGRSb2xlQXJuOiBidWlsZFJvbGVBcm4sXG4gICAgICBDb2RlQXJ0aWZhY3Q6IGNvZGVBcnRpZmFjdCxcbiAgICAgIENwdUNvbmZpZ3VyYXRpb25zOiBjcHVDb25maWd1cmF0aW9ucyxcbiAgICAgIERlc2NyaXB0aW9uOiBkZXNjcmlwdGlvbixcbiAgICAgIEVncmVzc05ldHdvcmtDb25uZWN0b3JzOiBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyxcbiAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiBlbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAgIEhvb2tzOiBob29rcyxcbiAgICAgIExvZ2dpbmc6IHJlbmRlckxvZ2dpbmcobG9nZ2luZyksXG4gICAgICBOYW1lOiBuYW1lLFxuICAgICAgUmVzb3VyY2VzOiByZXNvdXJjZXMsXG4gICAgICBUYWdzOiByZW5kZXJUYWdzKHByb3BzLnRhZ3MpLFxuICAgIH07XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZSA9IG5ldyBDZm5SZXNvdXJjZSh0aGlzLCBcIk1pY3Jvdm1JbWFnZVwiLCB7XG4gICAgICB0eXBlOiBcIkFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VcIixcbiAgICAgIHByb3BlcnRpZXM6IHJlbmRlcmVkSW1hZ2VQcm9wZXJ0aWVzLFxuICAgIH0pO1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VOYW1lID0gdGhpcy5taWNyb3ZtSW1hZ2UucmVmO1xuICAgIHRoaXMubWljcm92bUltYWdlQXJuID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiSW1hZ2VBcm5cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmxvZ2dpbmcgPSBsb2dnaW5nO1xuICAgIHRoaXMubWljcm92bUltYWdlU3RhdGUgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJTdGF0ZVwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubGF0ZXN0QWN0aXZlSW1hZ2VWZXJzaW9uID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiTGF0ZXN0QWN0aXZlSW1hZ2VWZXJzaW9uXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5sYXRlc3RGYWlsZWRJbWFnZVZlcnNpb24gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJMYXRlc3RGYWlsZWRJbWFnZVZlcnNpb25cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmNyZWF0ZWRBdCA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkNyZWF0ZWRBdFwiKS50b1N0cmluZygpO1xuICAgIHRoaXMudXBkYXRlZEF0ID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiVXBkYXRlZEF0XCIpLnRvU3RyaW5nKCk7XG5cbiAgICB0aGlzLndpcmVWZXJzaW9uUHJ1bmluZyhyZW5kZXJlZEltYWdlUHJvcGVydGllcywgbmFtZSk7XG4gIH1cblxuICAvKipcbiAgICogV2lyZXMgdGhlIGFsd2F5cy1vbiB2ZXJzaW9uLXBydW5pbmcgY3VzdG9tIHJlc291cmNlLlxuICAgKlxuICAgKiBFdmVyeSBDbG91ZEZvcm1hdGlvbiBjcmVhdGUvdXBkYXRlIHRoYXQgdG91Y2hlcyB0aGUgaW1hZ2Ug4oCUIHNpZ25hbGVkIGJ5IGFcbiAgICogY2hhbmdlIHRvIHRoZSBtaXJyb3JlZCBpbWFnZSBwcm9wZXJ0aWVzIOKAlCBydW5zIHRoZSBwcnVuZSBoYW5kbGVyIEJFRk9SRSB0aGVcbiAgICogYEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VgIHVwZGF0ZSBjcmVhdGVzIGEgbmV3IHZlcnNpb246IHRoZSBpbWFnZSByZXNvdXJjZVxuICAgKiBjYXJyaWVzIGFuIGV4cGxpY2l0IGBEZXBlbmRzT25gIG9uIHRoZSBwcnVuZSBjdXN0b20gcmVzb3VyY2Ugc28gQ2xvdWRGb3JtYXRpb25cbiAgICogb3JkZXJzIHRoZSBwcnVuZSBmaXJzdC4gQSBsaXN0L2Rlc2NyaWJlIGZhaWx1cmUgZmFpbHMgdGhlIGRlcGxveW1lbnQgbG91ZGx5LFxuICAgKiBleGNlcHQgYSA0MDQgb24gdGhlIHZlcnNpb24gbGlzdCAodGhlIGltYWdlIGRvZXMgbm90IGV4aXN0IHlldCBvbiBhIGZyZXNoXG4gICAqIHN0YWNrIENSRUFURSksIHdoaWNoIGlzIHRyZWF0ZWQgYXMgbm90aGluZyB0byBwcnVuZTsgYSBwZXItdmVyc2lvbiBkZWxldGVcbiAgICogcmVmdXNhbCBpcyBsb2dnZWQgYW5kIHNraXBwZWQuIE9uIHN0YWNrIERFTEVURSB0aGUgaGFuZGxlciByZXR1cm5zIHN1Y2Nlc3NcbiAgICogd2l0aG91dCBwcnVuaW5nIGJlY2F1c2UgQ2xvdWRGb3JtYXRpb24gZGVsZXRlcyB0aGUgd2hvbGUgaW1hZ2UuIFRoZXJlIGFyZSBub1xuICAgKiBkZXBsb3ktdGltZSBrbm9iczogcHJ1bmluZyBpcyBhbHdheXMtb24gZW5jb2RlZCBiZWhhdmlvci5cbiAgICpcbiAgICogVGhlIGhhbmRsZXIgZW52IGFuZCBJQU0gcG9saWN5IHJlZmVyZW5jZSB0aGUgaW1hZ2UgQVJOIGNvbnN0cnVjdGVkIGZyb21cbiAgICogcHNldWRvLXBhcmFtZXRlcnMgKGBTdGFjay5mb3JtYXRBcm5gKSByYXRoZXIgdGhhbiBmcm9tIGBJbWFnZUFybmAgR2V0QXR0OlxuICAgKiB0aGUgaGFuZGxlciBmdW5jdGlvbiBpcyBkb3duc3RyZWFtIG9mIHRoZSBwcnVuZSBjdXN0b20gcmVzb3VyY2UsIHNvIGFcbiAgICogR2V0QXR0LWJhc2VkIHJlZmVyZW5jZSB3b3VsZCBtYWtlIHRoZSBoYW5kbGVyIGRlcGVuZCBvbiB0aGUgaW1hZ2UgYW5kIGNsb3NlXG4gICAqIGEgQ2xvdWRGb3JtYXRpb24gZGVwZW5kZW5jeSBjeWNsZSAoaW1hZ2Ug4oaSIHBydW5lIOKGkiBoYW5kbGVyIOKGkiBpbWFnZSkuIFRoZVxuICAgKiBBUk4gaXMgYnVpbHQgaW4gdGhlIGNhbm9uaWNhbCBjb2xvbiBmb3JtOiB0aGUgTGFtYmRhIE1pY3JvVk1zIGNvbnRyb2wgcGxhbmVcbiAgICogYXV0aG9yaXplcyBgYXJuOmF3czpsYW1iZGE6PHJlZ2lvbj46PGFjY291bnQ+Om1pY3Jvdm0taW1hZ2U6PG5hbWU+YCBvbmx5LFxuICAgKiBhbmQgcmVqZWN0cyB0aGUgc2xhc2ggZm9ybSAoYC4uLjptaWNyb3ZtLWltYWdlLzxuYW1lPmApIHdpdGggSFRUUCA0MDNcbiAgICogQWNjZXNzRGVuaWVkIHJlZ2FyZGxlc3Mgb2YgSUFNIChsaXZlLXZlcmlmaWVkKS5cbiAgICovXG4gIHByaXZhdGUgd2lyZVZlcnNpb25QcnVuaW5nKHJlbmRlcmVkSW1hZ2VQcm9wZXJ0aWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgaW1hZ2VOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwcnVuZUltYWdlQXJuID0gU3RhY2sub2YodGhpcykuZm9ybWF0QXJuKHtcbiAgICAgIHNlcnZpY2U6IFwibGFtYmRhXCIsXG4gICAgICByZXNvdXJjZTogXCJtaWNyb3ZtLWltYWdlXCIsXG4gICAgICByZXNvdXJjZU5hbWU6IGltYWdlTmFtZSxcbiAgICAgIGFybkZvcm1hdDogQXJuRm9ybWF0LkNPTE9OX1JFU09VUkNFX05BTUUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBwcnVuZUhhbmRsZXIgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiTWljcm92bUltYWdlUHJ1bmVIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yNF9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKE1JQ1JPVk1fSU1BR0VfUFJVTkVfSEFORExFUl9TT1VSQ0UpLFxuICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX0FSTjogcHJ1bmVJbWFnZUFybixcbiAgICAgICAgQVBQVEhFT1JZX01JQ1JPVk1fSU1BR0VfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRXhhY3RseSB0aGUgdHdvIG1pY3Jvdm0gbGlzdC9kZWxldGUgYWN0aW9ucyBvbiBcIipcIi4gVGhlIExhbWJkYSBNaWNyb1ZNc1xuICAgIC8vIGNvbnRyb2wgcGxhbmUgYXV0aG9yaXplcyB0aGUgY2Fub25pY2FsIGNvbG9uLWZvcm0gaW1hZ2UgQVJOXG4gICAgLy8gKGAuLi46bWljcm92bS1pbWFnZTo8bmFtZT5gKTsgdGhlIHNsYXNoIGZvcm0gKGAuLi46bWljcm92bS1pbWFnZS88bmFtZT5gKVxuICAgIC8vIGlzIHJlamVjdGVkIHdpdGggSFRUUCA0MDMgQWNjZXNzRGVuaWVkIHJlZ2FyZGxlc3Mgb2YgSUFNIChsaXZlLXZlcmlmaWVkLFxuICAgIC8vIGJ5dGUtaWRlbnRpY2FsIG1lc3NhZ2UgdG8gdGhlIGRlcGxveSBmYWlsdXJlcyB0aGlzIGZpeCBhZGRyZXNzZXMpLlxuICAgIC8vIFJlc291cmNlLWxldmVsIElBTSBzY29waW5nIHN1cHBvcnQgcmVtYWlucyB1bnRlc3RlZCwgc28gdGhlIGdyYW50IHN0YXlzXG4gICAgLy8gb24gXCIqXCI7IHRoZSBoYW5kbGVyIGJpbmFyeSBpdHNlbGYgb25seSBldmVyIHRhcmdldHMgdGhlIHNpbmdsZSBpbWFnZSBBUk5cbiAgICAvLyBmcm9tIGl0cyBBUFBUSEVPUllfTUlDUk9WTV9JTUFHRV9BUk4gZW52LCB3aGljaCBpcyB0aGUgYWN0dWFsIGNvbnN0cmFpbnQuXG4gICAgcHJ1bmVIYW5kbGVyLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkxpc3RNaWNyb3ZtSW1hZ2VWZXJzaW9uc1wiLCBcImxhbWJkYTpEZWxldGVNaWNyb3ZtSW1hZ2VWZXJzaW9uXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgY29uc3QgcHJ1bmVQcm92aWRlciA9IG5ldyBQcm92aWRlcih0aGlzLCBcIk1pY3Jvdm1JbWFnZVBydW5lUHJvdmlkZXJcIiwge1xuICAgICAgb25FdmVudEhhbmRsZXI6IHBydW5lSGFuZGxlcixcbiAgICB9KTtcblxuICAgIGNvbnN0IHBydW5lID0gbmV3IEN1c3RvbVJlc291cmNlKHRoaXMsIFwiTWljcm92bUltYWdlUHJ1bmVcIiwge1xuICAgICAgc2VydmljZVRva2VuOiBwcnVuZVByb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgLy8gTWlycm9ycyB0aGUgaW1hZ2UncyByZW5kZXJlZCBwcm9wZXJ0aWVzIHNvIHRoZSBwcnVuZSBjdXN0b20gcmVzb3VyY2VcbiAgICAgICAgLy8gaXMgcmUtaW52b2tlZCBleGFjdGx5IHdoZW4gdGhlIGltYWdlIHJlc291cmNlIGl0c2VsZiB3b3VsZCBiZSB1cGRhdGVkXG4gICAgICAgIC8vIGJ5IENsb3VkRm9ybWF0aW9uLiBUaGUgcHJ1bmUgaGFuZGxlciByZWFkcyB0aGUgaW1hZ2UgQVJOIGZyb20gaXRzIG93blxuICAgICAgICAvLyBlbnZpcm9ubWVudCByYXRoZXIgdGhhbiBmcm9tIHRoZXNlIHByb3BlcnRpZXMsIHNvIHRoZSBjdXN0b20gcmVzb3VyY2VcbiAgICAgICAgLy8gbmV2ZXIgY3JlYXRlcyBhbiBpbXBsaWNpdCBkZXBlbmRlbmN5IHRoYXQgd291bGQgcmV2ZXJzZSB0aGUgb3JkZXJpbmcuXG4gICAgICAgIE1pY3Jvdm1JbWFnZVByb3BlcnRpZXM6IHJlbmRlcmVkSW1hZ2VQcm9wZXJ0aWVzLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMubWljcm92bUltYWdlLm5vZGUuYWRkRGVwZW5kZW5jeShwcnVuZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTmFtZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbmFtZSA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcIm5hbWVcIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAhL15bQS1aYS16MC05Xy1dezEsNjR9JC8udGVzdChuYW1lKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBuYW1lIG11c3QgYmUgMS02NCBjaGFyYWN0ZXJzIHVzaW5nIGxldHRlcnMsIG51bWJlcnMsIGh5cGhlbnMsIG9yIHVuZGVyc2NvcmVzXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHZhbHVlKS50cmltKCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgcHJvcE5hbWUpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgL1xccy8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgbm9ybWFsaXplZC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBhdCBtb3N0ICR7bWF4TGVuZ3RofSBjaGFyYWN0ZXJzYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUJ1aWxkUm9sZUFybih2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgY29uc3QgYXJuID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlLCBcImJ1aWxkUm9sZUFyblwiLCAyMDQ4KTtcbiAgaWYgKFxuICAgICFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmXG4gICAgIS9eYXJuOmF3c1thLXpBLVotXSo6aWFtOjpcXGR7MTJ9OnJvbGVcXC8/W2EtekEtWl8wLTkrPSwuQFxcLV8vXSskLy50ZXN0KGFybilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBidWlsZFJvbGVBcm4gbXVzdCBiZSBhbiBJQU0gcm9sZSBBUk5cIik7XG4gIH1cbiAgcmV0dXJuIGFybjtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZUFydGlmYWN0KFxuICBjb2RlQXJ0aWZhY3Q6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNvZGVBcnRpZmFjdCB8IHVuZGVmaW5lZCxcbik6IHsgVXJpOiBzdHJpbmcgfSB7XG4gIGlmIChjb2RlQXJ0aWZhY3QgPT09IHVuZGVmaW5lZCB8fCBjb2RlQXJ0aWZhY3QgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuY29kZUFydGlmYWN0XCIpO1xuICB9XG4gIHJldHVybiB7XG4gICAgVXJpOiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcoY29kZUFydGlmYWN0LnVyaSwgXCJjb2RlQXJ0aWZhY3QudXJpXCIsIDIwNDgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICBjb25uZWN0b3JzOiByZWFkb25seSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXSB8IHVuZGVmaW5lZCxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKCFjb25uZWN0b3JzIHx8IGNvbm5lY3RvcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgZW50cnlcIik7XG4gIH1cbiAgaWYgKGNvbm5lY3RvcnMubGVuZ3RoID4gMTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgYXQgbW9zdCAxMCBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBlbnRyaWVzXCIpO1xuICB9XG5cbiAgY29uc3QgYXJucyA9IGNvbm5lY3RvcnMubWFwKChjb25uZWN0b3IsIGluZGV4KSA9PiB7XG4gICAgaWYgKGNvbm5lY3RvciA9PT0gdW5kZWZpbmVkIHx8IGNvbm5lY3RvciA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNbJHtpbmRleH1dYCk7XG4gICAgfVxuICAgIGNvbnN0IGFybiA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKFxuICAgICAgY29ubmVjdG9yLm5ldHdvcmtDb25uZWN0b3JBcm4sXG4gICAgICBgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNbJHtpbmRleH1dLm5ldHdvcmtDb25uZWN0b3JBcm5gLFxuICAgICk7XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoYXJuKSAmJiAvXFxzLy50ZXN0KGFybikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNbJHtpbmRleH1dLm5ldHdvcmtDb25uZWN0b3JBcm4gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBhcm47XG4gIH0pO1xuXG4gIGFzc2VydE5vRHVwbGljYXRlcyhhcm5zLCBcImVncmVzc05ldHdvcmtDb25uZWN0b3JzIG5ldHdvcmtDb25uZWN0b3JBcm5cIik7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVBZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdLFxuKTogQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5W10ge1xuICBjb25zdCBjYXBhYmlsaXRpZXMgPSB2YWx1ZXMgPz8gW0FwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTExdO1xuICBpZiAoY2FwYWJpbGl0aWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyBlbnRyeVwiKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gY2FwYWJpbGl0aWVzLm1hcCgoY2FwYWJpbGl0eSwgaW5kZXgpID0+IHtcbiAgICBpZiAoU3RyaW5nKGNhcGFiaWxpdHkpLnRyaW0oKS50b1VwcGVyQ2FzZSgpICE9PSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzWyR7aW5kZXh9XSBtdXN0IGJlIEFMTGApO1xuICAgIH1cbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTDtcbiAgfSk7XG4gIGFzc2VydE5vRHVwbGljYXRlcyhub3JtYWxpemVkLCBcImFkZGl0aW9uYWxPc0NhcGFiaWxpdGllc1wiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNwdUNvbmZpZ3VyYXRpb25zKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVDb25maWd1cmF0aW9uW10sXG4pOiBBcnJheTx7IEFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlIH0+IHtcbiAgY29uc3QgY3B1Q29uZmlndXJhdGlvbnMgPSB2YWx1ZXMgPz8gW3sgYXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH1dO1xuICBpZiAoY3B1Q29uZmlndXJhdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgY3B1Q29uZmlndXJhdGlvbnMgZW50cnlcIik7XG4gIH1cbiAgcmV0dXJuIGNwdUNvbmZpZ3VyYXRpb25zLm1hcCgoY3B1LCBpbmRleCkgPT4ge1xuICAgIGlmIChjcHUgPT09IHVuZGVmaW5lZCB8fCBjcHUgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmNwdUNvbmZpZ3VyYXRpb25zWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBhcmNoaXRlY3R1cmUgPSBTdHJpbmcoY3B1LmFyY2hpdGVjdHVyZSA/PyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0KVxuICAgICAgLnRyaW0oKVxuICAgICAgLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKGFyY2hpdGVjdHVyZSAhPT0gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGNwdUNvbmZpZ3VyYXRpb25zWyR7aW5kZXh9XS5hcmNoaXRlY3R1cmUgbXVzdCBiZSBBUk1fNjRgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgQXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH07XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFbnZpcm9ubWVudFZhcmlhYmxlcyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlRW52aXJvbm1lbnRWYXJpYWJsZVtdLFxuKTogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiB7XG4gIGlmICgodmFsdWVzPy5sZW5ndGggPz8gMCkgPiA1MCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBhdCBtb3N0IDUwIGVudmlyb25tZW50VmFyaWFibGVzIGVudHJpZXNcIik7XG4gIH1cblxuICBjb25zdCByZW5kZXJlZCA9ICh2YWx1ZXMgPz8gW10pLm1hcCgoZW50cnksIGluZGV4KSA9PiB7XG4gICAgaWYgKGVudHJ5ID09PSB1bmRlZmluZWQgfHwgZW50cnkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcoZW50cnkua2V5LCBgZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dLmtleWAsIDI1Nik7XG4gICAgY29uc3QgdmFsdWUgPSBlbnRyeS52YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5LnZhbHVlID09PSBudWxsID8gdW5kZWZpbmVkIDogU3RyaW5nKGVudHJ5LnZhbHVlKTtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dLnZhbHVlYCk7XG4gICAgfVxuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiB2YWx1ZS5sZW5ndGggPiA0MDk2KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dLnZhbHVlIG11c3QgYmUgYXQgbW9zdCA0MDk2IGNoYXJhY3RlcnNgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgS2V5OiBrZXksIFZhbHVlOiB2YWx1ZSB9O1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoXG4gICAgcmVuZGVyZWQubWFwKChlbnRyeSkgPT4gZW50cnkuS2V5KSxcbiAgICBcImVudmlyb25tZW50VmFyaWFibGVzIGtleVwiLFxuICApO1xuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckhvb2tzKGhvb2tzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VIb29rcyB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgaWYgKGhvb2tzID09PSB1bmRlZmluZWQgfHwgaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3NcIik7XG4gIH1cblxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgY29uc3QgbWljcm92bUhvb2tzID0gcmVuZGVyUnVudGltZUhvb2tzKGhvb2tzLm1pY3Jvdm1Ib29rcyk7XG4gIGlmIChtaWNyb3ZtSG9va3MpIHtcbiAgICByZW5kZXJlZC5NaWNyb3ZtSG9va3MgPSBtaWNyb3ZtSG9va3M7XG4gIH1cbiAgY29uc3QgbWljcm92bUltYWdlSG9va3MgPSByZW5kZXJJbWFnZUhvb2tzKGhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzKTtcbiAgaWYgKG1pY3Jvdm1JbWFnZUhvb2tzKSB7XG4gICAgcmVuZGVyZWQuTWljcm92bUltYWdlSG9va3MgPSBtaWNyb3ZtSW1hZ2VIb29rcztcbiAgfVxuICBjb25zdCBoYXNIb29rR3JvdXAgPSBCb29sZWFuKHJlbmRlcmVkLk1pY3Jvdm1Ib29rcyB8fCByZW5kZXJlZC5NaWNyb3ZtSW1hZ2VIb29rcyk7XG4gIGlmIChoYXNIb29rR3JvdXAgJiYgaG9va3MucG9ydCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGhvb2tzLnBvcnQgaXMgcmVxdWlyZWQgd2hlbiBwcm9wcy5ob29rcy5taWNyb3ZtSG9va3Mgb3IgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3MgaXMgY29uZmlndXJlZFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGhvb2tzLnBvcnQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghaGFzSG9va0dyb3VwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBob29rcy5wb3J0IHJlcXVpcmVzIHByb3BzLmhvb2tzLm1pY3Jvdm1Ib29rcyBvciBwcm9wcy5ob29rcy5taWNyb3ZtSW1hZ2VIb29rc1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmVuZGVyZWQuUG9ydCA9IG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKGhvb2tzLnBvcnQsIFwiaG9va3MucG9ydFwiLCAxLCA2NTUzNSk7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSdW50aW1lSG9va3MoaG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuICBpZiAoaG9va3MgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzLm1pY3Jvdm1Ib29rc1wiKTtcbiAgfVxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiUmVzdW1lXCIsIGhvb2tzLnJlc3VtZSwgXCJob29rcy5taWNyb3ZtSG9va3MucmVzdW1lXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSZXN1bWVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MucmVzdW1lVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy5yZXN1bWVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiUnVuXCIsIGhvb2tzLnJ1biwgXCJob29rcy5taWNyb3ZtSG9va3MucnVuXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSdW5UaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MucnVuVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy5ydW5UaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiU3VzcGVuZFwiLCBob29rcy5zdXNwZW5kLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5zdXNwZW5kXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJTdXNwZW5kVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiVGVybWluYXRlXCIsIGhvb2tzLnRlcm1pbmF0ZSwgXCJob29rcy5taWNyb3ZtSG9va3MudGVybWluYXRlXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJUZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MudGVybWluYXRlVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy50ZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgaWYgKE9iamVjdC5rZXlzKHJlbmRlcmVkKS5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBob29rcy5taWNyb3ZtSG9va3Mgc2V0dGluZ1wiKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckltYWdlSG9va3MoaG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuICBpZiAoaG9va3MgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzXCIpO1xuICB9XG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSZWFkeVwiLCBob29rcy5yZWFkeSwgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy5yZWFkeVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiUmVhZHlUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MucmVhZHlUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUltYWdlSG9va3MucmVhZHlUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICAzNjAwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJWYWxpZGF0ZVwiLCBob29rcy52YWxpZGF0ZSwgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy52YWxpZGF0ZVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiVmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MudmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUltYWdlSG9va3MudmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICAzNjAwLFxuICApO1xuICBpZiAoT2JqZWN0LmtleXMocmVuZGVyZWQpLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzIHNldHRpbmdcIik7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiBzZXRIb29rTW9kZShcbiAgdGFyZ2V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBzdHJpbmcsXG4gIG1vZGU6IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZSB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAobW9kZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcobW9kZSkudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gIGlmIChub3JtYWxpemVkICE9PSBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUuRU5BQkxFRCAmJiBub3JtYWxpemVkICE9PSBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUuRElTQUJMRUQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBFTkFCTEVEIG9yIERJU0FCTEVEYCk7XG4gIH1cbiAgdGFyZ2V0W2tleV0gPSBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBzZXRPcHRpb25hbEludGVnZXIoXG4gIHRhcmdldDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIGtleTogc3RyaW5nLFxuICB2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBtaW46IG51bWJlcixcbiAgbWF4OiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGFyZ2V0W2tleV0gPSBub3JtYWxpemVJbnRlZ2VySW5SYW5nZSh2YWx1ZSwgcHJvcE5hbWUsIG1pbiwgbWF4KTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9nZ2luZyhsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHwgdW5kZWZpbmVkKTogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB7XG4gIGlmIChsb2dnaW5nID09PSB1bmRlZmluZWQgfHwgbG9nZ2luZyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5sb2dnaW5nXCIpO1xuICB9XG4gIGNvbnN0IGhhc0Nsb3VkV2F0Y2ggPSBsb2dnaW5nLmNsb3VkV2F0Y2ggIT09IHVuZGVmaW5lZCAmJiBsb2dnaW5nLmNsb3VkV2F0Y2ggIT09IG51bGw7XG4gIGNvbnN0IGhhc0Rpc2FibGVkID0gbG9nZ2luZy5kaXNhYmxlZCAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzQ2xvdWRXYXRjaCA9PT0gaGFzRGlzYWJsZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcgbXVzdCBzcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGNsb3VkV2F0Y2ggb3IgZGlzYWJsZWRcIik7XG4gIH1cbiAgaWYgKGhhc0Rpc2FibGVkKSB7XG4gICAgaWYgKGxvZ2dpbmcuZGlzYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5kaXNhYmxlZCBtdXN0IGJlIHRydWUgd2hlbiBwcm92aWRlZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgZGlzYWJsZWQ6IHRydWUgfTtcbiAgfVxuICByZXR1cm4geyBjbG91ZFdhdGNoOiBub3JtYWxpemVDbG91ZFdhdGNoTG9nZ2luZyhsb2dnaW5nLmNsb3VkV2F0Y2gpIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNsb3VkV2F0Y2hMb2dnaW5nKFxuICBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZyB8IHVuZGVmaW5lZCxcbik6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nIHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmxvZ2dpbmcuY2xvdWRXYXRjaFwiKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIC4uLihsb2dnaW5nLmxvZ0dyb3VwICE9PSB1bmRlZmluZWQgPyB7IGxvZ0dyb3VwOiBub3JtYWxpemVMb2dHcm91cChsb2dnaW5nLmxvZ0dyb3VwKSB9IDoge30pLFxuICAgIC4uLihsb2dnaW5nLmxvZ1N0cmVhbSAhPT0gdW5kZWZpbmVkID8geyBsb2dTdHJlYW06IG5vcm1hbGl6ZUxvZ1N0cmVhbShsb2dnaW5nLmxvZ1N0cmVhbSkgfSA6IHt9KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyTG9nZ2luZyhsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAobG9nZ2luZy5jbG91ZFdhdGNoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIENsb3VkV2F0Y2g6IHtcbiAgICAgICAgLi4uKGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cCAhPT0gdW5kZWZpbmVkID8geyBMb2dHcm91cDogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwIH0gOiB7fSksXG4gICAgICAgIC4uLihsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtICE9PSB1bmRlZmluZWQgPyB7IExvZ1N0cmVhbTogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbSB9IDoge30pLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IERpc2FibGVkOiB0cnVlIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvZ0dyb3VwKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW2EtekEtWjAtOV9cXC0vLiNdezEsNTEyfSQvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cCBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9nU3RyZWFtKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbVwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICghL15bXjoqXSokLy50ZXN0KG5vcm1hbGl6ZWQpIHx8IG5vcm1hbGl6ZWQubGVuZ3RoID4gNTEyKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbSBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUmVzb3VyY2VzKFxuICByZXNvdXJjZXM6IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlc1tdIHwgdW5kZWZpbmVkLFxuKTogQXJyYXk8eyBNaW5pbXVtTWVtb3J5SW5NaUI6IG51bWJlciB9PiB7XG4gIGlmICghcmVzb3VyY2VzIHx8IHJlc291cmNlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgZXhhY3RseSAxIHJlc291cmNlcyBlbnRyeVwiKTtcbiAgfVxuICBpZiAocmVzb3VyY2VzLmxlbmd0aCA+IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgZXhhY3RseSAxIHJlc291cmNlcyBlbnRyeVwiKTtcbiAgfVxuICBjb25zdCByZXNvdXJjZSA9IHJlc291cmNlc1swXTtcbiAgaWYgKHJlc291cmNlID09PSB1bmRlZmluZWQgfHwgcmVzb3VyY2UgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMucmVzb3VyY2VzWzBdXCIpO1xuICB9XG4gIHJldHVybiBbXG4gICAge1xuICAgICAgTWluaW11bU1lbW9yeUluTWlCOiBub3JtYWxpemVQb3NpdGl2ZUludGVnZXIocmVzb3VyY2UubWluaW11bU1lbW9yeUluTWlCLCBcInJlc291cmNlc1swXS5taW5pbXVtTWVtb3J5SW5NaUJcIiksXG4gICAgfSxcbiAgXTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUG9zaXRpdmVJbnRlZ2VyKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPCBtaW4gfHwgdmFsdWUgPiBtYXgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBpbnRlZ2VyIGZyb20gJHttaW59IHRvICR7bWF4fWApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9EdXBsaWNhdGVzKHZhbHVlczogcmVhZG9ubHkgc3RyaW5nW10sIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZW4uaGFzKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgZG9lcyBub3QgYWxsb3cgZHVwbGljYXRlICR7bGFiZWx9IHZhbHVlc2ApO1xuICAgIH1cbiAgICBzZWVuLmFkZCh2YWx1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVuZGVyVGFncyh0YWdzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4ge1xuICBjb25zdCByZW5kZXJlZDogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiA9IFtcbiAgICB7IEtleTogXCJGcmFtZXdvcmtcIiwgVmFsdWU6IFwiQXBwVGhlb3J5XCIgfSxcbiAgICB7IEtleTogXCJDb21wb25lbnRcIiwgVmFsdWU6IFwiTWljcm92bUltYWdlXCIgfSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh0YWdzID8/IHt9KS5zb3J0KChbYV0sIFtiXSkgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRLZXkgPSBrZXkudHJpbSgpO1xuICAgIGlmICghbm9ybWFsaXplZEtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiB0YWcga2V5cyBjYW5ub3QgYmUgZW1wdHlcIik7XG4gICAgfVxuICAgIHJlbmRlcmVkLnB1c2goeyBLZXk6IG5vcm1hbGl6ZWRLZXksIFZhbHVlOiB2YWx1ZSB9KTtcbiAgfVxuXG4gIHJldHVybiByZW5kZXJlZDtcbn1cbiJdfQ==