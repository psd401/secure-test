# Gradebook integration research — PowerSchool + Schoology score push

**Status:** research, 2026-09-22. Nothing built. Feeds roadmap batch 6
(`docs/roadmap-2026-09.md`) and `docs/reporting-design.md` R3 / D-R3.
Sources are public documentation as of 2026-09-22; anything behind
PowerSchool's partner login is marked *unconfirmed*.

## The question

Can a teacher click one button in the tool and have scores land in
PowerTeacher Pro and/or Schoology? If not, what has to exist, who provides
it, and how do other vendors do it?

## Short answer

- **Yes, one-click is achievable for both, with server-to-server APIs
  that already exist.** Nothing has to be demanded of either vendor.
  What has to be *provisioned* is district-side: two PowerSchool plugins
  and a Schoology API credential.
- **MCP is the wrong layer.** No vendor publishes an MCP server for
  PowerSchool, Schoology, Google Classroom, Edlink or 1EdTech; the
  community ones are read-only student-grade scrapers. MCP is an
  agent-to-tool protocol; a gradebook push is a scheduled or
  button-triggered server call, which is what the APIs below already
  are. An MCP wrapper could be added later for an assistant use case; it
  does not solve the push.
- **The mechanism every serious vendor uses for PowerSchool is
  OneRoster 1.1 Gradebook Push through PowerSchool's "Universal
  Rostering" plugin** (Google Classroom, Canvas, Otus, Classworks,
  SchoolDay). **For Schoology it is either the REST API v1 (OAuth 1.0a)
  or LTI 1.3 Assignment and Grade Services.** Assessment vendors that do
  NOT do this (Pear Assessment / Edulastic, Illuminate, MasteryConnect,
  Formative) fall back to CSV or a browser extension that pastes into the
  PowerTeacher Pro scoresheet.

## Path A — PowerSchool SIS / PowerTeacher Pro (gradebook of record)

**Mechanism:** OneRoster 1.1 Gradebook Service, *push* direction. The
consumer (our server) `PUT`s a `category`, a `lineItem` (the assignment)
and one `result` per student, each with a sourcedId we assign. PowerSchool
exposes `PUT /api/ims/oneroster/v1p1/lineItems/{id}` and
`PUT …/results/{id}` (plus DELETE) — create-by-PUT is the OneRoster idiom.
The v1p2 gradebook endpoints exist on the API home but PowerSchool's 1EdTech
certification (v26.5.1.0, 2026-05-27) lists **1.1 Gradebook Push** only;
1.2 is Pull. Use 1.1.

**What the district installs / enables (IT ask):**
1. PowerSchool's **Universal Rostering** plugin (PowerSchool-supplied; "PUT
   requests to write course assignments and grades to PowerSchool").
   Otus's admin guide says enabling write-back needs an "Opportunity ID"
   from PowerSchool and a $0 quote — i.e. PowerSchool switches it on per
   district. *Unconfirmed whether a district admin can flip it alone.*
   PSD may already have it if Google Classroom → PowerSchool grade export
   or Canvas passback is in use anywhere.
2. **Our own plugin** (`plugin.xml`): an admin uploads any plugin file at
   System Settings → Plugin Management; no partner certification gates
   install. It declares the OneRoster access request; PowerSchool issues
   the OAuth2 client-credentials pair the admin hands to us. Self-authored
   is explicitly supported — we are the district, so "vendor review" is
   us.
3. **Gradebook categories** must already exist (district-level active
   categories in PTP; Otus / Google both require the category to be
   present and mapped). Title limits seen in vendor docs: line item ≤ 50
   chars, category ≤ 30.

**Identity mapping — what we hold vs. what OneRoster wants:** the roster
extract carries `sections.id` and the student *number*; OneRoster keys
`results.student` and `lineItem.class` by PowerSchool's OneRoster
sourcedIds. The same plugin's rostering endpoints (`/classes`, `/users`,
`/enrollments`) return those sourcedIds with the student number and
section id in `identifier` / `metadata`, so the mapping is a read on our
side, not a warehouse change. *Which PowerSchool id becomes the sourcedId
(dcid vs id) is unconfirmed until the plugin is live.*

**Teacher experience:** "Send to PowerSchool" on the results page →
choose category (and per-section if the sitting spans sections) → one
line item per section, results for every handed-in attempt, points-only
(PTP passback is total-points; percent/letter are derived there). Re-send
updates the same sourcedIds (idempotent). Scores for students not yet
handed in are omitted, not zeroed.

**Limits:** points only; standards grades are a separate PTP passback that
only Schoology has; `PUT` semantics mean we own the sourcedId namespace
(`secure-test:<attempt_id>` etc.); PowerSchool's per-plugin request
interval is admin-configurable, default undocumented.

## Path B — Schoology

Two viable mechanisms; REST is the one-click one.

**B1 REST API v1 (recommended for the button).**
- Auth: OAuth 1.0a. Two-legged with an admin-issued consumer key/secret
  (School Management → Integration → API) acts as the key's owner; a
  district-private app does NOT need App Center approval. Three-legged
  (teacher clicks "Connect Schoology" once) acts as the teacher and needs
  no admin key but adds a consent step.
