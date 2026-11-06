import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * Lambda layers and container-image functions.
 *
 * A Node and a Python zip function declare a Lambda layer; the layer content is
 * extracted into /opt, so the handler imports a module from
 * /opt/nodejs/node_modules or /opt/python and executes a tool from /opt/bin.
 * Three container-image functions are built from a Dockerfile whose build
 * argument writes a value into the image, so the row proves the built bytes.
 *
 * https://docs.aws.amazon.com/lambda/latest/dg/chapter-layers.html
 * https://docs.aws.amazon.com/lambda/latest/dg/packaging-layers.html
 * https://docs.aws.amazon.com/lambda/latest/dg/images-create.html
 */
export class LambdaPackagingStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const root = path.join(__dirname, "..");

        const nodeLayer = new lambda.LayerVersion(this, "NodeLayer", {
            layerVersionName: "apptheory-local-node-layer",
            code: lambda.Code.fromAsset(path.join(root, "layers/node")),
            compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
            description: "nodejs/node_modules and bin content for the local runner",
        });
        const pythonLayer = new lambda.LayerVersion(this, "PythonLayer", {
            layerVersionName: "apptheory-local-python-layer",
            code: lambda.Code.fromAsset(path.join(root, "layers/python")),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
            description: "python module and bin content for the local runner",
        });

        const layerNode = new lambda.Function(this, "LayerNodeFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "app.handler",
            code: lambda.Code.fromAsset(path.join(root, "handlers/node")),
            layers: [nodeLayer],
            timeout: cdk.Duration.seconds(10),
            description: "Imports a module from /opt/nodejs/node_modules and runs /opt/bin/layer-tool",
        });
        const layerPython = new lambda.Function(this, "LayerPythonFn", {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: "app.handler",
            code: lambda.Code.fromAsset(path.join(root, "handlers/python")),
            layers: [pythonLayer],
            timeout: cdk.Duration.seconds(10),
            description: "Imports a module from /opt/python and runs /opt/bin/layer-tool",
        });

        const imageGo = new lambda.DockerImageFunction(this, "ImageGoFn", {
            code: lambda.DockerImageCode.fromImageAsset(path.join(root, "images/go"), {
                buildArgs: { IMAGE_VALUE: "go-image-build" },
            }),
            description: "Provided runtime image built by the local runner",
        });
        const imageNode = new lambda.DockerImageFunction(this, "ImageNodeFn", {
            code: lambda.DockerImageCode.fromImageAsset(path.join(root, "images/node"), {
                buildArgs: { IMAGE_VALUE: "node-image-build" },
            }),
            description: "Node image built by the local runner",
        });
        const imagePython = new lambda.DockerImageFunction(this, "ImagePythonFn", {
            code: lambda.DockerImageCode.fromImageAsset(path.join(root, "images/python"), {
                buildArgs: { IMAGE_VALUE: "python-image-build" },
            }),
            description: "Python image built by the local runner",
        });

        const api = new apigwv2.HttpApi(this, "PackagingApi", {
            apiName: "apptheory-local-packaging",
        });
        const routes: Array<[string, lambda.IFunction, string]> = [
            ["/layer/node", layerNode, "LayerNodeIntegration"],
            ["/layer/python", layerPython, "LayerPythonIntegration"],
            ["/image/go", imageGo, "ImageGoIntegration"],
            ["/image/node", imageNode, "ImageNodeIntegration"],
            ["/image/python", imagePython, "ImagePythonIntegration"],
        ];
        for (const [routePath, handler, id] of routes) {
            api.addRoutes({
                path: routePath,
                methods: [apigwv2.HttpMethod.GET],
                integration: new apigwv2Integrations.HttpLambdaIntegration(id, handler),
            });
        }

        new cdk.CfnOutput(this, "PackagingApiUrl", { value: api.apiEndpoint });
    }
}
