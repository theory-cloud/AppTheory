import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

/**
 * The second app of the shared-plane row.
 *
 * It defines a role another co-resident run's function assumes through STS, and
 * a REST API whose resource policy trusts the first app's caller. A run of this
 * app publishes those definitions into the shared IAM plane; a run of
 * examples/cdk/local-iam assumes the role and calls this API, and this run
 * verifies the session and evaluates its own resource policy.
 */
export class LocalIamPeerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    const peerIdentity = [
      "exports.handler = async (event) => {",
      "  const context = event.requestContext || {};",
      "  const identity = context.identity || {};",
      "  return {",
      "    statusCode: 200,",
      '    headers: { "content-type": "application/json" },',
      "    body: JSON.stringify({",
      '      route: "peer",',
      "      caller: identity.caller || null,",
      "      userArn: identity.userArn || null,",
      "      accountId: identity.accountId || null,",
      "      accessKey: identity.accessKey || null,",
      "    }),",
      "  };",
      "};",
    ].join("\n");

    const identityFn = new lambda.Function(this, "PeerIdentityFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Peer identity echo: reports the caller this run's gateway resolved",
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(peerIdentity),
    });

    // A role this run defines and the other run assumes. Its trust policy is
    // the one decision the local STS endpoint makes; its identity policy is what
    // the assumed session may call.
    const vendingRole = new iam.Role(this, "PeerVendingRole", {
      roleName: "local-iam-peer-vending",
      assumedBy: new iam.AccountPrincipal(this.account),
    });

    const api = new apigw.RestApi(this, "PeerApi", {
      restApiName: "local-iam-peer",
      deployOptions: { stageName: "lab" },
    });
    const peer = api.root.addResource("peer");
    peer.addMethod("GET", new apigw.LambdaIntegration(identityFn), {
      authorizationType: apigw.AuthorizationType.IAM,
    });

    // The resource policy accepts this run's own roles. The row's session lives
    // in this account, so the same-account union rule applies and the role's
    // identity grant is what allows the call.
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        principals: [new iam.AccountRootPrincipal()],
        resources: ["execute-api:/lab/GET/peer"],
      }),
    );
    vendingRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/GET/peer`],
      }),
    );

    new cdk.CfnOutput(this, "PeerVendingRoleArn", { value: vendingRole.roleArn });
  }
}
