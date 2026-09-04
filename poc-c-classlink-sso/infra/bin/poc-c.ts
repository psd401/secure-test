#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { PocCStack } from "../lib/poc-c-stack";

const app = new cdk.App();
new PocCStack(app, "SecureTestPocC", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  description: "PoC-C: ClassLink OIDC id_token verification — API GW + Lambda.",
});
