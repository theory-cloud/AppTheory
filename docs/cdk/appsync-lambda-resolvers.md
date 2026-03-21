# AppSync Lambda Resolvers

Use this guide when AppSync owns the GraphQL API and AppTheory owns the Lambda resolver runtime.

AppTheory does not export an AppSync-specific CDK construct. Use `aws-cdk-lib/aws-appsync` for the GraphQL API,
schema, auth, and Lambda data source wiring, and keep the Lambda handler on AppTheory's AppSync runtime entrypoints.

## Use this when

- AppSync should manage schema, auth, and resolver registration
- the Lambda handler should keep AppTheory routing, middleware, and typed AppSync context behavior
- you want the same resolver Lambda pattern in Go, TypeScript, or Python

## Minimal TypeScript stack

```ts
import * as path from "node:path";

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export class AppSyncResolverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, "ResolverHandler", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "dist")),
      timeout: cdk.Duration.seconds(30),
    });

    const api = new appsync.GraphqlApi(this, "GraphqlApi", {
      name: "apptheory-things",
      definition: appsync.Definition.fromFile(
        path.join(__dirname, "..", "schema.graphql"),
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
        },
      },
    });

    const lambdaSource = api.addLambdaDataSource("ThingResolvers", handler);

    lambdaSource.createResolver("GetThingResolver", {
      typeName: "Query",
      fieldName: "getThing",
    });

    lambdaSource.createResolver("CreateThingResolver", {
      typeName: "Mutation",
      fieldName: "createThing",
    });

    new cdk.CfnOutput(this, "GraphqlUrl", { value: api.graphqlUrl });
  }
}
```

The AppSync side owns:

- GraphQL schema files
- auth mode selection and AppSync-specific policies
- resolver registration (`Query`, `Mutation`, `Subscription`) and data sources

The AppTheory Lambda side owns:

- request adaptation from the standard direct Lambda resolver event
- route registration (`GET /fieldName` or `POST /fieldName`)
- middleware, error shaping, and typed AppSync context access

## Resolver-to-route mapping

Keep the AppTheory route name aligned with the GraphQL field name:

- `Query.getThing` -> `GET /getThing`
- `Mutation.createThing` -> `POST /createThing`
- `Subscription.onThingUpdated` -> `GET /onThingUpdated`

Use the explicit AppSync runtime entrypoint when the Lambda is AppSync-only:

- Go: `app.ServeAppSync(ctx, event)`
- TypeScript: `app.serveAppSync(event, ctx)`
- Python: `app.serve_appsync(event, ctx)`

Use the universal dispatcher when the same Lambda also accepts other AWS trigger types:

- Go: `app.HandleLambda(ctx, event)`
- TypeScript: `app.handleLambda(event, ctx)`
- Python: `app.handle_lambda(event, ctx)`

## Scope boundaries

- AppTheory does not generate GraphQL schemas, AppSync auth policies, or AppSync resolver infrastructure
- AppTheory does not currently export an `AppTheoryAppSyncApi` or resolver-specific construct under
  `@theory-cloud/apptheory-cdk`
- you do not need custom request mapping rewrites just to use AppTheory's AppSync runtime adapters with the standard
  direct Lambda event shape

## Related guides

- [AppSync Lambda Resolver Runtime Recipe](../migration/appsync-lambda-resolvers.md)
- [AppTheory API Reference](../api-reference.md)
