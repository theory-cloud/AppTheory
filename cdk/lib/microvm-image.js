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
     * a CloudFormation dependency cycle (image → prune → handler → image).
     */
    wireVersionPruning(renderedImageProperties, imageName) {
        const pruneImageArn = aws_cdk_lib_1.Stack.of(this).formatArn({
            service: "lambda",
            resource: "microvm-image",
            resourceName: imageName,
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
        // Exactly the two microvm list/delete actions on "*". Lambda MicroVM
        // image-version operations are currently permission-only actions: the
        // service does not honor resource-level scoping for them, so a grant
        // scoped to the image ARN is rejected at runtime with HTTP 403 (observed
        // live: "is not authorized to perform: lambda:ListMicrovmImageVersions on
        // resource: arn:aws:lambda:...:microvm-image/<image>"). The handler
        // binary itself only ever targets the single image ARN from its
        // APPTHEORY_MICROVM_IMAGE_ARN env, which is the actual constraint.
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
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "4.2.2-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBa0Y7QUFDbEYsMkNBQTJDO0FBQzNDLGlEQUFpRDtBQUNqRCxtRUFBd0Q7QUFDeEQsMkNBQXVDO0FBR3ZDLHVGQUEyRjtBQW9CM0Y7O0dBRUc7QUFDSCxJQUFZLGlDQUtYO0FBTEQsV0FBWSxpQ0FBaUM7SUFDM0M7O09BRUc7SUFDSCxnREFBVyxDQUFBO0FBQ2IsQ0FBQyxFQUxXLGlDQUFpQyxpREFBakMsaUNBQWlDLFFBSzVDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLG9DQUtYO0FBTEQsV0FBWSxvQ0FBb0M7SUFDOUM7O09BRUc7SUFDSCx5REFBaUIsQ0FBQTtBQUNuQixDQUFDLEVBTFcsb0NBQW9DLG9EQUFwQyxvQ0FBb0MsUUFLL0M7QUFFRDs7R0FFRztBQUNILElBQVksd0JBVVg7QUFWRCxXQUFZLHdCQUF3QjtJQUNsQzs7T0FFRztJQUNILGlEQUFxQixDQUFBO0lBRXJCOztPQUVHO0lBQ0gsK0NBQW1CLENBQUE7QUFDckIsQ0FBQyxFQVZXLHdCQUF3Qix3Q0FBeEIsd0JBQXdCLFFBVW5DO0FBdVFEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSxxQkFBc0IsU0FBUSxzQkFBUztJQThDbEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFpQztRQUN6RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQ0FBc0MsQ0FBQyxDQUFDO1FBQzFELENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3ZDLE1BQU0sV0FBVyxHQUFHLHVCQUF1QixDQUFDLEtBQUssQ0FB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QUNuQixNQUFNLElBQUksS0FBSyxDQUFDLGlEQUFpRCxDQUFDLENBQUM7UUFDckUsQ0FBQztRQUNELFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELENBQUM7SUFFRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2ZuUmVzb3VyY2UsIEN1c3RvbVJlc291cmNlLCBEdXJhdGlvbiwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0IHsgUHJvdmlkZXIgfSBmcm9tIFwiYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IgfSBmcm9tIFwiLi9taWNyb3ZtLW5ldHdvcmstY29ubmVjdG9yXCI7XG5pbXBvcnQgeyBNSUNST1ZNX0lNQUdFX1BSVU5FX0hBTkRMRVJfU09VUkNFIH0gZnJvbSBcIi4vcHJpdmF0ZS9taWNyb3ZtLWltYWdlLXBydW5lLWhhbmRsZXJcIjtcblxuLyoqXG4gKiBSZWZlcmVuY2UgdG8gYSBMYW1iZGEgTWljcm9WTSBpbWFnZSB1c2FibGUgYnkgTWljcm9WTSBjb250cm9sbGVyIGNvbnN0cnVjdHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB7XG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBub3JtYWxpemVkIGRlcGxveW1lbnQtb3duZWQgcnVudGltZSBsb2dnaW5nIHBvc3R1cmUgZm9yIHRoaXMgaW1hZ2UuXG4gICAqXG4gICAqIENvbnRyb2xsZXJzIHByb3BhZ2F0ZSB0aGlzIGV4YWN0IENsb3VkV2F0Y2gtb3ItZGlzYWJsZWQgY2hvaWNlIHRvIGV2ZXJ5XG4gICAqIGBSdW5NaWNyb3ZtYCByZXF1ZXN0LlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZztcbn1cblxuLyoqXG4gKiBBZGRpdGlvbmFsIE9TIGNhcGFiaWxpdGllcyBzdXBwb3J0ZWQgYnkgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkge1xuICAvKipcbiAgICogR3JhbnRzIGFsbCBjdXJyZW50bHkgc3VwcG9ydGVkIE1pY3JvVk0gT1MgY2FwYWJpbGl0aWVzLlxuICAgKi9cbiAgQUxMID0gXCJBTExcIixcbn1cblxuLyoqXG4gKiBDUFUgYXJjaGl0ZWN0dXJlcyBzdXBwb3J0ZWQgYnkgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUge1xuICAvKipcbiAgICogQVJNNjQgTWljcm9WTSBpbWFnZSBhcmNoaXRlY3R1cmUuXG4gICAqL1xuICBBUk1fNjQgPSBcIkFSTV82NFwiLFxufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rIG1vZGUgZm9yIExhbWJkYSBNaWNyb1ZNIGltYWdlIGhvb2tzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUge1xuICAvKipcbiAgICogRGlzYWJsZSB0aGUgbGlmZWN5Y2xlIGhvb2suXG4gICAqL1xuICBESVNBQkxFRCA9IFwiRElTQUJMRURcIixcblxuICAvKipcbiAgICogRW5hYmxlIHRoZSBsaWZlY3ljbGUgaG9vay5cbiAgICovXG4gIEVOQUJMRUQgPSBcIkVOQUJMRURcIixcbn1cblxuLyoqXG4gKiBDb2RlIGFydGlmYWN0IGxvY2F0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNvZGVBcnRpZmFjdCB7XG4gIC8qKlxuICAgKiBUaGUgVVJJIG9mIHRoZSBjb2RlIGFydGlmYWN0LCBzdWNoIGFzIGFuIEFtYXpvbiBTMyBwYXRoIG9yIEFtYXpvbiBFQ1IgaW1hZ2UgVVJJLlxuICAgKi9cbiAgcmVhZG9ubHkgdXJpOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ1BVIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbiB7XG4gIC8qKlxuICAgKiBUaGUgQ1BVIGFyY2hpdGVjdHVyZS5cbiAgICpcbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NFxuICAgKi9cbiAgcmVhZG9ubHkgYXJjaGl0ZWN0dXJlPzogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlO1xufVxuXG4vKipcbiAqIEVudmlyb25tZW50IHZhcmlhYmxlIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGUge1xuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGUga2V5LlxuICAgKi9cbiAgcmVhZG9ubHkga2V5OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlIHZhbHVlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsdWU6IHN0cmluZztcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9va3MgaW52b2tlZCBkdXJpbmcgTWljcm9WTSBpbWFnZSBidWlsZCBldmVudHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQnVpbGRIb29rcyB7XG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSByZWFkeSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSByZWFkeT86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcmVhZHkgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHJlYWR5VGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgdmFsaWRhdGUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHZhbGlkYXRlIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSB2YWxpZGF0ZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2tzIGludm9rZWQgZHVyaW5nIE1pY3JvVk0gZXZlbnRzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3Mge1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcmVzdW1lIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3VtZT86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcmVzdW1lIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSByZXN1bWVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBydW4gaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVuPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSBydW4gaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHJ1blRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHN1c3BlbmQgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgc3VzcGVuZD86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgc3VzcGVuZCBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3VzcGVuZFRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHRlcm1pbmF0ZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSB0ZXJtaW5hdGU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHRlcm1pbmF0ZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgdGVybWluYXRlVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBIb29rIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3Mge1xuICAvKipcbiAgICogTGlmZWN5Y2xlIGhvb2tzIGZvciBNaWNyb1ZNIGV2ZW50cy5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1Ib29rcz86IEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3M7XG5cbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rcyBmb3IgTWljcm9WTSBpbWFnZSBidWlsZCBldmVudHMuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2VIb29rcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3M7XG5cbiAgLyoqXG4gICAqIFRoZSBwb3J0IG51bWJlciBvbiB3aGljaCB0aGUgaG9va3MgbGlzdGVuZXIgcnVucy5cbiAgICovXG4gIHJlYWRvbmx5IHBvcnQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvdWRXYXRjaCBMb2dzIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UgbG9nZ2luZy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgQ2xvdWRXYXRjaCBMb2dzIGxvZyBncm91cCB0byBzZW5kIGxvZ3MgdG8uXG4gICAqL1xuICByZWFkb25seSBsb2dHcm91cD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIENsb3VkV2F0Y2ggTG9ncyBsb2cgc3RyZWFtIHdpdGhpbiB0aGUgbG9nIGdyb3VwLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nU3RyZWFtPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIExvZ2dpbmcgY29uZmlndXJhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHtcbiAgLyoqXG4gICAqIENvbmZpZ3VyYXRpb24gZm9yIHNlbmRpbmcgbG9ncyB0byBBbWF6b24gQ2xvdWRXYXRjaCBMb2dzLlxuICAgKi9cbiAgcmVhZG9ubHkgY2xvdWRXYXRjaD86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nO1xuXG4gIC8qKlxuICAgKiBTZXQgdG8gdHJ1ZSB0byBkaXNhYmxlIE1pY3JvVk0gbG9nZ2luZy5cbiAgICovXG4gIHJlYWRvbmx5IGRpc2FibGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBSZXNvdXJjZSByZXF1aXJlbWVudHMgZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzIHtcbiAgLyoqXG4gICAqIFRoZSBtaW5pbXVtIGFtb3VudCBvZiBtZW1vcnkgaW4gTWlCIHRvIGFsbG9jYXRlIHRvIHRoZSBNaWNyb1ZNLlxuICAgKi9cbiAgcmVhZG9ubHkgbWluaW11bU1lbW9yeUluTWlCOiBudW1iZXI7XG59XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgQXBwVGhlb3J5TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVByb3BzIHtcbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgZGVzY3JpcHRpb24gb2YgdGhlIHZlcnNpb24uXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBiYXNlIE1pY3JvVk0gaW1hZ2UgdXNlZC5cbiAgICovXG4gIHJlYWRvbmx5IGJhc2VJbWFnZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgc3BlY2lmaWMgdmVyc2lvbiBvZiB0aGUgYmFzZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgYmFzZUltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBJQU0gYnVpbGQgcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGJ1aWxkUm9sZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29kZSBhcnRpZmFjdCBmb3IgdGhpcyB2ZXJzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgY29kZUFydGlmYWN0OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3Q7XG5cbiAgLyoqXG4gICAqIFRoZSBsaXN0IG9mIGVncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgYXZhaWxhYmxlIHRvIHRoZSBNaWNyb1ZNIGF0IHJ1bnRpbWUuXG4gICAqXG4gICAqIFBhc3MgYEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yYCBpbnN0YW5jZXMgb3IgY29tcGF0aWJsZSBjb25uZWN0b3IgcmVmZXJlbmNlcy5cbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW107XG5cbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rIGNvbmZpZ3VyYXRpb24gZm9yIE1pY3JvVk1zIGFuZCBNaWNyb1ZNIGltYWdlcy5cbiAgICpcbiAgICogUGFzcyBhbiBlbXB0eSBvYmplY3QgKGB7fWApIGZvciBBcHBUaGVvcnkgZW5kcG9pbnQtZGlzcGF0Y2hlZCBNaWNyb1ZNIGltYWdlcy5cbiAgICogQXBwVGhlb3J5IHRoZW4gc3ludGhlc2l6ZXMgYEhvb2tzOiB7fWAgc28gTGFtYmRhIGJ1aWxkcyB0aGUgaW1hZ2Ugd2l0aG91dFxuICAgKiBBV1MtaW52b2tlZCBsaWZlY3ljbGUgaG9va3MgYW5kIHJ1bnRpbWUgdHJhZmZpYyBpcyBkZWxpdmVyZWQgdGhyb3VnaCB0aGVcbiAgICogTWljcm9WTSBlbmRwb2ludCBvbiB0aGUgZGVmYXVsdCBwb3J0IDgwODAuIElmIGFueSBob29rIGlzIGNvbmZpZ3VyZWQsIGBwb3J0YFxuICAgKiBpcyByZXF1aXJlZCBieSBBV1MgYW5kIEFwcFRoZW9yeSB2YWxpZGF0ZXMgaXQgZmFpbC1jbG9zZWQuXG4gICAqL1xuICByZWFkb25seSBob29rczogQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3M7XG5cbiAgLyoqXG4gICAqIENvbmZpZ3VyYXRpb24gZm9yIE1pY3JvVk0gbG9nZ2luZyBvdXRwdXQuXG4gICAqXG4gICAqIFNwZWNpZnkgZXhhY3RseSBvbmUgb2YgYGNsb3VkV2F0Y2hgIG9yIGBkaXNhYmxlZDogdHJ1ZWAuXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgcmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciB0aGUgTWljcm9WTS5cbiAgICpcbiAgICogQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZSBjdXJyZW50bHkgYWNjZXB0cyBleGFjdGx5IG9uZSBSZXNvdXJjZXMgZW50cnkuXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZXM6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlc1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIE9TIGNhcGFiaWxpdGllcyBncmFudGVkIHRvIHRoZSBNaWNyb1ZNIHJ1bnRpbWUgZW52aXJvbm1lbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IFtBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMXVxuICAgKi9cbiAgcmVhZG9ubHkgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzPzogQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5W107XG5cbiAgLyoqXG4gICAqIFRoZSBsaXN0IG9mIHN1cHBvcnRlZCBDUFUgY29uZmlndXJhdGlvbnMgZm9yIHRoZSBNaWNyb1ZNLlxuICAgKlxuICAgKiBAZGVmYXVsdCBbeyBhcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQgfV1cbiAgICovXG4gIHJlYWRvbmx5IGNwdUNvbmZpZ3VyYXRpb25zPzogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbltdO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZXMgc2V0IGluIHRoZSBNaWNyb1ZNIHJ1bnRpbWUgZW52aXJvbm1lbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBlbnZpcm9ubWVudFZhcmlhYmxlcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGVbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBDbG91ZEZvcm1hdGlvbiB0YWdzIHRvIGFwcGx5IHRvIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgdGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIEFXUyBMYW1iZGEgTWljcm9WTSBpbWFnZXMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgaXMgaW50ZW50aW9uYWxseSBkZXBsb3ltZW50LW9ubHk6IGl0IGNyZWF0ZXMgdGhlIENsb3VkRm9ybWF0aW9uXG4gKiBgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZWAgcmVzb3VyY2UgZnJvbSBjYWxsZXItcHJvdmlkZWQgY29kZSBhcnRpZmFjdCwgYmFzZSBpbWFnZSxcbiAqIGJ1aWxkIHJvbGUsIGxpZmVjeWNsZSBob29rcywgbG9nZ2luZyBjb25maWd1cmF0aW9uLCByZXNvdXJjZSByZXF1aXJlbWVudHMsIGFuZFxuICogQXBwVGhlb3J5IE1pY3JvVk0gbmV0d29yay1jb25uZWN0b3IgcmVmZXJlbmNlcy4gUnVudGltZSBjb250cm9sbGVyIGJlaGF2aW9yIHN0YXlzIGluXG4gKiB0aGUgQXBwVGhlb3J5IHJ1bnRpbWUgY29udHJhY3QuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgZXh0ZW5kcyBDb25zdHJ1Y3QgaW1wbGVtZW50cyBJQXBwVGhlb3J5TWljcm92bUltYWdlIHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIENsb3VkRm9ybWF0aW9uIE1pY3JvVk0gaW1hZ2UgcmVzb3VyY2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlOiBDZm5SZXNvdXJjZTtcblxuICAvKipcbiAgICogVGhlIE1pY3JvVk0gaW1hZ2UgbmFtZSByZXR1cm5lZCBieSBSZWYuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbm9ybWFsaXplZCBkZXBsb3ltZW50LW93bmVkIHJ1bnRpbWUgbG9nZ2luZyBwb3N0dXJlIGZvciB0aGlzIGltYWdlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjdXJyZW50IGltYWdlIHN0YXRlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZVN0YXRlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBsYXRlc3QgYWN0aXZlIGltYWdlIHZlcnNpb24uXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbGF0ZXN0QWN0aXZlSW1hZ2VWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBsYXRlc3QgZmFpbGVkIGltYWdlIHZlcnNpb24sIGlmIGFueS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsYXRlc3RGYWlsZWRJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHRpbWVzdGFtcCB3aGVuIHRoZSBpbWFnZSB3YXMgY3JlYXRlZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBjcmVhdGVkQXQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHRpbWVzdGFtcCB3aGVuIHRoZSBpbWFnZSB3YXMgbGFzdCB1cGRhdGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHVwZGF0ZWRBdDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAocHJvcHMgPT09IHVuZGVmaW5lZCB8fCBwcm9wcyA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IG5hbWUgPSBub3JtYWxpemVOYW1lKHByb3BzLm5hbWUpO1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcocHJvcHMuZGVzY3JpcHRpb24sIFwiZGVzY3JpcHRpb25cIik7XG4gICAgY29uc3QgYmFzZUltYWdlQXJuID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLmJhc2VJbWFnZUFybiwgXCJiYXNlSW1hZ2VBcm5cIiwgMjA0OCk7XG4gICAgY29uc3QgYmFzZUltYWdlVmVyc2lvbiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5iYXNlSW1hZ2VWZXJzaW9uLCBcImJhc2VJbWFnZVZlcnNpb25cIiwgMjA0OCk7XG4gICAgY29uc3QgYnVpbGRSb2xlQXJuID0gbm9ybWFsaXplQnVpbGRSb2xlQXJuKHByb3BzLmJ1aWxkUm9sZUFybik7XG4gICAgY29uc3QgY29kZUFydGlmYWN0ID0gcmVuZGVyQ29kZUFydGlmYWN0KHByb3BzLmNvZGVBcnRpZmFjdCk7XG4gICAgY29uc3QgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgPSBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKHByb3BzLmVncmVzc05ldHdvcmtDb25uZWN0b3JzKTtcbiAgICBjb25zdCBob29rcyA9IHJlbmRlckhvb2tzKHByb3BzLmhvb2tzKTtcbiAgICBjb25zdCBsb2dnaW5nID0gbm9ybWFsaXplTG9nZ2luZyhwcm9wcy5sb2dnaW5nKTtcbiAgICBjb25zdCByZXNvdXJjZXMgPSByZW5kZXJSZXNvdXJjZXMocHJvcHMucmVzb3VyY2VzKTtcbiAgICBjb25zdCBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMgPSBub3JtYWxpemVBZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMocHJvcHMuYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKTtcbiAgICBjb25zdCBjcHVDb25maWd1cmF0aW9ucyA9IHJlbmRlckNwdUNvbmZpZ3VyYXRpb25zKHByb3BzLmNwdUNvbmZpZ3VyYXRpb25zKTtcbiAgICBjb25zdCBlbnZpcm9ubWVudFZhcmlhYmxlcyA9IHJlbmRlckVudmlyb25tZW50VmFyaWFibGVzKHByb3BzLmVudmlyb25tZW50VmFyaWFibGVzKTtcblxuICAgIGNvbnN0IHJlbmRlcmVkSW1hZ2VQcm9wZXJ0aWVzID0ge1xuICAgICAgQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzOiBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMsXG4gICAgICBCYXNlSW1hZ2VBcm46IGJhc2VJbWFnZUFybixcbiAgICAgIEJhc2VJbWFnZVZlcnNpb246IGJhc2VJbWFnZVZlcnNpb24sXG4gICAgICBCdWlsZFJvbGVBcm46IGJ1aWxkUm9sZUFybixcbiAgICAgIENvZGVBcnRpZmFjdDogY29kZUFydGlmYWN0LFxuICAgICAgQ3B1Q29uZmlndXJhdGlvbnM6IGNwdUNvbmZpZ3VyYXRpb25zLFxuICAgICAgRGVzY3JpcHRpb246IGRlc2NyaXB0aW9uLFxuICAgICAgRWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IGVncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgRW52aXJvbm1lbnRWYXJpYWJsZXM6IGVudmlyb25tZW50VmFyaWFibGVzLFxuICAgICAgSG9va3M6IGhvb2tzLFxuICAgICAgTG9nZ2luZzogcmVuZGVyTG9nZ2luZyhsb2dnaW5nKSxcbiAgICAgIE5hbWU6IG5hbWUsXG4gICAgICBSZXNvdXJjZXM6IHJlc291cmNlcyxcbiAgICAgIFRhZ3M6IHJlbmRlclRhZ3MocHJvcHMudGFncyksXG4gICAgfTtcblxuICAgIHRoaXMubWljcm92bUltYWdlID0gbmV3IENmblJlc291cmNlKHRoaXMsIFwiTWljcm92bUltYWdlXCIsIHtcbiAgICAgIHR5cGU6IFwiQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZVwiLFxuICAgICAgcHJvcGVydGllczogcmVuZGVyZWRJbWFnZVByb3BlcnRpZXMsXG4gICAgfSk7XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZU5hbWUgPSB0aGlzLm1pY3Jvdm1JbWFnZS5yZWY7XG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VBcm4gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJJbWFnZUFyblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubG9nZ2luZyA9IGxvZ2dpbmc7XG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VTdGF0ZSA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIlN0YXRlXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5sYXRlc3RBY3RpdmVJbWFnZVZlcnNpb24gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJMYXRlc3RBY3RpdmVJbWFnZVZlcnNpb25cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmxhdGVzdEZhaWxlZEltYWdlVmVyc2lvbiA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkxhdGVzdEZhaWxlZEltYWdlVmVyc2lvblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMuY3JlYXRlZEF0ID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiQ3JlYXRlZEF0XCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy51cGRhdGVkQXQgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJVcGRhdGVkQXRcIikudG9TdHJpbmcoKTtcblxuICAgIHRoaXMud2lyZVZlcnNpb25QcnVuaW5nKHJlbmRlcmVkSW1hZ2VQcm9wZXJ0aWVzLCBuYW1lKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaXJlcyB0aGUgYWx3YXlzLW9uIHZlcnNpb24tcHJ1bmluZyBjdXN0b20gcmVzb3VyY2UuXG4gICAqXG4gICAqIEV2ZXJ5IENsb3VkRm9ybWF0aW9uIGNyZWF0ZS91cGRhdGUgdGhhdCB0b3VjaGVzIHRoZSBpbWFnZSDigJQgc2lnbmFsZWQgYnkgYVxuICAgKiBjaGFuZ2UgdG8gdGhlIG1pcnJvcmVkIGltYWdlIHByb3BlcnRpZXMg4oCUIHJ1bnMgdGhlIHBydW5lIGhhbmRsZXIgQkVGT1JFIHRoZVxuICAgKiBgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZWAgdXBkYXRlIGNyZWF0ZXMgYSBuZXcgdmVyc2lvbjogdGhlIGltYWdlIHJlc291cmNlXG4gICAqIGNhcnJpZXMgYW4gZXhwbGljaXQgYERlcGVuZHNPbmAgb24gdGhlIHBydW5lIGN1c3RvbSByZXNvdXJjZSBzbyBDbG91ZEZvcm1hdGlvblxuICAgKiBvcmRlcnMgdGhlIHBydW5lIGZpcnN0LiBBIGxpc3QvZGVzY3JpYmUgZmFpbHVyZSBmYWlscyB0aGUgZGVwbG95bWVudCBsb3VkbHksXG4gICAqIGV4Y2VwdCBhIDQwNCBvbiB0aGUgdmVyc2lvbiBsaXN0ICh0aGUgaW1hZ2UgZG9lcyBub3QgZXhpc3QgeWV0IG9uIGEgZnJlc2hcbiAgICogc3RhY2sgQ1JFQVRFKSwgd2hpY2ggaXMgdHJlYXRlZCBhcyBub3RoaW5nIHRvIHBydW5lOyBhIHBlci12ZXJzaW9uIGRlbGV0ZVxuICAgKiByZWZ1c2FsIGlzIGxvZ2dlZCBhbmQgc2tpcHBlZC4gT24gc3RhY2sgREVMRVRFIHRoZSBoYW5kbGVyIHJldHVybnMgc3VjY2Vzc1xuICAgKiB3aXRob3V0IHBydW5pbmcgYmVjYXVzZSBDbG91ZEZvcm1hdGlvbiBkZWxldGVzIHRoZSB3aG9sZSBpbWFnZS4gVGhlcmUgYXJlIG5vXG4gICAqIGRlcGxveS10aW1lIGtub2JzOiBwcnVuaW5nIGlzIGFsd2F5cy1vbiBlbmNvZGVkIGJlaGF2aW9yLlxuICAgKlxuICAgKiBUaGUgaGFuZGxlciBlbnYgYW5kIElBTSBwb2xpY3kgcmVmZXJlbmNlIHRoZSBpbWFnZSBBUk4gY29uc3RydWN0ZWQgZnJvbVxuICAgKiBwc2V1ZG8tcGFyYW1ldGVycyAoYFN0YWNrLmZvcm1hdEFybmApIHJhdGhlciB0aGFuIGZyb20gYEltYWdlQXJuYCBHZXRBdHQ6XG4gICAqIHRoZSBoYW5kbGVyIGZ1bmN0aW9uIGlzIGRvd25zdHJlYW0gb2YgdGhlIHBydW5lIGN1c3RvbSByZXNvdXJjZSwgc28gYVxuICAgKiBHZXRBdHQtYmFzZWQgcmVmZXJlbmNlIHdvdWxkIG1ha2UgdGhlIGhhbmRsZXIgZGVwZW5kIG9uIHRoZSBpbWFnZSBhbmQgY2xvc2VcbiAgICogYSBDbG91ZEZvcm1hdGlvbiBkZXBlbmRlbmN5IGN5Y2xlIChpbWFnZSDihpIgcHJ1bmUg4oaSIGhhbmRsZXIg4oaSIGltYWdlKS5cbiAgICovXG4gIHByaXZhdGUgd2lyZVZlcnNpb25QcnVuaW5nKHJlbmRlcmVkSW1hZ2VQcm9wZXJ0aWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgaW1hZ2VOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwcnVuZUltYWdlQXJuID0gU3RhY2sub2YodGhpcykuZm9ybWF0QXJuKHtcbiAgICAgIHNlcnZpY2U6IFwibGFtYmRhXCIsXG4gICAgICByZXNvdXJjZTogXCJtaWNyb3ZtLWltYWdlXCIsXG4gICAgICByZXNvdXJjZU5hbWU6IGltYWdlTmFtZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHBydW5lSGFuZGxlciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJNaWNyb3ZtSW1hZ2VQcnVuZUhhbmRsZXJcIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzI0X1gsXG4gICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoTUlDUk9WTV9JTUFHRV9QUlVORV9IQU5ETEVSX1NPVVJDRSksXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQVBQVEhFT1JZX01JQ1JPVk1fSU1BR0VfQVJOOiBwcnVuZUltYWdlQXJuLFxuICAgICAgICBBUFBUSEVPUllfTUlDUk9WTV9JTUFHRV9SRUdJT046IFN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBFeGFjdGx5IHRoZSB0d28gbWljcm92bSBsaXN0L2RlbGV0ZSBhY3Rpb25zIG9uIFwiKlwiLiBMYW1iZGEgTWljcm9WTVxuICAgIC8vIGltYWdlLXZlcnNpb24gb3BlcmF0aW9ucyBhcmUgY3VycmVudGx5IHBlcm1pc3Npb24tb25seSBhY3Rpb25zOiB0aGVcbiAgICAvLyBzZXJ2aWNlIGRvZXMgbm90IGhvbm9yIHJlc291cmNlLWxldmVsIHNjb3BpbmcgZm9yIHRoZW0sIHNvIGEgZ3JhbnRcbiAgICAvLyBzY29wZWQgdG8gdGhlIGltYWdlIEFSTiBpcyByZWplY3RlZCBhdCBydW50aW1lIHdpdGggSFRUUCA0MDMgKG9ic2VydmVkXG4gICAgLy8gbGl2ZTogXCJpcyBub3QgYXV0aG9yaXplZCB0byBwZXJmb3JtOiBsYW1iZGE6TGlzdE1pY3Jvdm1JbWFnZVZlcnNpb25zIG9uXG4gICAgLy8gcmVzb3VyY2U6IGFybjphd3M6bGFtYmRhOi4uLjptaWNyb3ZtLWltYWdlLzxpbWFnZT5cIikuIFRoZSBoYW5kbGVyXG4gICAgLy8gYmluYXJ5IGl0c2VsZiBvbmx5IGV2ZXIgdGFyZ2V0cyB0aGUgc2luZ2xlIGltYWdlIEFSTiBmcm9tIGl0c1xuICAgIC8vIEFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX0FSTiBlbnYsIHdoaWNoIGlzIHRoZSBhY3R1YWwgY29uc3RyYWludC5cbiAgICBwcnVuZUhhbmRsZXIuYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6TGlzdE1pY3Jvdm1JbWFnZVZlcnNpb25zXCIsIFwibGFtYmRhOkRlbGV0ZU1pY3Jvdm1JbWFnZVZlcnNpb25cIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBjb25zdCBwcnVuZVByb3ZpZGVyID0gbmV3IFByb3ZpZGVyKHRoaXMsIFwiTWljcm92bUltYWdlUHJ1bmVQcm92aWRlclwiLCB7XG4gICAgICBvbkV2ZW50SGFuZGxlcjogcHJ1bmVIYW5kbGVyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcHJ1bmUgPSBuZXcgQ3VzdG9tUmVzb3VyY2UodGhpcywgXCJNaWNyb3ZtSW1hZ2VQcnVuZVwiLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IHBydW5lUHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAvLyBNaXJyb3JzIHRoZSBpbWFnZSdzIHJlbmRlcmVkIHByb3BlcnRpZXMgc28gdGhlIHBydW5lIGN1c3RvbSByZXNvdXJjZVxuICAgICAgICAvLyBpcyByZS1pbnZva2VkIGV4YWN0bHkgd2hlbiB0aGUgaW1hZ2UgcmVzb3VyY2UgaXRzZWxmIHdvdWxkIGJlIHVwZGF0ZWRcbiAgICAgICAgLy8gYnkgQ2xvdWRGb3JtYXRpb24uIFRoZSBwcnVuZSBoYW5kbGVyIHJlYWRzIHRoZSBpbWFnZSBBUk4gZnJvbSBpdHMgb3duXG4gICAgICAgIC8vIGVudmlyb25tZW50IHJhdGhlciB0aGFuIGZyb20gdGhlc2UgcHJvcGVydGllcywgc28gdGhlIGN1c3RvbSByZXNvdXJjZVxuICAgICAgICAvLyBuZXZlciBjcmVhdGVzIGFuIGltcGxpY2l0IGRlcGVuZGVuY3kgdGhhdCB3b3VsZCByZXZlcnNlIHRoZSBvcmRlcmluZy5cbiAgICAgICAgTWljcm92bUltYWdlUHJvcGVydGllczogcmVuZGVyZWRJbWFnZVByb3BlcnRpZXMsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2Uubm9kZS5hZGREZXBlbmRlbmN5KHBydW5lKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOYW1lKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBuYW1lID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibmFtZVwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICEvXltBLVphLXowLTlfLV17MSw2NH0kLy50ZXN0KG5hbWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IG5hbWUgbXVzdCBiZSAxLTY0IGNoYXJhY3RlcnMgdXNpbmcgbGV0dGVycywgbnVtYmVycywgaHlwaGVucywgb3IgdW5kZXJzY29yZXNcIixcbiAgICApO1xuICB9XG4gIHJldHVybiBuYW1lO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcodmFsdWUpLnRyaW0oKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBwcm9wTmFtZSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAvXFxzLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiBub3JtYWxpemVkLmxlbmd0aCA+IG1heExlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGF0IG1vc3QgJHttYXhMZW5ndGh9IGNoYXJhY3RlcnNgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQnVpbGRSb2xlQXJuKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBjb25zdCBhcm4gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWUsIFwiYnVpbGRSb2xlQXJuXCIsIDIwNDgpO1xuICBpZiAoXG4gICAgIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiZcbiAgICAhL15hcm46YXdzW2EtekEtWi1dKjppYW06OlxcZHsxMn06cm9sZVxcLz9bYS16QS1aXzAtOSs9LC5AXFwtXy9dKyQvLnRlc3QoYXJuKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGJ1aWxkUm9sZUFybiBtdXN0IGJlIGFuIElBTSByb2xlIEFSTlwiKTtcbiAgfVxuICByZXR1cm4gYXJuO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb2RlQXJ0aWZhY3QoXG4gIGNvZGVBcnRpZmFjdDogQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0IHwgdW5kZWZpbmVkLFxuKTogeyBVcmk6IHN0cmluZyB9IHtcbiAgaWYgKGNvZGVBcnRpZmFjdCA9PT0gdW5kZWZpbmVkIHx8IGNvZGVBcnRpZmFjdCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5jb2RlQXJ0aWZhY3RcIik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBVcmk6IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhjb2RlQXJ0aWZhY3QudXJpLCBcImNvZGVBcnRpZmFjdC51cmlcIiwgMjA0OCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gIGNvbm5lY3RvcnM6IHJlYWRvbmx5IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWNvbm5lY3RvcnMgfHwgY29ubmVjdG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBlbnRyeVwiKTtcbiAgfVxuICBpZiAoY29ubmVjdG9ycy5sZW5ndGggPiAxMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBhdCBtb3N0IDEwIGVncmVzc05ldHdvcmtDb25uZWN0b3JzIGVudHJpZXNcIik7XG4gIH1cblxuICBjb25zdCBhcm5zID0gY29ubmVjdG9ycy5tYXAoKGNvbm5lY3RvciwgaW5kZXgpID0+IHtcbiAgICBpZiAoY29ubmVjdG9yID09PSB1bmRlZmluZWQgfHwgY29ubmVjdG9yID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3QgYXJuID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcoXG4gICAgICBjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvckFybixcbiAgICAgIGBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV0ubmV0d29ya0Nvbm5lY3RvckFybmAsXG4gICAgKTtcbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChhcm4pICYmIC9cXHMvLnRlc3QoYXJuKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWljcm92bUltYWdlOiBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV0ubmV0d29ya0Nvbm5lY3RvckFybiBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGFybjtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5W10sXG4pOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXSB7XG4gIGNvbnN0IGNhcGFiaWxpdGllcyA9IHZhbHVlcyA/PyBbQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTF07XG4gIGlmIChjYXBhYmlsaXRpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzIGVudHJ5XCIpO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjYXBhYmlsaXRpZXMubWFwKChjYXBhYmlsaXR5LCBpbmRleCkgPT4ge1xuICAgIGlmIChTdHJpbmcoY2FwYWJpbGl0eSkudHJpbSgpLnRvVXBwZXJDYXNlKCkgIT09IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTEwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXNbJHtpbmRleH1dIG11c3QgYmUgQUxMYCk7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMO1xuICB9KTtcbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKG5vcm1hbGl6ZWQsIFwiYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ3B1Q29uZmlndXJhdGlvbnMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb25bXSxcbik6IEFycmF5PHsgQXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUgfT4ge1xuICBjb25zdCBjcHVDb25maWd1cmF0aW9ucyA9IHZhbHVlcyA/PyBbeyBhcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQgfV07XG4gIGlmIChjcHVDb25maWd1cmF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBjcHVDb25maWd1cmF0aW9ucyBlbnRyeVwiKTtcbiAgfVxuICByZXR1cm4gY3B1Q29uZmlndXJhdGlvbnMubWFwKChjcHUsIGluZGV4KSA9PiB7XG4gICAgaWYgKGNwdSA9PT0gdW5kZWZpbmVkIHx8IGNwdSA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuY3B1Q29uZmlndXJhdGlvbnNbJHtpbmRleH1dYCk7XG4gICAgfVxuICAgIGNvbnN0IGFyY2hpdGVjdHVyZSA9IFN0cmluZyhjcHUuYXJjaGl0ZWN0dXJlID8/IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQpXG4gICAgICAudHJpbSgpXG4gICAgICAudG9VcHBlckNhc2UoKTtcbiAgICBpZiAoYXJjaGl0ZWN0dXJlICE9PSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogY3B1Q29uZmlndXJhdGlvbnNbJHtpbmRleH1dLmFyY2hpdGVjdHVyZSBtdXN0IGJlIEFSTV82NGApO1xuICAgIH1cbiAgICByZXR1cm4geyBBcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQgfTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckVudmlyb25tZW50VmFyaWFibGVzKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlW10sXG4pOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+IHtcbiAgaWYgKCh2YWx1ZXM/Lmxlbmd0aCA/PyAwKSA+IDUwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGF0IG1vc3QgNTAgZW52aXJvbm1lbnRWYXJpYWJsZXMgZW50cmllc1wiKTtcbiAgfVxuXG4gIGNvbnN0IHJlbmRlcmVkID0gKHZhbHVlcyA/PyBbXSkubWFwKChlbnRyeSwgaW5kZXgpID0+IHtcbiAgICBpZiAoZW50cnkgPT09IHVuZGVmaW5lZCB8fCBlbnRyeSA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dYCk7XG4gICAgfVxuICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhlbnRyeS5rZXksIGBlbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV0ua2V5YCwgMjU2KTtcbiAgICBjb25zdCB2YWx1ZSA9IGVudHJ5LnZhbHVlID09PSB1bmRlZmluZWQgfHwgZW50cnkudmFsdWUgPT09IG51bGwgPyB1bmRlZmluZWQgOiBTdHJpbmcoZW50cnkudmFsdWUpO1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV0udmFsdWVgKTtcbiAgICB9XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIHZhbHVlLmxlbmd0aCA+IDQwOTYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBlbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV0udmFsdWUgbXVzdCBiZSBhdCBtb3N0IDQwOTYgY2hhcmFjdGVyc2ApO1xuICAgIH1cbiAgICByZXR1cm4geyBLZXk6IGtleSwgVmFsdWU6IHZhbHVlIH07XG4gIH0pO1xuXG4gIGFzc2VydE5vRHVwbGljYXRlcyhcbiAgICByZW5kZXJlZC5tYXAoKGVudHJ5KSA9PiBlbnRyeS5LZXkpLFxuICAgIFwiZW52aXJvbm1lbnRWYXJpYWJsZXMga2V5XCIsXG4gICk7XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVySG9va3MoaG9va3M6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAoaG9va3MgPT09IHVuZGVmaW5lZCB8fCBob29rcyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rc1wiKTtcbiAgfVxuXG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBjb25zdCBtaWNyb3ZtSG9va3MgPSByZW5kZXJSdW50aW1lSG9va3MoaG9va3MubWljcm92bUhvb2tzKTtcbiAgaWYgKG1pY3Jvdm1Ib29rcykge1xuICAgIHJlbmRlcmVkLk1pY3Jvdm1Ib29rcyA9IG1pY3Jvdm1Ib29rcztcbiAgfVxuICBjb25zdCBtaWNyb3ZtSW1hZ2VIb29rcyA9IHJlbmRlckltYWdlSG9va3MoaG9va3MubWljcm92bUltYWdlSG9va3MpO1xuICBpZiAobWljcm92bUltYWdlSG9va3MpIHtcbiAgICByZW5kZXJlZC5NaWNyb3ZtSW1hZ2VIb29rcyA9IG1pY3Jvdm1JbWFnZUhvb2tzO1xuICB9XG4gIGNvbnN0IGhhc0hvb2tHcm91cCA9IEJvb2xlYW4ocmVuZGVyZWQuTWljcm92bUhvb2tzIHx8IHJlbmRlcmVkLk1pY3Jvdm1JbWFnZUhvb2tzKTtcbiAgaWYgKGhhc0hvb2tHcm91cCAmJiBob29rcy5wb3J0ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogaG9va3MucG9ydCBpcyByZXF1aXJlZCB3aGVuIHByb3BzLmhvb2tzLm1pY3Jvdm1Ib29rcyBvciBwcm9wcy5ob29rcy5taWNyb3ZtSW1hZ2VIb29rcyBpcyBjb25maWd1cmVkXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaG9va3MucG9ydCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFoYXNIb29rR3JvdXApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGhvb2tzLnBvcnQgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUhvb2tzIG9yIHByb3BzLmhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZW5kZXJlZC5Qb3J0ID0gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UoaG9va3MucG9ydCwgXCJob29rcy5wb3J0XCIsIDEsIDY1NTM1KTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJ1bnRpbWVIb29rcyhob29rcz86IEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUhvb2tzXCIpO1xuICB9XG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSZXN1bWVcIiwgaG9va3MucmVzdW1lLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5yZXN1bWVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJlc3VtZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5yZXN1bWVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnJlc3VtZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSdW5cIiwgaG9va3MucnVuLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5ydW5cIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJ1blRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5ydW5UaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnJ1blRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJTdXNwZW5kXCIsIGhvb2tzLnN1c3BlbmQsIFwiaG9va3MubWljcm92bUhvb2tzLnN1c3BlbmRcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3Muc3VzcGVuZFRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3Muc3VzcGVuZFRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJUZXJtaW5hdGVcIiwgaG9va3MudGVybWluYXRlLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy50ZXJtaW5hdGVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy50ZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBpZiAoT2JqZWN0LmtleXMocmVuZGVyZWQpLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGhvb2tzLm1pY3Jvdm1Ib29rcyBzZXR0aW5nXCIpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVySW1hZ2VIb29rcyhob29rcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3NcIik7XG4gIH1cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJlYWR5XCIsIGhvb2tzLnJlYWR5LCBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnJlYWR5XCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSZWFkeVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5yZWFkeVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy5yZWFkeVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDM2MDAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlZhbGlkYXRlXCIsIGhvb2tzLnZhbGlkYXRlLCBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnZhbGlkYXRlXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJWYWxpZGF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy52YWxpZGF0ZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy52YWxpZGF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDM2MDAsXG4gICk7XG4gIGlmIChPYmplY3Qua2V5cyhyZW5kZXJlZCkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgaG9va3MubWljcm92bUltYWdlSG9va3Mgc2V0dGluZ1wiKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHNldEhvb2tNb2RlKFxuICB0YXJnZXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBrZXk6IHN0cmluZyxcbiAgbW9kZTogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChtb2RlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhtb2RlKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgaWYgKG5vcm1hbGl6ZWQgIT09IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZS5FTkFCTEVEICYmIG5vcm1hbGl6ZWQgIT09IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZS5ESVNBQkxFRCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIEVOQUJMRUQgb3IgRElTQUJMRURgKTtcbiAgfVxuICB0YXJnZXRba2V5XSA9IG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgdGFyZ2V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBzdHJpbmcsXG4gIHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIG1pbjogbnVtYmVyLFxuICBtYXg6IG51bWJlcixcbik6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0YXJnZXRba2V5XSA9IG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKHZhbHVlLCBwcm9wTmFtZSwgbWluLCBtYXgpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dnaW5nKGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcgfCB1bmRlZmluZWQpOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmxvZ2dpbmdcIik7XG4gIH1cbiAgY29uc3QgaGFzQ2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gdW5kZWZpbmVkICYmIGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gbnVsbDtcbiAgY29uc3QgaGFzRGlzYWJsZWQgPSBsb2dnaW5nLmRpc2FibGVkICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNDbG91ZFdhdGNoID09PSBoYXNEaXNhYmxlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZyBtdXN0IHNwZWNpZnkgZXhhY3RseSBvbmUgb2YgY2xvdWRXYXRjaCBvciBkaXNhYmxlZFwiKTtcbiAgfVxuICBpZiAoaGFzRGlzYWJsZWQpIHtcbiAgICBpZiAobG9nZ2luZy5kaXNhYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmRpc2FibGVkIG11c3QgYmUgdHJ1ZSB3aGVuIHByb3ZpZGVkXCIpO1xuICAgIH1cbiAgICByZXR1cm4geyBkaXNhYmxlZDogdHJ1ZSB9O1xuICB9XG4gIHJldHVybiB7IGNsb3VkV2F0Y2g6IG5vcm1hbGl6ZUNsb3VkV2F0Y2hMb2dnaW5nKGxvZ2dpbmcuY2xvdWRXYXRjaCkgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ2xvdWRXYXRjaExvZ2dpbmcoXG4gIGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nIHwgdW5kZWZpbmVkLFxuKTogQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMubG9nZ2luZy5jbG91ZFdhdGNoXCIpO1xuICB9XG4gIHJldHVybiB7XG4gICAgLi4uKGxvZ2dpbmcubG9nR3JvdXAgIT09IHVuZGVmaW5lZCA/IHsgbG9nR3JvdXA6IG5vcm1hbGl6ZUxvZ0dyb3VwKGxvZ2dpbmcubG9nR3JvdXApIH0gOiB7fSksXG4gICAgLi4uKGxvZ2dpbmcubG9nU3RyZWFtICE9PSB1bmRlZmluZWQgPyB7IGxvZ1N0cmVhbTogbm9ybWFsaXplTG9nU3RyZWFtKGxvZ2dpbmcubG9nU3RyZWFtKSB9IDoge30pLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJMb2dnaW5nKGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmIChsb2dnaW5nLmNsb3VkV2F0Y2gpIHtcbiAgICByZXR1cm4ge1xuICAgICAgQ2xvdWRXYXRjaDoge1xuICAgICAgICAuLi4obG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwICE9PSB1bmRlZmluZWQgPyB7IExvZ0dyb3VwOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXAgfSA6IHt9KSxcbiAgICAgICAgLi4uKGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gIT09IHVuZGVmaW5lZCA/IHsgTG9nU3RyZWFtOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIH0gOiB7fSksXG4gICAgICB9LFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgRGlzYWJsZWQ6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9nR3JvdXAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXBcIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAhL15bYS16QS1aMC05X1xcLS8uI117MSw1MTJ9JC8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dTdHJlYW0odmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgKCEvXlteOipdKiQvLnRlc3Qobm9ybWFsaXplZCkgfHwgbm9ybWFsaXplZC5sZW5ndGggPiA1MTIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSZXNvdXJjZXMoXG4gIHJlc291cmNlczogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzW10gfCB1bmRlZmluZWQsXG4pOiBBcnJheTx7IE1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyIH0+IHtcbiAgaWYgKCFyZXNvdXJjZXMgfHwgcmVzb3VyY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBleGFjdGx5IDEgcmVzb3VyY2VzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChyZXNvdXJjZXMubGVuZ3RoID4gMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBleGFjdGx5IDEgcmVzb3VyY2VzIGVudHJ5XCIpO1xuICB9XG4gIGNvbnN0IHJlc291cmNlID0gcmVzb3VyY2VzWzBdO1xuICBpZiAocmVzb3VyY2UgPT09IHVuZGVmaW5lZCB8fCByZXNvdXJjZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5yZXNvdXJjZXNbMF1cIik7XG4gIH1cbiAgcmV0dXJuIFtcbiAgICB7XG4gICAgICBNaW5pbXVtTWVtb3J5SW5NaUI6IG5vcm1hbGl6ZVBvc2l0aXZlSW50ZWdlcihyZXNvdXJjZS5taW5pbXVtTWVtb3J5SW5NaUIsIFwicmVzb3VyY2VzWzBdLm1pbmltdW1NZW1vcnlJbk1pQlwiKSxcbiAgICB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZywgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IG1pbiB8fCB2YWx1ZSA+IG1heCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGFuIGludGVnZXIgZnJvbSAke21pbn0gdG8gJHttYXh9YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0R1cGxpY2F0ZXModmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtsYWJlbH0gdmFsdWVzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZW5kZXJUYWdzKHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiB7XG4gIGNvbnN0IHJlbmRlcmVkOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+ID0gW1xuICAgIHsgS2V5OiBcIkZyYW1ld29ya1wiLCBWYWx1ZTogXCJBcHBUaGVvcnlcIiB9LFxuICAgIHsgS2V5OiBcIkNvbXBvbmVudFwiLCBWYWx1ZTogXCJNaWNyb3ZtSW1hZ2VcIiB9LFxuICBdO1xuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHRhZ3MgPz8ge30pLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZEtleSA9IGtleS50cmltKCk7XG4gICAgaWYgKCFub3JtYWxpemVkS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IHRhZyBrZXlzIGNhbm5vdCBiZSBlbXB0eVwiKTtcbiAgICB9XG4gICAgcmVuZGVyZWQucHVzaCh7IEtleTogbm9ybWFsaXplZEtleSwgVmFsdWU6IHZhbHVlIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuIl19