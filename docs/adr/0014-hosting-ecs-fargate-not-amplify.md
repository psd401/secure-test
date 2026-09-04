# 0014. Host the design tool on ECS Fargate (AI Studio pattern), not Amplify

- **Status**: Accepted
- **Date**: 2026-07-09

## Context

The design tool is deployed nowhere; it runs locally against local Postgres with the mock
OIDC issuer. The first real deploy waits on the ClassLink Partner Portal `client_id`, but
the hosting **decision** is being made now so the deploy is a known quantity when auth
clears. The governing constraint: everything stays inside PSD's AWS account ("AWS bubble")
where DPAs already exist — which rules out Vercel/Netlify-class hosts and any non-AWS
ancillary services, but not Amplify (Amplify is AWS; its rejection below is technical).

PSD's default is Amplify — nearly all district web apps run there. Facts gathered
2026-07-09 against current AWS docs:

- **Amplify Hosting** supports Next.js **12–15** only; this app is Next 16 with `proxy.ts`.
  Its SSR compute runs outside the customer VPC with no security group and no pinnable
  egress IPs (open feature request since 2023), so it cannot be admitted to our Aurora
  cluster, which is gated solely by SG ingress (`design-tool/infra/lib/design-tool-stack.ts`).
  It enforces a hard, non-configurable **30-second response timeout** and does not support
  Next.js streaming — a direct conflict with Phase 3 AI essay scoring, PDF import
  (OCR + LLM extraction), and the deferred server-side `/pdf` route (ADR 0013).
- **App Runner** entered maintenance mode 2026-03-31 and **closed to new customers
  2026-04-30** — unavailable.
- **ECS Express Mode** is AWS's official App Runner successor (re:Invent 2025): managed
  Fargate + shared ALB. Viable, but ~8 months old with L1-only CDK support
  (`CfnExpressGatewayService`).
- **AI Studio precedent**: PSD already made this exact migration once.
  `psd401/aistudio` `infra/lib/frontend-stack-ecs.ts` is ECS Fargate + ALB and its
  docstring reads *"Replaces Amplify hosting with containerized Next.js deployment for
  native HTTP/2 streaming support."* Its Aurora Serverless v2 lives in private subnets
  with the RDS Data API (`enableHttpEndpoint: true`) and no public DB endpoint. Reusable
  CDK constructs exist (`EcsServiceConstruct`, `VPCProvider`, observability).

## Decision

**Host the design tool on ECS Fargate + ALB via CDK, following AI Studio's
`frontend-stack-ecs` shape, simplified** (no WAF / multi-stack / SSM cross-wiring on day
one). Extend the existing `DesignToolStack`.

- **Database access — A now, B later (documented intent).**
  - **A (now):** keep the existing public-subnet, SG-gated Aurora; add an SG-to-SG ingress
    rule from the Fargate service's security group (tighter than the current CIDR rule).
    The app keeps the standard `postgres` Drizzle driver, same as local dev.
  - **B (prod hardening, before real student/teacher data):** match AI Studio — move the
    cluster to private subnets, enable the RDS Data API, remove the public endpoint. This
    is a cluster-networking rebuild plus an app driver change (`aws-data-api`); it is
    intentionally deferred, not forgotten.
- **Networking: isolated VPC for now.** The design tool stays in its own VPC (the stack's
  existing one). Folding into AI Studio's shared-VPC pattern is an open question pending
  a decision with IT (the DNS/network zone owner). Fargate tasks run in public subnets with public IPs (no NAT —
  consistent with the stack's existing no-NAT cost posture) and reach Bedrock/S3 directly.

## Consequences

- **Better**: no framework-version support matrix (container runs the Next 16 standalone
  build as-is); streaming AI responses and >30s requests work, which Phase 3 scoring and
  PDF import need; a Linux container makes the deferred headless-Chromium `/pdf` route
  viable, per ADR 0013's escape hatch; district ops already run this exact shape for AI
  Studio, with CDK constructs to crib from; SG-to-SG beats CIDR maintenance.
- **Worse**: always-on cost — a small Fargate task + dedicated ALB is roughly $25–35/mo
  for dev, vs Amplify's near-zero idle; we own the Dockerfile, image builds (ECR), and
  deploy pipeline — no built-in branch previews or git-push deploys.
- **Escape hatches**: ECS Express Mode if the hand-rolled Fargate/ALB stack proves heavier
  than it's worth (same underlying resources, so migration is small); Amplify becomes
  re-evaluable only if AWS ships Next 16 support **and** VPC access **and** lifts the 30s
  cap — the version gap is temporary, the other two are structural.
- **Open**: shared-VPC vs isolated long-term (IT); actual deploy still gated on the
  ClassLink `client_id`; next step is the already-sequenced validation slice
  (`cdk synth` of the Fargate additions + Drizzle migration run against Aurora).
