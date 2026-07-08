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
        const logging = renderLogging(props.logging);
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
                Logging: logging,
                Name: name,
                Resources: resources,
                Tags: renderTags(props.tags),
            },
        });
        this.microvmImageName = this.microvmImage.ref;
        this.microvmImageArn = this.microvmImage.getAtt("ImageArn").toString();
        this.microvmImageState = this.microvmImage.getAtt("State").toString();
        this.latestActiveImageVersion = this.microvmImage.getAtt("LatestActiveImageVersion").toString();
        this.latestFailedImageVersion = this.microvmImage.getAtt("LatestFailedImageVersion").toString();
        this.createdAt = this.microvmImage.getAtt("CreatedAt").toString();
        this.updatedAt = this.microvmImage.getAtt("UpdatedAt").toString();
    }
}
exports.AppTheoryMicrovmImage = AppTheoryMicrovmImage;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "1.16.0" };
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
function renderLogging(logging) {
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
        return { Disabled: true };
    }
    return { CloudWatch: renderCloudWatchLogging(logging.cloudWatch) };
}
function renderCloudWatchLogging(logging) {
    if (logging === undefined || logging === null) {
        throw new Error("AppTheoryMicrovmImage requires props.logging.cloudWatch");
    }
    const rendered = {};
    if (logging.logGroup !== undefined) {
        rendered.LogGroup = normalizeLogGroup(logging.logGroup);
    }
    if (logging.logStream !== undefined) {
        rendered.LogStream = normalizeLogStream(logging.logStream);
    }
    return rendered;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBaUQ7QUFDakQsMkNBQXVDO0FBY3ZDOztHQUVHO0FBQ0gsSUFBWSxpQ0FLWDtBQUxELFdBQVksaUNBQWlDO0lBQzNDOztPQUVHO0lBQ0gsZ0RBQVcsQ0FBQTtBQUNiLENBQUMsRUFMVyxpQ0FBaUMsaURBQWpDLGlDQUFpQyxRQUs1QztBQUVEOztHQUVHO0FBQ0gsSUFBWSxvQ0FLWDtBQUxELFdBQVksb0NBQW9DO0lBQzlDOztPQUVHO0lBQ0gseURBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQUxXLG9DQUFvQyxvREFBcEMsb0NBQW9DLFFBSy9DO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHdCQVVYO0FBVkQsV0FBWSx3QkFBd0I7SUFDbEM7O09BRUc7SUFDSCxpREFBcUIsQ0FBQTtJQUVyQjs7T0FFRztJQUNILCtDQUFtQixDQUFBO0FBQ3JCLENBQUMsRUFWVyx3QkFBd0Isd0NBQXhCLHdCQUF3QixRQVVuQztBQXVRRDs7Ozs7Ozs7R0FRRztBQUNILE1BQWEscUJBQXNCLFNBQVEsc0JBQVM7SUF5Q2xELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0NBQXNDLENBQUMsQ0FBQztRQUMxRCxDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQUcsYUFBYSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN2QyxNQUFNLFdBQVcsR0FBRyx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFLGFBQWEsQ0FBQyxDQUFDO1FBQzlFLE1BQU0sWUFBWSxHQUFHLDJCQUEy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UUFDckUsQ0FBQztRQUNELFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELENBQUM7SUFFRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2ZuUmVzb3VyY2UsIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB9IGZyb20gXCIuL21pY3Jvdm0tbmV0d29yay1jb25uZWN0b3JcIjtcblxuLyoqXG4gKiBSZWZlcmVuY2UgdG8gYSBMYW1iZGEgTWljcm9WTSBpbWFnZSB1c2FibGUgYnkgTWljcm9WTSBjb250cm9sbGVyIGNvbnN0cnVjdHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB7XG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlQXJuOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5IHtcbiAgLyoqXG4gICAqIEdyYW50cyBhbGwgY3VycmVudGx5IHN1cHBvcnRlZCBNaWNyb1ZNIE9TIGNhcGFiaWxpdGllcy5cbiAgICovXG4gIEFMTCA9IFwiQUxMXCIsXG59XG5cbi8qKlxuICogQ1BVIGFyY2hpdGVjdHVyZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlIHtcbiAgLyoqXG4gICAqIEFSTTY0IE1pY3JvVk0gaW1hZ2UgYXJjaGl0ZWN0dXJlLlxuICAgKi9cbiAgQVJNXzY0ID0gXCJBUk1fNjRcIixcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9vayBtb2RlIGZvciBMYW1iZGEgTWljcm9WTSBpbWFnZSBob29rcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHtcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGxpZmVjeWNsZSBob29rLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcIkRJU0FCTEVEXCIsXG5cbiAgLyoqXG4gICAqIEVuYWJsZSB0aGUgbGlmZWN5Y2xlIGhvb2suXG4gICAqL1xuICBFTkFCTEVEID0gXCJFTkFCTEVEXCIsXG59XG5cbi8qKlxuICogQ29kZSBhcnRpZmFjdCBsb2NhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3Qge1xuICAvKipcbiAgICogVGhlIFVSSSBvZiB0aGUgY29kZSBhcnRpZmFjdCwgc3VjaCBhcyBhbiBBbWF6b24gUzMgcGF0aCBvciBBbWF6b24gRUNSIGltYWdlIFVSSS5cbiAgICovXG4gIHJlYWRvbmx5IHVyaTogc3RyaW5nO1xufVxuXG4vKipcbiAqIENQVSBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb24ge1xuICAvKipcbiAgICogVGhlIENQVSBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjRcbiAgICovXG4gIHJlYWRvbmx5IGFyY2hpdGVjdHVyZT86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZTtcbn1cblxuLyoqXG4gKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlIHtcbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlIGtleS5cbiAgICovXG4gIHJlYWRvbmx5IGtleTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZSB2YWx1ZS5cbiAgICovXG4gIHJlYWRvbmx5IHZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2tzIGludm9rZWQgZHVyaW5nIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3Mge1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcmVhZHkgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZHk/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlYWR5IGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSByZWFkeVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHZhbGlkYXRlIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHZhbGlkYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB2YWxpZGF0ZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rcyBpbnZva2VkIGR1cmluZyBNaWNyb1ZNIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzIHtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJlc3VtZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSByZXN1bWU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlc3VtZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzdW1lVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgcnVuIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bj86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcnVuIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSBydW5UaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBzdXNwZW5kIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmQ/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHN1c3BlbmQgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSB0ZXJtaW5hdGUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdGVybWluYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB0ZXJtaW5hdGUgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogSG9vayBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzIHtcbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rcyBmb3IgTWljcm9WTSBldmVudHMuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9va3MgZm9yIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzO1xuXG4gIC8qKlxuICAgKiBUaGUgcG9ydCBudW1iZXIgb24gd2hpY2ggdGhlIGhvb2tzIGxpc3RlbmVyIHJ1bnMuXG4gICAqL1xuICByZWFkb25seSBwb3J0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3VkV2F0Y2ggTG9ncyBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlIGxvZ2dpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcge1xuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIENsb3VkV2F0Y2ggTG9ncyBsb2cgZ3JvdXAgdG8gc2VuZCBsb2dzIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBDbG91ZFdhdGNoIExvZ3MgbG9nIHN0cmVhbSB3aXRoaW4gdGhlIGxvZyBncm91cC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ1N0cmVhbT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBMb2dnaW5nIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB7XG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBzZW5kaW5nIGxvZ3MgdG8gQW1hem9uIENsb3VkV2F0Y2ggTG9ncy5cbiAgICovXG4gIHJlYWRvbmx5IGNsb3VkV2F0Y2g/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZztcblxuICAvKipcbiAgICogU2V0IHRvIHRydWUgdG8gZGlzYWJsZSBNaWNyb1ZNIGxvZ2dpbmcuXG4gICAqL1xuICByZWFkb25seSBkaXNhYmxlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogUmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlcyB7XG4gIC8qKlxuICAgKiBUaGUgbWluaW11bSBhbW91bnQgb2YgbWVtb3J5IGluIE1pQiB0byBhbGxvY2F0ZSB0byB0aGUgTWljcm9WTS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGRlc2NyaXB0aW9uIG9mIHRoZSB2ZXJzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgYmFzZSBNaWNyb1ZNIGltYWdlIHVzZWQuXG4gICAqL1xuICByZWFkb25seSBiYXNlSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHNwZWNpZmljIHZlcnNpb24gb2YgdGhlIGJhc2UgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IGJhc2VJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgSUFNIGJ1aWxkIHJvbGUuXG4gICAqL1xuICByZWFkb25seSBidWlsZFJvbGVBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvZGUgYXJ0aWZhY3QgZm9yIHRoaXMgdmVyc2lvbi5cbiAgICovXG4gIHJlYWRvbmx5IGNvZGVBcnRpZmFjdDogQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0O1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBlZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIGF2YWlsYWJsZSB0byB0aGUgTWljcm9WTSBhdCBydW50aW1lLlxuICAgKlxuICAgKiBQYXNzIGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcmAgaW5zdGFuY2VzIG9yIGNvbXBhdGlibGUgY29ubmVjdG9yIHJlZmVyZW5jZXMuXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9vayBjb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNcyBhbmQgTWljcm9WTSBpbWFnZXMuXG4gICAqXG4gICAqIFBhc3MgYW4gZW1wdHkgb2JqZWN0IChge31gKSBmb3IgQXBwVGhlb3J5IGVuZHBvaW50LWRpc3BhdGNoZWQgTWljcm9WTSBpbWFnZXMuXG4gICAqIEFwcFRoZW9yeSB0aGVuIHN5bnRoZXNpemVzIGBIb29rczoge31gIHNvIExhbWJkYSBidWlsZHMgdGhlIGltYWdlIHdpdGhvdXRcbiAgICogQVdTLWludm9rZWQgbGlmZWN5Y2xlIGhvb2tzIGFuZCBydW50aW1lIHRyYWZmaWMgaXMgZGVsaXZlcmVkIHRocm91Z2ggdGhlXG4gICAqIE1pY3JvVk0gZW5kcG9pbnQgb24gdGhlIGRlZmF1bHQgcG9ydCA4MDgwLiBJZiBhbnkgaG9vayBpcyBjb25maWd1cmVkLCBgcG9ydGBcbiAgICogaXMgcmVxdWlyZWQgYnkgQVdTIGFuZCBBcHBUaGVvcnkgdmFsaWRhdGVzIGl0IGZhaWwtY2xvc2VkLlxuICAgKi9cbiAgcmVhZG9ubHkgaG9va3M6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNIGxvZ2dpbmcgb3V0cHV0LlxuICAgKlxuICAgKiBTcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGBjbG91ZFdhdGNoYCBvciBgZGlzYWJsZWQ6IHRydWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZztcblxuICAvKipcbiAgICogVGhlIHJlc291cmNlIHJlcXVpcmVtZW50cyBmb3IgdGhlIE1pY3JvVk0uXG4gICAqXG4gICAqIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UgY3VycmVudGx5IGFjY2VwdHMgZXhhY3RseSBvbmUgUmVzb3VyY2VzIGVudHJ5LlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2VzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VSZXNvdXJjZXNbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgZ3JhbnRlZCB0byB0aGUgTWljcm9WTSBydW50aW1lIGVudmlyb25tZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTF1cbiAgICovXG4gIHJlYWRvbmx5IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdO1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBzdXBwb3J0ZWQgQ1BVIGNvbmZpZ3VyYXRpb25zIGZvciB0aGUgTWljcm9WTS5cbiAgICpcbiAgICogQGRlZmF1bHQgW3sgYXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH1dXG4gICAqL1xuICByZWFkb25seSBjcHVDb25maWd1cmF0aW9ucz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb25bXTtcblxuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGVzIHNldCBpbiB0aGUgTWljcm9WTSBydW50aW1lIGVudmlyb25tZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgZW52aXJvbm1lbnRWYXJpYWJsZXM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgQ2xvdWRGb3JtYXRpb24gdGFncyB0byBhcHBseSB0byB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSBDREsgY29uc3RydWN0IGZvciBBV1MgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIGludGVudGlvbmFsbHkgZGVwbG95bWVudC1vbmx5OiBpdCBjcmVhdGVzIHRoZSBDbG91ZEZvcm1hdGlvblxuICogYEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VgIHJlc291cmNlIGZyb20gY2FsbGVyLXByb3ZpZGVkIGNvZGUgYXJ0aWZhY3QsIGJhc2UgaW1hZ2UsXG4gKiBidWlsZCByb2xlLCBsaWZlY3ljbGUgaG9va3MsIGxvZ2dpbmcgY29uZmlndXJhdGlvbiwgcmVzb3VyY2UgcmVxdWlyZW1lbnRzLCBhbmRcbiAqIEFwcFRoZW9yeSBNaWNyb1ZNIG5ldHdvcmstY29ubmVjdG9yIHJlZmVyZW5jZXMuIFJ1bnRpbWUgY29udHJvbGxlciBiZWhhdmlvciBzdGF5cyBpblxuICogdGhlIEFwcFRoZW9yeSBydW50aW1lIGNvbnRyYWN0LlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWljcm92bUltYWdlIGV4dGVuZHMgQ29uc3RydWN0IGltcGxlbWVudHMgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBDbG91ZEZvcm1hdGlvbiBNaWNyb1ZNIGltYWdlIHJlc291cmNlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogQ2ZuUmVzb3VyY2U7XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIG5hbWUgcmV0dXJuZWQgYnkgUmVmLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZU5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGN1cnJlbnQgaW1hZ2Ugc3RhdGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlU3RhdGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxhdGVzdCBhY3RpdmUgaW1hZ2UgdmVyc2lvbi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsYXRlc3RBY3RpdmVJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxhdGVzdCBmYWlsZWQgaW1hZ2UgdmVyc2lvbiwgaWYgYW55LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxhdGVzdEZhaWxlZEltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGltZXN0YW1wIHdoZW4gdGhlIGltYWdlIHdhcyBjcmVhdGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNyZWF0ZWRBdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGltZXN0YW1wIHdoZW4gdGhlIGltYWdlIHdhcyBsYXN0IHVwZGF0ZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdXBkYXRlZEF0OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHNcIik7XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG5vcm1hbGl6ZU5hbWUocHJvcHMubmFtZSk7XG4gICAgY29uc3QgZGVzY3JpcHRpb24gPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhwcm9wcy5kZXNjcmlwdGlvbiwgXCJkZXNjcmlwdGlvblwiKTtcbiAgICBjb25zdCBiYXNlSW1hZ2VBcm4gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMuYmFzZUltYWdlQXJuLCBcImJhc2VJbWFnZUFyblwiLCAyMDQ4KTtcbiAgICBjb25zdCBiYXNlSW1hZ2VWZXJzaW9uID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLmJhc2VJbWFnZVZlcnNpb24sIFwiYmFzZUltYWdlVmVyc2lvblwiLCAyMDQ4KTtcbiAgICBjb25zdCBidWlsZFJvbGVBcm4gPSBub3JtYWxpemVCdWlsZFJvbGVBcm4ocHJvcHMuYnVpbGRSb2xlQXJuKTtcbiAgICBjb25zdCBjb2RlQXJ0aWZhY3QgPSByZW5kZXJDb2RlQXJ0aWZhY3QocHJvcHMuY29kZUFydGlmYWN0KTtcbiAgICBjb25zdCBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMocHJvcHMuZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMpO1xuICAgIGNvbnN0IGhvb2tzID0gcmVuZGVySG9va3MocHJvcHMuaG9va3MpO1xuICAgIGNvbnN0IGxvZ2dpbmcgPSByZW5kZXJMb2dnaW5nKHByb3BzLmxvZ2dpbmcpO1xuICAgIGNvbnN0IHJlc291cmNlcyA9IHJlbmRlclJlc291cmNlcyhwcm9wcy5yZXNvdXJjZXMpO1xuICAgIGNvbnN0IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyA9IG5vcm1hbGl6ZUFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyhwcm9wcy5hZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMpO1xuICAgIGNvbnN0IGNwdUNvbmZpZ3VyYXRpb25zID0gcmVuZGVyQ3B1Q29uZmlndXJhdGlvbnMocHJvcHMuY3B1Q29uZmlndXJhdGlvbnMpO1xuICAgIGNvbnN0IGVudmlyb25tZW50VmFyaWFibGVzID0gcmVuZGVyRW52aXJvbm1lbnRWYXJpYWJsZXMocHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMpO1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2UgPSBuZXcgQ2ZuUmVzb3VyY2UodGhpcywgXCJNaWNyb3ZtSW1hZ2VcIiwge1xuICAgICAgdHlwZTogXCJBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlXCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEFkZGl0aW9uYWxPc0NhcGFiaWxpdGllczogYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzLFxuICAgICAgICBCYXNlSW1hZ2VBcm46IGJhc2VJbWFnZUFybixcbiAgICAgICAgQmFzZUltYWdlVmVyc2lvbjogYmFzZUltYWdlVmVyc2lvbixcbiAgICAgICAgQnVpbGRSb2xlQXJuOiBidWlsZFJvbGVBcm4sXG4gICAgICAgIENvZGVBcnRpZmFjdDogY29kZUFydGlmYWN0LFxuICAgICAgICBDcHVDb25maWd1cmF0aW9uczogY3B1Q29uZmlndXJhdGlvbnMsXG4gICAgICAgIERlc2NyaXB0aW9uOiBkZXNjcmlwdGlvbixcbiAgICAgICAgRWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IGVncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczogZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgICAgIEhvb2tzOiBob29rcyxcbiAgICAgICAgTG9nZ2luZzogbG9nZ2luZyxcbiAgICAgICAgTmFtZTogbmFtZSxcbiAgICAgICAgUmVzb3VyY2VzOiByZXNvdXJjZXMsXG4gICAgICAgIFRhZ3M6IHJlbmRlclRhZ3MocHJvcHMudGFncyksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VOYW1lID0gdGhpcy5taWNyb3ZtSW1hZ2UucmVmO1xuICAgIHRoaXMubWljcm92bUltYWdlQXJuID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiSW1hZ2VBcm5cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLm1pY3Jvdm1JbWFnZVN0YXRlID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiU3RhdGVcIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvbiA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiTGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5jcmVhdGVkQXQgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJDcmVhdGVkQXRcIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLnVwZGF0ZWRBdCA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIlVwZGF0ZWRBdFwiKS50b1N0cmluZygpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5hbWUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5hbWUgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJuYW1lXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW0EtWmEtejAtOV8tXXsxLDY0fSQvLnRlc3QobmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbmFtZSBtdXN0IGJlIDEtNjQgY2hhcmFjdGVycyB1c2luZyBsZXR0ZXJzLCBudW1iZXJzLCBoeXBoZW5zLCBvciB1bmRlcnNjb3Jlc1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5hbWU7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSkudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIHByb3BOYW1lKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIC9cXHMvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYXQgbW9zdCAke21heExlbmd0aH0gY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCdWlsZFJvbGVBcm4odmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGNvbnN0IGFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZSwgXCJidWlsZFJvbGVBcm5cIiwgMjA0OCk7XG4gIGlmIChcbiAgICAhVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJlxuICAgICEvXmFybjphd3NbYS16QS1aLV0qOmlhbTo6XFxkezEyfTpyb2xlXFwvP1thLXpBLVpfMC05Kz0sLkBcXC1fL10rJC8udGVzdChhcm4pXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogYnVpbGRSb2xlQXJuIG11c3QgYmUgYW4gSUFNIHJvbGUgQVJOXCIpO1xuICB9XG4gIHJldHVybiBhcm47XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGVBcnRpZmFjdChcbiAgY29kZUFydGlmYWN0OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3QgfCB1bmRlZmluZWQsXG4pOiB7IFVyaTogc3RyaW5nIH0ge1xuICBpZiAoY29kZUFydGlmYWN0ID09PSB1bmRlZmluZWQgfHwgY29kZUFydGlmYWN0ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmNvZGVBcnRpZmFjdFwiKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIFVyaTogbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGNvZGVBcnRpZmFjdC51cmksIFwiY29kZUFydGlmYWN0LnVyaVwiLCAyMDQ4KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgY29ubmVjdG9yczogcmVhZG9ubHkgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW10gfCB1bmRlZmluZWQsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghY29ubmVjdG9ycyB8fCBjb25uZWN0b3JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGVncmVzc05ldHdvcmtDb25uZWN0b3JzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGF0IG1vc3QgMTAgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgZW50cmllc1wiKTtcbiAgfVxuXG4gIGNvbnN0IGFybnMgPSBjb25uZWN0b3JzLm1hcCgoY29ubmVjdG9yLCBpbmRleCkgPT4ge1xuICAgIGlmIChjb25uZWN0b3IgPT09IHVuZGVmaW5lZCB8fCBjb25uZWN0b3IgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBhcm4gPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhcbiAgICAgIGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yQXJuLFxuICAgICAgYGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuYCxcbiAgICApO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGFybikgJiYgL1xccy8udGVzdChhcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuIG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYXJuO1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgXCJlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXSxcbik6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdIHtcbiAgY29uc3QgY2FwYWJpbGl0aWVzID0gdmFsdWVzID8/IFtBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMXTtcbiAgaWYgKGNhcGFiaWxpdGllcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMgZW50cnlcIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhcGFiaWxpdGllcy5tYXAoKGNhcGFiaWxpdHksIGluZGV4KSA9PiB7XG4gICAgaWYgKFN0cmluZyhjYXBhYmlsaXR5KS50cmltKCkudG9VcHBlckNhc2UoKSAhPT0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllc1ske2luZGV4fV0gbXVzdCBiZSBBTExgKTtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTEw7XG4gIH0pO1xuICBhc3NlcnROb0R1cGxpY2F0ZXMobm9ybWFsaXplZCwgXCJhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXNcIik7XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDcHVDb25maWd1cmF0aW9ucyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbltdLFxuKTogQXJyYXk8eyBBcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZSB9PiB7XG4gIGNvbnN0IGNwdUNvbmZpZ3VyYXRpb25zID0gdmFsdWVzID8/IFt7IGFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9XTtcbiAgaWYgKGNwdUNvbmZpZ3VyYXRpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGNwdUNvbmZpZ3VyYXRpb25zIGVudHJ5XCIpO1xuICB9XG4gIHJldHVybiBjcHVDb25maWd1cmF0aW9ucy5tYXAoKGNwdSwgaW5kZXgpID0+IHtcbiAgICBpZiAoY3B1ID09PSB1bmRlZmluZWQgfHwgY3B1ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5jcHVDb25maWd1cmF0aW9uc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3QgYXJjaGl0ZWN0dXJlID0gU3RyaW5nKGNwdS5hcmNoaXRlY3R1cmUgPz8gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NClcbiAgICAgIC50cmltKClcbiAgICAgIC50b1VwcGVyQ2FzZSgpO1xuICAgIGlmIChhcmNoaXRlY3R1cmUgIT09IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBjcHVDb25maWd1cmF0aW9uc1ske2luZGV4fV0uYXJjaGl0ZWN0dXJlIG11c3QgYmUgQVJNXzY0YCk7XG4gICAgfVxuICAgIHJldHVybiB7IEFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9O1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRW52aXJvbm1lbnRWYXJpYWJsZXMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGVbXSxcbik6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4ge1xuICBpZiAoKHZhbHVlcz8ubGVuZ3RoID8/IDApID4gNTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgYXQgbW9zdCA1MCBlbnZpcm9ubWVudFZhcmlhYmxlcyBlbnRyaWVzXCIpO1xuICB9XG5cbiAgY29uc3QgcmVuZGVyZWQgPSAodmFsdWVzID8/IFtdKS5tYXAoKGVudHJ5LCBpbmRleCkgPT4ge1xuICAgIGlmIChlbnRyeSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGVudHJ5LmtleSwgYGVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS5rZXlgLCAyNTYpO1xuICAgIGNvbnN0IHZhbHVlID0gZW50cnkudmFsdWUgPT09IHVuZGVmaW5lZCB8fCBlbnRyeS52YWx1ZSA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IFN0cmluZyhlbnRyeS52YWx1ZSk7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS52YWx1ZWApO1xuICAgIH1cbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgdmFsdWUubGVuZ3RoID4gNDA5Nikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS52YWx1ZSBtdXN0IGJlIGF0IG1vc3QgNDA5NiBjaGFyYWN0ZXJzYCk7XG4gICAgfVxuICAgIHJldHVybiB7IEtleToga2V5LCBWYWx1ZTogdmFsdWUgfTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKFxuICAgIHJlbmRlcmVkLm1hcCgoZW50cnkpID0+IGVudHJ5LktleSksXG4gICAgXCJlbnZpcm9ubWVudFZhcmlhYmxlcyBrZXlcIixcbiAgKTtcbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJIb29rcyhob29rczogQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3MgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkIHx8IGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzXCIpO1xuICB9XG5cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGNvbnN0IG1pY3Jvdm1Ib29rcyA9IHJlbmRlclJ1bnRpbWVIb29rcyhob29rcy5taWNyb3ZtSG9va3MpO1xuICBpZiAobWljcm92bUhvb2tzKSB7XG4gICAgcmVuZGVyZWQuTWljcm92bUhvb2tzID0gbWljcm92bUhvb2tzO1xuICB9XG4gIGNvbnN0IG1pY3Jvdm1JbWFnZUhvb2tzID0gcmVuZGVySW1hZ2VIb29rcyhob29rcy5taWNyb3ZtSW1hZ2VIb29rcyk7XG4gIGlmIChtaWNyb3ZtSW1hZ2VIb29rcykge1xuICAgIHJlbmRlcmVkLk1pY3Jvdm1JbWFnZUhvb2tzID0gbWljcm92bUltYWdlSG9va3M7XG4gIH1cbiAgY29uc3QgaGFzSG9va0dyb3VwID0gQm9vbGVhbihyZW5kZXJlZC5NaWNyb3ZtSG9va3MgfHwgcmVuZGVyZWQuTWljcm92bUltYWdlSG9va3MpO1xuICBpZiAoaGFzSG9va0dyb3VwICYmIGhvb2tzLnBvcnQgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBob29rcy5wb3J0IGlzIHJlcXVpcmVkIHdoZW4gcHJvcHMuaG9va3MubWljcm92bUhvb2tzIG9yIHByb3BzLmhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzIGlzIGNvbmZpZ3VyZWRcIixcbiAgICApO1xuICB9XG4gIGlmIChob29rcy5wb3J0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIWhhc0hvb2tHcm91cCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogaG9va3MucG9ydCByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSG9va3Mgb3IgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3NcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJlbmRlcmVkLlBvcnQgPSBub3JtYWxpemVJbnRlZ2VySW5SYW5nZShob29rcy5wb3J0LCBcImhvb2tzLnBvcnRcIiwgMSwgNjU1MzUpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUnVudGltZUhvb2tzKGhvb2tzPzogQXBwVGhlb3J5TWljcm92bVJ1bnRpbWVIb29rcyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkIHtcbiAgaWYgKGhvb2tzID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChob29rcyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSG9va3NcIik7XG4gIH1cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJlc3VtZVwiLCBob29rcy5yZXN1bWUsIFwiaG9va3MubWljcm92bUhvb2tzLnJlc3VtZVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiUmVzdW1lVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnJlc3VtZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3MucmVzdW1lVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJ1blwiLCBob29rcy5ydW4sIFwiaG9va3MubWljcm92bUhvb2tzLnJ1blwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiUnVuVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnJ1blRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3MucnVuVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlN1c3BlbmRcIiwgaG9va3Muc3VzcGVuZCwgXCJob29rcy5taWNyb3ZtSG9va3Muc3VzcGVuZFwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiU3VzcGVuZFRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5zdXNwZW5kVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy5zdXNwZW5kVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlRlcm1pbmF0ZVwiLCBob29rcy50ZXJtaW5hdGUsIFwiaG9va3MubWljcm92bUhvb2tzLnRlcm1pbmF0ZVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiVGVybWluYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3MudGVybWluYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgNjAsXG4gICk7XG4gIGlmIChPYmplY3Qua2V5cyhyZW5kZXJlZCkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgaG9va3MubWljcm92bUhvb2tzIHNldHRpbmdcIik7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJJbWFnZUhvb2tzKGhvb2tzPzogQXBwVGhlb3J5TWljcm92bUltYWdlQnVpbGRIb29rcyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkIHtcbiAgaWYgKGhvb2tzID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChob29rcyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSW1hZ2VIb29rc1wiKTtcbiAgfVxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiUmVhZHlcIiwgaG9va3MucmVhZHksIFwiaG9va3MubWljcm92bUltYWdlSG9va3MucmVhZHlcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJlYWR5VGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnJlYWR5VGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnJlYWR5VGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgMzYwMCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiVmFsaWRhdGVcIiwgaG9va3MudmFsaWRhdGUsIFwiaG9va3MubWljcm92bUltYWdlSG9va3MudmFsaWRhdGVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlZhbGlkYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnZhbGlkYXRlVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnZhbGlkYXRlVGltZW91dEluU2Vjb25kc1wiLFxuICAgIDEsXG4gICAgMzYwMCxcbiAgKTtcbiAgaWYgKE9iamVjdC5rZXlzKHJlbmRlcmVkKS5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBob29rcy5taWNyb3ZtSW1hZ2VIb29rcyBzZXR0aW5nXCIpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gc2V0SG9va01vZGUoXG4gIHRhcmdldDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIGtleTogc3RyaW5nLFxuICBtb2RlOiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKG1vZGUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKG1vZGUpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICBpZiAobm9ybWFsaXplZCAhPT0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlLkVOQUJMRUQgJiYgbm9ybWFsaXplZCAhPT0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlLkRJU0FCTEVEKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgRU5BQkxFRCBvciBESVNBQkxFRGApO1xuICB9XG4gIHRhcmdldFtrZXldID0gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICB0YXJnZXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBrZXk6IHN0cmluZyxcbiAgdmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgbWluOiBudW1iZXIsXG4gIG1heDogbnVtYmVyLFxuKTogdm9pZCB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRhcmdldFtrZXldID0gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UodmFsdWUsIHByb3BOYW1lLCBtaW4sIG1heCk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckxvZ2dpbmcobG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmxvZ2dpbmdcIik7XG4gIH1cbiAgY29uc3QgaGFzQ2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gdW5kZWZpbmVkICYmIGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gbnVsbDtcbiAgY29uc3QgaGFzRGlzYWJsZWQgPSBsb2dnaW5nLmRpc2FibGVkICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNDbG91ZFdhdGNoID09PSBoYXNEaXNhYmxlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZyBtdXN0IHNwZWNpZnkgZXhhY3RseSBvbmUgb2YgY2xvdWRXYXRjaCBvciBkaXNhYmxlZFwiKTtcbiAgfVxuICBpZiAoaGFzRGlzYWJsZWQpIHtcbiAgICBpZiAobG9nZ2luZy5kaXNhYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmRpc2FibGVkIG11c3QgYmUgdHJ1ZSB3aGVuIHByb3ZpZGVkXCIpO1xuICAgIH1cbiAgICByZXR1cm4geyBEaXNhYmxlZDogdHJ1ZSB9O1xuICB9XG4gIHJldHVybiB7IENsb3VkV2F0Y2g6IHJlbmRlckNsb3VkV2F0Y2hMb2dnaW5nKGxvZ2dpbmcuY2xvdWRXYXRjaCkgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2xvdWRXYXRjaExvZ2dpbmcobG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmxvZ2dpbmcuY2xvdWRXYXRjaFwiKTtcbiAgfVxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBpZiAobG9nZ2luZy5sb2dHcm91cCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVuZGVyZWQuTG9nR3JvdXAgPSBub3JtYWxpemVMb2dHcm91cChsb2dnaW5nLmxvZ0dyb3VwKTtcbiAgfVxuICBpZiAobG9nZ2luZy5sb2dTdHJlYW0gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlbmRlcmVkLkxvZ1N0cmVhbSA9IG5vcm1hbGl6ZUxvZ1N0cmVhbShsb2dnaW5nLmxvZ1N0cmVhbSk7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dHcm91cCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcImxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cFwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICEvXlthLXpBLVowLTlfXFwtLy4jXXsxLDUxMn0kLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXAgaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIik7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvZ1N0cmVhbSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcImxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW1cIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAoIS9eW146Kl0qJC8udGVzdChub3JtYWxpemVkKSB8fCBub3JtYWxpemVkLmxlbmd0aCA+IDUxMikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIik7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlc291cmNlcyhcbiAgcmVzb3VyY2VzOiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VSZXNvdXJjZXNbXSB8IHVuZGVmaW5lZCxcbik6IEFycmF5PHsgTWluaW11bU1lbW9yeUluTWlCOiBudW1iZXIgfT4ge1xuICBpZiAoIXJlc291cmNlcyB8fCByZXNvdXJjZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGV4YWN0bHkgMSByZXNvdXJjZXMgZW50cnlcIik7XG4gIH1cbiAgaWYgKHJlc291cmNlcy5sZW5ndGggPiAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGV4YWN0bHkgMSByZXNvdXJjZXMgZW50cnlcIik7XG4gIH1cbiAgY29uc3QgcmVzb3VyY2UgPSByZXNvdXJjZXNbMF07XG4gIGlmIChyZXNvdXJjZSA9PT0gdW5kZWZpbmVkIHx8IHJlc291cmNlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLnJlc291cmNlc1swXVwiKTtcbiAgfVxuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIE1pbmltdW1NZW1vcnlJbk1pQjogbm9ybWFsaXplUG9zaXRpdmVJbnRlZ2VyKHJlc291cmNlLm1pbmltdW1NZW1vcnlJbk1pQiwgXCJyZXNvdXJjZXNbMF0ubWluaW11bU1lbW9yeUluTWlCXCIpLFxuICAgIH0sXG4gIF07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogbnVtYmVyIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPCAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyYCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVJbnRlZ2VySW5SYW5nZSh2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgbWluIHx8IHZhbHVlID4gbWF4KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYW4gaW50ZWdlciBmcm9tICR7bWlufSB0byAke21heH1gKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vRHVwbGljYXRlcyh2YWx1ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWVuLmhhcyh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIGRvZXMgbm90IGFsbG93IGR1cGxpY2F0ZSAke2xhYmVsfSB2YWx1ZXNgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlbmRlclRhZ3ModGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+IHtcbiAgY29uc3QgcmVuZGVyZWQ6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4gPSBbXG4gICAgeyBLZXk6IFwiRnJhbWV3b3JrXCIsIFZhbHVlOiBcIkFwcFRoZW9yeVwiIH0sXG4gICAgeyBLZXk6IFwiQ29tcG9uZW50XCIsIFZhbHVlOiBcIk1pY3Jvdm1JbWFnZVwiIH0sXG4gIF07XG5cbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModGFncyA/PyB7fSkuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICBjb25zdCBub3JtYWxpemVkS2V5ID0ga2V5LnRyaW0oKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWRLZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogdGFnIGtleXMgY2Fubm90IGJlIGVtcHR5XCIpO1xuICAgIH1cbiAgICByZW5kZXJlZC5wdXNoKHsgS2V5OiBub3JtYWxpemVkS2V5LCBWYWx1ZTogdmFsdWUgfSk7XG4gIH1cblxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG4iXX0=