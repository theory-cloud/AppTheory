import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * Runtimes an AppTheory Web Function deploys on.
 *
 * These are the Lambda Web Function managed runtimes that can start an HTTP server
 * (`nodejs24.x` and `nodejs26.x`). The set is closed on purpose: a runtime outside it is
 * refused at synthesis rather than deployed into a function that cannot start.
 */
const SUPPORTED_RUNTIMES: { [name: string]: string } = {
  "nodejs24.x": "Node.js 24",
  "nodejs26.x": "Node.js 26",
};

/**
 * The endpoint a Web Function serves requests on.
 *
 * Every field here is deployment configuration, not a runtime knob: the endpoint is part of the
 * stack, so its shape is decided at synthesis time and never by an environment variable.
 */
export interface AppTheoryWebFunctionEndpointProps {
  /**
   * The name of the endpoint.
   *
   * Must be 2 to 64 characters of letters, numbers, hyphens or underscores, starting and ending
   * with a letter or number.
   *
   * @default undefined - the endpoint is named `prod` in the home Region
   */
  readonly endpointName?: string;

  /**
   * A description of the endpoint.
   *
   * @default undefined - no description
   */
  readonly description?: string;

  /**
   * The maximum number of concurrent execution environments the endpoint may use.
   *
   * A cap on top of the account's vCPU quota, not a reservation. Must be 2 or greater.
   *
   * @default undefined - scaling is limited only by the account's vCPU quota
   */
  readonly maxEnvironments?: number;

  /**
   * The maximum request rate per second the endpoint accepts.
   *
   * The service accepts 0, 100 through 1000 in increments of 100, and 2000 through 10000 in
   * increments of 1000. Which of those a Region accepts varies, and an unsupported value is
   * rejected at deploy time with the values that Region does accept.
   *
   * @default undefined - the request rate is limited only by the account's rate limit quota
   */
  readonly rateLimit?: number;
}

/**
 * Properties for an AppTheory Web Function.
 *
 * A Web Function is a Lambda function that serves HTTP directly: the application starts its own
 * HTTP server and one execution environment answers many concurrent requests. That is a different
 * execution model from the request/response runtime in `runtime/`, and this construct composes the
 * deployment for it.
 */
export interface AppTheoryWebFunctionProps {
  /**
   * The deployment package: a directory to asset, or a bucket object holding the application.
   */
  readonly code: lambda.WebFunctionCode;

  /**
   * The managed runtime the revision runs.
   *
   * Only `nodejs24.x` and `nodejs26.x` are accepted; any other runtime is refused at synthesis.
   *
   * @default undefined - a runtime is required
   */
  readonly runtime: lambda.WebFunctionRuntime;

  /**
   * The entry file the runtime loads, relative to the root of the deployment package.
   *
   * Only supported for Node.js runtimes. When set, it is passed to the runtime through
   * `AWS_LAMBDA_NODEJS_ENTRYPOINT`; do not also set that variable in `environment`.
   *
   * @default undefined - the runtime's default entry point, `index.js`
   */
  readonly entryPoint?: string;

  /**
   * Environment variables for the revision.
   *
   * `AWS_LAMBDA_HTTP_ENDPOINT` is set by the Lambda service and must not be set here: the
   * application reads it to learn where to listen.
   *
   * @default undefined - no environment variables
   */
  readonly environment?: { [key: string]: string };

  /**
   * The timeout of one request, in seconds.
   *
   * @default undefined - the service default of 30 seconds
   */
  readonly timeout?: Duration;

  /**
   * The maximum number of concurrent requests one execution environment answers.
   *
   * Must be an integer between 1 and 128.
   *
   * @default undefined - the service default of 64
   */
  readonly maxConcurrencyPerEnvironment?: number;

  /**
   * A description of the revision.
   *
   * @default undefined - no description
   */
  readonly description?: string;

  /**
   * Who authorizes requests to the endpoint.
   *
   * `IAM_AUTH` is the default: the endpoint is not public and Lambda authorizes every request
   * against IAM. `APPLICATION_MANAGED` makes the endpoint public and leaves authorization to the
   * application, and is therefore never a default.
   *
   * @default lambda.WebFunctionAuthType.IAM_AUTH
   */
  readonly authType?: lambda.WebFunctionAuthType;

  /**
   * Settings of the endpoint the function serves requests on.
   *
   * @default undefined - a home-Region endpoint named `prod`
   */
  readonly endpoint?: AppTheoryWebFunctionEndpointProps;

  /**
   * The execution role.
   *
   * @default undefined - a new role with `AWSLambdaBasicExecutionRole` is created
   */
  readonly role?: iam.IRole;