- Write: `POST /sections/{section_id}/assignments` (`title`, `max_points`,
  `grading_category`, `due`, `published`) then
  `PUT /sections/{section_id}/grades` with
  `{"grades":{"grade":[{"assignment_id","enrollment_id","grade","comment"}]}}`.
  `exception` 1 = excused, 2 = incomplete.
- Rate limit: 50 credits / 5 s per key, writes cost 3, 429 + Retry-After.
- Section mapping: Schoology sections provisioned from PowerSchool (SIS
  Connect / the PowerSchool provisioning app) carry the SIS section id as
  `section_school_code`; a `GET /sections/{id}` or the user's sections
  list gives `enrollment_id` per student with `school_uid` = student
  number. *Field names to confirm against a PSD section.*

**B2 LTI 1.3 Assignment and Grade Services.** Schoology is 1EdTech
"LTI Advantage Complete" (2025-10-14). We would register as an LTI 1.3
app (manual registration — no dynamic registration; sysadmin installs,
copies a Deployment ID to us), then post scores with a client-credentials
JWT outside any launch. Costs: the assessment must exist in the Schoology
course as an external-tool item (deep link or "Enable grading") before a
line item exists; linked sections create one line item per section and
only one accepts scores; category set via Deep Linking is reported flaky.
This is the standards route (`docs/plan.md` Phase 4) and what Google
Assignments, McGraw Hill, Wayground, IXL ship; it is a launch-first
workflow, not a results-page button. Keep as the later, portable option.

**Schoology → PowerTeacher Pro:** one-way, per course, via the
"PowerSchool grade item passback" app; the *teacher* maps categories and
presses Sync (or schedules daily/weekly); items without a category do not
sync; system admins cannot sync for teachers. An assignment we create by
REST with a `grading_category` is an ordinary graded item and rides that
sync. So for a Schoology-first teacher, Path B alone reaches PowerSchool
without Path A — one click here, one click there.

## Path C — the fallbacks everyone else ships

- **PowerTeacher Pro Import Scores CSV**: per assignment, student-number
  column + score column minimum, header row and name column optional.
  Already the D-R3 shape; keep it as the offline path.
