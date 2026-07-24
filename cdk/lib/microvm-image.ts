import { CfnResource, Token } from "aws-cdk-lib";
import { Construct } from "constructs";

import type { IAppTheoryMicrovmNetworkConnector } from "./microvm-network-connector";

/**
 * Reference to a Lambda MicroVM image usable by MicroVM controller constructs.
 */
export interface IAppTheoryMicrovmImage {
  /**
   * The ARN of the MicroVM image.
   */
  readonly microvmImageArn: string;

  /**
   * The normalized deployment-owned runtime logging posture for this image.
   *
   * Controllers propagate this exact CloudWatch-or-disabled choice to every
   * `RunMicrovm` request.
   */
  readonly logging: AppTheoryMicrovmImageLogging;
}

/**
 * Additional OS capabilities supported by Lambda MicroVM images.
 */
export enum AppTheoryMicrovmImageOsCapability {
  /**
   * Grants all currently supported MicroVM OS capabilities.
   */
  ALL = "ALL",
}

/**
 * CPU architectures supported by Lambda MicroVM images.
 */
export enum AppTheoryMicrovmImageCpuArchitecture {
  /**
   * ARM64 MicroVM image architecture.
   */
  ARM_64 = "ARM_64",
}

/**
 * Lifecycle hook mode for Lambda MicroVM image hooks.
 */
export enum AppTheoryMicrovmHookMode {
  /**
   * Disable the lifecycle hook.
   */
  DISABLED = "DISABLED",

  /**
   * Enable the lifecycle hook.
   */
  ENABLED = "ENABLED",
}

/**
 * Code artifact location for AWS::Lambda::MicrovmImage.
 */
export interface AppTheoryMicrovmImageCodeArtifact {
  /**
   * The URI of the code artifact, such as an Amazon S3 path or Amazon ECR image URI.
   */
  readonly uri: string;
}

/**
 * CPU configuration for AWS::Lambda::MicrovmImage.
 */
export interface AppTheoryMicrovmImageCpuConfiguration {
  /**
   * The CPU architecture.
   *
   * @default AppTheoryMicrovmImageCpuArchitecture.ARM_64
   */
  readonly architecture?: AppTheoryMicrovmImageCpuArchitecture;
}

/**
 * Environment variable for AWS::Lambda::MicrovmImage.
 */
export interface AppTheoryMicrovmImageEnvironmentVariable {
  /**
   * Environment variable key.
   */
  readonly key: string;

  /**
   * Environment variable value.
   */
  readonly value: string;
}

/**
 * Lifecycle hooks invoked during MicroVM image build events.
 */
export interface AppTheoryMicrovmImageBuildHooks {
  /**
   * Whether the ready hook is enabled.
   */
  readonly ready?: AppTheoryMicrovmHookMode;

  /**
   * The maximum time in seconds for the ready hook to complete.
   */
  readonly readyTimeoutInSeconds?: number;

  /**
   * Whether the validate hook is enabled.
   */
  readonly validate?: AppTheoryMicrovmHookMode;

  /**
   * The maximum time in seconds for the validate hook to complete.
   */
  readonly validateTimeoutInSeconds?: number;
}

/**
 * Lifecycle hooks invoked during MicroVM events.
 */
export interface AppTheoryMicrovmRuntimeHooks {
  /**
   * Whether the resume hook is enabled.
   */
  readonly resume?: AppTheoryMicrovmHookMode;

  /**
   * The maximum time in seconds for the resume hook to complete.
   */
  readonly resumeTimeoutInSeconds?: number;

  /**
   * Whether the run hook is enabled.
   */
  readonly run?: AppTheoryMicrovmHookMode;

  /**
   * The maximum time in seconds for the run hook to complete.
   */
  readonly runTimeoutInSeconds?: number;

  /**
   * Whether the suspend hook is enabled.
   */
  readonly suspend?: AppTheoryMicrovmHookMode;

  /**
   * The maximum time in seconds for the suspend hook to complete.
   */
  readonly suspendTimeoutInSeconds?: number;

  /**
   * Whether the terminate hook is enabled.
   */
  readonly terminate?: AppTheoryMicrovmHookMode;

  /**
   * The maximum time in seconds for the terminate hook to complete.
   */
  readonly terminateTimeoutInSeconds?: number;
}

