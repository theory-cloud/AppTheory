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
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "1.13.2" };
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
    if (hooks.port !== undefined) {
        rendered.Port = normalizeIntegerInRange(hooks.port, "hooks.port", 1, 65535);
    }
    if (!rendered.MicrovmHooks && !rendered.MicrovmImageHooks) {
        throw new Error("AppTheoryMicrovmImage requires props.hooks.microvmHooks or props.hooks.microvmImageHooks");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBaUQ7QUFDakQsMkNBQXVDO0FBSXZDOztHQUVHO0FBQ0gsSUFBWSxpQ0FLWDtBQUxELFdBQVksaUNBQWlDO0lBQzNDOztPQUVHO0lBQ0gsZ0RBQVcsQ0FBQTtBQUNiLENBQUMsRUFMVyxpQ0FBaUMsaURBQWpDLGlDQUFpQyxRQUs1QztBQUVEOztHQUVHO0FBQ0gsSUFBWSxvQ0FLWDtBQUxELFdBQVksb0NBQW9DO0lBQzlDOztPQUVHO0lBQ0gseURBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQUxXLG9DQUFvQyxvREFBcEMsb0NBQW9DLFFBSy9DO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHdCQVVYO0FBVkQsV0FBWSx3QkFBd0I7SUFDbEM7O09BRUc7SUFDSCxpREFBcUIsQ0FBQTtJQUVyQjs7T0FFRztJQUNILCtDQUFtQixDQUFBO0FBQ3JCLENBQUMsRUFWVyx3QkFBd0Isd0NBQXhCLHdCQUF3QixRQVVuQztBQWlRRDs7Ozs7Ozs7R0FRRztBQUNILE1BQWEscUJBQXNCLFNBQVEsc0JBQVM7SUF5Q2xELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0NBQXNDLENBQUMsQ0FBQztRQUMxRCxDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQUcsYUFBYSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN2QyxNQUFNLFdBQVcsR0FBRyx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFLGFBQWEsQ0FBQyxDQUFDO1FBQzlFLE1BQU0sWUFBWSxHQUFHLDJCQUEy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OlsiaW1wb3J0IHsgQ2ZuUmVzb3VyY2UsIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB9IGZyb20gXCIuL21pY3Jvdm0tbmV0d29yay1jb25uZWN0b3JcIjtcblxuLyoqXG4gKiBBZGRpdGlvbmFsIE9TIGNhcGFiaWxpdGllcyBzdXBwb3J0ZWQgYnkgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkge1xuICAvKipcbiAgICogR3JhbnRzIGFsbCBjdXJyZW50bHkgc3VwcG9ydGVkIE1pY3JvVk0gT1MgY2FwYWJpbGl0aWVzLlxuICAgKi9cbiAgQUxMID0gXCJBTExcIixcbn1cblxuLyoqXG4gKiBDUFUgYXJjaGl0ZWN0dXJlcyBzdXBwb3J0ZWQgYnkgTGFtYmRhIE1pY3JvVk0gaW1hZ2VzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUge1xuICAvKipcbiAgICogQVJNNjQgTWljcm9WTSBpbWFnZSBhcmNoaXRlY3R1cmUuXG4gICAqL1xuICBBUk1fNjQgPSBcIkFSTV82NFwiLFxufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rIG1vZGUgZm9yIExhbWJkYSBNaWNyb1ZNIGltYWdlIGhvb2tzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUge1xuICAvKipcbiAgICogRGlzYWJsZSB0aGUgbGlmZWN5Y2xlIGhvb2suXG4gICAqL1xuICBESVNBQkxFRCA9IFwiRElTQUJMRURcIixcblxuICAvKipcbiAgICogRW5hYmxlIHRoZSBsaWZlY3ljbGUgaG9vay5cbiAgICovXG4gIEVOQUJMRUQgPSBcIkVOQUJMRURcIixcbn1cblxuLyoqXG4gKiBDb2RlIGFydGlmYWN0IGxvY2F0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNvZGVBcnRpZmFjdCB7XG4gIC8qKlxuICAgKiBUaGUgVVJJIG9mIHRoZSBjb2RlIGFydGlmYWN0LCBzdWNoIGFzIGFuIEFtYXpvbiBTMyBwYXRoIG9yIEFtYXpvbiBFQ1IgaW1hZ2UgVVJJLlxuICAgKi9cbiAgcmVhZG9ubHkgdXJpOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ1BVIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbiB7XG4gIC8qKlxuICAgKiBUaGUgQ1BVIGFyY2hpdGVjdHVyZS5cbiAgICpcbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NFxuICAgKi9cbiAgcmVhZG9ubHkgYXJjaGl0ZWN0dXJlPzogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlO1xufVxuXG4vKipcbiAqIEVudmlyb25tZW50IHZhcmlhYmxlIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGUge1xuICAvKipcbiAgICogRW52aXJvbm1lbnQgdmFyaWFibGUga2V5LlxuICAgKi9cbiAgcmVhZG9ubHkga2V5OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlIHZhbHVlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsdWU6IHN0cmluZztcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9va3MgaW52b2tlZCBkdXJpbmcgTWljcm9WTSBpbWFnZSBidWlsZCBldmVudHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQnVpbGRIb29rcyB7XG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSByZWFkeSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSByZWFkeT86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcmVhZHkgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHJlYWR5VGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgdmFsaWRhdGUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHZhbGlkYXRlIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSB2YWxpZGF0ZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2tzIGludm9rZWQgZHVyaW5nIE1pY3JvVk0gZXZlbnRzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3Mge1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcmVzdW1lIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc3VtZT86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcmVzdW1lIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSByZXN1bWVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBydW4gaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcnVuPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSBydW4gaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHJ1blRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHN1c3BlbmQgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgc3VzcGVuZD86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgc3VzcGVuZCBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3VzcGVuZFRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHRlcm1pbmF0ZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSB0ZXJtaW5hdGU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHRlcm1pbmF0ZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgdGVybWluYXRlVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBIb29rIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3Mge1xuICAvKipcbiAgICogTGlmZWN5Y2xlIGhvb2tzIGZvciBNaWNyb1ZNIGV2ZW50cy5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1Ib29rcz86IEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3M7XG5cbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rcyBmb3IgTWljcm9WTSBpbWFnZSBidWlsZCBldmVudHMuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2VIb29rcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3M7XG5cbiAgLyoqXG4gICAqIFRoZSBwb3J0IG51bWJlciBvbiB3aGljaCB0aGUgaG9va3MgbGlzdGVuZXIgcnVucy5cbiAgICovXG4gIHJlYWRvbmx5IHBvcnQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvdWRXYXRjaCBMb2dzIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UgbG9nZ2luZy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgQ2xvdWRXYXRjaCBMb2dzIGxvZyBncm91cCB0byBzZW5kIGxvZ3MgdG8uXG4gICAqL1xuICByZWFkb25seSBsb2dHcm91cD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIENsb3VkV2F0Y2ggTG9ncyBsb2cgc3RyZWFtIHdpdGhpbiB0aGUgbG9nIGdyb3VwLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nU3RyZWFtPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIExvZ2dpbmcgY29uZmlndXJhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHtcbiAgLyoqXG4gICAqIENvbmZpZ3VyYXRpb24gZm9yIHNlbmRpbmcgbG9ncyB0byBBbWF6b24gQ2xvdWRXYXRjaCBMb2dzLlxuICAgKi9cbiAgcmVhZG9ubHkgY2xvdWRXYXRjaD86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nO1xuXG4gIC8qKlxuICAgKiBTZXQgdG8gdHJ1ZSB0byBkaXNhYmxlIE1pY3JvVk0gbG9nZ2luZy5cbiAgICovXG4gIHJlYWRvbmx5IGRpc2FibGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBSZXNvdXJjZSByZXF1aXJlbWVudHMgZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzIHtcbiAgLyoqXG4gICAqIFRoZSBtaW5pbXVtIGFtb3VudCBvZiBtZW1vcnkgaW4gTWlCIHRvIGFsbG9jYXRlIHRvIHRoZSBNaWNyb1ZNLlxuICAgKi9cbiAgcmVhZG9ubHkgbWluaW11bU1lbW9yeUluTWlCOiBudW1iZXI7XG59XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgQXBwVGhlb3J5TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVByb3BzIHtcbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgZGVzY3JpcHRpb24gb2YgdGhlIHZlcnNpb24uXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBiYXNlIE1pY3JvVk0gaW1hZ2UgdXNlZC5cbiAgICovXG4gIHJlYWRvbmx5IGJhc2VJbWFnZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgc3BlY2lmaWMgdmVyc2lvbiBvZiB0aGUgYmFzZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgYmFzZUltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBJQU0gYnVpbGQgcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGJ1aWxkUm9sZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY29kZSBhcnRpZmFjdCBmb3IgdGhpcyB2ZXJzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgY29kZUFydGlmYWN0OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3Q7XG5cbiAgLyoqXG4gICAqIFRoZSBsaXN0IG9mIGVncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgYXZhaWxhYmxlIHRvIHRoZSBNaWNyb1ZNIGF0IHJ1bnRpbWUuXG4gICAqXG4gICAqIFBhc3MgYEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yYCBpbnN0YW5jZXMgb3IgY29tcGF0aWJsZSBjb25uZWN0b3IgcmVmZXJlbmNlcy5cbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW107XG5cbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rIGNvbmZpZ3VyYXRpb24gZm9yIE1pY3JvVk1zIGFuZCBNaWNyb1ZNIGltYWdlcy5cbiAgICovXG4gIHJlYWRvbmx5IGhvb2tzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VIb29rcztcblxuICAvKipcbiAgICogQ29uZmlndXJhdGlvbiBmb3IgTWljcm9WTSBsb2dnaW5nIG91dHB1dC5cbiAgICpcbiAgICogU3BlY2lmeSBleGFjdGx5IG9uZSBvZiBgY2xvdWRXYXRjaGAgb3IgYGRpc2FibGVkOiB0cnVlYC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSByZXNvdXJjZSByZXF1aXJlbWVudHMgZm9yIHRoZSBNaWNyb1ZNLlxuICAgKlxuICAgKiBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlIGN1cnJlbnRseSBhY2NlcHRzIGV4YWN0bHkgb25lIFJlc291cmNlcyBlbnRyeS5cbiAgICovXG4gIHJlYWRvbmx5IHJlc291cmNlczogQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgT1MgY2FwYWJpbGl0aWVzIGdyYW50ZWQgdG8gdGhlIE1pY3JvVk0gcnVudGltZSBlbnZpcm9ubWVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgW0FwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTExdXG4gICAqL1xuICByZWFkb25seSBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXTtcblxuICAvKipcbiAgICogVGhlIGxpc3Qgb2Ygc3VwcG9ydGVkIENQVSBjb25maWd1cmF0aW9ucyBmb3IgdGhlIE1pY3JvVk0uXG4gICAqXG4gICAqIEBkZWZhdWx0IFt7IGFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9XVxuICAgKi9cbiAgcmVhZG9ubHkgY3B1Q29uZmlndXJhdGlvbnM/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVDb25maWd1cmF0aW9uW107XG5cbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlcyBzZXQgaW4gdGhlIE1pY3JvVk0gcnVudGltZSBlbnZpcm9ubWVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgW11cbiAgICovXG4gIHJlYWRvbmx5IGVudmlyb25tZW50VmFyaWFibGVzPzogQXBwVGhlb3J5TWljcm92bUltYWdlRW52aXJvbm1lbnRWYXJpYWJsZVtdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIENsb3VkRm9ybWF0aW9uIHRhZ3MgdG8gYXBwbHkgdG8gdGhlIE1pY3JvVk0gaW1hZ2UuXG4gICAqL1xuICByZWFkb25seSB0YWdzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuLyoqXG4gKiBBcHBUaGVvcnkgQ0RLIGNvbnN0cnVjdCBmb3IgQVdTIExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBpbnRlbnRpb25hbGx5IGRlcGxveW1lbnQtb25seTogaXQgY3JlYXRlcyB0aGUgQ2xvdWRGb3JtYXRpb25cbiAqIGBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlYCByZXNvdXJjZSBmcm9tIGNhbGxlci1wcm92aWRlZCBjb2RlIGFydGlmYWN0LCBiYXNlIGltYWdlLFxuICogYnVpbGQgcm9sZSwgbGlmZWN5Y2xlIGhvb2tzLCBsb2dnaW5nIGNvbmZpZ3VyYXRpb24sIHJlc291cmNlIHJlcXVpcmVtZW50cywgYW5kXG4gKiBBcHBUaGVvcnkgTWljcm9WTSBuZXR3b3JrLWNvbm5lY3RvciByZWZlcmVuY2VzLiBSdW50aW1lIGNvbnRyb2xsZXIgYmVoYXZpb3Igc3RheXMgaW5cbiAqIHRoZSBBcHBUaGVvcnkgcnVudGltZSBjb250cmFjdC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBDbG91ZEZvcm1hdGlvbiBNaWNyb1ZNIGltYWdlIHJlc291cmNlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogQ2ZuUmVzb3VyY2U7XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIG5hbWUgcmV0dXJuZWQgYnkgUmVmLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZU5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGN1cnJlbnQgaW1hZ2Ugc3RhdGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlU3RhdGU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxhdGVzdCBhY3RpdmUgaW1hZ2UgdmVyc2lvbi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBsYXRlc3RBY3RpdmVJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxhdGVzdCBmYWlsZWQgaW1hZ2UgdmVyc2lvbiwgaWYgYW55LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxhdGVzdEZhaWxlZEltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGltZXN0YW1wIHdoZW4gdGhlIGltYWdlIHdhcyBjcmVhdGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNyZWF0ZWRBdDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGltZXN0YW1wIHdoZW4gdGhlIGltYWdlIHdhcyBsYXN0IHVwZGF0ZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdXBkYXRlZEF0OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHNcIik7XG4gICAgfVxuXG4gICAgY29uc3QgbmFtZSA9IG5vcm1hbGl6ZU5hbWUocHJvcHMubmFtZSk7XG4gICAgY29uc3QgZGVzY3JpcHRpb24gPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhwcm9wcy5kZXNjcmlwdGlvbiwgXCJkZXNjcmlwdGlvblwiKTtcbiAgICBjb25zdCBiYXNlSW1hZ2VBcm4gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMuYmFzZUltYWdlQXJuLCBcImJhc2VJbWFnZUFyblwiLCAyMDQ4KTtcbiAgICBjb25zdCBiYXNlSW1hZ2VWZXJzaW9uID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLmJhc2VJbWFnZVZlcnNpb24sIFwiYmFzZUltYWdlVmVyc2lvblwiLCAyMDQ4KTtcbiAgICBjb25zdCBidWlsZFJvbGVBcm4gPSBub3JtYWxpemVCdWlsZFJvbGVBcm4ocHJvcHMuYnVpbGRSb2xlQXJuKTtcbiAgICBjb25zdCBjb2RlQXJ0aWZhY3QgPSByZW5kZXJDb2RlQXJ0aWZhY3QocHJvcHMuY29kZUFydGlmYWN0KTtcbiAgICBjb25zdCBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMocHJvcHMuZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMpO1xuICAgIGNvbnN0IGhvb2tzID0gcmVuZGVySG9va3MocHJvcHMuaG9va3MpO1xuICAgIGNvbnN0IGxvZ2dpbmcgPSByZW5kZXJMb2dnaW5nKHByb3BzLmxvZ2dpbmcpO1xuICAgIGNvbnN0IHJlc291cmNlcyA9IHJlbmRlclJlc291cmNlcyhwcm9wcy5yZXNvdXJjZXMpO1xuICAgIGNvbnN0IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyA9IG5vcm1hbGl6ZUFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyhwcm9wcy5hZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMpO1xuICAgIGNvbnN0IGNwdUNvbmZpZ3VyYXRpb25zID0gcmVuZGVyQ3B1Q29uZmlndXJhdGlvbnMocHJvcHMuY3B1Q29uZmlndXJhdGlvbnMpO1xuICAgIGNvbnN0IGVudmlyb25tZW50VmFyaWFibGVzID0gcmVuZGVyRW52aXJvbm1lbnRWYXJpYWJsZXMocHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMpO1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2UgPSBuZXcgQ2ZuUmVzb3VyY2UodGhpcywgXCJNaWNyb3ZtSW1hZ2VcIiwge1xuICAgICAgdHlwZTogXCJBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlXCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEFkZGl0aW9uYWxPc0NhcGFiaWxpdGllczogYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzLFxuICAgICAgICBCYXNlSW1hZ2VBcm46IGJhc2VJbWFnZUFybixcbiAgICAgICAgQmFzZUltYWdlVmVyc2lvbjogYmFzZUltYWdlVmVyc2lvbixcbiAgICAgICAgQnVpbGRSb2xlQXJuOiBidWlsZFJvbGVBcm4sXG4gICAgICAgIENvZGVBcnRpZmFjdDogY29kZUFydGlmYWN0LFxuICAgICAgICBDcHVDb25maWd1cmF0aW9uczogY3B1Q29uZmlndXJhdGlvbnMsXG4gICAgICAgIERlc2NyaXB0aW9uOiBkZXNjcmlwdGlvbixcbiAgICAgICAgRWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IGVncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczogZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgICAgIEhvb2tzOiBob29rcyxcbiAgICAgICAgTG9nZ2luZzogbG9nZ2luZyxcbiAgICAgICAgTmFtZTogbmFtZSxcbiAgICAgICAgUmVzb3VyY2VzOiByZXNvdXJjZXMsXG4gICAgICAgIFRhZ3M6IHJlbmRlclRhZ3MocHJvcHMudGFncyksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VOYW1lID0gdGhpcy5taWNyb3ZtSW1hZ2UucmVmO1xuICAgIHRoaXMubWljcm92bUltYWdlQXJuID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiSW1hZ2VBcm5cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLm1pY3Jvdm1JbWFnZVN0YXRlID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiU3RhdGVcIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvbiA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiTGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5jcmVhdGVkQXQgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJDcmVhdGVkQXRcIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLnVwZGF0ZWRBdCA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIlVwZGF0ZWRBdFwiKS50b1N0cmluZygpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5hbWUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5hbWUgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJuYW1lXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW0EtWmEtejAtOV8tXXsxLDY0fSQvLnRlc3QobmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbmFtZSBtdXN0IGJlIDEtNjQgY2hhcmFjdGVycyB1c2luZyBsZXR0ZXJzLCBudW1iZXJzLCBoeXBoZW5zLCBvciB1bmRlcnNjb3Jlc1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5hbWU7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSkudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIHByb3BOYW1lKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIC9cXHMvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6ICR7cHJvcE5hbWV9IG11c3QgYmUgYXQgbW9zdCAke21heExlbmd0aH0gY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCdWlsZFJvbGVBcm4odmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGNvbnN0IGFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZSwgXCJidWlsZFJvbGVBcm5cIiwgMjA0OCk7XG4gIGlmIChcbiAgICAhVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJlxuICAgICEvXmFybjphd3NbYS16QS1aLV0qOmlhbTo6XFxkezEyfTpyb2xlXFwvP1thLXpBLVpfMC05Kz0sLkBcXC1fL10rJC8udGVzdChhcm4pXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogYnVpbGRSb2xlQXJuIG11c3QgYmUgYW4gSUFNIHJvbGUgQVJOXCIpO1xuICB9XG4gIHJldHVybiBhcm47XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGVBcnRpZmFjdChcbiAgY29kZUFydGlmYWN0OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3QgfCB1bmRlZmluZWQsXG4pOiB7IFVyaTogc3RyaW5nIH0ge1xuICBpZiAoY29kZUFydGlmYWN0ID09PSB1bmRlZmluZWQgfHwgY29kZUFydGlmYWN0ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmNvZGVBcnRpZmFjdFwiKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIFVyaTogbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGNvZGVBcnRpZmFjdC51cmksIFwiY29kZUFydGlmYWN0LnVyaVwiLCAyMDQ4KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgY29ubmVjdG9yczogcmVhZG9ubHkgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW10gfCB1bmRlZmluZWQsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghY29ubmVjdG9ycyB8fCBjb25uZWN0b3JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGVncmVzc05ldHdvcmtDb25uZWN0b3JzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHN1cHBvcnRzIGF0IG1vc3QgMTAgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgZW50cmllc1wiKTtcbiAgfVxuXG4gIGNvbnN0IGFybnMgPSBjb25uZWN0b3JzLm1hcCgoY29ubmVjdG9yLCBpbmRleCkgPT4ge1xuICAgIGlmIChjb25uZWN0b3IgPT09IHVuZGVmaW5lZCB8fCBjb25uZWN0b3IgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBhcm4gPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhcbiAgICAgIGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yQXJuLFxuICAgICAgYGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuYCxcbiAgICApO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGFybikgJiYgL1xccy8udGVzdChhcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuIG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYXJuO1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgXCJlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHlbXSxcbik6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdIHtcbiAgY29uc3QgY2FwYWJpbGl0aWVzID0gdmFsdWVzID8/IFtBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMXTtcbiAgaWYgKGNhcGFiaWxpdGllcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMgZW50cnlcIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IGNhcGFiaWxpdGllcy5tYXAoKGNhcGFiaWxpdHksIGluZGV4KSA9PiB7XG4gICAgaWYgKFN0cmluZyhjYXBhYmlsaXR5KS50cmltKCkudG9VcHBlckNhc2UoKSAhPT0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllc1ske2luZGV4fV0gbXVzdCBiZSBBTExgKTtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTEw7XG4gIH0pO1xuICBhc3NlcnROb0R1cGxpY2F0ZXMobm9ybWFsaXplZCwgXCJhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXNcIik7XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDcHVDb25maWd1cmF0aW9ucyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbltdLFxuKTogQXJyYXk8eyBBcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZSB9PiB7XG4gIGNvbnN0IGNwdUNvbmZpZ3VyYXRpb25zID0gdmFsdWVzID8/IFt7IGFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9XTtcbiAgaWYgKGNwdUNvbmZpZ3VyYXRpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGNwdUNvbmZpZ3VyYXRpb25zIGVudHJ5XCIpO1xuICB9XG4gIHJldHVybiBjcHVDb25maWd1cmF0aW9ucy5tYXAoKGNwdSwgaW5kZXgpID0+IHtcbiAgICBpZiAoY3B1ID09PSB1bmRlZmluZWQgfHwgY3B1ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5jcHVDb25maWd1cmF0aW9uc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3QgYXJjaGl0ZWN0dXJlID0gU3RyaW5nKGNwdS5hcmNoaXRlY3R1cmUgPz8gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NClcbiAgICAgIC50cmltKClcbiAgICAgIC50b1VwcGVyQ2FzZSgpO1xuICAgIGlmIChhcmNoaXRlY3R1cmUgIT09IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiBjcHVDb25maWd1cmF0aW9uc1ske2luZGV4fV0uYXJjaGl0ZWN0dXJlIG11c3QgYmUgQVJNXzY0YCk7XG4gICAgfVxuICAgIHJldHVybiB7IEFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCB9O1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRW52aXJvbm1lbnRWYXJpYWJsZXMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGVbXSxcbik6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4ge1xuICBpZiAoKHZhbHVlcz8ubGVuZ3RoID8/IDApID4gNTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgYXQgbW9zdCA1MCBlbnZpcm9ubWVudFZhcmlhYmxlcyBlbnRyaWVzXCIpO1xuICB9XG5cbiAgY29uc3QgcmVuZGVyZWQgPSAodmFsdWVzID8/IFtdKS5tYXAoKGVudHJ5LCBpbmRleCkgPT4ge1xuICAgIGlmIChlbnRyeSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGVudHJ5LmtleSwgYGVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS5rZXlgLCAyNTYpO1xuICAgIGNvbnN0IHZhbHVlID0gZW50cnkudmFsdWUgPT09IHVuZGVmaW5lZCB8fCBlbnRyeS52YWx1ZSA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IFN0cmluZyhlbnRyeS52YWx1ZSk7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS52YWx1ZWApO1xuICAgIH1cbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgdmFsdWUubGVuZ3RoID4gNDA5Nikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XS52YWx1ZSBtdXN0IGJlIGF0IG1vc3QgNDA5NiBjaGFyYWN0ZXJzYCk7XG4gICAgfVxuICAgIHJldHVybiB7IEtleToga2V5LCBWYWx1ZTogdmFsdWUgfTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKFxuICAgIHJlbmRlcmVkLm1hcCgoZW50cnkpID0+IGVudHJ5LktleSksXG4gICAgXCJlbnZpcm9ubWVudFZhcmlhYmxlcyBrZXlcIixcbiAgKTtcbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJIb29rcyhob29rczogQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3MgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkIHx8IGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzXCIpO1xuICB9XG5cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGNvbnN0IG1pY3Jvdm1Ib29rcyA9IHJlbmRlclJ1bnRpbWVIb29rcyhob29rcy5taWNyb3ZtSG9va3MpO1xuICBpZiAobWljcm92bUhvb2tzKSB7XG4gICAgcmVuZGVyZWQuTWljcm92bUhvb2tzID0gbWljcm92bUhvb2tzO1xuICB9XG4gIGNvbnN0IG1pY3Jvdm1JbWFnZUhvb2tzID0gcmVuZGVySW1hZ2VIb29rcyhob29rcy5taWNyb3ZtSW1hZ2VIb29rcyk7XG4gIGlmIChtaWNyb3ZtSW1hZ2VIb29rcykge1xuICAgIHJlbmRlcmVkLk1pY3Jvdm1JbWFnZUhvb2tzID0gbWljcm92bUltYWdlSG9va3M7XG4gIH1cbiAgaWYgKGhvb2tzLnBvcnQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlbmRlcmVkLlBvcnQgPSBub3JtYWxpemVJbnRlZ2VySW5SYW5nZShob29rcy5wb3J0LCBcImhvb2tzLnBvcnRcIiwgMSwgNjU1MzUpO1xuICB9XG4gIGlmICghcmVuZGVyZWQuTWljcm92bUhvb2tzICYmICFyZW5kZXJlZC5NaWNyb3ZtSW1hZ2VIb29rcykge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5ob29rcy5taWNyb3ZtSG9va3Mgb3IgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3NcIik7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSdW50aW1lSG9va3MoaG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuICBpZiAoaG9va3MgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzLm1pY3Jvdm1Ib29rc1wiKTtcbiAgfVxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiUmVzdW1lXCIsIGhvb2tzLnJlc3VtZSwgXCJob29rcy5taWNyb3ZtSG9va3MucmVzdW1lXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSZXN1bWVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MucmVzdW1lVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy5yZXN1bWVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiUnVuXCIsIGhvb2tzLnJ1biwgXCJob29rcy5taWNyb3ZtSG9va3MucnVuXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSdW5UaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MucnVuVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy5ydW5UaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiU3VzcGVuZFwiLCBob29rcy5zdXNwZW5kLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5zdXNwZW5kXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJTdXNwZW5kVGltZW91dEluU2Vjb25kc1wiLFxuICAgIGhvb2tzLnN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgc2V0SG9va01vZGUocmVuZGVyZWQsIFwiVGVybWluYXRlXCIsIGhvb2tzLnRlcm1pbmF0ZSwgXCJob29rcy5taWNyb3ZtSG9va3MudGVybWluYXRlXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJUZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MudGVybWluYXRlVGltZW91dEluU2Vjb25kcyxcbiAgICBcImhvb2tzLm1pY3Jvdm1Ib29rcy50ZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICA2MCxcbiAgKTtcbiAgaWYgKE9iamVjdC5rZXlzKHJlbmRlcmVkKS5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgYXQgbGVhc3QgMSBob29rcy5taWNyb3ZtSG9va3Mgc2V0dGluZ1wiKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckltYWdlSG9va3MoaG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuICBpZiAoaG9va3MgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKGhvb2tzID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzXCIpO1xuICB9XG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSZWFkeVwiLCBob29rcy5yZWFkeSwgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy5yZWFkeVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiUmVhZHlUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MucmVhZHlUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUltYWdlSG9va3MucmVhZHlUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICAzNjAwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJWYWxpZGF0ZVwiLCBob29rcy52YWxpZGF0ZSwgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy52YWxpZGF0ZVwiKTtcbiAgc2V0T3B0aW9uYWxJbnRlZ2VyKFxuICAgIHJlbmRlcmVkLFxuICAgIFwiVmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3MudmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUltYWdlSG9va3MudmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgMSxcbiAgICAzNjAwLFxuICApO1xuICBpZiAoT2JqZWN0LmtleXMocmVuZGVyZWQpLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzIHNldHRpbmdcIik7XG4gIH1cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuXG5mdW5jdGlvbiBzZXRIb29rTW9kZShcbiAgdGFyZ2V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBzdHJpbmcsXG4gIG1vZGU6IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZSB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAobW9kZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcobW9kZSkudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gIGlmIChub3JtYWxpemVkICE9PSBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUuRU5BQkxFRCAmJiBub3JtYWxpemVkICE9PSBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGUuRElTQUJMRUQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBFTkFCTEVEIG9yIERJU0FCTEVEYCk7XG4gIH1cbiAgdGFyZ2V0W2tleV0gPSBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBzZXRPcHRpb25hbEludGVnZXIoXG4gIHRhcmdldDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIGtleTogc3RyaW5nLFxuICB2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBtaW46IG51bWJlcixcbiAgbWF4OiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGFyZ2V0W2tleV0gPSBub3JtYWxpemVJbnRlZ2VySW5SYW5nZSh2YWx1ZSwgcHJvcE5hbWUsIG1pbiwgbWF4KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyTG9nZ2luZyhsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMubG9nZ2luZ1wiKTtcbiAgfVxuICBjb25zdCBoYXNDbG91ZFdhdGNoID0gbG9nZ2luZy5jbG91ZFdhdGNoICE9PSB1bmRlZmluZWQgJiYgbG9nZ2luZy5jbG91ZFdhdGNoICE9PSBudWxsO1xuICBjb25zdCBoYXNEaXNhYmxlZCA9IGxvZ2dpbmcuZGlzYWJsZWQgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0Nsb3VkV2F0Y2ggPT09IGhhc0Rpc2FibGVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nIG11c3Qgc3BlY2lmeSBleGFjdGx5IG9uZSBvZiBjbG91ZFdhdGNoIG9yIGRpc2FibGVkXCIpO1xuICB9XG4gIGlmIChoYXNEaXNhYmxlZCkge1xuICAgIGlmIChsb2dnaW5nLmRpc2FibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcuZGlzYWJsZWQgbXVzdCBiZSB0cnVlIHdoZW4gcHJvdmlkZWRcIik7XG4gICAgfVxuICAgIHJldHVybiB7IERpc2FibGVkOiB0cnVlIH07XG4gIH1cbiAgcmV0dXJuIHsgQ2xvdWRXYXRjaDogcmVuZGVyQ2xvdWRXYXRjaExvZ2dpbmcobG9nZ2luZy5jbG91ZFdhdGNoKSB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDbG91ZFdhdGNoTG9nZ2luZyhsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZyB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMubG9nZ2luZy5jbG91ZFdhdGNoXCIpO1xuICB9XG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGlmIChsb2dnaW5nLmxvZ0dyb3VwICE9PSB1bmRlZmluZWQpIHtcbiAgICByZW5kZXJlZC5Mb2dHcm91cCA9IG5vcm1hbGl6ZUxvZ0dyb3VwKGxvZ2dpbmcubG9nR3JvdXApO1xuICB9XG4gIGlmIChsb2dnaW5nLmxvZ1N0cmVhbSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVuZGVyZWQuTG9nU3RyZWFtID0gbm9ybWFsaXplTG9nU3RyZWFtKGxvZ2dpbmcubG9nU3RyZWFtKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvZ0dyb3VwKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW2EtekEtWjAtOV9cXC0vLiNdezEsNTEyfSQvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cCBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9nU3RyZWFtKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbVwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICghL15bXjoqXSokLy50ZXN0KG5vcm1hbGl6ZWQpIHx8IG5vcm1hbGl6ZWQubGVuZ3RoID4gNTEyKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbSBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUmVzb3VyY2VzKFxuICByZXNvdXJjZXM6IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlc1tdIHwgdW5kZWZpbmVkLFxuKTogQXJyYXk8eyBNaW5pbXVtTWVtb3J5SW5NaUI6IG51bWJlciB9PiB7XG4gIGlmICghcmVzb3VyY2VzIHx8IHJlc291cmNlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgZXhhY3RseSAxIHJlc291cmNlcyBlbnRyeVwiKTtcbiAgfVxuICBpZiAocmVzb3VyY2VzLmxlbmd0aCA+IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgZXhhY3RseSAxIHJlc291cmNlcyBlbnRyeVwiKTtcbiAgfVxuICBjb25zdCByZXNvdXJjZSA9IHJlc291cmNlc1swXTtcbiAgaWYgKHJlc291cmNlID09PSB1bmRlZmluZWQgfHwgcmVzb3VyY2UgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMucmVzb3VyY2VzWzBdXCIpO1xuICB9XG4gIHJldHVybiBbXG4gICAge1xuICAgICAgTWluaW11bU1lbW9yeUluTWlCOiBub3JtYWxpemVQb3NpdGl2ZUludGVnZXIocmVzb3VyY2UubWluaW11bU1lbW9yeUluTWlCLCBcInJlc291cmNlc1swXS5taW5pbXVtTWVtb3J5SW5NaUJcIiksXG4gICAgfSxcbiAgXTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUG9zaXRpdmVJbnRlZ2VyKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPCBtaW4gfHwgdmFsdWUgPiBtYXgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBpbnRlZ2VyIGZyb20gJHttaW59IHRvICR7bWF4fWApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9EdXBsaWNhdGVzKHZhbHVlczogcmVhZG9ubHkgc3RyaW5nW10sIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZW4uaGFzKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgZG9lcyBub3QgYWxsb3cgZHVwbGljYXRlICR7bGFiZWx9IHZhbHVlc2ApO1xuICAgIH1cbiAgICBzZWVuLmFkZCh2YWx1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVuZGVyVGFncyh0YWdzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4ge1xuICBjb25zdCByZW5kZXJlZDogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiA9IFtcbiAgICB7IEtleTogXCJGcmFtZXdvcmtcIiwgVmFsdWU6IFwiQXBwVGhlb3J5XCIgfSxcbiAgICB7IEtleTogXCJDb21wb25lbnRcIiwgVmFsdWU6IFwiTWljcm92bUltYWdlXCIgfSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh0YWdzID8/IHt9KS5zb3J0KChbYV0sIFtiXSkgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRLZXkgPSBrZXkudHJpbSgpO1xuICAgIGlmICghbm9ybWFsaXplZEtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiB0YWcga2V5cyBjYW5ub3QgYmUgZW1wdHlcIik7XG4gICAgfVxuICAgIHJlbmRlcmVkLnB1c2goeyBLZXk6IG5vcm1hbGl6ZWRLZXksIFZhbHVlOiB2YWx1ZSB9KTtcbiAgfVxuXG4gIHJldHVybiByZW5kZXJlZDtcbn1cbiJdfQ==