- Browser extensions that paste into the PTP scoresheet ("Grading
  Assistant", "Classroom → PowerSchool Grade Sync"): fragile, tiny user
  counts; not for us.
- **Edlink** is the only aggregator that writes into BOTH PowerSchool
  (via its own PS plugin) and Schoology; $0–$2,999 / month platform fee
  plus per-person, paid by the vendor. Buys nothing PSD cannot do itself
  with Paths A + B, since we control the SIS.
- Clever LMS Connect writes to Google Classroom / Canvas / Schoology but
  never to the SIS; ClassLink has no gradebook write at all.

## How vendors compare (mechanism actually documented)

| Vendor | PowerSchool | Schoology |
|---|---|---|
| Google Classroom | OneRoster 1.1 via Universal Rostering plugin; admin enters client id/secret | n/a (Google Assignments = LTI 1.3 tool) |
| Canvas | OneRoster 1.1 plugin (older: PowerQuery plugin), nightly or manual | — |
| Otus | OneRoster 1.1 plugin, nightly, points only, needs Opportunity ID | — |
| Microsoft Teams | SDS Grade Sync (legacy REST plugin sunset 2024) | — |
| McGraw Hill, Wayground, IXL, Kami, Formative | none / CSV | LTI 1.3 AGS |
| Edpuzzle | — | LTI 1.1 Basic Outcomes |
| Pear Assessment / Edulastic | none documented | LTI |
| Illuminate (Renaissance) | none (Synergy / Q / Aeries only); districts use PTP CSV | — |
| MasteryConnect | CSV | none found |

Pattern: SIS write = OneRoster push through a plugin; LMS write = LTI
AGS; assessment-first tools mostly stop at the LMS or at CSV.

## Recommendation

1. **Build Path A first** (PowerSchool is the gradebook of record; D-5).
   One IT ask: Universal Rostering write-back enabled + our plugin
   installed. Then a "Send to PowerSchool" button on the results page.
2. **Path B1 (Schoology REST, two-legged district key) second**, same
   button with a "Schoology" target; the teacher's existing Schoology →
   PTP sync carries it onward. Do not chain A through B.
3. **Keep the CSV** (D-R3) as the no-integration fallback.
4. **LTI 1.3 AGS later**, if a second LMS (Canvas) or a launch-from-LMS
   workflow shows up.
   *(Superseded for step 1 by the 2026-09-22 evening update above: Path A
   is the `/ws/xte/` plugin API, not OneRoster.)*
5. **No MCP for this.** Revisit only for an assistant feature.

## Update 2026-09-22 evening — IT's reply changes Path A

IT (internal — see the ops repository) examined PowerSchool's developer
portal and PSD's schema and proposes a different, lighter PowerSchool
mechanism than OneRoster:

- **PowerTeacher Pro's own `/ws/xte/` gradebook API**, reachable by a
  district-written plugin (`plugin.xml` with `<oauth/>` + a field-level
  `<access_request>`). No Universal Rostering add-on, no PowerSchool
  quote, no partner program. IT writes and installs the plugin and hands
  us the OAuth client-credentials pair. The write set is
  `POST /ws/xte/section/assignment/` (assignment + per-section rows +
  category association) and `PUT /ws/xte/score` (bulk scores keyed by
  `assignmentsectionid` + `studentsdcid`).
- **Every call keys on PowerSchool DCIDs** (`STUDENTS.DCID`,
  `SECTIONS.DCID`, the teacher's `USERS.DCID`) — none of which the roster
  extract carries. IT will add them to the nightly extract.
- **The credential is district-wide and PowerSchool applies no per-user
  restriction** to plugin calls; our server must enforce that a teacher
  only writes to sections they currently teach.
- **Schoology's `section_school_code` is `SECTIONS.DCID`**, so the same
  DCID matches a sitting's section to its Schoology section with no
  teacher mapping.
- **About 40 % of PSD sections with gradebook assignments this year use
  Schoology → PTP passback** (46 % last year); it is per teacher / section.
  One destination per send (D-1) is therefore the rule, remembered per
  section.
- Categories: four district categories are copied to every teacher
  (Classwork, Test, Project, Quiz) plus many teacher-created ones; default
  to the teacher's "Test", allow override, check `ISACTIVE`.

OneRoster 1.1 push (the vendor pattern above) remains the portable route
for a district that lacks the plugin option; at PSD it is not needed.
The build design is `docs/gradebook-push-design.md`.

## Decisions (James, 2026-09-22)

- **D-1** One target per send: the teacher picks PowerSchool *or*
  Schoology; no "both" option (avoids double posting through the
  Schoology → PTP sync). A teacher without that sync may press the button
  twice, once per target.
- **D-2** Schoology auth = **three-legged OAuth per teacher** ("Connect
  Schoology" once); the connection is scoped to that teacher's own
  courses by Schoology itself (decided 2026-09-22 evening after IT's
  reply).
- **D-3** Whether Universal Rostering write-back is already on at PSD is
  the anchor question of the IT ask (internal — see the ops repository).

## What must be confirmed before scoping slices

- Does PSD's PowerSchool already run Universal Rostering with write-back
  (Google Classroom grade export in use?), and can IT enable it without a
  PowerSchool opportunity ticket?
- The OneRoster sourcedId ↔ `sections.id` / student number mapping, and
  whether a `results` PUT is restricted to line items our plugin created.
- Which Schoology sections are SIS-provisioned and what `section_school_code`
  carries; whether the PTP passback app is enabled for pilot courses.
- PowerSchool's proprietary `/ws/…` assignment endpoints exist but are
  login-gated; not needed if OneRoster push works.
- Policy: one target per assessment send, or both? Double posting when a
  teacher's Schoology already syncs to PTP.

## Sources (selected)

- PowerSchool Universal Rostering: https://ps.powerschool-docs.com/pssis-admin/latest/universal-rostering
- PowerSchool 1EdTech certification: https://site.imsglobal.org/certifications/powerschool-group-llc/powerschool-sis
- PowerSchool OneRoster API home: https://sis.powerschool.com/api/ims/oneroster/v1p1
- Install plugins / plugin security: https://ps.powerschool-docs.com/pssis-admin/latest/install-plugins , https://ps.powerschool-docs.com/pssis-admin/latest/plugin-security
- PTP Import Scores: https://ps.powerschool-docs.com/powerteacher-pro/latest/importing-and-exporting-scores
- Otus PowerSchool passback (admin): help.otus.com → "Admin guide for PowerSchool grade passback"
- Google Classroom ↔ PowerSchool: support.google.com/edu/classroom → "Connect Classroom to your SIS"
- Schoology REST auth / grade / assignment: https://developers.schoology.com/api-documentation/authentication/ , https://developers.schoology.com/api-documentation/rest-api-v1/grade/ , https://developers.schoology.com/api-documentation/rest-api-v1/assignment/
- Schoology rate limits: https://uc.powerschool-docs.com/en/schoology/latest/system-requirements
- Schoology LTI apps: https://developers.schoology.com/app-platform/lti-apps/
- Schoology → PTP sync: https://uc.powerschool-docs.com/en/schoology/latest/syncing-grades-to-powerteacher-pro
- Schoology 1EdTech certification: https://site.imsglobal.org/certifications/schoology/schoology
- LTI AGS 2.0: https://www.imsglobal.org/spec/lti-ags/v2p0 ; security framework: https://www.imsglobal.org/spec/security/v1p0/
- OneRoster 1.2 gradebook: https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/gradebook-informationmodel/OneRosterv1p2GradebookService_InfoModelv1p0.html
- Edlink PowerSchool / Schoology / pricing: https://ed.link/docs/providers/powerschool/functionality , https://ed.link/docs/providers/schoology/functionality , https://ed.link/community/pricing-faq/
- Clever LMS Connect: https://dev.clever.com/docs/lms-connect-overview
- Community MCP servers (read-only): https://github.com/443pablo/mcp-powerschool , https://github.com/coimf/schoology-mcp
