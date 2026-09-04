# Public repository — sweep, squash, move

Written 2026-09-03. Batch 2b of `docs/roadmap-2026-09.md`. The decision of
record from 2026-09-02 was "publish a FRESH repository from a squashed,
swept clone — never flip this one public." On 2026-09-03 James extended it
(**D-P1**): development moves to that public repository, this private repo
is archived read-only as the historical record, and the client's releases
publish in the public repo (Installomator needs an unauthenticated release
URL — `docs/client-release-plan.md`). Two mirrored repositories were
rejected: every commit twice, diverging histories, no benefit.

## Why one repo, and what stays private

- **Public `secure-test`** (new): the code, the design pages, ADRs, the
  check lists, CLAUDE.md as a contributor guide plus the running state log
  — scrubbed to roles, not names, and to no district identifiers. GitHub's
  push protection and secret scanning are free on public repositories.
- **This repository → archived** (read-only, name unchanged or
  `secure-test-private-history`): the full record, including the history
  the squash removes.
- **Private `secure-test-ops`** (new, small; **D-P2, James**): what we
  still write that must not be public — IT requests naming people and
  dates (`docs/requests/`), district infrastructure specifics (the AWS
  account id, the cluster secret ARN, the district NAT address, hostnames,
  the OAuth client ids now in `infra/cdk.json`), teacher-authored sample
  content, the day-of hand-run scripts, anything naming a student. The
  public CLAUDE.md points at it by name only.

## Inventory to scrub (HEAD first, then the squash removes the history)

From CLAUDE.md's 2026-09-02 list, plus what the 2026-09-03 sweeps added:
- the AWS account id (12 files) — infra README, cdk outputs pasted into
  docs, deploy notes;
- the cluster secret ARN and the district NAT address (`design-tool/infra/README.md`);
- `infra/cdk.json` OAuth client ids and any hostname → `cdk.context.json`
  (gitignored) or environment, with an `.example` file;
- the production hostname wherever it is literal (docs, check lists,
  launch recipes) → a placeholder or the ops repo;
- staff and student-domain emails (27 / 29 files) → roles ("the data
  engineer", "a teacher"); the two demo student accounts stay only if they
  are demo;
- docs quoting teacher-authored assessment content (4 files) → removed or
  replaced with the hand-built fixtures;
- `docs/requests/*` → the ops repo;
- the one real student number (already scrubbed from HEAD in 1dc4383; the
  squash removes the two 2026-08-29 commits and the message);
- ClassLink-era text stays where it is an ADR or a design record (history,
  not sensitive) and goes where it carries an identifier;
- `~/secure-test-hand-teacher-row.sh` is already outside the repo.

## Slices

1. **Scan.** On a fresh clone, run `gitleaks detect` over the full history
   and a pattern sweep over HEAD for: the account id, `arn:aws`, the NAT
   address, `psd401.net` / `edtools.psd401.net` addresses, the hostname,
   `client_id`, nine-digit numbers, personal names from `docs/requests/`.
   Output: a checked list per file. Size S. Sonnet 5 / high.
2. **Scrub HEAD in this repo** (so the clone is only a squash): the moves
   to `cdk.context.json` / env with `.example` files and a README note;
   the doc edits from the inventory; `docs/requests/` and the other
   internal files moved to a staging folder for the ops repo; CLAUDE.md
   rewritten (roles, no ids, the working rules kept, the state log kept
   and scrubbed). Every design-tool and client suite still green; `cdk
   synth` still works with the context file. One or two commits, each
   reviewed. Size M. Sonnet 5 / high; **a Fable or Opus review of the
   final tree** (`git grep` for every pattern from slice 1 must return
   nothing) before anything is pushed publicly.
3. **Create the public repository** from the scrubbed HEAD, squashed to
   one "initial public commit" (**D-P4, James: squash**, not a curated
   history — the rewrite is the point); add the license (**D-P3, James:
   MIT**), a README written for outsiders (what it is, what
   it is not, how to run it, that it is district-built), `SECURITY.md`,
   `CODEOWNERS`, branch protection on `main`, Dependabot, secret scanning
   with push protection on, a `gitleaks` pre-commit hook. Size S.
4. **Cut over.** This checkout's `origin` → the public repo (the local
   folder path stays, so the memory directory keyed to it keeps working);
   the private repo archived; `secure-test-ops` created with the staged
   internal files and a README; CLAUDE.md's "start here" bullet points at
   the ops repo for the internal notes. From here every commit lands in
   the public repo only. Size S.
