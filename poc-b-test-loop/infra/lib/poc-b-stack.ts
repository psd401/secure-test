import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

export class PocBStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = new nodejs.NodejsFunction(this, "ResponseIntakeFn", {
      entry: path.join(__dirname, "..", "lambda", "response-intake.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      logRetention: logs.RetentionDays.ONE_WEEK,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
    });

    const api = new apigw.RestApi(this, "PocBApi", {
      restApiName: "secure-test-poc-b",
      deployOptions: { stageName: "poc" },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ["POST", "OPTIONS"],
      },
    });

    api.root
      .addResource("responses")
      .addMethod("POST", new apigw.LambdaIntegration(handler));

    new cdk.CfnOutput(this, "ApiUrl", {
      value: `${api.url}responses`,
      description: "Set POCB_API_URL to this in the client env before launching PocBClient.",
    });
  }
}