/**
 * Hook configuration for AWS::Lambda::MicrovmImage.
 */
export interface AppTheoryMicrovmImageHooks {
  /**
   * Lifecycle hooks for MicroVM events.
   */
  readonly microvmHooks?: AppTheoryMicrovmRuntimeHooks;

  /**
   * Lifecycle hooks for MicroVM image build events.
   */
  readonly microvmImageHooks?: AppTheoryMicrovmImageBuildHooks;

  /**
   * The port number on which the hooks listener runs.
   */
  readonly port?: number;
}

/**
 * CloudWatch Logs configuration for AWS::Lambda::MicrovmImage logging.
 */
export interface AppTheoryMicrovmImageCloudWatchLogging {
  /**
   * The name of the CloudWatch Logs log group to send logs to.
   */
  readonly logGroup?: string;

  /**
   * The name of the CloudWatch Logs log stream within the log group.
   */
  readonly logStream?: string;
}

/**
 * Logging configuration for AWS::Lambda::MicrovmImage.
 */
export interface AppTheoryMicrovmImageLogging {
  /**
   * Configuration for sending logs to Amazon CloudWatch Logs.
   */
  readonly cloudWatch?: AppTheoryMicrovmImageCloudWatchLogging;

  /**
   * Set to true to disable MicroVM logging.
   */
  readonly disabled?: boolean;
}

/**
 * Resource requirements for AWS::Lambda::MicrovmImage.
 */
export interface AppTheoryMicrovmImageResources {
  /**
   * The minimum amount of memory in MiB to allocate to the MicroVM.
   */
  readonly minimumMemoryInMiB: number;
}

/**
 * Properties for AppTheoryMicrovmImage.
 */
export interface AppTheoryMicrovmImageProps {
  /**
   * The name of the MicroVM image.
   */
  readonly name: string;

  /**
   * The description of the version.
   */
  readonly description: string;

  /**
   * The ARN of the base MicroVM image used.
   */
  readonly baseImageArn: string;

  /**
   * The specific version of the base MicroVM image.
   */
  readonly baseImageVersion: string;

  /**
   * The ARN of the IAM build role.
   */
  readonly buildRoleArn: string;

  /**
   * The code artifact for this version.
   */
  readonly codeArtifact: AppTheoryMicrovmImageCodeArtifact;

  /**
   * The list of egress network connectors available to the MicroVM at runtime.
   *
   * Pass `AppTheoryMicrovmNetworkConnector` instances or compatible connector references.
   * At least one connector reference is required and no more than 10 may be supplied.
   */
  readonly egressNetworkConnectors: IAppTheoryMicrovmNetworkConnector[];

  /**
   * Lifecycle hook configuration for MicroVMs and MicroVM images.
   *
   * Pass an empty object (`{}`) for AppTheory endpoint-dispatched MicroVM images.
   * AppTheory then synthesizes `Hooks: {}` so Lambda builds the image without
   * AWS-invoked lifecycle hooks and runtime traffic is delivered through the
   * MicroVM endpoint on the default port 8080. If any hook is configured, `port`
   * is required by AWS and AppTheory validates it fail-closed.
   */
  readonly hooks: AppTheoryMicrovmImageHooks;

  /**
   * Configuration for MicroVM logging output.
   *
   * Specify exactly one of `cloudWatch` or `disabled: true`.
   */
  readonly logging: AppTheoryMicrovmImageLogging;

  /**
   * The resource requirements for the MicroVM.
   *
   * AWS::Lambda::MicrovmImage currently accepts exactly one Resources entry.
   */
  readonly resources: AppTheoryMicrovmImageResources[];

  /**
   * Additional OS capabilities granted to the MicroVM runtime environment.
   *
   * @default [AppTheoryMicrovmImageOsCapability.ALL]
   */
  readonly additionalOsCapabilities?: AppTheoryMicrovmImageOsCapability[];

  /**
   * The list of supported CPU configurations for the MicroVM.
   *
   * @default [{ architecture: AppTheoryMicrovmImageCpuArchitecture.ARM_64 }]
   */
  readonly cpuConfigurations?: AppTheoryMicrovmImageCpuConfiguration[];

  /**
   * Environment variables set in the MicroVM runtime environment.
   *
   * @default []
   */
  readonly environmentVariables?: AppTheoryMicrovmImageEnvironmentVariable[];

