# 0008. Storage abstraction — local-fs first, S3 ready

- **Status**: Accepted; app provider **live** (slice 30, 2026-06-17); bucket/encryption decisions resolved (below); CDK + deploy pending (slice 31)
- **Date**: 2026-05-21 (decisions resolved 2026-06-17)

## Context

Slice 10 added image uploads to the design tool. The broader plan locks S3 (SSE-KMS) for production asset storage, but no CDK stack for the design tool exists yet (slice 4 deferred it pending the Q 1.4 Aurora cost decision). The design tool needs a working upload + serve + delete path today so the upcoming item-integration slice has something to reference, but adding a cloud bucket and IAM plumbing now would couple the two decisions together unnecessarily.

The same pattern resolved cleanly in slice 7 for AI providers (ADR 0007) and slice 4 for Postgres (ADR 0005): build a thin abstraction, ship a local-first implementation, document the swap path explicitly.

## Decision

- `design-tool/lib/storage/` defines a `StorageProvider` interface (`put`, `get`, `delete`, plus an `id` string persisted in `assets.storage_provider`). The interface intentionally has no concept of signed URLs, listing, or lifecycle policies — those land alongside the S3 implementation, not before.
- The default implementation, `localFsProvider`, writes asset bytes to `STORAGE_LOCAL_ROOT` (default `./storage`). The `assets.storage_key` is just the asset's UUID; no per-owner directory tree. ACL is enforced by the `assets` table + the `requireSession` + owner-match check at the API layer, not by filesystem permissions.
- `getStorageProvider()` is env-keyed off `STORAGE_PROVIDER` (default `local-fs`). Any unknown value throws a clear error pointing here.
- `assets.storage_provider` is persisted per row so a future deployment with mixed storage (e.g. legacy local-fs rows after an S3 rollout) can route reads correctly.

## Consequences

- **Better**: the entire upload UX is testable today (`bun test` covers put/get/delete round-trip + the API guards). Adding S3 is a one-file addition (`lib/storage/s3Provider.ts`) + a one-line edit to `getStorageProvider()`. No CDK or IAM is required for slice-10 to ship.
- **Worse**: the local-fs path doesn't exercise the failure modes a cloud bucket will (network errors, eventual consistency on listings, regional latency). Tests written against the local provider may need extending once S3 lands.
- **Escape hatch**: if local-fs proves unfit even for dev (e.g. multi-developer shared dev DB), Postgres-large-object storage is a viable middle step that needs no new env vars beyond `DATABASE_URL`.

## Decisions (resolved 2026-06-17)

Framing: the design tool is a **teacher-facing authoring tool that produces exported content for students**. Asset uploads are teacher-authored item images, not student PII at rest. That relaxes encryption-audit, data-residency, and retention constraints, so the MVP takes the simplest option at each fork and hardens only if a student-data surface ever lands.

- [x] **10.1 Bucket strategy.** One bucket **per environment** (`secure-test-design-tool-dev` / `-prod`). Whole-bucket IAM grants (simpler to reason about than prefix scoping), independent lifecycle per env, dev deletable wholesale, no cross-env read risk.
- [x] **10.2 KMS key ownership.** **SSE-S3 (AWS-managed AES256) everywhere for now.** No student PII at rest, so per-key audit / instant-revoke is not load-bearing yet. `S3_KMS_KEY_ID` stays unset; `s3Provider` already supports SSE-KMS if a customer-managed key is introduced for a future student-data surface.
- [x] **10.3 Direct browser → S3 PUT (presigned).** **Deferred — keep the server gateway.** Item images are small and `MAX_UPLOAD_BYTES`-capped, and the gateway is where MIME/size validation + SHA dedup happen. Revisit only for a large / hi-res upload use case.
- [x] **10.4 CDN / signed-URL strategy for reads.** **App-served reads** via `/api/assets/<id>` (owner-scoped authz preserved; URL unchanged). CloudFront deferred to student-runtime read scale, to be paired with signed URLs at that point.
- [x] **10.5 Lifecycle / cost.** **Abort incomplete multipart uploads (~7 days); no versioning yet.** No Glacier (small, hot images; exports are generated on-demand, not stored in S3). An orphan-object janitor (for best-effort delete misses) is deferred until a real orphan rate is observed.

### Wiring steps

- [x] Implement `S3Provider` in `design-tool/lib/storage/s3Provider.ts`. (slice 30)
- [x] Recognize `STORAGE_PROVIDER=s3` — via a `getStorageProviderById` registry; reads/deletes route by the row's persisted `storage_provider`, writes use the env-selected active provider. (slice 30)
- [x] Add `@aws-sdk/client-s3` to `design-tool/package.json`. (slice 30)
- [x] Add `S3_BUCKET`, `S3_REGION` to `.env.local.example` as documented, unset placeholders (`S3_KMS_KEY_ID` stays optional/unset per 10.2). (2026-06-17)
- [ ] Wire the CDK stack (slice 31) to provision the per-env bucket + an abort-incomplete-multipart lifecycle rule + grant the app role `s3:PutObject` / `s3:GetObject` / `s3:DeleteObject`. No KMS key resource needed (SSE-S3).
- [x] Backfill — not required: the design tool is deployed nowhere, so no pre-S3 assets exist; slice 30's per-row read routing makes the first S3 cutover safe with no migration script.
