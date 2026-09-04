# secure-test

A macOS secure-testing browser for students and the teacher-facing
assessment-authoring tool that feeds it. Built in-house by Peninsula School
District (Washington, USA) for its own classrooms and published under the MIT
license so other districts can read, reuse, or adapt it.

## What it is

- **`design-tool/`** — a Next.js web app where teachers write assessments
  (multiple choice, short text, essay with rubric, match, order, hotspot,
  drawing, table, shared stimulus / item sets), import them from PDF with an
  AI-assisted extractor, set accommodations, run test sessions, monitor
  students live, score, and export results. Postgres via Drizzle, Zod
  schemas, KaTeX math, Google OIDC sign-in.
- **`client/`** — the student app. An AppKit shell around a locked-down
  `WKWebView` that runs inside a real Apple `AEAssessmentSession`
  (Automatic Assessment Configuration) when the build carries the
  entitlement, and a simulated session otherwise. All logic lives in the
  `SecureTestCore` SwiftPM package so it is testable without a window
  server.
- **`packages/schema/`** — the shared Zod wire formats. Two on purpose: the
  teacher's export bundle carries answer keys, the student's delivery bundle
  has no field that can hold one (ADR 0016).
- **`docs/`** — the plan, the ADRs (`docs/adr/`), one design page per
  feature, and the hand-check lists that record what was verified by hand.
- **`poc-*/`** — the three feasibility spikes that preceded the build. Kept
  as the empirical record; not maintained.

## What it is not

- Not a product and not supported. It is one district's working code,
  published as-is. Issues and pull requests are welcome but there is no
  service commitment.
- Not district-neutral yet. Sign-in is Google Workspace with roles derived
  from two email domains (staff and student), the roster comes from a
  nightly warehouse extract in a documented CSV shape (`docs/roster-extract.md`),
  and hosting is AWS (Aurora Serverless v2, ECS Fargate, S3, Bedrock). Each
  of those sits behind an abstraction or a config value, but swapping one is
  work, not a switch.
- Not a lockdown guarantee on its own. The student client relies on Apple's
  Automatic Assessment Configuration, which needs a restricted entitlement
  Apple grants per team, plus device management for the fleet.

## Running the design tool

Requirements: [bun](https://bun.sh), a local Postgres, and a Google OAuth
client (or the mock/dev token path described in `docs/`).

```bash
bun install                                   # workspace install, at the repo root
cp design-tool/.env.local.example design-tool/.env.local   # then fill it in
cd design-tool
bun run db:migrate
bun run dev                                   # http://localhost:3000
```

Tests and checks:

```bash
cd packages/schema && bun run build && bun test
cd design-tool && bun run typecheck
cd design-tool && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test
```

AI features (item generation, PDF import, math translation) default to a
`mock` provider; the real providers are Amazon Bedrock and need AWS
credentials (ADR 0007, 0011, 0015).

## Running the student client

```bash
cd client/SecureTestCore && swift test        # all the logic, no Xcode needed
cd client && xcodebuild -project SecureTest.xcodeproj -scheme SecureTest -destination 'platform=macOS' build
```

A real assessment session needs the
`com.apple.developer.automatic-assessment-configuration` entitlement, which
Apple grants per developer team, and a provisioning profile that carries it.
Without it the app runs with a simulated session (`SECURE_TEST_SIMULATE_LOCKDOWN=1`).
`client/README.md` has the details; `client/MANUAL-CHECKS.md` is the
hand-check record, because the AppKit / WebKit surface cannot be driven
headlessly here (ADR 0013).

## Deploying

`design-tool/infra/` is an AWS CDK app. Account-specific values (account id,
OAuth client ids, the public hostname, the guardrail id) are read from a
gitignored `cdk.context.json`; copy `cdk.context.json.example` and fill it
in. `design-tool/infra/README.md` and `docs/ecs-deploy-plan.md` walk through
the first deploy and the migration step.

## Where to read next

- `docs/plan.md` — the feasibility plan and phased roadmap.
- `docs/adr/` — architecture decisions, numbered.
- `docs/*-design.md` — one page per feature: decisions, slices, progress.
- `CLAUDE.md` — working conventions and the running state log. It is
  written for an AI coding assistant as well as for people; its
  "Contributing / what stays out of this repo" section is the rule set for
  what may be committed here.

## Contributing

- Install the pre-commit scanner once per clone: `brew install gitleaks`
  and `git config core.hooksPath .githooks` (`bun install` sets the hooks
  path for you). The hook runs `gitleaks` over the staged changes with the
  repo's `.gitleaks.toml`, which adds identifier-shaped rules (student
  numbers, district emails, account ids) to the default credential rules.
- No student data, no teacher-authored assessment content, no district
  identifiers in tracked files. Roles and placeholders instead. See
  `CLAUDE.md`.
- Security reports: see `SECURITY.md`.

## License

MIT — see `LICENSE`. Copyright Peninsula School District.