  /**
   * Additional CloudFormation tags to apply to the MicroVM image.
   */
  readonly tags?: Record<string, string>;
}

/**
 * AppTheory CDK construct for AWS Lambda MicroVM images.
 *
 * This construct is intentionally deployment-only: it creates the CloudFormation
 * `AWS::Lambda::MicrovmImage` resource from caller-provided code artifact, base image,
 * build role, lifecycle hooks, logging configuration, resource requirements, and
 * AppTheory MicroVM network-connector references. Runtime controller behavior stays in
 * the AppTheory runtime contract.
 */
export class AppTheoryMicrovmImage extends Construct implements IAppTheoryMicrovmImage {
  /**
   * The underlying CloudFormation MicroVM image resource.
   */
  public readonly microvmImage: CfnResource;

  /**
   * The MicroVM image name returned by Ref.
   */
  public readonly microvmImageName: string;

  /**
   * The ARN of the MicroVM image.
   */
  public readonly microvmImageArn: string;

  /**
   * The normalized deployment-owned runtime logging posture for this image.
   */
  public readonly logging: AppTheoryMicrovmImageLogging;

  /**
   * The current image state.
   */
  public readonly microvmImageState: string;

  /**
   * The latest active image version.
   */
  public readonly latestActiveImageVersion: string;

  /**
   * The latest failed image version, if any.
   */
  public readonly latestFailedImageVersion: string;

  /**
   * The timestamp when the image was created.
   */
  public readonly createdAt: string;

  /**
   * The timestamp when the image was last updated.
   */
  public readonly updatedAt: string;

