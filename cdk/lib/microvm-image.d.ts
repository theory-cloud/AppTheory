import { CfnResource } from "aws-cdk-lib";
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
export declare enum AppTheoryMicrovmImageOsCapability {
    /**
     * Grants all currently supported MicroVM OS capabilities.
     */
    ALL = "ALL"
}
/**
 * CPU architectures supported by Lambda MicroVM images.
 */
export declare enum AppTheoryMicrovmImageCpuArchitecture {
    /**
     * ARM64 MicroVM image architecture.
     */
    ARM_64 = "ARM_64"
}
/**
 * Lifecycle hook mode for Lambda MicroVM image hooks.
 */
export declare enum AppTheoryMicrovmHookMode {
    /**
     * Disable the lifecycle hook.
     */
    DISABLED = "DISABLED",
    /**
     * Enable the lifecycle hook.
     */
    ENABLED = "ENABLED"
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
export declare class AppTheoryMicrovmImage extends Construct implements IAppTheoryMicrovmImage {
    /**
     * The underlying CloudFormation MicroVM image resource.
     */
    readonly microvmImage: CfnResource;
    /**
     * The MicroVM image name returned by Ref.
     */
    readonly microvmImageName: string;
    /**
     * The ARN of the MicroVM image.
     */
    readonly microvmImageArn: string;
    /**
     * The normalized deployment-owned runtime logging posture for this image.
     */
    readonly logging: AppTheoryMicrovmImageLogging;
    /**
     * The current image state.
     */
    readonly microvmImageState: string;
    /**
     * The latest active image version.
     */
    readonly latestActiveImageVersion: string;
    /**
     * The latest failed image version, if any.
     */
    readonly latestFailedImageVersion: string;
    /**
     * The timestamp when the image was created.
     */
    readonly createdAt: string;
    /**
     * The timestamp when the image was last updated.
     */
    readonly updatedAt: string;
    constructor(scope: Construct, id: string, props: AppTheoryMicrovmImageProps);
}
