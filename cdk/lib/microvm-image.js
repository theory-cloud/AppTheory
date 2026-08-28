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
     * orders the prune first. A list/describe failure fails the deployment loudly;
     * a per-version delete refusal is logged and skipped. On stack DELETE the
     * handler returns success without pruning because CloudFormation deletes the
     * whole image. There are no deploy-time knobs: pruning is always-on encoded
     * behavior.
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
        // Least privilege: exactly the two microvm list/delete actions on this
        // image ARN and nothing else. No wildcard service permissions.
        pruneHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ["lambda:ListMicrovmImageVersions", "lambda:DeleteMicrovmImageVersion"],
            resources: [pruneImageArn],
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
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "4.1.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBa0Y7QUFDbEYsMkNBQTJDO0FBQzNDLGlEQUFpRDtBQUNqRCxtRUFBd0Q7QUFDeEQsMkNBQXVDO0FBR3ZDLHVGQUEyRjtBQW9CM0Y7O0dBRUc7QUFDSCxJQUFZLGlDQUtYO0FBTEQsV0FBWSxpQ0FBaUM7SUFDM0M7O09BRUc7SUFDSCxnREFBVyxDQUFBO0FBQ2IsQ0FBQyxFQUxXLGlDQUFpQyxpREFBakMsaUNBQWlDLFFBSzVDO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLG9DQUtYO0FBTEQsV0FBWSxvQ0FBb0M7SUFDOUM7O09BRUc7SUFDSCx5REFBaUIsQ0FBQTtBQUNuQixDQUFDLEVBTFcsb0NBQW9DLG9EQUFwQyxvQ0FBb0MsUUFLL0M7QUFFRDs7R0FFRztBQUNILElBQVksd0JBVVg7QUFWRCxXQUFZLHdCQUF3QjtJQUNsQzs7T0FFRztJQUNILGlEQUFxQixDQUFBO0lBRXJCOztPQUVHO0lBQ0gsK0NBQW1CLENBQUE7QUFDckIsQ0FBQyxFQVZXLHdCQUF3Qix3Q0FBeEIsd0JBQXdCLFFBVW5DO0FBdVFEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSxxQkFBc0IsU0FBUSxzQkFBUztJQThDbEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFpQztRQUN6RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQ0FBc0MsQ0FBQyxDQUFDO1FBQzFELENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3ZDLE1BQU0sV0FBVyxHQUFHLHVCQUF1QixDQUFDLEtBQUssQ0FB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QUFFLEdBQUcsRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUVELE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBDZm5SZXNvdXJjZSwgQ3VzdG9tUmVzb3VyY2UsIER1cmF0aW9uLCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBQcm92aWRlciB9IGZyb20gXCJhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB9IGZyb20gXCIuL21pY3Jvdm0tbmV0d29yay1jb25uZWN0b3JcIjtcbmltcG9ydCB7IE1JQ1JPVk1fSU1BR0VfUFJVTkVfSEFORExFUl9TT1VSQ0UgfSBmcm9tIFwiLi9wcml2YXRlL21pY3Jvdm0taW1hZ2UtcHJ1bmUtaGFuZGxlclwiO1xuXG4vKipcbiAqIFJlZmVyZW5jZSB0byBhIExhbWJkYSBNaWNyb1ZNIGltYWdlIHVzYWJsZSBieSBNaWNyb1ZNIGNvbnRyb2xsZXIgY29uc3RydWN0cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBJQXBwVGhlb3J5TWljcm92bUltYWdlIHtcbiAgLyoqXG4gICAqIFRoZSBBUk4gb2YgdGhlIE1pY3JvVk0gaW1hZ2UuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5vcm1hbGl6ZWQgZGVwbG95bWVudC1vd25lZCBydW50aW1lIGxvZ2dpbmcgcG9zdHVyZSBmb3IgdGhpcyBpbWFnZS5cbiAgICpcbiAgICogQ29udHJvbGxlcnMgcHJvcGFnYXRlIHRoaXMgZXhhY3QgQ2xvdWRXYXRjaC1vci1kaXNhYmxlZCBjaG9pY2UgdG8gZXZlcnlcbiAgICogYFJ1bk1pY3Jvdm1gIHJlcXVlc3QuXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nO1xufVxuXG4vKipcbiAqIEFkZGl0aW9uYWwgT1MgY2FwYWJpbGl0aWVzIHN1cHBvcnRlZCBieSBMYW1iZGEgTWljcm9WTSBpbWFnZXMuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eSB7XG4gIC8qKlxuICAgKiBHcmFudHMgYWxsIGN1cnJlbnRseSBzdXBwb3J0ZWQgTWljcm9WTSBPUyBjYXBhYmlsaXRpZXMuXG4gICAqL1xuICBBTEwgPSBcIkFMTFwiLFxufVxuXG4vKipcbiAqIENQVSBhcmNoaXRlY3R1cmVzIHN1cHBvcnRlZCBieSBMYW1iZGEgTWljcm9WTSBpbWFnZXMuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZSB7XG4gIC8qKlxuICAgKiBBUk02NCBNaWNyb1ZNIGltYWdlIGFyY2hpdGVjdHVyZS5cbiAgICovXG4gIEFSTV82NCA9IFwiQVJNXzY0XCIsXG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2sgbW9kZSBmb3IgTGFtYmRhIE1pY3JvVk0gaW1hZ2UgaG9va3MuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZSB7XG4gIC8qKlxuICAgKiBEaXNhYmxlIHRoZSBsaWZlY3ljbGUgaG9vay5cbiAgICovXG4gIERJU0FCTEVEID0gXCJESVNBQkxFRFwiLFxuXG4gIC8qKlxuICAgKiBFbmFibGUgdGhlIGxpZmVjeWNsZSBob29rLlxuICAgKi9cbiAgRU5BQkxFRCA9IFwiRU5BQkxFRFwiLFxufVxuXG4vKipcbiAqIENvZGUgYXJ0aWZhY3QgbG9jYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0IHtcbiAgLyoqXG4gICAqIFRoZSBVUkkgb2YgdGhlIGNvZGUgYXJ0aWZhY3QsIHN1Y2ggYXMgYW4gQW1hem9uIFMzIHBhdGggb3IgQW1hem9uIEVDUiBpbWFnZSBVUkkuXG4gICAqL1xuICByZWFkb25seSB1cmk6IHN0cmluZztcbn1cblxuLyoqXG4gKiBDUFUgY29uZmlndXJhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVDb25maWd1cmF0aW9uIHtcbiAgLyoqXG4gICAqIFRoZSBDUFUgYXJjaGl0ZWN0dXJlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0XG4gICAqL1xuICByZWFkb25seSBhcmNoaXRlY3R1cmU/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmU7XG59XG5cbi8qKlxuICogRW52aXJvbm1lbnQgdmFyaWFibGUgZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlRW52aXJvbm1lbnRWYXJpYWJsZSB7XG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBrZXkuXG4gICAqL1xuICByZWFkb25seSBrZXk6IHN0cmluZztcblxuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGUgdmFsdWUuXG4gICAqL1xuICByZWFkb25seSB2YWx1ZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rcyBpbnZva2VkIGR1cmluZyBNaWNyb1ZNIGltYWdlIGJ1aWxkIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzIHtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJlYWR5IGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlYWR5PzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSByZWFkeSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZHlUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSB2YWxpZGF0ZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSB2YWxpZGF0ZT86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgdmFsaWRhdGUgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHZhbGlkYXRlVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9va3MgaW52b2tlZCBkdXJpbmcgTWljcm9WTSBldmVudHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bVJ1bnRpbWVIb29rcyB7XG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSByZXN1bWUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzdW1lPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSByZXN1bWUgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3VtZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJ1biBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSBydW4/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJ1biBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVuVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgc3VzcGVuZCBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSBzdXNwZW5kPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSBzdXNwZW5kIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSBzdXNwZW5kVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgdGVybWluYXRlIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHRlcm1pbmF0ZT86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgdGVybWluYXRlIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSB0ZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEhvb2sgY29uZmlndXJhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VIb29rcyB7XG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9va3MgZm9yIE1pY3JvVk0gZXZlbnRzLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUhvb2tzPzogQXBwVGhlb3J5TWljcm92bVJ1bnRpbWVIb29rcztcblxuICAvKipcbiAgICogTGlmZWN5Y2xlIGhvb2tzIGZvciBNaWNyb1ZNIGltYWdlIGJ1aWxkIGV2ZW50cy5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZUhvb2tzPzogQXBwVGhlb3J5TWljcm92bUltYWdlQnVpbGRIb29rcztcblxuICAvKipcbiAgICogVGhlIHBvcnQgbnVtYmVyIG9uIHdoaWNoIHRoZSBob29rcyBsaXN0ZW5lciBydW5zLlxuICAgKi9cbiAgcmVhZG9ubHkgcG9ydD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG91ZFdhdGNoIExvZ3MgY29uZmlndXJhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZSBsb2dnaW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nIHtcbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBDbG91ZFdhdGNoIExvZ3MgbG9nIGdyb3VwIHRvIHNlbmQgbG9ncyB0by5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ0dyb3VwPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgQ2xvdWRXYXRjaCBMb2dzIGxvZyBzdHJlYW0gd2l0aGluIHRoZSBsb2cgZ3JvdXAuXG4gICAqL1xuICByZWFkb25seSBsb2dTdHJlYW0/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogTG9nZ2luZyBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcge1xuICAvKipcbiAgICogQ29uZmlndXJhdGlvbiBmb3Igc2VuZGluZyBsb2dzIHRvIEFtYXpvbiBDbG91ZFdhdGNoIExvZ3MuXG4gICAqL1xuICByZWFkb25seSBjbG91ZFdhdGNoPzogQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmc7XG5cbiAgLyoqXG4gICAqIFNldCB0byB0cnVlIHRvIGRpc2FibGUgTWljcm9WTSBsb2dnaW5nLlxuICAgKi9cbiAgcmVhZG9ubHkgZGlzYWJsZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFJlc291cmNlIHJlcXVpcmVtZW50cyBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VSZXNvdXJjZXMge1xuICAvKipcbiAgICogVGhlIG1pbmltdW0gYW1vdW50IG9mIG1lbW9yeSBpbiBNaUIgdG8gYWxsb2NhdGUgdG8gdGhlIE1pY3JvVk0uXG4gICAqL1xuICByZWFkb25seSBtaW5pbXVtTWVtb3J5SW5NaUI6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlUHJvcHMge1xuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIE1pY3JvVk0gaW1hZ2UuXG4gICAqL1xuICByZWFkb25seSBuYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBkZXNjcmlwdGlvbiBvZiB0aGUgdmVyc2lvbi5cbiAgICovXG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBBUk4gb2YgdGhlIGJhc2UgTWljcm9WTSBpbWFnZSB1c2VkLlxuICAgKi9cbiAgcmVhZG9ubHkgYmFzZUltYWdlQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBzcGVjaWZpYyB2ZXJzaW9uIG9mIHRoZSBiYXNlIE1pY3JvVk0gaW1hZ2UuXG4gICAqL1xuICByZWFkb25seSBiYXNlSW1hZ2VWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBBUk4gb2YgdGhlIElBTSBidWlsZCByb2xlLlxuICAgKi9cbiAgcmVhZG9ubHkgYnVpbGRSb2xlQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjb2RlIGFydGlmYWN0IGZvciB0aGlzIHZlcnNpb24uXG4gICAqL1xuICByZWFkb25seSBjb2RlQXJ0aWZhY3Q6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNvZGVBcnRpZmFjdDtcblxuICAvKipcbiAgICogVGhlIGxpc3Qgb2YgZWdyZXNzIG5ldHdvcmsgY29ubmVjdG9ycyBhdmFpbGFibGUgdG8gdGhlIE1pY3JvVk0gYXQgcnVudGltZS5cbiAgICpcbiAgICogUGFzcyBgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JgIGluc3RhbmNlcyBvciBjb21wYXRpYmxlIGNvbm5lY3RvciByZWZlcmVuY2VzLlxuICAgKiBBdCBsZWFzdCBvbmUgY29ubmVjdG9yIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBhbmQgbm8gbW9yZSB0aGFuIDEwIG1heSBiZSBzdXBwbGllZC5cbiAgICovXG4gIHJlYWRvbmx5IGVncmVzc05ldHdvcmtDb25uZWN0b3JzOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXTtcblxuICAvKipcbiAgICogTGlmZWN5Y2xlIGhvb2sgY29uZmlndXJhdGlvbiBmb3IgTWljcm9WTXMgYW5kIE1pY3JvVk0gaW1hZ2VzLlxuICAgKlxuICAgKiBQYXNzIGFuIGVtcHR5IG9iamVjdCAoYHt9YCkgZm9yIEFwcFRoZW9yeSBlbmRwb2ludC1kaXNwYXRjaGVkIE1pY3JvVk0gaW1hZ2VzLlxuICAgKiBBcHBUaGVvcnkgdGhlbiBzeW50aGVzaXplcyBgSG9va3M6IHt9YCBzbyBMYW1iZGEgYnVpbGRzIHRoZSBpbWFnZSB3aXRob3V0XG4gICAqIEFXUy1pbnZva2VkIGxpZmVjeWNsZSBob29rcyBhbmQgcnVudGltZSB0cmFmZmljIGlzIGRlbGl2ZXJlZCB0aHJvdWdoIHRoZVxuICAgKiBNaWNyb1ZNIGVuZHBvaW50IG9uIHRoZSBkZWZhdWx0IHBvcnQgODA4MC4gSWYgYW55IGhvb2sgaXMgY29uZmlndXJlZCwgYHBvcnRgXG4gICAqIGlzIHJlcXVpcmVkIGJ5IEFXUyBhbmQgQXBwVGhlb3J5IHZhbGlkYXRlcyBpdCBmYWlsLWNsb3NlZC5cbiAgICovXG4gIHJlYWRvbmx5IGhvb2tzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VIb29rcztcblxuICAvKipcbiAgICogQ29uZmlndXJhdGlvbiBmb3IgTWljcm9WTSBsb2dnaW5nIG91dHB1dC5cbiAgICpcbiAgICogU3BlY2lmeSBleGFjdGx5IG9uZSBvZiBgY2xvdWRXYXRjaGAgb3IgYGRpc2FibGVkOiB0cnVlYC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSByZXNvdXJjZSByZXF1aXJlbWVudHMgZm9yIHRoZSBNaWNyb1ZNLlxuICAgKlxuICAgKiBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlIGN1cnJlbnRseSBhY2NlcHRzIGV4YWN0bHkgb25lIFJlc291cmNlcyBlbnRyeS5cbiAgICovXG4gIHJlYWRvbmx5IHJlc291cmNlczogQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgT1MgY2FwYWJpbGl0aWVzIGdyYW50ZWQgdG8gdGhlIE1pY3JvVk0gcnVudGltZSBlbnZpcm9ubWVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgW0FwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTExdXG4gICAqL1xuICByZWFkb25seSBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXTtcblxuICAvKipcbiAgICogVGhlIGxpc3Qgb2Ygc3VwcG9ydGVkIENQVSBjb25maWd1cmF0aW9ucyBmb3IgdGhlIE1pY3JvVk0uXG4gICAqXG4gICAqIEBkZWZhdWx0IFt7IGFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9XVxuICAgKi9cbiAgcmVhZG9ubHkgY3B1Q29uZmlndXJhdGlvbnM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVDb25maWd1cmF0aW9uW107XG5cbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlcyBzZXQgaW4gdGhlIE1pY3JvVk0gcnVudGltZSBlbnZpcm9ubWVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGVudmlyb25tZW50VmFyaWFibGVzPzogQXBwVGhlb3J5TWljcm92bUltYWdlRW52aXJvbm1lbnRWYXJpYWJsZVtdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIENsb3VkRm9ybWF0aW9uIHRhZ3MgdG8gYXBwbHkgdG8gdGhlIE1pY3JvVk0gaW1hZ2UuXG4gICAqL1xuICByZWFkb25seSB0YWdzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuLyoqXG4gKiBBcHBUaGVvcnkgQ0RLIGNvbnN0cnVjdCBmb3IgQVdTIExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBpbnRlbnRpb25hbGx5IGRlcGxveW1lbnQtb25seTogaXQgY3JlYXRlcyB0aGUgQ2xvdWRGb3JtYXRpb25cbiAqIGBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlYCByZXNvdXJjZSBmcm9tIGNhbGxlci1wcm92aWRlZCBjb2RlIGFydGlmYWN0LCBiYXNlIGltYWdlLFxuICogYnVpbGQgcm9sZSwgbGlmZWN5Y2xlIGhvb2tzLCBsb2dnaW5nIGNvbmZpZ3VyYXRpb24sIHJlc291cmNlIHJlcXVpcmVtZW50cywgYW5kXG4gKiBBcHBUaGVvcnkgTWljcm9WTSBuZXR3b3JrLWNvbm5lY3RvciByZWZlcmVuY2VzLiBSdW50aW1lIGNvbnRyb2xsZXIgYmVoYXZpb3Igc3RheXMgaW5cbiAqIHRoZSBBcHBUaGVvcnkgcnVudGltZSBjb250cmFjdC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBleHRlbmRzIENvbnN0cnVjdCBpbXBsZW1lbnRzIElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Uge1xuICAvKipcbiAgICogVGhlIHVuZGVybHlpbmcgQ2xvdWRGb3JtYXRpb24gTWljcm9WTSBpbWFnZSByZXNvdXJjZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2U6IENmblJlc291cmNlO1xuXG4gIC8qKlxuICAgKiBUaGUgTWljcm9WTSBpbWFnZSBuYW1lIHJldHVybmVkIGJ5IFJlZi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VOYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBBUk4gb2YgdGhlIE1pY3JvVk0gaW1hZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBub3JtYWxpemVkIGRlcGxveW1lbnQtb3duZWQgcnVudGltZSBsb2dnaW5nIHBvc3R1cmUgZm9yIHRoaXMgaW1hZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZztcblxuICAvKipcbiAgICogVGhlIGN1cnJlbnQgaW1hZ2Ugc3RhdGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlU3RhdGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxhdGVzdCBhY3RpdmUgaW1hZ2UgdmVyc2lvbi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsYXRlc3RBY3RpdmVJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxhdGVzdCBmYWlsZWQgaW1hZ2UgdmVyc2lvbiwgaWYgYW55LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxhdGVzdEZhaWxlZEltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGltZXN0YW1wIHdoZW4gdGhlIGltYWdlIHdhcyBjcmVhdGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNyZWF0ZWRBdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGltZXN0YW1wIHdoZW4gdGhlIGltYWdlIHdhcyBsYXN0IHVwZGF0ZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdXBkYXRlZEF0OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHNcIik7XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG5vcm1hbGl6ZU5hbWUocHJvcHMubmFtZSk7XG4gICAgY29uc3QgZGVzY3JpcHRpb24gPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhwcm9wcy5kZXNjcmlwdGlvbiwgXCJkZXNjcmlwdGlvblwiKTtcbiAgICBjb25zdCBiYXNlSW1hZ2VBcm4gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMuYmFzZUltYWdlQXJuLCBcImJhc2VJbWFnZUFyblwiLCAyMDQ4KTtcbiAgICBjb25zdCBiYXNlSW1hZ2VWZXJzaW9uID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLmJhc2VJbWFnZVZlcnNpb24sIFwiYmFzZUltYWdlVmVyc2lvblwiLCAyMDQ4KTtcbiAgICBjb25zdCBidWlsZFJvbGVBcm4gPSBub3JtYWxpemVCdWlsZFJvbGVBcm4ocHJvcHMuYnVpbGRSb2xlQXJuKTtcbiAgICBjb25zdCBjb2RlQXJ0aWZhY3QgPSByZW5kZXJDb2RlQXJ0aWZhY3QocHJvcHMuY29kZUFydGlmYWN0KTtcbiAgICBjb25zdCBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMocHJvcHMuZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMpO1xuICAgIGNvbnN0IGhvb2tzID0gcmVuZGVySG9va3MocHJvcHMuaG9va3MpO1xuICAgIGNvbnN0IGxvZ2dpbmcgPSBub3JtYWxpemVMb2dnaW5nKHByb3BzLmxvZ2dpbmcpO1xuICAgIGNvbnN0IHJlc291cmNlcyA9IHJlbmRlclJlc291cmNlcyhwcm9wcy5yZXNvdXJjZXMpO1xuICAgIGNvbnN0IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyA9IG5vcm1hbGl6ZUFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyhwcm9wcy5hZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMpO1xuICAgIGNvbnN0IGNwdUNvbmZpZ3VyYXRpb25zID0gcmVuZGVyQ3B1Q29uZmlndXJhdGlvbnMocHJvcHMuY3B1Q29uZmlndXJhdGlvbnMpO1xuICAgIGNvbnN0IGVudmlyb25tZW50VmFyaWFibGVzID0gcmVuZGVyRW52aXJvbm1lbnRWYXJpYWJsZXMocHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMpO1xuXG4gICAgY29uc3QgcmVuZGVyZWRJbWFnZVByb3BlcnRpZXMgPSB7XG4gICAgICBBZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXM6IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyxcbiAgICAgIEJhc2VJbWFnZUFybjogYmFzZUltYWdlQXJuLFxuICAgICAgQmFzZUltYWdlVmVyc2lvbjogYmFzZUltYWdlVmVyc2lvbixcbiAgICAgIEJ1aWxkUm9sZUFybjogYnVpbGRSb2xlQXJuLFxuICAgICAgQ29kZUFydGlmYWN0OiBjb2RlQXJ0aWZhY3QsXG4gICAgICBDcHVDb25maWd1cmF0aW9uczogY3B1Q29uZmlndXJhdGlvbnMsXG4gICAgICBEZXNjcmlwdGlvbjogZGVzY3JpcHRpb24sXG4gICAgICBFZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMsXG4gICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczogZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgICBIb29rczogaG9va3MsXG4gICAgICBMb2dnaW5nOiByZW5kZXJMb2dnaW5nKGxvZ2dpbmcpLFxuICAgICAgTmFtZTogbmFtZSxcbiAgICAgIFJlc291cmNlczogcmVzb3VyY2VzLFxuICAgICAgVGFnczogcmVuZGVyVGFncyhwcm9wcy50YWdzKSxcbiAgICB9O1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2UgPSBuZXcgQ2ZuUmVzb3VyY2UodGhpcywgXCJNaWNyb3ZtSW1hZ2VcIiwge1xuICAgICAgdHlwZTogXCJBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlXCIsXG4gICAgICBwcm9wZXJ0aWVzOiByZW5kZXJlZEltYWdlUHJvcGVydGllcyxcbiAgICB9KTtcblxuICAgIHRoaXMubWljcm92bUltYWdlTmFtZSA9IHRoaXMubWljcm92bUltYWdlLnJlZjtcbiAgICB0aGlzLm1pY3Jvdm1JbWFnZUFybiA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkltYWdlQXJuXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5sb2dnaW5nID0gbG9nZ2luZztcbiAgICB0aGlzLm1pY3Jvdm1JbWFnZVN0YXRlID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiU3RhdGVcIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvbiA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiTGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5jcmVhdGVkQXQgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJDcmVhdGVkQXRcIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLnVwZGF0ZWRBdCA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIlVwZGF0ZWRBdFwiKS50b1N0cmluZygpO1xuXG4gICAgdGhpcy53aXJlVmVyc2lvblBydW5pbmcocmVuZGVyZWRJbWFnZVByb3BlcnRpZXMsIG5hbWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIFdpcmVzIHRoZSBhbHdheXMtb24gdmVyc2lvbi1wcnVuaW5nIGN1c3RvbSByZXNvdXJjZS5cbiAgICpcbiAgICogRXZlcnkgQ2xvdWRGb3JtYXRpb24gY3JlYXRlL3VwZGF0ZSB0aGF0IHRvdWNoZXMgdGhlIGltYWdlIOKAlCBzaWduYWxlZCBieSBhXG4gICAqIGNoYW5nZSB0byB0aGUgbWlycm9yZWQgaW1hZ2UgcHJvcGVydGllcyDigJQgcnVucyB0aGUgcHJ1bmUgaGFuZGxlciBCRUZPUkUgdGhlXG4gICAqIGBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlYCB1cGRhdGUgY3JlYXRlcyBhIG5ldyB2ZXJzaW9uOiB0aGUgaW1hZ2UgcmVzb3VyY2VcbiAgICogY2FycmllcyBhbiBleHBsaWNpdCBgRGVwZW5kc09uYCBvbiB0aGUgcHJ1bmUgY3VzdG9tIHJlc291cmNlIHNvIENsb3VkRm9ybWF0aW9uXG4gICAqIG9yZGVycyB0aGUgcHJ1bmUgZmlyc3QuIEEgbGlzdC9kZXNjcmliZSBmYWlsdXJlIGZhaWxzIHRoZSBkZXBsb3ltZW50IGxvdWRseTtcbiAgICogYSBwZXItdmVyc2lvbiBkZWxldGUgcmVmdXNhbCBpcyBsb2dnZWQgYW5kIHNraXBwZWQuIE9uIHN0YWNrIERFTEVURSB0aGVcbiAgICogaGFuZGxlciByZXR1cm5zIHN1Y2Nlc3Mgd2l0aG91dCBwcnVuaW5nIGJlY2F1c2UgQ2xvdWRGb3JtYXRpb24gZGVsZXRlcyB0aGVcbiAgICogd2hvbGUgaW1hZ2UuIFRoZXJlIGFyZSBubyBkZXBsb3ktdGltZSBrbm9iczogcHJ1bmluZyBpcyBhbHdheXMtb24gZW5jb2RlZFxuICAgKiBiZWhhdmlvci5cbiAgICpcbiAgICogVGhlIGhhbmRsZXIgZW52IGFuZCBJQU0gcG9saWN5IHJlZmVyZW5jZSB0aGUgaW1hZ2UgQVJOIGNvbnN0cnVjdGVkIGZyb21cbiAgICogcHNldWRvLXBhcmFtZXRlcnMgKGBTdGFjay5mb3JtYXRBcm5gKSByYXRoZXIgdGhhbiBmcm9tIGBJbWFnZUFybmAgR2V0QXR0OlxuICAgKiB0aGUgaGFuZGxlciBmdW5jdGlvbiBpcyBkb3duc3RyZWFtIG9mIHRoZSBwcnVuZSBjdXN0b20gcmVzb3VyY2UsIHNvIGFcbiAgICogR2V0QXR0LWJhc2VkIHJlZmVyZW5jZSB3b3VsZCBtYWtlIHRoZSBoYW5kbGVyIGRlcGVuZCBvbiB0aGUgaW1hZ2UgYW5kIGNsb3NlXG4gICAqIGEgQ2xvdWRGb3JtYXRpb24gZGVwZW5kZW5jeSBjeWNsZSAoaW1hZ2Ug4oaSIHBydW5lIOKGkiBoYW5kbGVyIOKGkiBpbWFnZSkuXG4gICAqL1xuICBwcml2YXRlIHdpcmVWZXJzaW9uUHJ1bmluZyhyZW5kZXJlZEltYWdlUHJvcGVydGllczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGltYWdlTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcHJ1bmVJbWFnZUFybiA9IFN0YWNrLm9mKHRoaXMpLmZvcm1hdEFybih7XG4gICAgICBzZXJ2aWNlOiBcImxhbWJkYVwiLFxuICAgICAgcmVzb3VyY2U6IFwibWljcm92bS1pbWFnZVwiLFxuICAgICAgcmVzb3VyY2VOYW1lOiBpbWFnZU5hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBwcnVuZUhhbmRsZXIgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiTWljcm92bUltYWdlUHJ1bmVIYW5kbGVyXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yNF9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKE1JQ1JPVk1fSU1BR0VfUFJVTkVfSEFORExFUl9TT1VSQ0UpLFxuICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX0FSTjogcHJ1bmVJbWFnZUFybixcbiAgICAgICAgQVBQVEhFT1JZX01JQ1JPVk1fSU1BR0VfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTGVhc3QgcHJpdmlsZWdlOiBleGFjdGx5IHRoZSB0d28gbWljcm92bSBsaXN0L2RlbGV0ZSBhY3Rpb25zIG9uIHRoaXNcbiAgICAvLyBpbWFnZSBBUk4gYW5kIG5vdGhpbmcgZWxzZS4gTm8gd2lsZGNhcmQgc2VydmljZSBwZXJtaXNzaW9ucy5cbiAgICBwcnVuZUhhbmRsZXIuYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6TGlzdE1pY3Jvdm1JbWFnZVZlcnNpb25zXCIsIFwibGFtYmRhOkRlbGV0ZU1pY3Jvdm1JbWFnZVZlcnNpb25cIl0sXG4gICAgICAgIHJlc291cmNlczogW3BydW5lSW1hZ2VBcm5dLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IHBydW5lUHJvdmlkZXIgPSBuZXcgUHJvdmlkZXIodGhpcywgXCJNaWNyb3ZtSW1hZ2VQcnVuZVByb3ZpZGVyXCIsIHtcbiAgICAgIG9uRXZlbnRIYW5kbGVyOiBwcnVuZUhhbmRsZXIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBwcnVuZSA9IG5ldyBDdXN0b21SZXNvdXJjZSh0aGlzLCBcIk1pY3Jvdm1JbWFnZVBydW5lXCIsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogcHJ1bmVQcm92aWRlci5zZXJ2aWNlVG9rZW4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIC8vIE1pcnJvcnMgdGhlIGltYWdlJ3MgcmVuZGVyZWQgcHJvcGVydGllcyBzbyB0aGUgcHJ1bmUgY3VzdG9tIHJlc291cmNlXG4gICAgICAgIC8vIGlzIHJlLWludm9rZWQgZXhhY3RseSB3aGVuIHRoZSBpbWFnZSByZXNvdXJjZSBpdHNlbGYgd291bGQgYmUgdXBkYXRlZFxuICAgICAgICAvLyBieSBDbG91ZEZvcm1hdGlvbi4gVGhlIHBydW5lIGhhbmRsZXIgcmVhZHMgdGhlIGltYWdlIEFSTiBmcm9tIGl0cyBvd25cbiAgICAgICAgLy8gZW52aXJvbm1lbnQgcmF0aGVyIHRoYW4gZnJvbSB0aGVzZSBwcm9wZXJ0aWVzLCBzbyB0aGUgY3VzdG9tIHJlc291cmNlXG4gICAgICAgIC8vIG5ldmVyIGNyZWF0ZXMgYW4gaW1wbGljaXQgZGVwZW5kZW5jeSB0aGF0IHdvdWxkIHJldmVyc2UgdGhlIG9yZGVyaW5nLlxuICAgICAgICBNaWNyb3ZtSW1hZ2VQcm9wZXJ0aWVzOiByZW5kZXJlZEltYWdlUHJvcGVydGllcyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZS5ub2RlLmFkZERlcGVuZGVuY3kocHJ1bmUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5hbWUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5hbWUgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJuYW1lXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW0EtWmEtejAtOV8tXXsxLDY0fSQvLnRlc3QobmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbmFtZSBtdXN0IGJlIDEtNjQgY2hhcmFjdGVycyB1c2luZyBsZXR0ZXJzLCBudW1iZXJzLCBoeXBoZW5zLCBvciB1bmRlcnNjb3Jlc1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5hbWU7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSkudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIHByb3BOYW1lKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIC9cXHMvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYXQgbW9zdCAke21heExlbmd0aH0gY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCdWlsZFJvbGVBcm4odmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGNvbnN0IGFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZSwgXCJidWlsZFJvbGVBcm5cIiwgMjA0OCk7XG4gIGlmIChcbiAgICAhVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJlxuICAgICEvXmFybjphd3NbYS16QS1aLV0qOmlhbTo6XFxkezEyfTpyb2xlXFwvP1thLXpBLVpfMC05Kz0sLkBcXC1fL10rJC8udGVzdChhcm4pXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogYnVpbGRSb2xlQXJuIG11c3QgYmUgYW4gSUFNIHJvbGUgQVJOXCIpO1xuICB9XG4gIHJldHVybiBhcm47XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGVBcnRpZmFjdChcbiAgY29kZUFydGlmYWN0OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3QgfCB1bmRlZmluZWQsXG4pOiB7IFVyaTogc3RyaW5nIH0ge1xuICBpZiAoY29kZUFydGlmYWN0ID09PSB1bmRlZmluZWQgfHwgY29kZUFydGlmYWN0ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmNvZGVBcnRpZmFjdFwiKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIFVyaTogbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGNvZGVBcnRpZmFjdC51cmksIFwiY29kZUFydGlmYWN0LnVyaVwiLCAyMDQ4KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgY29ubmVjdG9yczogcmVhZG9ubHkgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW10gfCB1bmRlZmluZWQsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghY29ubmVjdG9ycyB8fCBjb25uZWN0b3JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGVncmVzc05ldHdvcmtDb25uZWN0b3JzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGF0IG1vc3QgMTAgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgZW50cmllc1wiKTtcbiAgfVxuXG4gIGNvbnN0IGFybnMgPSBjb25uZWN0b3JzLm1hcCgoY29ubmVjdG9yLCBpbmRleCkgPT4ge1xuICAgIGlmIChjb25uZWN0b3IgPT09IHVuZGVmaW5lZCB8fCBjb25uZWN0b3IgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBhcm4gPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhcbiAgICAgIGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yQXJuLFxuICAgICAgYGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuYCxcbiAgICApO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGFybikgJiYgL1xccy8udGVzdChhcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuIG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYXJuO1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgXCJlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXSxcbik6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdIHtcbiAgY29uc3QgY2FwYWJpbGl0aWVzID0gdmFsdWVzID8/IFtBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMXTtcbiAgaWYgKGNhcGFiaWxpdGllcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMgZW50cnlcIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhcGFiaWxpdGllcy5tYXAoKGNhcGFiaWxpdHksIGluZGV4KSA9PiB7XG4gICAgaWYgKFN0cmluZyhjYXBhYmlsaXR5KS50cmltKCkudG9VcHBlckNhc2UoKSAhPT0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllc1ske2luZGV4fV0gbXVzdCBiZSBBTExgKTtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTEw7XG4gIH0pO1xuICBhc3NlcnROb0R1cGxpY2F0ZXMobm9ybWFsaXplZCwgXCJhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXNcIik7XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDcHVDb25maWd1cmF0aW9ucyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbltdLFxuKTogQXJyYXk8eyBBcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZSB9PiB7XG4gIGNvbnN0IGNwdUNvbmZpZ3VyYXRpb25zID0gdmFsdWVzID8/IFt7IGFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9XTtcbiAgaWYgKGNwdUNvbmZpZ3VyYXRpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGNwdUNvbmZpZ3VyYXRpb25zIGVudHJ5XCIpO1xuICB9XG4gIHJldHVybiBjcHVDb25maWd1cmF0aW9ucy5tYXAoKGNwdSwgaW5kZXgpID0+IHtcbiAgICBpZiAoY3B1ID09PSB1bmRlZmluZWQgfHwgY3B1ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5jcHVDb25maWd1cmF0aW9uc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3QgYXJjaGl0ZWN0dXJlID0gU3RyaW5nKGNwdS5hcmNoaXRlY3R1cmUgPz8gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NClcbiAgICAgIC50cmltKClcbiAgICAgIC50b1VwcGVyQ2FzZSgpO1xuICAgIGlmIChhcmNoaXRlY3R1cmUgIT09IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBjcHVDb25maWd1cmF0aW9uc1ske2luZGV4fV0uYXJjaGl0ZWN0dXJlIG11c3QgYmUgQVJNXzY0YCk7XG4gICAgfVxuICAgIHJldHVybiB7IEFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9O1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRW52aXJvbm1lbnRWYXJpYWJsZXMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGVbXSxcbik6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4ge1xuICBpZiAoKHZhbHVlcz8ubGVuZ3RoID8/IDApID4gNTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgYXQgbW9zdCA1MCBlbnZpcm9ubWVudFZhcmlhYmxlcyBlbnRyaWVzXCIpO1xuICB9XG5cbiAgY29uc3QgcmVuZGVyZWQgPSAodmFsdWVzID8/IFtdKS5tYXAoKGVudHJ5LCBpbmRleCkgPT4ge1xuICAgIGlmIChlbnRyeSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGVudHJ5LmtleSwgYGVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS5rZXlgLCAyNTYpO1xuICAgIGNvbnN0IHZhbHVlID0gZW50cnkudmFsdWUgPT09IHVuZGVmaW5lZCB8fCBlbnRyeS52YWx1ZSA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IFN0cmluZyhlbnRyeS52YWx1ZSk7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS52YWx1ZWApO1xuICAgIH1cbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgdmFsdWUubGVuZ3RoID4gNDA5Nikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS52YWx1ZSBtdXN0IGJlIGF0IG1vc3QgNDA5NiBjaGFyYWN0ZXJzYCk7XG4gICAgfVxuICAgIHJldHVybiB7IEtleToga2V5LCBWYWx1ZTogdmFsdWUgfTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKFxuICAgIHJlbmRlcmVkLm1hcCgoZW50cnkpID0+IGVudHJ5LktleSksXG4gICAgXCJlbnZpcm9ubWVudFZhcmlhYmxlcyBrZXlcIixcbiAgKTtcbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJIb29rcyhob29rczogQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3MgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkIHx8IGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzXCIpO1xuICB9XG5cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGNvbnN0IG1pY3Jvdm1Ib29rcyA9IHJlbmRlclJ1bnRpbWVIb29rcyhob29rcy5taWNyb3ZtSG9va3MpO1xuICBpZiAobWljcm92bUhvb2tzKSB7XG4gICAgcmVuZGVyZWQuTWljcm92bUhvb2tzID0gbWljcm92bUhvb2tzO1xuICB9XG4gIGNvbnN0IG1pY3Jvdm1JbWFnZUhvb2tzID0gcmVuZGVySW1hZ2VIb29rcyhob29rcy5taWNyb3ZtSW1hZ2VIb29rcyk7XG4gIGlmIChtaWNyb3ZtSW1hZ2VIb29rcykge1xuICAgIHJlbmRlcmVkLk1pY3Jvdm1JbWFnZUhvb2tzID0gbWljcm92bUltYWdlSG9va3M7XG4gIH1cbiAgY29uc3QgaGFzSG9va0dyb3VwID0gQm9vbGVhbihyZW5kZXJlZC5NaWNyb3ZtSG9va3MgfHwgcmVuZGVyZWQuTWljcm92bUltYWdlSG9va3MpO1xuICBpZiAoaGFzSG9va0dyb3VwICYmIGhvb2tzLnBvcnQgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBob29rcy5wb3J0IGlzIHJlcXVpcmVkIHdoZW4gcHJvcHMuaG9va3MubWljcm92bUhvb2tzIG9yIHByb3BzLmhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzIGlzIGNvbmZpZ3VyZWRcIixcbiAgICApO1xuICB9XG4gIGlmIChob29rcy5wb3J0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIWhhc0hvb2tHcm91cCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogaG9va3MucG9ydCByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSG9va3Mgb3IgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3NcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJlbmRlcmVkLlBvcnQgPSBub3JtYWxpemVJbnRlZ2VySW5SYW5nZShob29rcy5wb3J0LCBcImhvb2tzLnBvcnRcIiwgMSwgNjU1MzUpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUnVudGltZUhvb2tzKGhvb2tzPzogQXBwVGhlb3J5TWljcm92bVJ1bnRpbWVIb29rcyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkIHtcbiAgaWYgKGhvb2tzID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChob29rcyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSG9va3NcIik7XG4gIH1cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJlc3VtZVwiLCBob29rcy5yZXN1bWUsIFwiaG9va3MubWljcm92bUhvb2tzLnJlc3VtZVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiUmVzdW1lVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnJlc3VtZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3MucmVzdW1lVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJ1blwiLCBob29rcy5ydW4sIFwiaG9va3MubWljcm92bUhvb2tzLnJ1blwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiUnVuVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnJ1blRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3MucnVuVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlN1c3BlbmRcIiwgaG9va3Muc3VzcGVuZCwgXCJob29rcy5taWNyb3ZtSG9va3Muc3VzcGVuZFwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiU3VzcGVuZFRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5zdXNwZW5kVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy5zdXNwZW5kVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlRlcm1pbmF0ZVwiLCBob29rcy50ZXJtaW5hdGUsIFwiaG9va3MubWljcm92bUhvb2tzLnRlcm1pbmF0ZVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiVGVybWluYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3MudGVybWluYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIGlmIChPYmplY3Qua2V5cyhyZW5kZXJlZCkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgaG9va3MubWljcm92bUhvb2tzIHNldHRpbmdcIik7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJJbWFnZUhvb2tzKGhvb2tzPzogQXBwVGhlb3J5TWljcm92bUltYWdlQnVpbGRIb29rcyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkIHtcbiAgaWYgKGhvb2tzID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChob29rcyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSW1hZ2VIb29rc1wiKTtcbiAgfVxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiUmVhZHlcIiwgaG9va3MucmVhZHksIFwiaG9va3MubWljcm92bUltYWdlSG9va3MucmVhZHlcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJlYWR5VGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnJlYWR5VGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnJlYWR5VGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgMzYwMCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiVmFsaWRhdGVcIiwgaG9va3MudmFsaWRhdGUsIFwiaG9va3MubWljcm92bUltYWdlSG9va3MudmFsaWRhdGVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlZhbGlkYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnZhbGlkYXRlVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnZhbGlkYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgMzYwMCxcbiAgKTtcbiAgaWYgKE9iamVjdC5rZXlzKHJlbmRlcmVkKS5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBob29rcy5taWNyb3ZtSW1hZ2VIb29rcyBzZXR0aW5nXCIpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gc2V0SG9va01vZGUoXG4gIHRhcmdldDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIGtleTogc3RyaW5nLFxuICBtb2RlOiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKG1vZGUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKG1vZGUpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICBpZiAobm9ybWFsaXplZCAhPT0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlLkVOQUJMRUQgJiYgbm9ybWFsaXplZCAhPT0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlLkRJU0FCTEVEKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgRU5BQkxFRCBvciBESVNBQkxFRGApO1xuICB9XG4gIHRhcmdldFtrZXldID0gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICB0YXJnZXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBrZXk6IHN0cmluZyxcbiAgdmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgbWluOiBudW1iZXIsXG4gIG1heDogbnVtYmVyLFxuKTogdm9pZCB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRhcmdldFtrZXldID0gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UodmFsdWUsIHByb3BOYW1lLCBtaW4sIG1heCk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvZ2dpbmcobG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB8IHVuZGVmaW5lZCk6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMubG9nZ2luZ1wiKTtcbiAgfVxuICBjb25zdCBoYXNDbG91ZFdhdGNoID0gbG9nZ2luZy5jbG91ZFdhdGNoICE9PSB1bmRlZmluZWQgJiYgbG9nZ2luZy5jbG91ZFdhdGNoICE9PSBudWxsO1xuICBjb25zdCBoYXNEaXNhYmxlZCA9IGxvZ2dpbmcuZGlzYWJsZWQgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0Nsb3VkV2F0Y2ggPT09IGhhc0Rpc2FibGVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nIG11c3Qgc3BlY2lmeSBleGFjdGx5IG9uZSBvZiBjbG91ZFdhdGNoIG9yIGRpc2FibGVkXCIpO1xuICB9XG4gIGlmIChoYXNEaXNhYmxlZCkge1xuICAgIGlmIChsb2dnaW5nLmRpc2FibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcuZGlzYWJsZWQgbXVzdCBiZSB0cnVlIHdoZW4gcHJvdmlkZWRcIik7XG4gICAgfVxuICAgIHJldHVybiB7IGRpc2FibGVkOiB0cnVlIH07XG4gIH1cbiAgcmV0dXJuIHsgY2xvdWRXYXRjaDogbm9ybWFsaXplQ2xvdWRXYXRjaExvZ2dpbmcobG9nZ2luZy5jbG91ZFdhdGNoKSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDbG91ZFdhdGNoTG9nZ2luZyhcbiAgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcgfCB1bmRlZmluZWQsXG4pOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZyB7XG4gIGlmIChsb2dnaW5nID09PSB1bmRlZmluZWQgfHwgbG9nZ2luZyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5sb2dnaW5nLmNsb3VkV2F0Y2hcIik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICAuLi4obG9nZ2luZy5sb2dHcm91cCAhPT0gdW5kZWZpbmVkID8geyBsb2dHcm91cDogbm9ybWFsaXplTG9nR3JvdXAobG9nZ2luZy5sb2dHcm91cCkgfSA6IHt9KSxcbiAgICAuLi4obG9nZ2luZy5sb2dTdHJlYW0gIT09IHVuZGVmaW5lZCA/IHsgbG9nU3RyZWFtOiBub3JtYWxpemVMb2dTdHJlYW0obG9nZ2luZy5sb2dTdHJlYW0pIH0gOiB7fSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlckxvZ2dpbmcobG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgaWYgKGxvZ2dpbmcuY2xvdWRXYXRjaCkge1xuICAgIHJldHVybiB7XG4gICAgICBDbG91ZFdhdGNoOiB7XG4gICAgICAgIC4uLihsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXAgIT09IHVuZGVmaW5lZCA/IHsgTG9nR3JvdXA6IGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cCB9IDoge30pLFxuICAgICAgICAuLi4obG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbSAhPT0gdW5kZWZpbmVkID8geyBMb2dTdHJlYW06IGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gfSA6IHt9KSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBEaXNhYmxlZDogdHJ1ZSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dHcm91cCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcImxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cFwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICEvXlthLXpBLVowLTlfXFwtLy4jXXsxLDUxMn0kLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXAgaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIik7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvZ1N0cmVhbSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcImxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW1cIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAoIS9eW146Kl0qJC8udGVzdChub3JtYWxpemVkKSB8fCBub3JtYWxpemVkLmxlbmd0aCA+IDUxMikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIik7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlc291cmNlcyhcbiAgcmVzb3VyY2VzOiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VSZXNvdXJjZXNbXSB8IHVuZGVmaW5lZCxcbik6IEFycmF5PHsgTWluaW11bU1lbW9yeUluTWlCOiBudW1iZXIgfT4ge1xuICBpZiAoIXJlc291cmNlcyB8fCByZXNvdXJjZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGV4YWN0bHkgMSByZXNvdXJjZXMgZW50cnlcIik7XG4gIH1cbiAgaWYgKHJlc291cmNlcy5sZW5ndGggPiAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGV4YWN0bHkgMSByZXNvdXJjZXMgZW50cnlcIik7XG4gIH1cbiAgY29uc3QgcmVzb3VyY2UgPSByZXNvdXJjZXNbMF07XG4gIGlmIChyZXNvdXJjZSA9PT0gdW5kZWZpbmVkIHx8IHJlc291cmNlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLnJlc291cmNlc1swXVwiKTtcbiAgfVxuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIE1pbmltdW1NZW1vcnlJbk1pQjogbm9ybWFsaXplUG9zaXRpdmVJbnRlZ2VyKHJlc291cmNlLm1pbmltdW1NZW1vcnlJbk1pQiwgXCJyZXNvdXJjZXNbMF0ubWluaW11bU1lbW9yeUluTWlCXCIpLFxuICAgIH0sXG4gIF07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogbnVtYmVyIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPCAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyYCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVJbnRlZ2VySW5SYW5nZSh2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgbWluIHx8IHZhbHVlID4gbWF4KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYW4gaW50ZWdlciBmcm9tICR7bWlufSB0byAke21heH1gKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vRHVwbGljYXRlcyh2YWx1ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWVuLmhhcyh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIGRvZXMgbm90IGFsbG93IGR1cGxpY2F0ZSAke2xhYmVsfSB2YWx1ZXNgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlbmRlclRhZ3ModGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+IHtcbiAgY29uc3QgcmVuZGVyZWQ6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4gPSBbXG4gICAgeyBLZXk6IFwiRnJhbWV3b3JrXCIsIFZhbHVlOiBcIkFwcFRoZW9yeVwiIH0sXG4gICAgeyBLZXk6IFwiQ29tcG9uZW50XCIsIFZhbHVlOiBcIk1pY3Jvdm1JbWFnZVwiIH0sXG4gIF07XG5cbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModGFncyA/PyB7fSkuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICBjb25zdCBub3JtYWxpemVkS2V5ID0ga2V5LnRyaW0oKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWRLZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogdGFnIGtleXMgY2Fubm90IGJlIGVtcHR5XCIpO1xuICAgIH1cbiAgICByZW5kZXJlZC5wdXNoKHsgS2V5OiBub3JtYWxpemVkS2V5LCBWYWx1ZTogdmFsdWUgfSk7XG4gIH1cblxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG4iXX0=