"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMicrovmImage = exports.AppTheoryMicrovmHookMode = exports.AppTheoryMicrovmImageCpuArchitecture = exports.AppTheoryMicrovmImageOsCapability = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const constructs_1 = require("constructs");
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
        this.microvmImage = new aws_cdk_lib_1.CfnResource(this, "MicrovmImage", {
            type: "AWS::Lambda::MicrovmImage",
            properties: {
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
            },
        });
        this.microvmImageName = this.microvmImage.ref;
        this.microvmImageArn = this.microvmImage.getAtt("ImageArn").toString();
        this.logging = logging;
        this.microvmImageState = this.microvmImage.getAtt("State").toString();
        this.latestActiveImageVersion = this.microvmImage.getAtt("LatestActiveImageVersion").toString();
        this.latestFailedImageVersion = this.microvmImage.getAtt("LatestFailedImageVersion").toString();
        this.createdAt = this.microvmImage.getAtt("CreatedAt").toString();
        this.updatedAt = this.microvmImage.getAtt("UpdatedAt").toString();
    }
}
exports.AppTheoryMicrovmImage = AppTheoryMicrovmImage;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "1.17.1" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBaUQ7QUFDakQsMkNBQXVDO0FBc0J2Qzs7R0FFRztBQUNILElBQVksaUNBS1g7QUFMRCxXQUFZLGlDQUFpQztJQUMzQzs7T0FFRztJQUNILGdEQUFXLENBQUE7QUFDYixDQUFDLEVBTFcsaUNBQWlDLGlEQUFqQyxpQ0FBaUMsUUFLNUM7QUFFRDs7R0FFRztBQUNILElBQVksb0NBS1g7QUFMRCxXQUFZLG9DQUFvQztJQUM5Qzs7T0FFRztJQUNILHlEQUFpQixDQUFBO0FBQ25CLENBQUMsRUFMVyxvQ0FBb0Msb0RBQXBDLG9DQUFvQyxRQUsvQztBQUVEOztHQUVHO0FBQ0gsSUFBWSx3QkFVWDtBQVZELFdBQVksd0JBQXdCO0lBQ2xDOztPQUVHO0lBQ0gsaURBQXFCLENBQUE7SUFFckI7O09BRUc7SUFDSCwrQ0FBbUIsQ0FBQTtBQUNyQixDQUFDLEVBVlcsd0JBQXdCLHdDQUF4Qix3QkFBd0IsUUFVbkM7QUF1UUQ7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFhLHFCQUFzQixTQUFRLHNCQUFTO0lBOENsRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWlDO1FBQ3pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUMxQyxNQUFNLElBQUksS0FBSyxDQUFDLHNDQUFzQyxDQUFDLENBQUM7UUFDMUQsQ0FBQztRQUVELE1BQU0sSUFBSSxHQUFHLGFBQWEsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDdkMsTUFBTSxXQUFXLEdBQUcsdUJBQXVCLENBQUMsS0FBSyxDQUFDLFdBQVcsRUFBRSxhQUFhLENBQUMsQ0FBQztRQUM5RSxNQUFNLFlBQVksR0FBRywyQkFB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QUNILENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxJQUE2QjtJQUMvQyxNQUFNLFFBQVEsR0FBMEM7UUFDdEQsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxXQUFXLEVBQUU7UUFDeEMsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxjQUFjLEVBQUU7S0FDNUMsQ0FBQztJQUVGLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQzdGLE1BQU0sYUFBYSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNqQyxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDbkIsTUFBTSxJQUFJLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFDRCxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUN0RCxDQUFDO0lBRUQsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmblJlc291cmNlLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IgfSBmcm9tIFwiLi9taWNyb3ZtLW5ldHdvcmstY29ubmVjdG9yXCI7XG5cbi8qKlxuICogUmVmZXJlbmNlIHRvIGEgTGFtYmRhIE1pY3JvVk0gaW1hZ2UgdXNhYmxlIGJ5IE1pY3JvVk0gY29udHJvbGxlciBjb25zdHJ1Y3RzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Uge1xuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbm9ybWFsaXplZCBkZXBsb3ltZW50LW93bmVkIHJ1bnRpbWUgbG9nZ2luZyBwb3N0dXJlIGZvciB0aGlzIGltYWdlLlxuICAgKlxuICAgKiBDb250cm9sbGVycyBwcm9wYWdhdGUgdGhpcyBleGFjdCBDbG91ZFdhdGNoLW9yLWRpc2FibGVkIGNob2ljZSB0byBldmVyeVxuICAgKiBgUnVuTWljcm92bWAgcmVxdWVzdC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmc7XG59XG5cbi8qKlxuICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5IHtcbiAgLyoqXG4gICAqIEdyYW50cyBhbGwgY3VycmVudGx5IHN1cHBvcnRlZCBNaWNyb1ZNIE9TIGNhcGFiaWxpdGllcy5cbiAgICovXG4gIEFMTCA9IFwiQUxMXCIsXG59XG5cbi8qKlxuICogQ1BVIGFyY2hpdGVjdHVyZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlIHtcbiAgLyoqXG4gICAqIEFSTTY0IE1pY3JvVk0gaW1hZ2UgYXJjaGl0ZWN0dXJlLlxuICAgKi9cbiAgQVJNXzY0ID0gXCJBUk1fNjRcIixcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9vayBtb2RlIGZvciBMYW1iZGEgTWljcm9WTSBpbWFnZSBob29rcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHtcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGxpZmVjeWNsZSBob29rLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcIkRJU0FCTEVEXCIsXG5cbiAgLyoqXG4gICAqIEVuYWJsZSB0aGUgbGlmZWN5Y2xlIGhvb2suXG4gICAqL1xuICBFTkFCTEVEID0gXCJFTkFCTEVEXCIsXG59XG5cbi8qKlxuICogQ29kZSBhcnRpZmFjdCBsb2NhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3Qge1xuICAvKipcbiAgICogVGhlIFVSSSBvZiB0aGUgY29kZSBhcnRpZmFjdCwgc3VjaCBhcyBhbiBBbWF6b24gUzMgcGF0aCBvciBBbWF6b24gRUNSIGltYWdlIFVSSS5cbiAgICovXG4gIHJlYWRvbmx5IHVyaTogc3RyaW5nO1xufVxuXG4vKipcbiAqIENQVSBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb24ge1xuICAvKipcbiAgICogVGhlIENQVSBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjRcbiAgICovXG4gIHJlYWRvbmx5IGFyY2hpdGVjdHVyZT86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZTtcbn1cblxuLyoqXG4gKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlIHtcbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlIGtleS5cbiAgICovXG4gIHJlYWRvbmx5IGtleTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZSB2YWx1ZS5cbiAgICovXG4gIHJlYWRvbmx5IHZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2tzIGludm9rZWQgZHVyaW5nIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3Mge1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcmVhZHkgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZHk/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlYWR5IGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSByZWFkeVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHZhbGlkYXRlIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHZhbGlkYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB2YWxpZGF0ZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rcyBpbnZva2VkIGR1cmluZyBNaWNyb1ZNIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzIHtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJlc3VtZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSByZXN1bWU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlc3VtZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzdW1lVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgcnVuIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bj86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcnVuIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSBydW5UaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBzdXNwZW5kIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmQ/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHN1c3BlbmQgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSB0ZXJtaW5hdGUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdGVybWluYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB0ZXJtaW5hdGUgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogSG9vayBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzIHtcbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rcyBmb3IgTWljcm9WTSBldmVudHMuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9va3MgZm9yIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzO1xuXG4gIC8qKlxuICAgKiBUaGUgcG9ydCBudW1iZXIgb24gd2hpY2ggdGhlIGhvb2tzIGxpc3RlbmVyIHJ1bnMuXG4gICAqL1xuICByZWFkb25seSBwb3J0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3VkV2F0Y2ggTG9ncyBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlIGxvZ2dpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcge1xuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIENsb3VkV2F0Y2ggTG9ncyBsb2cgZ3JvdXAgdG8gc2VuZCBsb2dzIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBDbG91ZFdhdGNoIExvZ3MgbG9nIHN0cmVhbSB3aXRoaW4gdGhlIGxvZyBncm91cC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ1N0cmVhbT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBMb2dnaW5nIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB7XG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBzZW5kaW5nIGxvZ3MgdG8gQW1hem9uIENsb3VkV2F0Y2ggTG9ncy5cbiAgICovXG4gIHJlYWRvbmx5IGNsb3VkV2F0Y2g/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZztcblxuICAvKipcbiAgICogU2V0IHRvIHRydWUgdG8gZGlzYWJsZSBNaWNyb1ZNIGxvZ2dpbmcuXG4gICAqL1xuICByZWFkb25seSBkaXNhYmxlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogUmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlcyB7XG4gIC8qKlxuICAgKiBUaGUgbWluaW11bSBhbW91bnQgb2YgbWVtb3J5IGluIE1pQiB0byBhbGxvY2F0ZSB0byB0aGUgTWljcm9WTS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGRlc2NyaXB0aW9uIG9mIHRoZSB2ZXJzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgYmFzZSBNaWNyb1ZNIGltYWdlIHVzZWQuXG4gICAqL1xuICByZWFkb25seSBiYXNlSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHNwZWNpZmljIHZlcnNpb24gb2YgdGhlIGJhc2UgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IGJhc2VJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgSUFNIGJ1aWxkIHJvbGUuXG4gICAqL1xuICByZWFkb25seSBidWlsZFJvbGVBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvZGUgYXJ0aWZhY3QgZm9yIHRoaXMgdmVyc2lvbi5cbiAgICovXG4gIHJlYWRvbmx5IGNvZGVBcnRpZmFjdDogQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0O1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBlZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIGF2YWlsYWJsZSB0byB0aGUgTWljcm9WTSBhdCBydW50aW1lLlxuICAgKlxuICAgKiBQYXNzIGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcmAgaW5zdGFuY2VzIG9yIGNvbXBhdGlibGUgY29ubmVjdG9yIHJlZmVyZW5jZXMuXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9vayBjb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNcyBhbmQgTWljcm9WTSBpbWFnZXMuXG4gICAqXG4gICAqIFBhc3MgYW4gZW1wdHkgb2JqZWN0IChge31gKSBmb3IgQXBwVGhlb3J5IGVuZHBvaW50LWRpc3BhdGNoZWQgTWljcm9WTSBpbWFnZXMuXG4gICAqIEFwcFRoZW9yeSB0aGVuIHN5bnRoZXNpemVzIGBIb29rczoge31gIHNvIExhbWJkYSBidWlsZHMgdGhlIGltYWdlIHdpdGhvdXRcbiAgICogQVdTLWludm9rZWQgbGlmZWN5Y2xlIGhvb2tzIGFuZCBydW50aW1lIHRyYWZmaWMgaXMgZGVsaXZlcmVkIHRocm91Z2ggdGhlXG4gICAqIE1pY3JvVk0gZW5kcG9pbnQgb24gdGhlIGRlZmF1bHQgcG9ydCA4MDgwLiBJZiBhbnkgaG9vayBpcyBjb25maWd1cmVkLCBgcG9ydGBcbiAgICogaXMgcmVxdWlyZWQgYnkgQVdTIGFuZCBBcHBUaGVvcnkgdmFsaWRhdGVzIGl0IGZhaWwtY2xvc2VkLlxuICAgKi9cbiAgcmVhZG9ubHkgaG9va3M6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNIGxvZ2dpbmcgb3V0cHV0LlxuICAgKlxuICAgKiBTcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGBjbG91ZFdhdGNoYCBvciBgZGlzYWJsZWQ6IHRydWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZztcblxuICAvKipcbiAgICogVGhlIHJlc291cmNlIHJlcXVpcmVtZW50cyBmb3IgdGhlIE1pY3JvVk0uXG4gICAqXG4gICAqIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UgY3VycmVudGx5IGFjY2VwdHMgZXhhY3RseSBvbmUgUmVzb3VyY2VzIGVudHJ5LlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2VzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VSZXNvdXJjZXNbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgZ3JhbnRlZCB0byB0aGUgTWljcm9WTSBydW50aW1lIGVudmlyb25tZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTF1cbiAgICovXG4gIHJlYWRvbmx5IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdO1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBzdXBwb3J0ZWQgQ1BVIGNvbmZpZ3VyYXRpb25zIGZvciB0aGUgTWljcm9WTS5cbiAgICpcbiAgICogQGRlZmF1bHQgW3sgYXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH1dXG4gICAqL1xuICByZWFkb25seSBjcHVDb25maWd1cmF0aW9ucz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb25bXTtcblxuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGVzIHNldCBpbiB0aGUgTWljcm9WTSBydW50aW1lIGVudmlyb25tZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZW52aXJvbm1lbnRWYXJpYWJsZXM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgQ2xvdWRGb3JtYXRpb24gdGFncyB0byBhcHBseSB0byB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSBDREsgY29uc3RydWN0IGZvciBBV1MgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIGludGVudGlvbmFsbHkgZGVwbG95bWVudC1vbmx5OiBpdCBjcmVhdGVzIHRoZSBDbG91ZEZvcm1hdGlvblxuICogYEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VgIHJlc291cmNlIGZyb20gY2FsbGVyLXByb3ZpZGVkIGNvZGUgYXJ0aWZhY3QsIGJhc2UgaW1hZ2UsXG4gKiBidWlsZCByb2xlLCBsaWZlY3ljbGUgaG9va3MsIGxvZ2dpbmcgY29uZmlndXJhdGlvbiwgcmVzb3VyY2UgcmVxdWlyZW1lbnRzLCBhbmRcbiAqIEFwcFRoZW9yeSBNaWNyb1ZNIG5ldHdvcmstY29ubmVjdG9yIHJlZmVyZW5jZXMuIFJ1bnRpbWUgY29udHJvbGxlciBiZWhhdmlvciBzdGF5cyBpblxuICogdGhlIEFwcFRoZW9yeSBydW50aW1lIGNvbnRyYWN0LlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWljcm92bUltYWdlIGV4dGVuZHMgQ29uc3RydWN0IGltcGxlbWVudHMgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBDbG91ZEZvcm1hdGlvbiBNaWNyb1ZNIGltYWdlIHJlc291cmNlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogQ2ZuUmVzb3VyY2U7XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIG5hbWUgcmV0dXJuZWQgYnkgUmVmLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZU5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5vcm1hbGl6ZWQgZGVwbG95bWVudC1vd25lZCBydW50aW1lIGxvZ2dpbmcgcG9zdHVyZSBmb3IgdGhpcyBpbWFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY3VycmVudCBpbWFnZSBzdGF0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VTdGF0ZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGF0ZXN0IGFjdGl2ZSBpbWFnZSB2ZXJzaW9uLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGF0ZXN0IGZhaWxlZCBpbWFnZSB2ZXJzaW9uLCBpZiBhbnkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB0aW1lc3RhbXAgd2hlbiB0aGUgaW1hZ2Ugd2FzIGNyZWF0ZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgY3JlYXRlZEF0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB0aW1lc3RhbXAgd2hlbiB0aGUgaW1hZ2Ugd2FzIGxhc3QgdXBkYXRlZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB1cGRhdGVkQXQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWljcm92bUltYWdlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG5cbiAgICBjb25zdCBuYW1lID0gbm9ybWFsaXplTmFtZShwcm9wcy5uYW1lKTtcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHByb3BzLmRlc2NyaXB0aW9uLCBcImRlc2NyaXB0aW9uXCIpO1xuICAgIGNvbnN0IGJhc2VJbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5iYXNlSW1hZ2VBcm4sIFwiYmFzZUltYWdlQXJuXCIsIDIwNDgpO1xuICAgIGNvbnN0IGJhc2VJbWFnZVZlcnNpb24gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMuYmFzZUltYWdlVmVyc2lvbiwgXCJiYXNlSW1hZ2VWZXJzaW9uXCIsIDIwNDgpO1xuICAgIGNvbnN0IGJ1aWxkUm9sZUFybiA9IG5vcm1hbGl6ZUJ1aWxkUm9sZUFybihwcm9wcy5idWlsZFJvbGVBcm4pO1xuICAgIGNvbnN0IGNvZGVBcnRpZmFjdCA9IHJlbmRlckNvZGVBcnRpZmFjdChwcm9wcy5jb2RlQXJ0aWZhY3QpO1xuICAgIGNvbnN0IGVncmVzc05ldHdvcmtDb25uZWN0b3JzID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyk7XG4gICAgY29uc3QgaG9va3MgPSByZW5kZXJIb29rcyhwcm9wcy5ob29rcyk7XG4gICAgY29uc3QgbG9nZ2luZyA9IG5vcm1hbGl6ZUxvZ2dpbmcocHJvcHMubG9nZ2luZyk7XG4gICAgY29uc3QgcmVzb3VyY2VzID0gcmVuZGVyUmVzb3VyY2VzKHByb3BzLnJlc291cmNlcyk7XG4gICAgY29uc3QgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzID0gbm9ybWFsaXplQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKHByb3BzLmFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyk7XG4gICAgY29uc3QgY3B1Q29uZmlndXJhdGlvbnMgPSByZW5kZXJDcHVDb25maWd1cmF0aW9ucyhwcm9wcy5jcHVDb25maWd1cmF0aW9ucyk7XG4gICAgY29uc3QgZW52aXJvbm1lbnRWYXJpYWJsZXMgPSByZW5kZXJFbnZpcm9ubWVudFZhcmlhYmxlcyhwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlcyk7XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZSA9IG5ldyBDZm5SZXNvdXJjZSh0aGlzLCBcIk1pY3Jvdm1JbWFnZVwiLCB7XG4gICAgICB0eXBlOiBcIkFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzOiBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMsXG4gICAgICAgIEJhc2VJbWFnZUFybjogYmFzZUltYWdlQXJuLFxuICAgICAgICBCYXNlSW1hZ2VWZXJzaW9uOiBiYXNlSW1hZ2VWZXJzaW9uLFxuICAgICAgICBCdWlsZFJvbGVBcm46IGJ1aWxkUm9sZUFybixcbiAgICAgICAgQ29kZUFydGlmYWN0OiBjb2RlQXJ0aWZhY3QsXG4gICAgICAgIENwdUNvbmZpZ3VyYXRpb25zOiBjcHVDb25maWd1cmF0aW9ucyxcbiAgICAgICAgRGVzY3JpcHRpb246IGRlc2NyaXB0aW9uLFxuICAgICAgICBFZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMsXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiBlbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAgICAgSG9va3M6IGhvb2tzLFxuICAgICAgICBMb2dnaW5nOiByZW5kZXJMb2dnaW5nKGxvZ2dpbmcpLFxuICAgICAgICBOYW1lOiBuYW1lLFxuICAgICAgICBSZXNvdXJjZXM6IHJlc291cmNlcyxcbiAgICAgICAgVGFnczogcmVuZGVyVGFncyhwcm9wcy50YWdzKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZU5hbWUgPSB0aGlzLm1pY3Jvdm1JbWFnZS5yZWY7XG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VBcm4gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJJbWFnZUFyblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubG9nZ2luZyA9IGxvZ2dpbmc7XG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VTdGF0ZSA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIlN0YXRlXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5sYXRlc3RBY3RpdmVJbWFnZVZlcnNpb24gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJMYXRlc3RBY3RpdmVJbWFnZVZlcnNpb25cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmxhdGVzdEZhaWxlZEltYWdlVmVyc2lvbiA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkxhdGVzdEZhaWxlZEltYWdlVmVyc2lvblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMuY3JlYXRlZEF0ID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiQ3JlYXRlZEF0XCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy51cGRhdGVkQXQgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJVcGRhdGVkQXRcIikudG9TdHJpbmcoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOYW1lKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBuYW1lID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibmFtZVwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICEvXltBLVphLXowLTlfLV17MSw2NH0kLy50ZXN0KG5hbWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IG5hbWUgbXVzdCBiZSAxLTY0IGNoYXJhY3RlcnMgdXNpbmcgbGV0dGVycywgbnVtYmVycywgaHlwaGVucywgb3IgdW5kZXJzY29yZXNcIixcbiAgICApO1xuICB9XG4gIHJldHVybiBuYW1lO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcodmFsdWUpLnRyaW0oKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBwcm9wTmFtZSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAvXFxzLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiBub3JtYWxpemVkLmxlbmd0aCA+IG1heExlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGF0IG1vc3QgJHttYXhMZW5ndGh9IGNoYXJhY3RlcnNgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQnVpbGRSb2xlQXJuKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBjb25zdCBhcm4gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWUsIFwiYnVpbGRSb2xlQXJuXCIsIDIwNDgpO1xuICBpZiAoXG4gICAgIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiZcbiAgICAhL15hcm46YXdzW2EtekEtWi1dKjppYW06OlxcZHsxMn06cm9sZVxcLz9bYS16QS1aXzAtOSs9LC5AXFwtXy9dKyQvLnRlc3QoYXJuKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGJ1aWxkUm9sZUFybiBtdXN0IGJlIGFuIElBTSByb2xlIEFSTlwiKTtcbiAgfVxuICByZXR1cm4gYXJuO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb2RlQXJ0aWZhY3QoXG4gIGNvZGVBcnRpZmFjdDogQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0IHwgdW5kZWZpbmVkLFxuKTogeyBVcmk6IHN0cmluZyB9IHtcbiAgaWYgKGNvZGVBcnRpZmFjdCA9PT0gdW5kZWZpbmVkIHx8IGNvZGVBcnRpZmFjdCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5jb2RlQXJ0aWZhY3RcIik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBVcmk6IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhjb2RlQXJ0aWZhY3QudXJpLCBcImNvZGVBcnRpZmFjdC51cmlcIiwgMjA0OCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gIGNvbm5lY3RvcnM6IHJlYWRvbmx5IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWNvbm5lY3RvcnMgfHwgY29ubmVjdG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBlbnRyeVwiKTtcbiAgfVxuICBpZiAoY29ubmVjdG9ycy5sZW5ndGggPiAxMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBhdCBtb3N0IDEwIGVncmVzc05ldHdvcmtDb25uZWN0b3JzIGVudHJpZXNcIik7XG4gIH1cblxuICBjb25zdCBhcm5zID0gY29ubmVjdG9ycy5tYXAoKGNvbm5lY3RvciwgaW5kZXgpID0+IHtcbiAgICBpZiAoY29ubmVjdG9yID09PSB1bmRlZmluZWQgfHwgY29ubmVjdG9yID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3QgYXJuID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcoXG4gICAgICBjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvckFybixcbiAgICAgIGBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV0ubmV0d29ya0Nvbm5lY3RvckFybmAsXG4gICAgKTtcbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChhcm4pICYmIC9cXHMvLnRlc3QoYXJuKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWljcm92bUltYWdlOiBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV0ubmV0d29ya0Nvbm5lY3RvckFybiBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGFybjtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5W10sXG4pOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXSB7XG4gIGNvbnN0IGNhcGFiaWxpdGllcyA9IHZhbHVlcyA/PyBbQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTF07XG4gIGlmIChjYXBhYmlsaXRpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzIGVudHJ5XCIpO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjYXBhYmlsaXRpZXMubWFwKChjYXBhYmlsaXR5LCBpbmRleCkgPT4ge1xuICAgIGlmIChTdHJpbmcoY2FwYWJpbGl0eSkudHJpbSgpLnRvVXBwZXJDYXNlKCkgIT09IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTEwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXNbJHtpbmRleH1dIG11c3QgYmUgQUxMYCk7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMO1xuICB9KTtcbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKG5vcm1hbGl6ZWQsIFwiYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ3B1Q29uZmlndXJhdGlvbnMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb25bXSxcbik6IEFycmF5PHsgQXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUgfT4ge1xuICBjb25zdCBjcHVDb25maWd1cmF0aW9ucyA9IHZhbHVlcyA/PyBbeyBhcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQgfV07XG4gIGlmIChjcHVDb25maWd1cmF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBjcHVDb25maWd1cmF0aW9ucyBlbnRyeVwiKTtcbiAgfVxuICByZXR1cm4gY3B1Q29uZmlndXJhdGlvbnMubWFwKChjcHUsIGluZGV4KSA9PiB7XG4gICAgaWYgKGNwdSA9PT0gdW5kZWZpbmVkIHx8IGNwdSA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuY3B1Q29uZmlndXJhdGlvbnNbJHtpbmRleH1dYCk7XG4gICAgfVxuICAgIGNvbnN0IGFyY2hpdGVjdHVyZSA9IFN0cmluZyhjcHUuYXJjaGl0ZWN0dXJlID8/IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQpXG4gICAgICAudHJpbSgpXG4gICAgICAudG9VcHBlckNhc2UoKTtcbiAgICBpZiAoYXJjaGl0ZWN0dXJlICE9PSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogY3B1Q29uZmlndXJhdGlvbnNbJHtpbmRleH1dLmFyY2hpdGVjdHVyZSBtdXN0IGJlIEFSTV82NGApO1xuICAgIH1cbiAgICByZXR1cm4geyBBcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQgfTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckVudmlyb25tZW50VmFyaWFibGVzKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlW10sXG4pOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+IHtcbiAgaWYgKCh2YWx1ZXM/Lmxlbmd0aCA/PyAwKSA+IDUwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGF0IG1vc3QgNTAgZW52aXJvbm1lbnRWYXJpYWJsZXMgZW50cmllc1wiKTtcbiAgfVxuXG4gIGNvbnN0IHJlbmRlcmVkID0gKHZhbHVlcyA/PyBbXSkubWFwKChlbnRyeSwgaW5kZXgpID0+IHtcbiAgICBpZiAoZW50cnkgPT09IHVuZGVmaW5lZCB8fCBlbnRyeSA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dYCk7XG4gICAgfVxuICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhlbnRyeS5rZXksIGBlbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV0ua2V5YCwgMjU2KTtcbiAgICBjb25zdCB2YWx1ZSA9IGVudHJ5LnZhbHVlID09PSB1bmRlZmluZWQgfHwgZW50cnkudmFsdWUgPT09IG51bGwgPyB1bmRlZmluZWQgOiBTdHJpbmcoZW50cnkudmFsdWUpO1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV0udmFsdWVgKTtcbiAgICB9XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIHZhbHVlLmxlbmd0aCA+IDQwOTYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBlbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV0udmFsdWUgbXVzdCBiZSBhdCBtb3N0IDQwOTYgY2hhcmFjdGVyc2ApO1xuICAgIH1cbiAgICByZXR1cm4geyBLZXk6IGtleSwgVmFsdWU6IHZhbHVlIH07XG4gIH0pO1xuXG4gIGFzc2VydE5vRHVwbGljYXRlcyhcbiAgICByZW5kZXJlZC5tYXAoKGVudHJ5KSA9PiBlbnRyeS5LZXkpLFxuICAgIFwiZW52aXJvbm1lbnRWYXJpYWJsZXMga2V5XCIsXG4gICk7XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVySG9va3MoaG9va3M6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAoaG9va3MgPT09IHVuZGVmaW5lZCB8fCBob29rcyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rc1wiKTtcbiAgfVxuXG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBjb25zdCBtaWNyb3ZtSG9va3MgPSByZW5kZXJSdW50aW1lSG9va3MoaG9va3MubWljcm92bUhvb2tzKTtcbiAgaWYgKG1pY3Jvdm1Ib29rcykge1xuICAgIHJlbmRlcmVkLk1pY3Jvdm1Ib29rcyA9IG1pY3Jvdm1Ib29rcztcbiAgfVxuICBjb25zdCBtaWNyb3ZtSW1hZ2VIb29rcyA9IHJlbmRlckltYWdlSG9va3MoaG9va3MubWljcm92bUltYWdlSG9va3MpO1xuICBpZiAobWljcm92bUltYWdlSG9va3MpIHtcbiAgICByZW5kZXJlZC5NaWNyb3ZtSW1hZ2VIb29rcyA9IG1pY3Jvdm1JbWFnZUhvb2tzO1xuICB9XG4gIGNvbnN0IGhhc0hvb2tHcm91cCA9IEJvb2xlYW4ocmVuZGVyZWQuTWljcm92bUhvb2tzIHx8IHJlbmRlcmVkLk1pY3Jvdm1JbWFnZUhvb2tzKTtcbiAgaWYgKGhhc0hvb2tHcm91cCAmJiBob29rcy5wb3J0ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogaG9va3MucG9ydCBpcyByZXF1aXJlZCB3aGVuIHByb3BzLmhvb2tzLm1pY3Jvdm1Ib29rcyBvciBwcm9wcy5ob29rcy5taWNyb3ZtSW1hZ2VIb29rcyBpcyBjb25maWd1cmVkXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaG9va3MucG9ydCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFoYXNIb29rR3JvdXApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGhvb2tzLnBvcnQgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUhvb2tzIG9yIHByb3BzLmhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZW5kZXJlZC5Qb3J0ID0gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UoaG9va3MucG9ydCwgXCJob29rcy5wb3J0XCIsIDEsIDY1NTM1KTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJ1bnRpbWVIb29rcyhob29rcz86IEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUhvb2tzXCIpO1xuICB9XG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSZXN1bWVcIiwgaG9va3MucmVzdW1lLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5yZXN1bWVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJlc3VtZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5yZXN1bWVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnJlc3VtZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSdW5cIiwgaG9va3MucnVuLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5ydW5cIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJ1blRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5ydW5UaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnJ1blRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJTdXNwZW5kXCIsIGhvb2tzLnN1c3BlbmQsIFwiaG9va3MubWljcm92bUhvb2tzLnN1c3BlbmRcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3Muc3VzcGVuZFRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3Muc3VzcGVuZFRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJUZXJtaW5hdGVcIiwgaG9va3MudGVybWluYXRlLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy50ZXJtaW5hdGVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy50ZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBpZiAoT2JqZWN0LmtleXMocmVuZGVyZWQpLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGhvb2tzLm1pY3Jvdm1Ib29rcyBzZXR0aW5nXCIpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVySW1hZ2VIb29rcyhob29rcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3NcIik7XG4gIH1cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJlYWR5XCIsIGhvb2tzLnJlYWR5LCBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnJlYWR5XCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSZWFkeVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5yZWFkeVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy5yZWFkeVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDM2MDAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlZhbGlkYXRlXCIsIGhvb2tzLnZhbGlkYXRlLCBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnZhbGlkYXRlXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJWYWxpZGF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy52YWxpZGF0ZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy52YWxpZGF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDM2MDAsXG4gICk7XG4gIGlmIChPYmplY3Qua2V5cyhyZW5kZXJlZCkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgaG9va3MubWljcm92bUltYWdlSG9va3Mgc2V0dGluZ1wiKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHNldEhvb2tNb2RlKFxuICB0YXJnZXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBrZXk6IHN0cmluZyxcbiAgbW9kZTogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChtb2RlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhtb2RlKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgaWYgKG5vcm1hbGl6ZWQgIT09IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZS5FTkFCTEVEICYmIG5vcm1hbGl6ZWQgIT09IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZS5ESVNBQkxFRCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIEVOQUJMRUQgb3IgRElTQUJMRURgKTtcbiAgfVxuICB0YXJnZXRba2V5XSA9IG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgdGFyZ2V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBzdHJpbmcsXG4gIHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIG1pbjogbnVtYmVyLFxuICBtYXg6IG51bWJlcixcbik6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0YXJnZXRba2V5XSA9IG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKHZhbHVlLCBwcm9wTmFtZSwgbWluLCBtYXgpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dnaW5nKGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcgfCB1bmRlZmluZWQpOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmxvZ2dpbmdcIik7XG4gIH1cbiAgY29uc3QgaGFzQ2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gdW5kZWZpbmVkICYmIGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gbnVsbDtcbiAgY29uc3QgaGFzRGlzYWJsZWQgPSBsb2dnaW5nLmRpc2FibGVkICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNDbG91ZFdhdGNoID09PSBoYXNEaXNhYmxlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZyBtdXN0IHNwZWNpZnkgZXhhY3RseSBvbmUgb2YgY2xvdWRXYXRjaCBvciBkaXNhYmxlZFwiKTtcbiAgfVxuICBpZiAoaGFzRGlzYWJsZWQpIHtcbiAgICBpZiAobG9nZ2luZy5kaXNhYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmRpc2FibGVkIG11c3QgYmUgdHJ1ZSB3aGVuIHByb3ZpZGVkXCIpO1xuICAgIH1cbiAgICByZXR1cm4geyBkaXNhYmxlZDogdHJ1ZSB9O1xuICB9XG4gIHJldHVybiB7IGNsb3VkV2F0Y2g6IG5vcm1hbGl6ZUNsb3VkV2F0Y2hMb2dnaW5nKGxvZ2dpbmcuY2xvdWRXYXRjaCkgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ2xvdWRXYXRjaExvZ2dpbmcoXG4gIGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nIHwgdW5kZWZpbmVkLFxuKTogQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMubG9nZ2luZy5jbG91ZFdhdGNoXCIpO1xuICB9XG4gIHJldHVybiB7XG4gICAgLi4uKGxvZ2dpbmcubG9nR3JvdXAgIT09IHVuZGVmaW5lZCA/IHsgbG9nR3JvdXA6IG5vcm1hbGl6ZUxvZ0dyb3VwKGxvZ2dpbmcubG9nR3JvdXApIH0gOiB7fSksXG4gICAgLi4uKGxvZ2dpbmcubG9nU3RyZWFtICE9PSB1bmRlZmluZWQgPyB7IGxvZ1N0cmVhbTogbm9ybWFsaXplTG9nU3RyZWFtKGxvZ2dpbmcubG9nU3RyZWFtKSB9IDoge30pLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJMb2dnaW5nKGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmIChsb2dnaW5nLmNsb3VkV2F0Y2gpIHtcbiAgICByZXR1cm4ge1xuICAgICAgQ2xvdWRXYXRjaDoge1xuICAgICAgICAuLi4obG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwICE9PSB1bmRlZmluZWQgPyB7IExvZ0dyb3VwOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXAgfSA6IHt9KSxcbiAgICAgICAgLi4uKGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gIT09IHVuZGVmaW5lZCA/IHsgTG9nU3RyZWFtOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIH0gOiB7fSksXG4gICAgICB9LFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgRGlzYWJsZWQ6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9nR3JvdXAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXBcIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAhL15bYS16QS1aMC05X1xcLS8uI117MSw1MTJ9JC8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dTdHJlYW0odmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgKCEvXlteOipdKiQvLnRlc3Qobm9ybWFsaXplZCkgfHwgbm9ybWFsaXplZC5sZW5ndGggPiA1MTIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSZXNvdXJjZXMoXG4gIHJlc291cmNlczogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzW10gfCB1bmRlZmluZWQsXG4pOiBBcnJheTx7IE1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyIH0+IHtcbiAgaWYgKCFyZXNvdXJjZXMgfHwgcmVzb3VyY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBleGFjdGx5IDEgcmVzb3VyY2VzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChyZXNvdXJjZXMubGVuZ3RoID4gMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBleGFjdGx5IDEgcmVzb3VyY2VzIGVudHJ5XCIpO1xuICB9XG4gIGNvbnN0IHJlc291cmNlID0gcmVzb3VyY2VzWzBdO1xuICBpZiAocmVzb3VyY2UgPT09IHVuZGVmaW5lZCB8fCByZXNvdXJjZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5yZXNvdXJjZXNbMF1cIik7XG4gIH1cbiAgcmV0dXJuIFtcbiAgICB7XG4gICAgICBNaW5pbXVtTWVtb3J5SW5NaUI6IG5vcm1hbGl6ZVBvc2l0aXZlSW50ZWdlcihyZXNvdXJjZS5taW5pbXVtTWVtb3J5SW5NaUIsIFwicmVzb3VyY2VzWzBdLm1pbmltdW1NZW1vcnlJbk1pQlwiKSxcbiAgICB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZywgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IG1pbiB8fCB2YWx1ZSA+IG1heCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGFuIGludGVnZXIgZnJvbSAke21pbn0gdG8gJHttYXh9YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0R1cGxpY2F0ZXModmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtsYWJlbH0gdmFsdWVzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZW5kZXJUYWdzKHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiB7XG4gIGNvbnN0IHJlbmRlcmVkOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+ID0gW1xuICAgIHsgS2V5OiBcIkZyYW1ld29ya1wiLCBWYWx1ZTogXCJBcHBUaGVvcnlcIiB9LFxuICAgIHsgS2V5OiBcIkNvbXBvbmVudFwiLCBWYWx1ZTogXCJNaWNyb3ZtSW1hZ2VcIiB9LFxuICBdO1xuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHRhZ3MgPz8ge30pLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZEtleSA9IGtleS50cmltKCk7XG4gICAgaWYgKCFub3JtYWxpemVkS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IHRhZyBrZXlzIGNhbm5vdCBiZSBlbXB0eVwiKTtcbiAgICB9XG4gICAgcmVuZGVyZWQucHVzaCh7IEtleTogbm9ybWFsaXplZEtleSwgVmFsdWU6IHZhbHVlIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuIl19