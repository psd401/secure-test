import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface AppServiceProps {
  readonly envName: string;
  /** The stack VPC; tasks run in its PUBLIC subnets with public IPs (ADR
   * 0014's no-NAT stance — the service SG only admits the ALB anyway). */
  readonly vpc: ec2.IVpc;
  /** The Aurora cluster's credentials secret; its JSON keys are injected as
   * DB_* env vars and the boot shim assembles DATABASE_URL (slice 3). */
  readonly databaseSecret: secretsmanager.ISecret;
  /** The Aurora cluster's SG; this construct adds the one ingress rule that
   * lets the service in on 5432 (same shape as the importer's rule). */
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
  /** Slice 31's asset bucket — STORAGE_PROVIDER=s3 target (container disk
   * is ephemeral). */
  readonly assetBucketName: string;
  /** Slice 31's asset-bucket managed policy — attaching it here closes ADR
   * 0008's "attach to the app role when app compute lands" step. */
  readonly assetAccessPolicy: iam.IManagedPolicy;
  /** Bedrock guardrail id (ADR 0011); ApplyGuardrail is scoped to it. */
  readonly guardrailId: string;
  /** Web OAuth client id (GCP "secure-test design tool"). Not a secret —
   * but James-held, so it arrives via cdk context, not the repo. */
  readonly oidcWebClientId?: string;
  /** Native client id (GCP "secure-test macOS client"). BOTH ids must be in
   * OIDC_AUDIENCE or the client's /api/auth/exchange breaks (plan slice 3). */
  readonly oidcNativeClientId?: string;
  /** ECS slice 4: the app's public origin host. Required — no default is
   * committed to source (see cdk.context.json.example); a friendlier name
   * + final domain are a post-pilot decision (nothing in the DB stores the
   * origin — a rename costs cert, one GCP redirect URI,
   * OIDC_REDIRECT_URI, SECURE_TEST_SERVER and one re-sign-in). */
  readonly domainName: string;
}

/** Name of the James-created app secret (slice 3). Keys:
 * DESIGN_TOOL_SESSION_SECRET, DESIGN_TOOL_PKCE_SECRET,
 * DESIGN_TOOL_DELIVERY_SECRET, OIDC_CLIENT_SECRET. Values never enter the
 * repo; create + fill before the first deploy:
 *   aws secretsmanager create-secret --name <name> --secret-string '{...}'
 */
export function appSecretName(envName: string): string {
  return `secure-test-design-tool/${envName}/app-env`;
}

// ECS deploy slices 2-4 (docs/ecs-deploy-plan.md): the first app compute.
//
// One Fargate task behind a public ALB, image built from the repo-root
// Dockerfile (design-tool/Dockerfile — the bun workspace needs packages/ in
// context). ARM64 throughout: local verifies ran on colima/arm64 and
// Fargate ARM is the cheaper tier; the DockerImageAsset platform and the
// task runtimePlatform must agree or the task crashes on exec format.
//
// HTTPS is load-bearing, not cosmetic: session/PKCE cookies are `secure`
// under NODE_ENV=production (lib/auth/session.ts), so a plain-HTTP origin
// fails sign-in with missing_pkce_cookie. The cert is DNS-validated and the
// psd401.ai zone lives OUTSIDE this stack — the first deploy pauses in
// CREATE_IN_PROGRESS on the certificate until James adds the validation
// CNAME (console → Certificate Manager → the pending cert shows it).
export class AppService extends Construct {
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  public readonly taskRole: iam.Role;

  constructor(scope: Construct, id: string, props: AppServiceProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const image = new ecrAssets.DockerImageAsset(this, "Image", {
      // Repo root — .dockerignore there keeps .env*, storage/ and the poc
      // trees out of the context.
      directory: path.join(__dirname, "..", "..", ".."),
      file: "design-tool/Dockerfile",
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // Explicit task role so the grants below are attached to a construct we
    // own (the pattern would otherwise synthesize an empty one).
    this.taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "Design-tool app task role: asset bucket, Bedrock models, guardrail.",
    });

    // ADR 0008's deferred step: the asset bucket policy finally has compute
    // to attach to.
    this.taskRole.addManagedPolicy(props.assetAccessPolicy);

    // Bedrock (ADR 0007, slice 27 wiring): SigV4 InvokeModel/Converse on the
    // `us.` cross-region inference profiles AND the underlying foundation
    // models — both ARNs are required (social-stories' proven policy shape).
    // Region is wildcarded because the us. profile routes cross-region.
    // Models: Sonnet 4.6 (item gen, PDF extract, essay score) + Haiku 4.5
    // (math translator) — the four BEDROCK_*_MODEL defaults in lib/ai.
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
          `arn:aws:bedrock:*:${stack.account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
          `arn:aws:bedrock:*:${stack.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
        ],
      }),
    );

    // Safeguarding guardrail (ADR 0011, slices 28-29).
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:ApplyGuardrail"],
        resources: [
          `arn:aws:bedrock:${stack.region}:${stack.account}:guardrail/${props.guardrailId}`,
        ],
      }),
    );

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    // DNS-validated cert for the placeholder domain. No hostedZone: the
    // validation CNAME is added by hand in the psd401.ai zone.
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(),
    });

    // James creates + fills this one out-of-band (values never enter the
    // repo). fromSecretNameV2 only shapes an ARN — a missing secret shows
    // up as the task failing to start, not at synth.
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppSecret",
      appSecretName(props.envName),
    );

    // Everything here matches a knob the app reads (validated against
    // lib/*): four provider selectors (all default "mock"), the guardrail
    // trio (GUARDRAIL_VERSION default is DRAFT — pin the validated v1),
    // storage, and OIDC. Model ids stay on their lib/ai defaults — set
    // BEDROCK_*_MODEL here only to override. OIDC_REDIRECT_URI lands in
    // slice 4 with the domain.
    const environment: Record<string, string> = {
      AWS_REGION: stack.region,
      STORAGE_PROVIDER: "s3",
      S3_BUCKET: props.assetBucketName,
      AI_PROVIDER: "bedrock",
      MATH_TRANSLATOR_PROVIDER: "bedrock",
      ESSAY_SCORER_PROVIDER: "bedrock",
      PDF_EXTRACTOR_PROVIDER: "bedrock",
      GUARDRAIL_PROVIDER: "bedrock",
      GUARDRAIL_ID: props.guardrailId,
      GUARDRAIL_VERSION: "1",
      OIDC_ISSUER: "https://accounts.google.com",
      // Explicit — do not trust origin derivation behind the ALB (plan
      // slice 3). Must match the redirect URI James adds to the web OAuth
      // client in GCP.
      OIDC_REDIRECT_URI: `https://${props.domainName}/api/auth/callback`,
    };
    if (props.oidcWebClientId) {
      environment.OIDC_CLIENT_ID = props.oidcWebClientId;
      // Both ids, or the native client's /api/auth/exchange rejects its
      // token (plan slice 3).
      environment.OIDC_AUDIENCE = [
        props.oidcWebClientId,
        ...(props.oidcNativeClientId ? [props.oidcNativeClientId] : []),
      ].join(",");
    }

    // ECS-native injection: the execution role gets the read grants, the
    // container sees plain env vars, and nothing secret is in the template.
    const secrets: Record<string, ecs.Secret> = {
      DB_HOST: ecs.Secret.fromSecretsManager(props.databaseSecret, "host"),
      DB_PORT: ecs.Secret.fromSecretsManager(props.databaseSecret, "port"),
      DB_NAME: ecs.Secret.fromSecretsManager(props.databaseSecret, "dbname"),
      DB_USER: ecs.Secret.fromSecretsManager(props.databaseSecret, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(
        props.databaseSecret,
        "password",
      ),
      DESIGN_TOOL_SESSION_SECRET: ecs.Secret.fromSecretsManager(
        appSecret,
        "DESIGN_TOOL_SESSION_SECRET",
      ),
      DESIGN_TOOL_PKCE_SECRET: ecs.Secret.fromSecretsManager(
        appSecret,
        "DESIGN_TOOL_PKCE_SECRET",
      ),
      DESIGN_TOOL_DELIVERY_SECRET: ecs.Secret.fromSecretsManager(
        appSecret,
        "DESIGN_TOOL_DELIVERY_SECRET",
      ),
      OIDC_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        appSecret,
        "OIDC_CLIENT_SECRET",
      ),
    };

    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "Service",
      {
        cluster,
        desiredCount: 1,
        // With one task, the 50% default would stop it before the
        // replacement starts; 100/200 = start-new-then-stop-old.
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskImageOptions: {
          image: ecs.ContainerImage.fromDockerImageAsset(image),
          containerPort: 3000,
          taskRole: this.taskRole,
          // NODE_ENV=production is baked into the image (Dockerfile).
          environment,
          secrets,
        },
        // ADR 0014: public subnets, public IPs, no NAT. The service SG the
        // pattern creates admits ONLY the ALB SG on 3000.
        taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        publicLoadBalancer: true,
        // Long AI requests (item gen) outlive the 60s default (plan risk
        // list) — 120s at the ALB.
        idleTimeout: cdk.Duration.seconds(120),
        // Roll back a deploy whose tasks never go healthy instead of
        // flapping forever.
        circuitBreaker: { rollback: true },
        // Slice 4: HTTPS listener on the placeholder domain (decision 1.1)
        // + HTTP→HTTPS redirect. domainZone stays unset — the psd401.ai
        // zone is outside this stack, James adds the ALIAS/CNAME to the
        // ALB by hand (AlbDnsName output below).
        certificate,
        redirectHTTP: true,
      },
    );

    // Dedicated no-auth no-DB endpoint (app/api/health/route.ts) — the
    // health check must not depend on the DB or a 0.5-ACU hiccup recycles
    // the task, and it should not cost an SSR render every probe.
    this.service.targetGroup.configureHealthCheck({
      path: "/api/health",
      healthyHttpCodes: "200",
    });

    // The one rule that lets app compute reach Aurora (mirrors the roster
    // importer's SG→SG rule; ClusterSg admits nothing else — no CIDR rules
    // since the 2026-09-01 infra slice). A one-off run-task on this task
    // definition with this SG is also how migrations reach the cluster
    // (README "Migrating Aurora").
    const serviceSg = this.service.service.connections.securityGroups[0];
    if (!serviceSg) {
      throw new Error("Fargate service synthesized without a security group");
    }
    props.databaseSecurityGroup.addIngressRule(
      serviceSg,
      ec2.Port.tcp(5432),
      "Design-tool Fargate service",
    );

    new cdk.CfnOutput(this, "AlbDnsName", {
      value: this.service.loadBalancer.loadBalancerDnsName,
      description: `ALB DNS name — CNAME target for ${props.domainName} in the psd401.ai zone.`,
    });

    new cdk.CfnOutput(this, "AppOrigin", {
      value: `https://${props.domainName}`,
      description:
        "The app origin: OIDC_REDIRECT_URI's host, the GCP redirect URI, and the client's SECURE_TEST_SERVER.",
    });
  }
}
