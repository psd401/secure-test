#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { PocBStack } from "../lib/poc-b-stack";

const app = new cdk.App();
new PocBStack(app, "SecureTestPocB", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  description: "PoC-B: test delivery loop — API Gateway + Lambda + CloudWatch.",
});