  /**
   * The log group the function sends its logs to.
   *
   * @default undefined - a log group is created and retained when the stack is deleted
   */
  readonly logGroup?: logs.ILogGroup;

  /**
   * The minimum log level of application logs.
   *
   * @default undefined - no application log level filtering
   */
  readonly applicationLogLevel?: lambda.ApplicationLogLevel;

  /**
   * The minimum log level of system logs.
   *
   * @default undefined - no system log level filtering
   */
  readonly systemLogLevel?: lambda.SystemLogLevel;
}

/**
 * A Lambda Web Function: a function that serves HTTP through its own endpoint.
 *
 * One composition creates the function, its first revision, and the endpoint it answers on, with
 * an endpoint that defaults to `IamAuth` so a function is never public by accident. The
 * application starts its own HTTP server and reads `AWS_LAMBDA_HTTP_ENDPOINT` for the address to
 * listen on; there is no adapter and no second entry point.
 *
 * @example
 * // A page and a streamed response, on an endpoint that requires IAM authorization
 * const app = new AppTheoryWebFunction(stack, 'Web', {
 *   code: lambda.WebFunctionCode.fromAssetToManagedBucket('app'),
 *   runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
 *   entryPoint: 'server.mjs',
 * });
 * // app.domainName is the endpoint to request, and app.endpoint.grants authorizes callers.
 */
export class AppTheoryWebFunction extends Construct {
  /**
   * The Web Function, its revision, and the endpoint it creates.
   */
  public readonly webFunction: lambda.WebFunction;

  /**
   * The endpoint requests reach, and the grants that authorize them.
   */
  public readonly endpoint: lambda.WebFunctionEndpoint;

  /**
   * The domain name to send requests to.
   */
  public readonly domainName: string;

  /**
   * The ARN of the function.
   */
  public readonly webFunctionArn: string;

  /**
   * The ID of the revision this construct created.
   *
   * This is the revision the endpoint sends all of its traffic to. To shift traffic between
   * revisions, set `endpoint.resource.revisionWeights` on the underlying L1 resource: the
   * `WebFunctionTraffic` helper only expresses `single(revisionId)`, so a weighted split is the
   * documented L1 escape hatch.
   */
  public readonly revisionId: string;

  constructor(scope: Construct, id: string, props: AppTheoryWebFunctionProps) {
    super(scope, id);

    const runtimeName = props.runtime.name;
    if (runtimeName.startsWith("python")) {
      throw new Error(
        `AppTheoryWebFunction does not compose the "${runtimeName}" Web Function runtime: a ` +
          "Python Web Function serves an ASGI or WSGI application, and AppTheory's Python " +
          "runtime is a request/response runtime with no such entry point. " +
          `Supported runtimes are ${Object.keys(SUPPORTED_RUNTIMES).join(", ")}`,
      );
    }
    if (!Object.hasOwn(SUPPORTED_RUNTIMES, runtimeName)) {
      throw new Error(
        `AppTheoryWebFunction does not support runtime "${runtimeName}"; ` +
          `supported runtimes are ${Object.keys(SUPPORTED_RUNTIMES).join(", ")}`,
      );
    }

    const environment = props.environment ?? {};
    if (Object.hasOwn(environment, "AWS_LAMBDA_HTTP_ENDPOINT")) {
      throw new Error(
        "AppTheoryWebFunction does not accept AWS_LAMBDA_HTTP_ENDPOINT in props.environment; " +
          "the Lambda service sets it and the application reads it",
      );
    }

    const endpointProps = props.endpoint ?? {};

    this.webFunction = new lambda.WebFunction(this, "Function", {
      code: props.code,
      runtime: props.runtime,
      entryPoint: props.entryPoint,
      environment: Object.keys(environment).length === 0 ? undefined : environment,
      timeout: props.timeout,
      maxConcurrencyPerEnvironment: props.maxConcurrencyPerEnvironment,
      revisionDescription: props.description,
      defaultEndpointAuth: props.authType ?? lambda.WebFunctionAuthType.IAM_AUTH,
      defaultEndpoint: {
        endpointName: endpointProps.endpointName,
        endpointDescription: endpointProps.description,
        maxEnvironments: endpointProps.maxEnvironments,
        rateLimit: endpointProps.rateLimit,
      },
      role: props.role,
      logGroup: props.logGroup,
      applicationLogLevel: props.applicationLogLevel,
      systemLogLevel: props.systemLogLevel,
    });

    this.endpoint = this.webFunction.endpoint;
    this.domainName = this.endpoint.domainName;
    this.webFunctionArn = this.webFunction.webFunctionArn;
    this.revisionId = this.webFunction.revisionId;
  }
}
