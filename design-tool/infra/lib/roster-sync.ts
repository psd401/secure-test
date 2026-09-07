import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

export interface RosterSyncProps {
  readonly envName: string;
  /** The design-tool cluster's credentials secret; the importer connects
   * with it. */
  readonly databaseSecret: secretsmanager.ISecret;
  /** The VPC the cluster lives in; the importer is placed in its isolated
   * subnets (the stack provides S3 + Secrets Manager endpoints there). */
  readonly vpc: ec2.IVpc;
  /** The cluster's security group; this construct adds the one ingress rule
   * that lets the importer in on 5432. */
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
  /** Slice 90: IAM principals in OTHER accounts that put snapshots — the
   * warehouse DAG's MWAA execution role. A policy in this account cannot be
   * attached to a role in theirs, so the grant lives on the bucket policy
   * (the data engineer's reply, 2026-08-27). Put-only under roster/, like the managed
   * policy below. */
  readonly producerRoleArns?: readonly string[];
  /** Observability slice 1 (docs/observability-design.md): the shared
   * alarm/feedback topic — the importer's Errors alarm publishes here. */
  readonly notifyTopic: sns.ITopic;
}

// Slice 76 (ADR 0017): the roster extract bucket and the importer it triggers.
//
// The warehouse DAG puts a snapshot under roster/<snapshot_id>/ and writes
// manifest.json last (docs/roster-extract.md). The bucket notifies the Lambda
// on that one key shape only; the Lambda reads the five objects, validates,
// and imports (design-tool/lib/roster/syncHandler.ts).
//
// Retention: snapshots hold every student's name and email, so objects
// expire after 30 days — enough to re-import a recent night by hand, not an
// archive. The roster itself lives in Postgres; the bucket is a mailbox.
//
// Not deployed in this phase. `cdk synth` is the verification.
export class RosterSync extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly fn: lambdaNodejs.NodejsFunction;
  public readonly producerPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: RosterSyncProps) {
    super(scope, id);

    const isProd = props.envName === "prod";
    const prefix = "roster/";

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: `secure-test-roster-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Slice 90: stated, not assumed. With bucket-owner-enforced, objects a
      // cross-account producer writes are owned by this account, so the
      // importer Lambda can read them without an ACL from the writer.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      lifecycleRules: [
        { prefix, expiration: cdk.Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // Slice 90: cross-account producers, on the bucket policy.
    const producers = props.producerRoleArns ?? [];
    if (producers.length > 0) {
      this.bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "WarehouseProducerPut",
          principals: producers.map((arn) => new iam.ArnPrincipal(arn)),
          actions: ["s3:PutObject"],
          resources: [this.bucket.arnForObjects(`${prefix}*`)],
        }),
      );
    }

    // What the warehouse side gets: put-only under the prefix. No read, no
    // list, no delete — the producer never needs to see a previous snapshot.
    this.producerPolicy = new iam.ManagedPolicy(this, "ProducerPolicy", {
      managedPolicyName: `secure-test-roster-${props.envName}-producer`,
      description:
        "PutObject under roster/ on the roster extract bucket. Attach to the " +
        "MWAA execution role or the IAM principal the warehouse DAG runs as.",
      statements: [
        new iam.PolicyStatement({
          actions: ["s3:PutObject"],
          resources: [this.bucket.arnForObjects(`${prefix}*`)],
        }),
      ],
    });

    // The importer's own security group. Outbound open (the endpoints and
    // the cluster are all inside the VPC); nothing inbound — a Lambda ENI
    // accepts no connections anyway.
    const importerSg = new ec2.SecurityGroup(this, "ImporterSg", {
      vpc: props.vpc,
      description: "Roster importer Lambda egress",
      allowAllOutbound: true,
    });

    // Cluster admits the importer SG→SG on 5432. Deliberately tighter than
    // the AI Studio oneroster-sync pattern, which admits the whole VPC CIDR:
    // here only ENIs carrying the importer's SG can open a connection, so a
    // future in-VPC resource gets nothing by default.
    props.databaseSecurityGroup.addIngressRule(
      importerSg,
      ec2.Port.tcp(5432),
      "Roster importer Lambda (SG-to-SG)",
    );

    this.fn = new lambdaNodejs.NodejsFunction(this, "Importer", {
      functionName: `secure-test-roster-sync-${props.envName}`,
      description: "Imports a warehouse roster snapshot when its manifest lands (ADR 0017).",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambda", "roster-sync.ts"),
      handler: "handler",
      // In the VPC, isolated subnets: no NAT, so S3 and Secrets Manager come
      // through the stack's VPC endpoints and the cluster through its SG
      // rule above. NodejsFunction attaches AWSLambdaVPCAccessExecutionRole
      // for the ENI it needs.
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [importerSg],
      // The importer holds a table lock per table for a district-scale
      // upsert; minutes, not seconds. One at a time — two snapshots racing
      // would each deactivate the other's rows in turn.
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      reservedConcurrentExecutions: 1,
      environment: {
        ROSTER_BUCKET: this.bucket.bucketName,
        ROSTER_PREFIX: prefix,
        DB_SECRET_ARN: props.databaseSecret.secretArn,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        // The handler imports design-tool code by its `@/` alias; that tsconfig
        // is where the alias is defined.
        tsconfig: path.join(__dirname, "..", "..", "tsconfig.json"),
        format: lambdaNodejs.OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        minify: false,
        // The Node 22 runtime ships SDK v3.
        externalModules: ["@aws-sdk/*"],
        // postgres.js needs these at runtime; without the shim an ESM bundle
        // has no `require`.
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    this.bucket.grantRead(this.fn, `${prefix}*`);
    props.databaseSecret.grantRead(this.fn);

    this.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.fn),
      { prefix, suffix: "/manifest.json" },
    );

    // Observability slice 1: one or more importer failures in a 5-minute
    // window is worth an email — a bad or missing snapshot means the
    // roster silently goes stale.
    new cloudwatch.Alarm(this, "ImporterErrorsAlarm", {
      metric: this.fn.metricErrors({
        statistic: "sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "One or more roster importer Lambda errors in the last 5 minutes.",
    }).addAlarmAction(new cwActions.SnsAction(props.notifyTopic));

    new cdk.CfnOutput(this, "RosterBucketName", {
      value: this.bucket.bucketName,
      description: "S3 bucket the warehouse DAG writes roster snapshots to.",
    });
    new cdk.CfnOutput(this, "RosterProducerPolicyArn", {
      value: this.producerPolicy.managedPolicyArn,
      description: "Put-only policy for the extract producer (hand to the data engineer).",
    });
    new cdk.CfnOutput(this, "RosterSyncFunctionName", {
      value: this.fn.functionName,
      description: "The importer Lambda; its CloudWatch log carries counts only.",
    });
  }
}