  constructor(scope: Construct, id: string, props: AppTheoryMicrovmImageProps) {
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

    this.microvmImage = new CfnResource(this, "MicrovmImage", {
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

function normalizeName(value: string): string {
  const name = normalizeRequiredString(value, "name");
  if (!Token.isUnresolved(value) && !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      "AppTheoryMicrovmImage: name must be 1-64 characters using letters, numbers, hyphens, or underscores",
    );
  }
  return name;
}

function normalizeRequiredString(value: string | undefined, propName: string): string {
  if (value === undefined || value === null) {
    throw new Error(`AppTheoryMicrovmImage requires props.${propName}`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error(`AppTheoryMicrovmImage requires props.${propName}`);
  }
  return normalized;
}

function normalizeNoWhitespaceString(value: string | undefined, propName: string, maxLength: number): string {
  const normalized = normalizeRequiredString(value, propName);
  if (!Token.isUnresolved(value) && /\s/.test(normalized)) {
    throw new Error(`AppTheoryMicrovmImage: ${propName} must not contain whitespace`);
  }
  if (!Token.isUnresolved(value) && normalized.length > maxLength) {
    throw new Error(`AppTheoryMicrovmImage: ${propName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeBuildRoleArn(value: string | undefined): string {
  const arn = normalizeNoWhitespaceString(value, "buildRoleArn", 2048);
  if (
    !Token.isUnresolved(value) &&
    !/^arn:aws[a-zA-Z-]*:iam::\d{12}:role\/?[a-zA-Z_0-9+=,.@\-_/]+$/.test(arn)
  ) {
    throw new Error("AppTheoryMicrovmImage: buildRoleArn must be an IAM role ARN");
  }
  return arn;
}

function renderCodeArtifact(
  codeArtifact: AppTheoryMicrovmImageCodeArtifact | undefined,
): { Uri: string } {
  if (codeArtifact === undefined || codeArtifact === null) {
    throw new Error("AppTheoryMicrovmImage requires props.codeArtifact");
  }
  return {
    Uri: normalizeNoWhitespaceString(codeArtifact.uri, "codeArtifact.uri", 2048),
  };
}

function normalizeConnectorReferences(
  connectors: readonly IAppTheoryMicrovmNetworkConnector[] | undefined,
): string[] {
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
    const arn = normalizeRequiredString(
      connector.networkConnectorArn,
      `egressNetworkConnectors[${index}].networkConnectorArn`,
    );
    if (!Token.isUnresolved(arn) && /\s/.test(arn)) {
      throw new Error(
        `AppTheoryMicrovmImage: egressNetworkConnectors[${index}].networkConnectorArn must not contain whitespace`,
      );
    }
    return arn;
  });

  assertNoDuplicates(arns, "egressNetworkConnectors networkConnectorArn");
  return arns;
}

function normalizeAdditionalOsCapabilities(
  values?: readonly AppTheoryMicrovmImageOsCapability[],
): AppTheoryMicrovmImageOsCapability[] {
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

function renderCpuConfigurations(
  values?: readonly AppTheoryMicrovmImageCpuConfiguration[],
): Array<{ Architecture: AppTheoryMicrovmImageCpuArchitecture }> {
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

function renderEnvironmentVariables(
  values?: readonly AppTheoryMicrovmImageEnvironmentVariable[],
): Array<{ Key: string; Value: string }> {
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
    if (!Token.isUnresolved(value) && value.length > 4096) {
      throw new Error(`AppTheoryMicrovmImage: environmentVariables[${index}].value must be at most 4096 characters`);
    }
    return { Key: key, Value: value };
  });

  assertNoDuplicates(
    rendered.map((entry) => entry.Key),
    "environmentVariables key",
  );
  return rendered;
}

function renderHooks(hooks: AppTheoryMicrovmImageHooks | undefined): Record<string, unknown> {
  if (hooks === undefined || hooks === null) {
    throw new Error("AppTheoryMicrovmImage requires props.hooks");
  }

  const rendered: Record<string, unknown> = {};
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
    throw new Error(
      "AppTheoryMicrovmImage: hooks.port is required when props.hooks.microvmHooks or props.hooks.microvmImageHooks is configured",
    );
  }
  if (hooks.port !== undefined) {
    if (!hasHookGroup) {
      throw new Error(
        "AppTheoryMicrovmImage: hooks.port requires props.hooks.microvmHooks or props.hooks.microvmImageHooks",
      );
    }
    rendered.Port = normalizeIntegerInRange(hooks.port, "hooks.port", 1, 65535);
  }
  return rendered;
}

function renderRuntimeHooks(hooks?: AppTheoryMicrovmRuntimeHooks): Record<string, unknown> | undefined {
  if (hooks === undefined) {
    return undefined;
  }
  if (hooks === null) {
    throw new Error("AppTheoryMicrovmImage requires props.hooks.microvmHooks");
  }
  const rendered: Record<string, unknown> = {};
  setHookMode(rendered, "Resume", hooks.resume, "hooks.microvmHooks.resume");
  setOptionalInteger(
    rendered,
    "ResumeTimeoutInSeconds",
    hooks.resumeTimeoutInSeconds,
    "hooks.microvmHooks.resumeTimeoutInSeconds",
    1,
    60,
  );
  setHookMode(rendered, "Run", hooks.run, "hooks.microvmHooks.run");
  setOptionalInteger(
    rendered,
    "RunTimeoutInSeconds",
    hooks.runTimeoutInSeconds,
    "hooks.microvmHooks.runTimeoutInSeconds",
    1,
    60,
  );
  setHookMode(rendered, "Suspend", hooks.suspend, "hooks.microvmHooks.suspend");
  setOptionalInteger(
    rendered,
    "SuspendTimeoutInSeconds",
    hooks.suspendTimeoutInSeconds,
    "hooks.microvmHooks.suspendTimeoutInSeconds",
    1,
    60,
  );
  setHookMode(rendered, "Terminate", hooks.terminate, "hooks.microvmHooks.terminate");
  setOptionalInteger(
    rendered,
    "TerminateTimeoutInSeconds",
    hooks.terminateTimeoutInSeconds,
    "hooks.microvmHooks.terminateTimeoutInSeconds",
    1,
    60,
  );
  if (Object.keys(rendered).length === 0) {
    throw new Error("AppTheoryMicrovmImage requires at least 1 hooks.microvmHooks setting");
  }
  return rendered;
}

function renderImageHooks(hooks?: AppTheoryMicrovmImageBuildHooks): Record<string, unknown> | undefined {
  if (hooks === undefined) {
    return undefined;
  }
  if (hooks === null) {
    throw new Error("AppTheoryMicrovmImage requires props.hooks.microvmImageHooks");
  }
  const rendered: Record<string, unknown> = {};
  setHookMode(rendered, "Ready", hooks.ready, "hooks.microvmImageHooks.ready");
  setOptionalInteger(
    rendered,
    "ReadyTimeoutInSeconds",
    hooks.readyTimeoutInSeconds,
    "hooks.microvmImageHooks.readyTimeoutInSeconds",
    1,
    3600,
  );
  setHookMode(rendered, "Validate", hooks.validate, "hooks.microvmImageHooks.validate");
  setOptionalInteger(
    rendered,
    "ValidateTimeoutInSeconds",
    hooks.validateTimeoutInSeconds,
    "hooks.microvmImageHooks.validateTimeoutInSeconds",
    1,
    3600,
  );
  if (Object.keys(rendered).length === 0) {
    throw new Error("AppTheoryMicrovmImage requires at least 1 hooks.microvmImageHooks setting");
  }
  return rendered;
}

function setHookMode(
  target: Record<string, unknown>,
  key: string,
  mode: AppTheoryMicrovmHookMode | undefined,
  propName: string,
): void {
  if (mode === undefined) {
    return;
  }
  const normalized = String(mode).trim().toUpperCase();
  if (normalized !== AppTheoryMicrovmHookMode.ENABLED && normalized !== AppTheoryMicrovmHookMode.DISABLED) {
    throw new Error(`AppTheoryMicrovmImage: ${propName} must be ENABLED or DISABLED`);
  }
  target[key] = normalized;
}

function setOptionalInteger(
  target: Record<string, unknown>,
  key: string,
  value: number | undefined,
  propName: string,
  min: number,
  max: number,
): void {
  if (value === undefined) {
    return;
  }
  target[key] = normalizeIntegerInRange(value, propName, min, max);
}

function normalizeLogging(logging: AppTheoryMicrovmImageLogging | undefined): AppTheoryMicrovmImageLogging {
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

function normalizeCloudWatchLogging(
  logging: AppTheoryMicrovmImageCloudWatchLogging | undefined,
): AppTheoryMicrovmImageCloudWatchLogging {
  if (logging === undefined || logging === null) {
    throw new Error("AppTheoryMicrovmImage requires props.logging.cloudWatch");
  }
  return {
    ...(logging.logGroup !== undefined ? { logGroup: normalizeLogGroup(logging.logGroup) } : {}),
    ...(logging.logStream !== undefined ? { logStream: normalizeLogStream(logging.logStream) } : {}),
  };
}

function renderLogging(logging: AppTheoryMicrovmImageLogging): Record<string, unknown> {
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

function normalizeLogGroup(value: string): string {
  const normalized = normalizeRequiredString(value, "logging.cloudWatch.logGroup");
  if (!Token.isUnresolved(value) && !/^[a-zA-Z0-9_\-/.#]{1,512}$/.test(normalized)) {
    throw new Error("AppTheoryMicrovmImage: logging.cloudWatch.logGroup is outside the CloudWatch Logs pattern");
  }
  return normalized;
}

function normalizeLogStream(value: string): string {
  const normalized = normalizeRequiredString(value, "logging.cloudWatch.logStream");
  if (!Token.isUnresolved(value) && (!/^[^:*]*$/.test(normalized) || normalized.length > 512)) {
    throw new Error("AppTheoryMicrovmImage: logging.cloudWatch.logStream is outside the CloudWatch Logs pattern");
  }
  return normalized;
}

function renderResources(
  resources: readonly AppTheoryMicrovmImageResources[] | undefined,
): Array<{ MinimumMemoryInMiB: number }> {
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

function normalizePositiveInteger(value: number | undefined, propName: string): number {
  if (value === undefined || value === null) {
    throw new Error(`AppTheoryMicrovmImage requires props.${propName}`);
  }
  if (Token.isUnresolved(value)) {
    return value;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`AppTheoryMicrovmImage: ${propName} must be a positive integer`);
  }
  return value;
}

function normalizeIntegerInRange(value: number, propName: string, min: number, max: number): number {
  if (Token.isUnresolved(value)) {
    return value;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`AppTheoryMicrovmImage: ${propName} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (Token.isUnresolved(value)) {
      continue;
    }
    if (seen.has(value)) {
      throw new Error(`AppTheoryMicrovmImage does not allow duplicate ${label} values`);
    }
    seen.add(value);
  }
}

function renderTags(tags?: Record<string, string>): Array<{ Key: string; Value: string }> {
  const rendered: Array<{ Key: string; Value: string }> = [
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