5. **Ongoing rules** (into the public CLAUDE.md): no account ids, ARNs,
   hostnames, client ids, emails or names in tracked files — roles and
   placeholders instead; student data never (the existing rule); teacher
   content never (hand-built fixtures only, the existing rule); the
   pre-commit scanner blocks what it can, the review catches the rest;
   anything district-specific goes to the ops repo.

Order relative to the release: slices 1–4 must finish before
`docs/client-release-plan.md` slice 4 (the `gh release`); nothing else
waits. Runs in the docs / infra-config line beside the client signing
work.

## Decisions

- **D-P1 (James, 2026-09-03)** one development repository, public; this
  one archived.
- **D-P2 (James, 2026-09-03)** a small private ops repository for what
  stays internal, rather than keeping internal notes in the archived repo
  (which would put it back in use).
- **D-P3 (James, 2026-09-03) MIT license.**
- **D-P4 (James, 2026-09-03) squash to a single initial commit.**
- **D-P5 (recommended)** CLAUDE.md stays in the public repo as contributor
  guide + scrubbed state log; the unscrubbed working notes live on in the
  archived history and, going forward, in the ops repo.

## Progress

**Slice 1 DONE 2026-09-04** (Sonnet 5 agent on a fresh clone; `gitleaks`
8.30.1 installed). gitleaks: 0 findings over the full history and HEAD —
it matches credential shapes only, so the identifier sweep is the real
scan. The per-file report lives outside the repo (session scratchpad).
Gaps the inventory above had missed, all handled in slice 2:
`design-tool/infra/cdk.context.json` was TRACKED and carried the account
id; the production hostname was a code default in
`design-tool-stack.ts`; the data engineer's name sat in four code files;
the roster go-live checklist named five real teachers with section loads;
a former laptop IP in `docs/ecs-deploy-plan.md`; the AWS SSO profile name
in five files; the Apple Team ID in the pbxproj (kept) and six docs. The
real student number lives only in three 2026-08-29 commits — the squash
removes it.

**Slice 2 DONE 2026-09-04** — seven commits on `main`, none pushed:
2a–2f by a Sonnet 5 agent in a worktree (each diff reviewed and every
suite re-run in the main session before the fast-forward), 2g from the
review. Decisions taken on the way (James): the go-live checklist moves
whole to the ops staging; James's name stays as author in ADRs, his email
and SSO profile name go; the Team ID stays in `project.pbxproj` only;
bundle ids stay; the three demo student accounts become
`<demo-student-A/B/C>` placeholders; the Bedrock guardrail id joins the
context keys. What changed: `cdk.context.json` untracked + `.example`
(account, OAuth ids, MWAA role ARN, `domainName`, `guardrailId` — the
stack throws without the last two); `docs/requests/` + the go-live
checklist → untracked `_ops-staging/` (on disk, for the ops repo); docs,
code comments, check lists and one test literal scrubbed; teacher content
paraphrased; CLAUDE.md scrubbed + a "Contributing / what stays out of
this repo" section (= slice 5's rules, done early); `.gitleaks.toml` with
five identifier rules + a fixture guard test
(`design-tool/test/roster-fixture-synthetic-ids.test.ts`);
`mint-student.ts` requires its email argument. Verified at `ab73f46`:
`git grep` for every slice-1 pattern returns only the pbxproj Team ID and
pattern descriptions; `gitleaks git --pre-commit --staged` clean; a
directory scan hits only gitignored files (`.env.local`, `.next/`, a local
folder) — hence the staged form is the documented check; design-tool
1135 pass, typecheck clean, schema 114, `swift test` 365, `cdk synth`
with real and with placeholder context.

**Precautions for student ids, as built** (James's question 2026-09-04):
the `.gitleaks.toml` rules (student-domain numeric addresses; a 9-digit
number near `ssid` / `student_number` / `ps_id`; any 7- or 9-digit run in
a `*.md`; account ids near AWS context; Google client ids), the fixture
guard test (roster fixtures may carry only repeated-digit 7/9-digit
values), the placeholder rule in CLAUDE.md, the squash, and the `git
grep` review before any public push. Slice 3 wires the staged scan as a
pre-commit hook and a GitHub Action.

Next: slice 3 (James creates the public repository; Claude drafts README
/ SECURITY.md / CODEOWNERS / the hook + Action), then slice 4 cut-over.
