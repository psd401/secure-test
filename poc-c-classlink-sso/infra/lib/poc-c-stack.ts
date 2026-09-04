import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

export class PocCStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const issuer = process.env.CLASSLINK_ISSUER ?? "https://launchpad.classlink.com";

    const handler = new nodejs.NodejsFunction(this, "VerifyIdTokenFn", {
      entry: path.join(__dirname, "..", "lambda", "verify-id-token.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      logRetention: logs.RetentionDays.ONE_WEEK,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OIDC_ISSUER: issuer,
      },
    });

    const api = new apigw.RestApi(this, "PocCApi", {
      restApiName: "secure-test-poc-c",
      deployOptions: { stageName: "poc" },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ["POST", "OPTIONS"],
      },
    });

    api.root
      .addResource("verify")
      .addMethod("POST", new apigw.LambdaIntegration(handler));

    new cdk.CfnOutput(this, "VerifyUrl", {
      value: `${api.url}verify`,
      description: "POST { id_token: \"...\" } here; the Lambda verifies signature against the configured issuer's JWKS.",
    });
  }
}
