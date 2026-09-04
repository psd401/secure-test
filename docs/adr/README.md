# Architecture Decision Records

Short, one-page rationales for decisions that affect more than one slice or that future-James will want to revisit. Use the [Michael Nygard format](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md):

```markdown
# NNNN. Title (imperative phrase)

- **Status**: Proposed | Accepted | Superseded by ADR-XXXX
- **Date**: YYYY-MM-DD

## Context
What problem are we solving? What constraints / forces are in play?

## Decision
What did we decide? In one or two sentences.

## Consequences
What becomes easier? What becomes harder? What's the escape hatch if we're wrong?
```

Numbering is monotonic; never renumber. To reverse a decision, write a new ADR that supersedes the old one.

## Index

- [0001 — Bun workspaces for the secure-test monorepo](0001-bun-workspaces.md)
- [0002 — Keep snake_case keys in the shared wire format](0002-snake-case-wire-format.md)
- [0003 — Stub the auth exchange route before the full ClassLink flow](0003-stub-auth-exchange-before-full-classlink-flow.md)
- [0004 — Store PKCE in-flight state in a signed httpOnly cookie](0004-pkce-state-stored-in-signed-cookie.md)
- [0005 — Local Postgres via homebrew, not Docker](0005-local-postgres-not-docker.md)
- [0006 — Preview iframe sandbox + CSP posture](0006-preview-iframe-sandbox.md)
- [0007 — AI model selection for item generation (deferred decision)](0007-ai-model-selection.md)
- [0008 — Storage abstraction — local-fs first, S3 ready](0008-storage-abstraction-local-fs-first.md)
- [0009 — KaTeX math rendering — SSR with raw LaTeX in storage](0009-katex-math-rendering.md)
- [0010 — Image refs in item content — `![alt](asset:<uuid>)` with owner-scoped resolution](0010-image-refs-in-item-content.md)
- [0011 — LLM-driven math notation translator (provider-abstracted; mock today)](0011-math-translator.md)
- [0012 — Safeguarding guardrails on the AI surfaces (mock default; Bedrock ApplyGuardrail)](0012-safeguarding-guardrails.md)
- [0013 — PDF for print accommodations — client-side print, not a headless-Chrome route](0013-print-pdf-via-client-side-print.md)
- [0014 — Host the design tool on ECS Fargate (AI Studio pattern), not Amplify](0014-hosting-ecs-fargate-not-amplify.md)
- [0015 — Scanned-PDF OCR via Bedrock document blocks](0015-scanned-pdf-ocr-via-bedrock-document-blocks.md)
- [0016 — Two wire formats — the teacher's export carries the answer keys, the student's delivery cannot express one](0016-two-wire-formats-teacher-export-and-student-delivery.md)
- [0017 — Roster from the PSD warehouse, identity from Google — not ClassLink](0017-roster-from-warehouse-and-google-identity.md)
