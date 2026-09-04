import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { RosterSync } from "./roster-sync";
import { AppService } from "./app-service";

export interface DesignToolStackProps extends cdk.StackProps {
  // Environment suffix for the per-env asset bucket
  // (secure-test-design-tool-<envName>, ADR 0008 10.1). Default "dev".
  // "prod" retains the bucket on stack deletion; any other value destroys +
  // auto-deletes its objects.
  readonly envName?: string;
  /** Slice 90: cross-account roles allowed to put roster snapshots. */
  readonly producerRoleArns?: readonly string[];
  /** ECS slice 3: OAuth client ids for the task env (James-held, via cdk
   * context — see bin/design-tool.ts). Without them the deploy comes up
   * with sign-in unconfigured. */
  readonly oidcWebClientId?: string;
  readonly oidcNativeClientId?: string;
  /** ECS slice 4: public origin host (plan decision 1.1 placeholder). */
  readonly domainName?: string;
  /** Bedrock guardrail id (ADR 0011 / 0012), from cdk context — a
   * district resource id, so it is not committed to source. */
  readonly guardrailId?: string;
}

// Aurora Postgres Serverless v2 cluster for the design tool (Slice 24).
//
// Public-access pattern: Aurora is `publiclyAccessible: true` and gated
// solely by the security group. This avoids NAT (~$32/mo). Acceptable
// because (a) playground account, (b) no production data yet, (c) password
// is a 30-char auto-generated secret, (d) the SG admits only two peers,
// SG→SG: the roster importer Lambda and the Fargate app service.
//
// No CIDR ingress (infra slice, 2026-09-01). The former `allowedIngressCidr`
// was James's home IP; the district's egress address is the WSIPC/K-20 NAT
// shared by the whole network, so it must never become a standing rule.
// Migrations run inside the VPC (README "Migrating Aurora"); ad-hoc psql
// is a temporary hand-added rule, revoked in the same session.
//
// The roster importer Lambda (roster-sync.ts) sits in the isolated subnets
// and reaches the cluster SG→SG, S3 through the gateway endpoint (free) and
// Secrets Manager through an interface endpoint (the one paid endpoint,
// ~$0.01/AZ-hour + data). Still no NAT.
//
// Scale-to-zero: min 0 ACU pauses the cluster after idle; storage cost
// (~$0.10/GB-mo) is the only floor. First connection after idle takes
// ~15-30s to wake.
export class DesignToolStack extends cdk.Stack {
  public readonly clusterEndpoint: string;
  public readonly secretArn: string;
  public readonly assetBucketName: string;

  constructor(scope: Construct, id: string, props: DesignToolStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        // Roster importer placement (infra-roster-lambda-vpc). Appended AFTER
        // "public" on purpose: CDK allocates subnet CIDRs in configuration
        // order, so the existing public subnets keep theirs and the cluster's
        // subnet group is untouched. Isolated = no route to the internet; the
        // endpoints below are the Lambda's only way out.
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Gateway endpoint: S3 from the isolated subnets, no NAT. Free.
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });

    // Interface endpoint: Secrets Manager from the isolated subnets. The
    // importer reads DB_SECRET_ARN once per cold start; with no NAT this is
    // the only path to the service. privateDnsEnabled so the SDK's default
    // regional hostname resolves to the endpoint ENIs. ONE AZ on purpose
    // (James, 2026-08-28, follow-up 9.4): each ENI is ~$7/mo and the Aurora
    // writer is single-AZ anyway, so a second ENI buys no resilience the
    // stack has elsewhere; a Lambda ENI in the other AZ still reaches this
    // one over private DNS inside the VPC.
    vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: vpc.availabilityZones.slice(0, 1),
      },
      privateDnsEnabled: true,
    });

    // Ingress rules are added by the two consumers below (RosterSync and
    // AppService), each SG→SG on 5432. Nothing else — see the header.
    const securityGroup = new ec2.SecurityGroup(this, "ClusterSg", {
      vpc,
      description: "Design-tool Aurora cluster ingress",
      allowAllOutbound: true,
    });

    const cluster = new rds.DatabaseCluster(this, "Cluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      // 0.5 min for the pilot (ECS deploy plan decision 1.2, 2026-08-31):
      // the web app has no waitForDatabase equivalent, and the 0-ACU resume
      // took 15-90s — first request after idle would 500. A few $/day;
      // revisit post-pilot. The importer's waitForDatabase goes dormant but
      // stays (right again if this ever returns to 0).
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: true,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [securityGroup],
      defaultDatabaseName: "secure_test_design_tool",
      credentials: rds.Credentials.fromGeneratedSecret("secure_test_admin"),
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.clusterEndpoint = cluster.clusterEndpoint.hostname;
    this.secretArn = cluster.secret!.secretArn;

    new cdk.CfnOutput(this, "ClusterEndpoint", {
      value: cluster.clusterEndpoint.socketAddress,
      description: "Aurora writer endpoint (host:port).",
    });

    new cdk.CfnOutput(this, "DatabaseName", {
      value: "secure_test_design_tool",
      description: "Initial database to use in DATABASE_URL.",
    });

    new cdk.CfnOutput(this, "CredentialsSecretArn", {
      value: cluster.secret!.secretArn,
      description:
        "Secrets Manager ARN holding {username, password, host, port, dbname}.",
    });

    // --- Asset storage: S3 bucket for design-tool image uploads (Slice 31,
    // ADR 0008). SSE-S3 default encryption (10.2 — no student PII at rest, so
    // a customer-managed key isn't load-bearing yet); public access fully
    // blocked since reads are app-served via /api/assets/<id>, never public
    // (10.4); an abort-incomplete-multipart lifecycle rule, no versioning
    // (10.5); per-env bucket name (10.1).
    const envName = props.envName ?? "dev";
    const isProd = envName === "prod";

    const assetBucket = new s3.Bucket(this, "AssetBucket", {
      bucketName: `secure-test-design-tool-${envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
      ],
      // dev is disposable; prod retains its bucket on stack deletion.
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
    this.assetBucketName = assetBucket.bucketName;

    // No app compute exists in this stack yet — the Next.js app runs locally
    // and connects with developer / IAM-user credentials — so there is no
    // execution role to grant. Expose a scoped managed policy instead: attach
    // it to the app role when app compute lands, or to a local-testing IAM
    // user (the S3 parallel to the secure-test-bedrock user). Object
    // Put/Get/Delete only; the app lists assets from Postgres, not S3, so no
    // s3:ListBucket is required.
    const assetAccessPolicy = new iam.ManagedPolicy(this, "AssetBucketAccess", {
      managedPolicyName: `secure-test-design-tool-${envName}-asset-access`,
      description:
        "Put/Get/Delete on the design-tool asset bucket. Attach to the app " +
        "execution role or a local-testing IAM user.",
      statements: [
        new iam.PolicyStatement({
          actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
          resources: [assetBucket.arnForObjects("*")],
        }),
      ],
    });

    new cdk.CfnOutput(this, "AssetBucketName", {
      value: assetBucket.bucketName,
      description: "S3 bucket for design-tool image assets (set as S3_BUCKET).",
    });

    new cdk.CfnOutput(this, "AssetBucketAccessPolicyArn", {
      value: assetAccessPolicy.managedPolicyArn,
      description:
        "Managed policy granting Put/Get/Delete on the asset bucket — attach to the app role or a testing IAM user.",
    });

    // --- Roster sync (Slice 76, ADR 0017): the extract bucket the warehouse
    // DAG writes to, and the importer Lambda its manifest triggers. Connects
    // to the cluster above with its credentials secret, from inside the VPC
    // (isolated subnets; the cluster SG admits the importer's SG on 5432).
    // A public cluster is not reachable from a Lambda outside the VPC unless
    // the SG is opened to the whole internet, which it never is — the
    // out-of-VPC placement timed out on every S3-triggered import.
    new RosterSync(this, "RosterSync", {
      envName,
      databaseSecret: cluster.secret!,
      vpc,
      databaseSecurityGroup: securityGroup,
      producerRoleArns: props.producerRoleArns,
    });

    // --- App compute (ECS deploy slices 2-4, docs/ecs-deploy-plan.md):
    // the Fargate service + ALB the design tool actually runs on. The
    // "no app compute exists yet" note above the managed policy is closed
    // by this construct attaching that policy to its task role.
    //
    // domainName is required, not defaulted (public-release scrub,
    // 2026-09-04): a real hostname used to ship as the fallback here, which
    // meant a bare `cdk synth`/`cdk deploy` silently pointed at the
    // district's production origin. Set it via context — see
    // cdk.context.json.example — or `--context domainName=…`.
    if (!props.domainName) {
      throw new Error(
        "DesignToolStack requires domainName (context key `domainName`, or " +
          "--context domainName=<host>). No production hostname is " +
          "committed to source — see cdk.context.json.example.",
      );
    }
    // Same rule for the guardrail id: the task role's ApplyGuardrail grant
    // and GUARDRAIL_ID both derive from it.
    if (!props.guardrailId) {
      throw new Error(
        "DesignToolStack requires guardrailId (context key `guardrailId`, or " +
          "--context guardrailId=<id>) — see cdk.context.json.example.",
      );
    }

    new AppService(this, "App", {
      envName,
      vpc,
      databaseSecret: cluster.secret!,
      databaseSecurityGroup: securityGroup,
      assetBucketName: assetBucket.bucketName,
      assetAccessPolicy: assetAccessPolicy,
      guardrailId: props.guardrailId,
      oidcWebClientId: props.oidcWebClientId,
      oidcNativeClientId: props.oidcNativeClientId,
      domainName: props.domainName,
    });
  }
}
