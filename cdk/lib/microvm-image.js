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
AppTheoryMicrovmImage[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage", version: "1.14.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1pbWFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0taW1hZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBaUQ7QUFDakQsMkNBQXVDO0FBY3ZDOztHQUVHO0FBQ0gsSUFBWSxpQ0FLWDtBQUxELFdBQVksaUNBQWlDO0lBQzNDOztPQUVHO0lBQ0gsZ0RBQVcsQ0FBQTtBQUNiLENBQUMsRUFMVyxpQ0FBaUMsaURBQWpDLGlDQUFpQyxRQUs1QztBQUVEOztHQUVHO0FBQ0gsSUFBWSxvQ0FLWDtBQUxELFdBQVksb0NBQW9DO0lBQzlDOztPQUVHO0lBQ0gseURBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQUxXLG9DQUFvQyxvREFBcEMsb0NBQW9DLFFBSy9DO0FBRUQ7O0dBRUc7QUFDSCxJQUFZLHdCQVVYO0FBVkQsV0FBWSx3QkFBd0I7SUFDbEM7O09BRUc7SUFDSCxpREFBcUIsQ0FBQTtJQUVyQjs7T0FFRztJQUNILCtDQUFtQixDQUFBO0FBQ3JCLENBQUMsRUFWVyx3QkFBd0Isd0NBQXhCLHdCQUF3QixRQVVuQztBQWlRRDs7Ozs7Ozs7R0FRRztBQUNILE1BQWEscUJBQXNCLFNBQVEsc0JBQVM7SUF5Q2xELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0NBQXNDLENBQUMsQ0FBQztRQUMxRCxDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQUcsYUFBYSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN2QyxNQUFNLFdBQVcsR0FBRyx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFLGFBQWEsQ0FBQyxDQUFDO1FBQzlFLE1BQU0sWUFBWSxHQUFHLDJCQUEy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OlsiaW1wb3J0IHsgQ2ZuUmVzb3VyY2UsIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB9IGZyb20gXCIuL21pY3Jvdm0tbmV0d29yay1jb25uZWN0b3JcIjtcblxuLyoqXG4gKiBSZWZlcmVuY2UgdG8gYSBMYW1iZGEgTWljcm9WTSBpbWFnZSB1c2FibGUgYnkgTWljcm9WTSBjb250cm9sbGVyIGNvbnN0cnVjdHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB7XG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlQXJuOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQWRkaXRpb25hbCBPUyBjYXBhYmlsaXRpZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5IHtcbiAgLyoqXG4gICAqIEdyYW50cyBhbGwgY3VycmVudGx5IHN1cHBvcnRlZCBNaWNyb1ZNIE9TIGNhcGFiaWxpdGllcy5cbiAgICovXG4gIEFMTCA9IFwiQUxMXCIsXG59XG5cbi8qKlxuICogQ1BVIGFyY2hpdGVjdHVyZXMgc3VwcG9ydGVkIGJ5IExhbWJkYSBNaWNyb1ZNIGltYWdlcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlIHtcbiAgLyoqXG4gICAqIEFSTTY0IE1pY3JvVk0gaW1hZ2UgYXJjaGl0ZWN0dXJlLlxuICAgKi9cbiAgQVJNXzY0ID0gXCJBUk1fNjRcIixcbn1cblxuLyoqXG4gKiBMaWZlY3ljbGUgaG9vayBtb2RlIGZvciBMYW1iZGEgTWljcm9WTSBpbWFnZSBob29rcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHtcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGxpZmVjeWNsZSBob29rLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcIkRJU0FCTEVEXCIsXG5cbiAgLyoqXG4gICAqIEVuYWJsZSB0aGUgbGlmZWN5Y2xlIGhvb2suXG4gICAqL1xuICBFTkFCTEVEID0gXCJFTkFCTEVEXCIsXG59XG5cbi8qKlxuICogQ29kZSBhcnRpZmFjdCBsb2NhdGlvbiBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDb2RlQXJ0aWZhY3Qge1xuICAvKipcbiAgICogVGhlIFVSSSBvZiB0aGUgY29kZSBhcnRpZmFjdCwgc3VjaCBhcyBhbiBBbWF6b24gUzMgcGF0aCBvciBBbWF6b24gRUNSIGltYWdlIFVSSS5cbiAgICovXG4gIHJlYWRvbmx5IHVyaTogc3RyaW5nO1xufVxuXG4vKipcbiAqIENQVSBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUNvbmZpZ3VyYXRpb24ge1xuICAvKipcbiAgICogVGhlIENQVSBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjRcbiAgICovXG4gIHJlYWRvbmx5IGFyY2hpdGVjdHVyZT86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZTtcbn1cblxuLyoqXG4gKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBmb3IgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VFbnZpcm9ubWVudFZhcmlhYmxlIHtcbiAgLyoqXG4gICAqIEVudmlyb25tZW50IHZhcmlhYmxlIGtleS5cbiAgICovXG4gIHJlYWRvbmx5IGtleTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZSB2YWx1ZS5cbiAgICovXG4gIHJlYWRvbmx5IHZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogTGlmZWN5Y2xlIGhvb2tzIGludm9rZWQgZHVyaW5nIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3Mge1xuICAvKipcbiAgICogV2hldGhlciB0aGUgcmVhZHkgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVhZHk/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlYWR5IGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSByZWFkeVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHZhbGlkYXRlIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHZhbGlkYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB2YWxpZGF0ZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGVUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIExpZmVjeWNsZSBob29rcyBpbnZva2VkIGR1cmluZyBNaWNyb1ZNIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzIHtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHJlc3VtZSBob29rIGlzIGVuYWJsZWQuXG4gICAqL1xuICByZWFkb25seSByZXN1bWU/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHJlc3VtZSBob29rIHRvIGNvbXBsZXRlLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzdW1lVGltZW91dEluU2Vjb25kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGUgcnVuIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHJ1bj86IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZTtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gdGltZSBpbiBzZWNvbmRzIGZvciB0aGUgcnVuIGhvb2sgdG8gY29tcGxldGUuXG4gICAqL1xuICByZWFkb25seSBydW5UaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBzdXNwZW5kIGhvb2sgaXMgZW5hYmxlZC5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmQ/OiBBcHBUaGVvcnlNaWNyb3ZtSG9va01vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIHRpbWUgaW4gc2Vjb25kcyBmb3IgdGhlIHN1c3BlbmQgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSB0ZXJtaW5hdGUgaG9vayBpcyBlbmFibGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdGVybWluYXRlPzogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlO1xuXG4gIC8qKlxuICAgKiBUaGUgbWF4aW11bSB0aW1lIGluIHNlY29uZHMgZm9yIHRoZSB0ZXJtaW5hdGUgaG9vayB0byBjb21wbGV0ZS5cbiAgICovXG4gIHJlYWRvbmx5IHRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogSG9vayBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUhvb2tzIHtcbiAgLyoqXG4gICAqIExpZmVjeWNsZSBob29rcyBmb3IgTWljcm9WTSBldmVudHMuXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtUnVudGltZUhvb2tzO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9va3MgZm9yIE1pY3JvVk0gaW1hZ2UgYnVpbGQgZXZlbnRzLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlSG9va3M/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VCdWlsZEhvb2tzO1xuXG4gIC8qKlxuICAgKiBUaGUgcG9ydCBudW1iZXIgb24gd2hpY2ggdGhlIGhvb2tzIGxpc3RlbmVyIHJ1bnMuXG4gICAqL1xuICByZWFkb25seSBwb3J0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3VkV2F0Y2ggTG9ncyBjb25maWd1cmF0aW9uIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlIGxvZ2dpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlQ2xvdWRXYXRjaExvZ2dpbmcge1xuICAvKipcbiAgICogVGhlIG5hbWUgb2YgdGhlIENsb3VkV2F0Y2ggTG9ncyBsb2cgZ3JvdXAgdG8gc2VuZCBsb2dzIHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBuYW1lIG9mIHRoZSBDbG91ZFdhdGNoIExvZ3MgbG9nIHN0cmVhbSB3aXRoaW4gdGhlIGxvZyBncm91cC5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ1N0cmVhbT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBMb2dnaW5nIGNvbmZpZ3VyYXRpb24gZm9yIEFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB7XG4gIC8qKlxuICAgKiBDb25maWd1cmF0aW9uIGZvciBzZW5kaW5nIGxvZ3MgdG8gQW1hem9uIENsb3VkV2F0Y2ggTG9ncy5cbiAgICovXG4gIHJlYWRvbmx5IGNsb3VkV2F0Y2g/OiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDbG91ZFdhdGNoTG9nZ2luZztcblxuICAvKipcbiAgICogU2V0IHRvIHRydWUgdG8gZGlzYWJsZSBNaWNyb1ZNIGxvZ2dpbmcuXG4gICAqL1xuICByZWFkb25seSBkaXNhYmxlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogUmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciBBV1M6OkxhbWJkYTo6TWljcm92bUltYWdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlcyB7XG4gIC8qKlxuICAgKiBUaGUgbWluaW11bSBhbW91bnQgb2YgbWVtb3J5IGluIE1pQiB0byBhbGxvY2F0ZSB0byB0aGUgTWljcm9WTS5cbiAgICovXG4gIHJlYWRvbmx5IG1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEFwcFRoZW9yeU1pY3Jvdm1JbWFnZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmFtZSBvZiB0aGUgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGRlc2NyaXB0aW9uIG9mIHRoZSB2ZXJzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgYmFzZSBNaWNyb1ZNIGltYWdlIHVzZWQuXG4gICAqL1xuICByZWFkb25seSBiYXNlSW1hZ2VBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHNwZWNpZmljIHZlcnNpb24gb2YgdGhlIGJhc2UgTWljcm9WTSBpbWFnZS5cbiAgICovXG4gIHJlYWRvbmx5IGJhc2VJbWFnZVZlcnNpb246IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIEFSTiBvZiB0aGUgSUFNIGJ1aWxkIHJvbGUuXG4gICAqL1xuICByZWFkb25seSBidWlsZFJvbGVBcm46IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvZGUgYXJ0aWZhY3QgZm9yIHRoaXMgdmVyc2lvbi5cbiAgICovXG4gIHJlYWRvbmx5IGNvZGVBcnRpZmFjdDogQXBwVGhlb3J5TWljcm92bUltYWdlQ29kZUFydGlmYWN0O1xuXG4gIC8qKlxuICAgKiBUaGUgbGlzdCBvZiBlZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIGF2YWlsYWJsZSB0byB0aGUgTWljcm9WTSBhdCBydW50aW1lLlxuICAgKlxuICAgKiBQYXNzIGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcmAgaW5zdGFuY2VzIG9yIGNvbXBhdGlibGUgY29ubmVjdG9yIHJlZmVyZW5jZXMuXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBMaWZlY3ljbGUgaG9vayBjb25maWd1cmF0aW9uIGZvciBNaWNyb1ZNcyBhbmQgTWljcm9WTSBpbWFnZXMuXG4gICAqL1xuICByZWFkb25seSBob29rczogQXBwVGhlb3J5TWljcm92bUltYWdlSG9va3M7XG5cbiAgLyoqXG4gICAqIENvbmZpZ3VyYXRpb24gZm9yIE1pY3JvVk0gbG9nZ2luZyBvdXRwdXQuXG4gICAqXG4gICAqIFNwZWNpZnkgZXhhY3RseSBvbmUgb2YgYGNsb3VkV2F0Y2hgIG9yIGBkaXNhYmxlZDogdHJ1ZWAuXG4gICAqL1xuICByZWFkb25seSBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgcmVzb3VyY2UgcmVxdWlyZW1lbnRzIGZvciB0aGUgTWljcm9WTS5cbiAgICpcbiAgICogQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZSBjdXJyZW50bHkgYWNjZXB0cyBleGFjdGx5IG9uZSBSZXNvdXJjZXMgZW50cnkuXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZXM6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZVJlc291cmNlc1tdO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIE9TIGNhcGFiaWxpdGllcyBncmFudGVkIHRvIHRoZSBNaWNyb1ZNIHJ1bnRpbWUgZW52aXJvbm1lbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IFtBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMXVxuICAgKi9cbiAgcmVhZG9ubHkgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzPzogQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5W107XG5cbiAgLyoqXG4gICAqIFRoZSBsaXN0IG9mIHN1cHBvcnRlZCBDUFUgY29uZmlndXJhdGlvbnMgZm9yIHRoZSBNaWNyb1ZNLlxuICAgKlxuICAgKiBAZGVmYXVsdCBbeyBhcmNoaXRlY3R1cmU6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNwdUFyY2hpdGVjdHVyZS5BUk1fNjQgfV1cbiAgICovXG4gIHJlYWRvbmx5IGNwdUNvbmZpZ3VyYXRpb25zPzogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1Q29uZmlndXJhdGlvbltdO1xuXG4gIC8qKlxuICAgKiBFbnZpcm9ubWVudCB2YXJpYWJsZXMgc2V0IGluIHRoZSBNaWNyb1ZNIHJ1bnRpbWUgZW52aXJvbm1lbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBlbnZpcm9ubWVudFZhcmlhYmxlcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUVudmlyb25tZW50VmFyaWFibGVbXTtcblxuICAvKipcbiAgICogQWRkaXRpb25hbCBDbG91ZEZvcm1hdGlvbiB0YWdzIHRvIGFwcGx5IHRvIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgdGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIEFXUyBMYW1iZGEgTWljcm9WTSBpbWFnZXMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgaXMgaW50ZW50aW9uYWxseSBkZXBsb3ltZW50LW9ubHk6IGl0IGNyZWF0ZXMgdGhlIENsb3VkRm9ybWF0aW9uXG4gKiBgQVdTOjpMYW1iZGE6Ok1pY3Jvdm1JbWFnZWAgcmVzb3VyY2UgZnJvbSBjYWxsZXItcHJvdmlkZWQgY29kZSBhcnRpZmFjdCwgYmFzZSBpbWFnZSxcbiAqIGJ1aWxkIHJvbGUsIGxpZmVjeWNsZSBob29rcywgbG9nZ2luZyBjb25maWd1cmF0aW9uLCByZXNvdXJjZSByZXF1aXJlbWVudHMsIGFuZFxuICogQXBwVGhlb3J5IE1pY3JvVk0gbmV0d29yay1jb25uZWN0b3IgcmVmZXJlbmNlcy4gUnVudGltZSBjb250cm9sbGVyIGJlaGF2aW9yIHN0YXlzIGluXG4gKiB0aGUgQXBwVGhlb3J5IHJ1bnRpbWUgY29udHJhY3QuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgZXh0ZW5kcyBDb25zdHJ1Y3QgaW1wbGVtZW50cyBJQXBwVGhlb3J5TWljcm92bUltYWdlIHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIENsb3VkRm9ybWF0aW9uIE1pY3JvVk0gaW1hZ2UgcmVzb3VyY2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlOiBDZm5SZXNvdXJjZTtcblxuICAvKipcbiAgICogVGhlIE1pY3JvVk0gaW1hZ2UgbmFtZSByZXR1cm5lZCBieSBSZWYuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWljcm92bUltYWdlTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgQVJOIG9mIHRoZSBNaWNyb1ZNIGltYWdlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZUFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY3VycmVudCBpbWFnZSBzdGF0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtaWNyb3ZtSW1hZ2VTdGF0ZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGF0ZXN0IGFjdGl2ZSBpbWFnZSB2ZXJzaW9uLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGxhdGVzdEFjdGl2ZUltYWdlVmVyc2lvbjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGF0ZXN0IGZhaWxlZCBpbWFnZSB2ZXJzaW9uLCBpZiBhbnkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbGF0ZXN0RmFpbGVkSW1hZ2VWZXJzaW9uOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB0aW1lc3RhbXAgd2hlbiB0aGUgaW1hZ2Ugd2FzIGNyZWF0ZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgY3JlYXRlZEF0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB0aW1lc3RhbXAgd2hlbiB0aGUgaW1hZ2Ugd2FzIGxhc3QgdXBkYXRlZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB1cGRhdGVkQXQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWljcm92bUltYWdlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG5cbiAgICBjb25zdCBuYW1lID0gbm9ybWFsaXplTmFtZShwcm9wcy5uYW1lKTtcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHByb3BzLmRlc2NyaXB0aW9uLCBcImRlc2NyaXB0aW9uXCIpO1xuICAgIGNvbnN0IGJhc2VJbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5iYXNlSW1hZ2VBcm4sIFwiYmFzZUltYWdlQXJuXCIsIDIwNDgpO1xuICAgIGNvbnN0IGJhc2VJbWFnZVZlcnNpb24gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMuYmFzZUltYWdlVmVyc2lvbiwgXCJiYXNlSW1hZ2VWZXJzaW9uXCIsIDIwNDgpO1xuICAgIGNvbnN0IGJ1aWxkUm9sZUFybiA9IG5vcm1hbGl6ZUJ1aWxkUm9sZUFybihwcm9wcy5idWlsZFJvbGVBcm4pO1xuICAgIGNvbnN0IGNvZGVBcnRpZmFjdCA9IHJlbmRlckNvZGVBcnRpZmFjdChwcm9wcy5jb2RlQXJ0aWZhY3QpO1xuICAgIGNvbnN0IGVncmVzc05ldHdvcmtDb25uZWN0b3JzID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyk7XG4gICAgY29uc3QgaG9va3MgPSByZW5kZXJIb29rcyhwcm9wcy5ob29rcyk7XG4gICAgY29uc3QgbG9nZ2luZyA9IHJlbmRlckxvZ2dpbmcocHJvcHMubG9nZ2luZyk7XG4gICAgY29uc3QgcmVzb3VyY2VzID0gcmVuZGVyUmVzb3VyY2VzKHByb3BzLnJlc291cmNlcyk7XG4gICAgY29uc3QgYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzID0gbm9ybWFsaXplQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzKHByb3BzLmFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyk7XG4gICAgY29uc3QgY3B1Q29uZmlndXJhdGlvbnMgPSByZW5kZXJDcHVDb25maWd1cmF0aW9ucyhwcm9wcy5jcHVDb25maWd1cmF0aW9ucyk7XG4gICAgY29uc3QgZW52aXJvbm1lbnRWYXJpYWJsZXMgPSByZW5kZXJFbnZpcm9ubWVudFZhcmlhYmxlcyhwcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlcyk7XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZSA9IG5ldyBDZm5SZXNvdXJjZSh0aGlzLCBcIk1pY3Jvdm1JbWFnZVwiLCB7XG4gICAgICB0eXBlOiBcIkFXUzo6TGFtYmRhOjpNaWNyb3ZtSW1hZ2VcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzOiBhZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMsXG4gICAgICAgIEJhc2VJbWFnZUFybjogYmFzZUltYWdlQXJuLFxuICAgICAgICBCYXNlSW1hZ2VWZXJzaW9uOiBiYXNlSW1hZ2VWZXJzaW9uLFxuICAgICAgICBCdWlsZFJvbGVBcm46IGJ1aWxkUm9sZUFybixcbiAgICAgICAgQ29kZUFydGlmYWN0OiBjb2RlQXJ0aWZhY3QsXG4gICAgICAgIENwdUNvbmZpZ3VyYXRpb25zOiBjcHVDb25maWd1cmF0aW9ucyxcbiAgICAgICAgRGVzY3JpcHRpb246IGRlc2NyaXB0aW9uLFxuICAgICAgICBFZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMsXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiBlbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAgICAgSG9va3M6IGhvb2tzLFxuICAgICAgICBMb2dnaW5nOiBsb2dnaW5nLFxuICAgICAgICBOYW1lOiBuYW1lLFxuICAgICAgICBSZXNvdXJjZXM6IHJlc291cmNlcyxcbiAgICAgICAgVGFnczogcmVuZGVyVGFncyhwcm9wcy50YWdzKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLm1pY3Jvdm1JbWFnZU5hbWUgPSB0aGlzLm1pY3Jvdm1JbWFnZS5yZWY7XG4gICAgdGhpcy5taWNyb3ZtSW1hZ2VBcm4gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJJbWFnZUFyblwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubWljcm92bUltYWdlU3RhdGUgPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJTdGF0ZVwiKS50b1N0cmluZygpO1xuICAgIHRoaXMubGF0ZXN0QWN0aXZlSW1hZ2VWZXJzaW9uID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiTGF0ZXN0QWN0aXZlSW1hZ2VWZXJzaW9uXCIpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5sYXRlc3RGYWlsZWRJbWFnZVZlcnNpb24gPSB0aGlzLm1pY3Jvdm1JbWFnZS5nZXRBdHQoXCJMYXRlc3RGYWlsZWRJbWFnZVZlcnNpb25cIikudG9TdHJpbmcoKTtcbiAgICB0aGlzLmNyZWF0ZWRBdCA9IHRoaXMubWljcm92bUltYWdlLmdldEF0dChcIkNyZWF0ZWRBdFwiKS50b1N0cmluZygpO1xuICAgIHRoaXMudXBkYXRlZEF0ID0gdGhpcy5taWNyb3ZtSW1hZ2UuZ2V0QXR0KFwiVXBkYXRlZEF0XCIpLnRvU3RyaW5nKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTmFtZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbmFtZSA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcIm5hbWVcIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAhL15bQS1aYS16MC05Xy1dezEsNjR9JC8udGVzdChuYW1lKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBuYW1lIG11c3QgYmUgMS02NCBjaGFyYWN0ZXJzIHVzaW5nIGxldHRlcnMsIG51bWJlcnMsIGh5cGhlbnMsIG9yIHVuZGVyc2NvcmVzXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHZhbHVlKS50cmltKCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgcHJvcE5hbWUpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgL1xccy8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgbm9ybWFsaXplZC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogJHtwcm9wTmFtZX0gbXVzdCBiZSBhdCBtb3N0ICR7bWF4TGVuZ3RofSBjaGFyYWN0ZXJzYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUJ1aWxkUm9sZUFybih2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgY29uc3QgYXJuID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlLCBcImJ1aWxkUm9sZUFyblwiLCAyMDQ4KTtcbiAgaWYgKFxuICAgICFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmXG4gICAgIS9eYXJuOmF3c1thLXpBLVotXSo6aWFtOjpcXGR7MTJ9OnJvbGVcXC8/W2EtekEtWl8wLTkrPSwuQFxcLV8vXSskLy50ZXN0KGFybilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBidWlsZFJvbGVBcm4gbXVzdCBiZSBhbiBJQU0gcm9sZSBBUk5cIik7XG4gIH1cbiAgcmV0dXJuIGFybjtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZUFydGlmYWN0KFxuICBjb2RlQXJ0aWZhY3Q6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNvZGVBcnRpZmFjdCB8IHVuZGVmaW5lZCxcbik6IHsgVXJpOiBzdHJpbmcgfSB7XG4gIGlmIChjb2RlQXJ0aWZhY3QgPT09IHVuZGVmaW5lZCB8fCBjb2RlQXJ0aWZhY3QgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuY29kZUFydGlmYWN0XCIpO1xuICB9XG4gIHJldHVybiB7XG4gICAgVXJpOiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcoY29kZUFydGlmYWN0LnVyaSwgXCJjb2RlQXJ0aWZhY3QudXJpXCIsIDIwNDgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICBjb25uZWN0b3JzOiByZWFkb25seSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXSB8IHVuZGVmaW5lZCxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKCFjb25uZWN0b3JzIHx8IGNvbm5lY3RvcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgZW50cnlcIik7XG4gIH1cbiAgaWYgKGNvbm5lY3RvcnMubGVuZ3RoID4gMTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2Ugc3VwcG9ydHMgYXQgbW9zdCAxMCBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBlbnRyaWVzXCIpO1xuICB9XG5cbiAgY29uc3QgYXJucyA9IGNvbm5lY3RvcnMubWFwKChjb25uZWN0b3IsIGluZGV4KSA9PiB7XG4gICAgaWYgKGNvbm5lY3RvciA9PT0gdW5kZWZpbmVkIHx8IGNvbm5lY3RvciA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNbJHtpbmRleH1dYCk7XG4gICAgfVxuICAgIGNvbnN0IGFybiA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKFxuICAgICAgY29ubmVjdG9yLm5ldHdvcmtDb25uZWN0b3JBcm4sXG4gICAgICBgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNbJHtpbmRleH1dLm5ldHdvcmtDb25uZWN0b3JBcm5gLFxuICAgICk7XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoYXJuKSAmJiAvXFxzLy50ZXN0KGFybikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNbJHtpbmRleH1dLm5ldHdvcmtDb25uZWN0b3JBcm4gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBhcm47XG4gIH0pO1xuXG4gIGFzc2VydE5vRHVwbGljYXRlcyhhcm5zLCBcImVncmVzc05ldHdvcmtDb25uZWN0b3JzIG5ldHdvcmtDb25uZWN0b3JBcm5cIik7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVBZGRpdGlvbmFsT3NDYXBhYmlsaXRpZXMoXG4gIHZhbHVlcz86IHJlYWRvbmx5IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eVtdLFxuKTogQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5W10ge1xuICBjb25zdCBjYXBhYmlsaXRpZXMgPSB2YWx1ZXMgPz8gW0FwcFRoZW9yeU1pY3Jvdm1JbWFnZU9zQ2FwYWJpbGl0eS5BTExdO1xuICBpZiAoY2FwYWJpbGl0aWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGFkZGl0aW9uYWxPc0NhcGFiaWxpdGllcyBlbnRyeVwiKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gY2FwYWJpbGl0aWVzLm1hcCgoY2FwYWJpbGl0eSwgaW5kZXgpID0+IHtcbiAgICBpZiAoU3RyaW5nKGNhcGFiaWxpdHkpLnRyaW0oKS50b1VwcGVyQ2FzZSgpICE9PSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VPc0NhcGFiaWxpdHkuQUxMKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogYWRkaXRpb25hbE9zQ2FwYWJpbGl0aWVzWyR7aW5kZXh9XSBtdXN0IGJlIEFMTGApO1xuICAgIH1cbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bUltYWdlT3NDYXBhYmlsaXR5LkFMTDtcbiAgfSk7XG4gIGFzc2VydE5vRHVwbGljYXRlcyhub3JtYWxpemVkLCBcImFkZGl0aW9uYWxPc0NhcGFiaWxpdGllc1wiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNwdUNvbmZpZ3VyYXRpb25zKFxuICB2YWx1ZXM/OiByZWFkb25seSBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVDb25maWd1cmF0aW9uW10sXG4pOiBBcnJheTx7IEFyY2hpdGVjdHVyZTogQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlIH0+IHtcbiAgY29uc3QgY3B1Q29uZmlndXJhdGlvbnMgPSB2YWx1ZXMgPz8gW3sgYXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH1dO1xuICBpZiAoY3B1Q29uZmlndXJhdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgY3B1Q29uZmlndXJhdGlvbnMgZW50cnlcIik7XG4gIH1cbiAgcmV0dXJuIGNwdUNvbmZpZ3VyYXRpb25zLm1hcCgoY3B1LCBpbmRleCkgPT4ge1xuICAgIGlmIChjcHUgPT09IHVuZGVmaW5lZCB8fCBjcHUgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmNwdUNvbmZpZ3VyYXRpb25zWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBhcmNoaXRlY3R1cmUgPSBTdHJpbmcoY3B1LmFyY2hpdGVjdHVyZSA/PyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0KVxuICAgICAgLnRyaW0oKVxuICAgICAgLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKGFyY2hpdGVjdHVyZSAhPT0gQXBwVGhlb3J5TWljcm92bUltYWdlQ3B1QXJjaGl0ZWN0dXJlLkFSTV82NCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGNwdUNvbmZpZ3VyYXRpb25zWyR7aW5kZXh9XS5hcmNoaXRlY3R1cmUgbXVzdCBiZSBBUk1fNjRgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgQXJjaGl0ZWN0dXJlOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VDcHVBcmNoaXRlY3R1cmUuQVJNXzY0IH07XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFbnZpcm9ubWVudFZhcmlhYmxlcyhcbiAgdmFsdWVzPzogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlRW52aXJvbm1lbnRWYXJpYWJsZVtdLFxuKTogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiB7XG4gIGlmICgodmFsdWVzPy5sZW5ndGggPz8gMCkgPiA1MCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBhdCBtb3N0IDUwIGVudmlyb25tZW50VmFyaWFibGVzIGVudHJpZXNcIik7XG4gIH1cblxuICBjb25zdCByZW5kZXJlZCA9ICh2YWx1ZXMgPz8gW10pLm1hcCgoZW50cnksIGluZGV4KSA9PiB7XG4gICAgaWYgKGVudHJ5ID09PSB1bmRlZmluZWQgfHwgZW50cnkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmVudmlyb25tZW50VmFyaWFibGVzWyR7aW5kZXh9XWApO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcoZW50cnkua2V5LCBgZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dLmtleWAsIDI1Nik7XG4gICAgY29uc3QgdmFsdWUgPSBlbnRyeS52YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IGVudHJ5LnZhbHVlID09PSBudWxsID8gdW5kZWZpbmVkIDogU3RyaW5nKGVudHJ5LnZhbHVlKTtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dLnZhbHVlYCk7XG4gICAgfVxuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiB2YWx1ZS5sZW5ndGggPiA0MDk2KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogZW52aXJvbm1lbnRWYXJpYWJsZXNbJHtpbmRleH1dLnZhbHVlIG11c3QgYmUgYXQgbW9zdCA0MDk2IGNoYXJhY3RlcnNgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgS2V5OiBrZXksIFZhbHVlOiB2YWx1ZSB9O1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoXG4gICAgcmVuZGVyZWQubWFwKChlbnRyeSkgPT4gZW50cnkuS2V5KSxcbiAgICBcImVudmlyb25tZW50VmFyaWFibGVzIGtleVwiLFxuICApO1xuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckhvb2tzKGhvb2tzOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VIb29rcyB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgaWYgKGhvb2tzID09PSB1bmRlZmluZWQgfHwgaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3NcIik7XG4gIH1cblxuICBjb25zdCByZW5kZXJlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgY29uc3QgbWljcm92bUhvb2tzID0gcmVuZGVyUnVudGltZUhvb2tzKGhvb2tzLm1pY3Jvdm1Ib29rcyk7XG4gIGlmIChtaWNyb3ZtSG9va3MpIHtcbiAgICByZW5kZXJlZC5NaWNyb3ZtSG9va3MgPSBtaWNyb3ZtSG9va3M7XG4gIH1cbiAgY29uc3QgbWljcm92bUltYWdlSG9va3MgPSByZW5kZXJJbWFnZUhvb2tzKGhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzKTtcbiAgaWYgKG1pY3Jvdm1JbWFnZUhvb2tzKSB7XG4gICAgcmVuZGVyZWQuTWljcm92bUltYWdlSG9va3MgPSBtaWNyb3ZtSW1hZ2VIb29rcztcbiAgfVxuICBpZiAoaG9va3MucG9ydCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVuZGVyZWQuUG9ydCA9IG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKGhvb2tzLnBvcnQsIFwiaG9va3MucG9ydFwiLCAxLCA2NTUzNSk7XG4gIH1cbiAgaWYgKCFyZW5kZXJlZC5NaWNyb3ZtSG9va3MgJiYgIXJlbmRlcmVkLk1pY3Jvdm1JbWFnZUhvb2tzKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIHByb3BzLmhvb2tzLm1pY3Jvdm1Ib29rcyBvciBwcm9wcy5ob29rcy5taWNyb3ZtSW1hZ2VIb29rc1wiKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJ1bnRpbWVIb29rcyhob29rcz86IEFwcFRoZW9yeU1pY3Jvdm1SdW50aW1lSG9va3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUhvb2tzXCIpO1xuICB9XG4gIGNvbnN0IHJlbmRlcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSZXN1bWVcIiwgaG9va3MucmVzdW1lLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5yZXN1bWVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJlc3VtZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5yZXN1bWVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnJlc3VtZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJSdW5cIiwgaG9va3MucnVuLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy5ydW5cIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlJ1blRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5ydW5UaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnJ1blRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJTdXNwZW5kXCIsIGhvb2tzLnN1c3BlbmQsIFwiaG9va3MubWljcm92bUhvb2tzLnN1c3BlbmRcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlN1c3BlbmRUaW1lb3V0SW5TZWNvbmRzXCIsXG4gICAgaG9va3Muc3VzcGVuZFRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSG9va3Muc3VzcGVuZFRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBzZXRIb29rTW9kZShyZW5kZXJlZCwgXCJUZXJtaW5hdGVcIiwgaG9va3MudGVybWluYXRlLCBcImhvb2tzLm1pY3Jvdm1Ib29rcy50ZXJtaW5hdGVcIik7XG4gIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgICByZW5kZXJlZCxcbiAgICBcIlRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy50ZXJtaW5hdGVUaW1lb3V0SW5TZWNvbmRzLFxuICAgIFwiaG9va3MubWljcm92bUhvb2tzLnRlcm1pbmF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDYwLFxuICApO1xuICBpZiAoT2JqZWN0LmtleXMocmVuZGVyZWQpLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBhdCBsZWFzdCAxIGhvb2tzLm1pY3Jvdm1Ib29rcyBzZXR0aW5nXCIpO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVySW1hZ2VIb29rcyhob29rcz86IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUJ1aWxkSG9va3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmIChob29rcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoaG9va3MgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuaG9va3MubWljcm92bUltYWdlSG9va3NcIik7XG4gIH1cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlJlYWR5XCIsIGhvb2tzLnJlYWR5LCBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnJlYWR5XCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJSZWFkeVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy5yZWFkeVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy5yZWFkeVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDM2MDAsXG4gICk7XG4gIHNldEhvb2tNb2RlKHJlbmRlcmVkLCBcIlZhbGlkYXRlXCIsIGhvb2tzLnZhbGlkYXRlLCBcImhvb2tzLm1pY3Jvdm1JbWFnZUhvb2tzLnZhbGlkYXRlXCIpO1xuICBzZXRPcHRpb25hbEludGVnZXIoXG4gICAgcmVuZGVyZWQsXG4gICAgXCJWYWxpZGF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICBob29rcy52YWxpZGF0ZVRpbWVvdXRJblNlY29uZHMsXG4gICAgXCJob29rcy5taWNyb3ZtSW1hZ2VIb29rcy52YWxpZGF0ZVRpbWVvdXRJblNlY29uZHNcIixcbiAgICAxLFxuICAgIDM2MDAsXG4gICk7XG4gIGlmIChPYmplY3Qua2V5cyhyZW5kZXJlZCkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlIHJlcXVpcmVzIGF0IGxlYXN0IDEgaG9va3MubWljcm92bUltYWdlSG9va3Mgc2V0dGluZ1wiKTtcbiAgfVxuICByZXR1cm4gcmVuZGVyZWQ7XG59XG5cbmZ1bmN0aW9uIHNldEhvb2tNb2RlKFxuICB0YXJnZXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBrZXk6IHN0cmluZyxcbiAgbW9kZTogQXBwVGhlb3J5TWljcm92bUhvb2tNb2RlIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChtb2RlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhtb2RlKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgaWYgKG5vcm1hbGl6ZWQgIT09IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZS5FTkFCTEVEICYmIG5vcm1hbGl6ZWQgIT09IEFwcFRoZW9yeU1pY3Jvdm1Ib29rTW9kZS5ESVNBQkxFRCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIEVOQUJMRUQgb3IgRElTQUJMRURgKTtcbiAgfVxuICB0YXJnZXRba2V5XSA9IG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHNldE9wdGlvbmFsSW50ZWdlcihcbiAgdGFyZ2V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAga2V5OiBzdHJpbmcsXG4gIHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIG1pbjogbnVtYmVyLFxuICBtYXg6IG51bWJlcixcbik6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0YXJnZXRba2V5XSA9IG5vcm1hbGl6ZUludGVnZXJJblJhbmdlKHZhbHVlLCBwcm9wTmFtZSwgbWluLCBtYXgpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJMb2dnaW5nKGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmIChsb2dnaW5nID09PSB1bmRlZmluZWQgfHwgbG9nZ2luZyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5sb2dnaW5nXCIpO1xuICB9XG4gIGNvbnN0IGhhc0Nsb3VkV2F0Y2ggPSBsb2dnaW5nLmNsb3VkV2F0Y2ggIT09IHVuZGVmaW5lZCAmJiBsb2dnaW5nLmNsb3VkV2F0Y2ggIT09IG51bGw7XG4gIGNvbnN0IGhhc0Rpc2FibGVkID0gbG9nZ2luZy5kaXNhYmxlZCAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzQ2xvdWRXYXRjaCA9PT0gaGFzRGlzYWJsZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IGxvZ2dpbmcgbXVzdCBzcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGNsb3VkV2F0Y2ggb3IgZGlzYWJsZWRcIik7XG4gIH1cbiAgaWYgKGhhc0Rpc2FibGVkKSB7XG4gICAgaWYgKGxvZ2dpbmcuZGlzYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5kaXNhYmxlZCBtdXN0IGJlIHRydWUgd2hlbiBwcm92aWRlZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgRGlzYWJsZWQ6IHRydWUgfTtcbiAgfVxuICByZXR1cm4geyBDbG91ZFdhdGNoOiByZW5kZXJDbG91ZFdhdGNoTG9nZ2luZyhsb2dnaW5nLmNsb3VkV2F0Y2gpIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNsb3VkV2F0Y2hMb2dnaW5nKGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUNsb3VkV2F0Y2hMb2dnaW5nIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGlmIChsb2dnaW5nID09PSB1bmRlZmluZWQgfHwgbG9nZ2luZyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5sb2dnaW5nLmNsb3VkV2F0Y2hcIik7XG4gIH1cbiAgY29uc3QgcmVuZGVyZWQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgaWYgKGxvZ2dpbmcubG9nR3JvdXAgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlbmRlcmVkLkxvZ0dyb3VwID0gbm9ybWFsaXplTG9nR3JvdXAobG9nZ2luZy5sb2dHcm91cCk7XG4gIH1cbiAgaWYgKGxvZ2dpbmcubG9nU3RyZWFtICE9PSB1bmRlZmluZWQpIHtcbiAgICByZW5kZXJlZC5Mb2dTdHJlYW0gPSBub3JtYWxpemVMb2dTdHJlYW0obG9nZ2luZy5sb2dTdHJlYW0pO1xuICB9XG4gIHJldHVybiByZW5kZXJlZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9nR3JvdXAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJsb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXBcIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAhL15bYS16QS1aMC05X1xcLS8uI117MSw1MTJ9JC8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZTogbG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMb2dTdHJlYW0odmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgKCEvXlteOipdKiQvLnRlc3Qobm9ybWFsaXplZCkgfHwgbm9ybWFsaXplZC5sZW5ndGggPiA1MTIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUltYWdlOiBsb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSZXNvdXJjZXMoXG4gIHJlc291cmNlczogcmVhZG9ubHkgQXBwVGhlb3J5TWljcm92bUltYWdlUmVzb3VyY2VzW10gfCB1bmRlZmluZWQsXG4pOiBBcnJheTx7IE1pbmltdW1NZW1vcnlJbk1pQjogbnVtYmVyIH0+IHtcbiAgaWYgKCFyZXNvdXJjZXMgfHwgcmVzb3VyY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBleGFjdGx5IDEgcmVzb3VyY2VzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChyZXNvdXJjZXMubGVuZ3RoID4gMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBzdXBwb3J0cyBleGFjdGx5IDEgcmVzb3VyY2VzIGVudHJ5XCIpO1xuICB9XG4gIGNvbnN0IHJlc291cmNlID0gcmVzb3VyY2VzWzBdO1xuICBpZiAocmVzb3VyY2UgPT09IHVuZGVmaW5lZCB8fCByZXNvdXJjZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1JbWFnZSByZXF1aXJlcyBwcm9wcy5yZXNvdXJjZXNbMF1cIik7XG4gIH1cbiAgcmV0dXJuIFtcbiAgICB7XG4gICAgICBNaW5pbXVtTWVtb3J5SW5NaUI6IG5vcm1hbGl6ZVBvc2l0aXZlSW50ZWdlcihyZXNvdXJjZS5taW5pbXVtTWVtb3J5SW5NaUIsIFwicmVzb3VyY2VzWzBdLm1pbmltdW1NZW1vcnlJbk1pQlwiKSxcbiAgICB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSW50ZWdlckluUmFuZ2UodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZywgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IG1pbiB8fCB2YWx1ZSA+IG1heCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUltYWdlOiAke3Byb3BOYW1lfSBtdXN0IGJlIGFuIGludGVnZXIgZnJvbSAke21pbn0gdG8gJHttYXh9YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0R1cGxpY2F0ZXModmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1JbWFnZSBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtsYWJlbH0gdmFsdWVzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZW5kZXJUYWdzKHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogQXJyYXk8eyBLZXk6IHN0cmluZzsgVmFsdWU6IHN0cmluZyB9PiB7XG4gIGNvbnN0IHJlbmRlcmVkOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+ID0gW1xuICAgIHsgS2V5OiBcIkZyYW1ld29ya1wiLCBWYWx1ZTogXCJBcHBUaGVvcnlcIiB9LFxuICAgIHsgS2V5OiBcIkNvbXBvbmVudFwiLCBWYWx1ZTogXCJNaWNyb3ZtSW1hZ2VcIiB9LFxuICBdO1xuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHRhZ3MgPz8ge30pLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgY29uc3Qgbm9ybWFsaXplZEtleSA9IGtleS50cmltKCk7XG4gICAgaWYgKCFub3JtYWxpemVkS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U6IHRhZyBrZXlzIGNhbm5vdCBiZSBlbXB0eVwiKTtcbiAgICB9XG4gICAgcmVuZGVyZWQucHVzaCh7IEtleTogbm9ybWFsaXplZEtleSwgVmFsdWU6IHZhbHVlIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuIl19