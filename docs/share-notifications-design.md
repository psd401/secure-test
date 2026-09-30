# Share notifications — design note

Roadmap row SN. Side: design-tool. Pilot-teacher feedback (2026-09-29): a
teacher who is shared an assessment or added as a co-teacher gets no notice
outside the dashboard.

## Decisions (James, 2026-09-29)

- **D-1 Badge now, email later.** A "New" badge ships first. Email waits on
  SES (sending domain + sandbox exit), bundled with the safeguarding email
  ask (`docs/safeguarding-alerts-design.md` D-5) in the next IT/AWS batch.
- **D-2 Both events.** A share offer and a co-teach grant each notify.
- **D-3 Sender.** From a no-reply address on the verified domain;
  **Reply-To = the sharing teacher**, so a reply reaches them. (SES only
  verifies the From identity; Reply-To can be any address.)
- **D-4 Built in a worktree** (`claude/share-notify`), merged later.

## Slice 1 — "New" badge (no SES)

- **Share offers:** every pending offer is already its own card under
  "Shared with you" on the home page; each card now carries **New**. It goes
  away when the teacher adds the copy (the card goes with it).
- **Co-teach grants:** migration **0048** adds `access_grants.seen_at`
  (backfilled to `created_at`, so only grants made after the deploy show
  New). The co-teach row on the home list shows **New** while `seen_at` is
  null; opening the assessment's editor sets it. An admin acting as the
  teacher does not clear it.
- Only live assessment-scope grants count (revoked / expired / not-started
  never show New). A revoke followed by a re-grant is New again.

## Slice 2 — email (built behind a provider; off until SES exists)

- `lib/email/` with `mock` (default) and `ses` providers, selected by
  `EMAIL_PROVIDER`; `EMAIL_FROM` names the no-reply sender.
- Sent after the share / grant row commits, best effort: a send failure is
  logged (`share_email_failed`) and never fails the share.
- Content: who shared, the assessment title, a link to the home page. No
  student data, no assessment content.
- Not sent for a duplicate (409) share or grant.

## Slice 3 — infra (after SES exists)

- IT's answer (2026-09-30): option A — send as `no-reply@<app hostname>`,
  keeping app mail's reputation apart from the district domain (p=quarantine);
  no SMTP relay / Workspace delegation. IT runs both district zones and adds
  the records by hand — the stack creates NONE. Custom MAIL FROM optional —
  skipped (DKIM on the sending domain aligns for DMARC). Mail goes straight to
  Gmail; Google opens every link, so a link may only open a page (ours do: the
  editor marks a grant seen only for a signed-in teacher). After the
  two-address test IT will likely add a `_dmarc` record at p=quarantine on the
  sending domain.
- Stack: `ses.EmailIdentity` for the app hostname (Easy DKIM), the three DKIM
  CNAMEs as outputs `EmailDkimCname1..3`, `ses:SendEmail` on that identity for
  the task role, `EMAIL_PROVIDER=ses` + `EMAIL_FROM=no-reply@<app hostname>`
  in the task definition (derived from `domainName`, no new context key).
- Until the CNAMEs verify and SES leaves the sandbox, a send fails and is
  logged as `share_email_failed` (warn); the share itself succeeds.
- Then: IT adds the CNAMEs → identity verifies → the two-address test (both
  recipients verified while in the sandbox; tell IT when, they check
  delivery) → James files the SES production-access request → row 329.

## Progress

- 2026-09-29: slice 1 committed in the worktree (4 new tests).
- 2026-09-29: slice 2 built in the worktree: `lib/email/` (`mock` | `ses`,
  `@aws-sdk/client-sesv2`), `sendShareEmail` awaited after the row insert in
  `POST /api/assessments/[id]/shares` (links to `/dashboard`) and
  `POST /api/assessments/[id]/grants` (links to the editor); 11 tests. With
  `EMAIL_PROVIDER` unset nothing leaves the process. `.env.local.example`
  does not list `EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_REGION` yet (env
  files are off-limits to Claude — add by hand).
- 2026-09-29: both slices merged to `main` (`ac2f4f3`, `28ff1fd`), not
  deployed. Badge hand-run ✅ on local dev — rows 325–328 in
  `docs/design-tool-manual-checks.md`; row 329 (the email itself) waits on
  SES.
- 2026-09-29: DEPLOYED — rev 61 (`5e496d6`) carried both slices and
  migration 0048 (applied at boot). The badge is live; `EMAIL_PROVIDER` is
  unset on the origin, so no email is sent. IT ask for SES sent the same
  day (James leans option B, `no-reply@psd401.net`); slice 3 follows the
  answer.
- 2026-09-30: IT answered (option A, records by hand, no custom MAIL FROM
  needed). Slice 3 built: SES identity + DKIM outputs + scoped grant +
  `EMAIL_PROVIDER` / `EMAIL_FROM` in `infra/lib/app-service.ts`; synth
  checked. Not deployed. Reply to IT corrects the domain: the app hostname
  is under the `.ai` zone, not `.net`, so their DMARC answer (inherits the
  `.net` sp=none) needs re-checking against the `.ai` zone's policy.
- 2026-09-30: DEPLOYED — rev 64 (`1e4b929`), health stamp = HEAD, no
  migration. Identity created, DKIM `PENDING` until IT adds the three
  CNAMEs (reply with the values sent by James). The SES account already has
  production access (`ProductionAccessEnabled: true`) — no sandbox-exit
  request needed. Next: identity verifies → two-address test (row 329),
  telling IT when.
