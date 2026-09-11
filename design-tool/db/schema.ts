import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type {
  DrawingCanvas,
  HotspotRegion,
  ItemResponse,
  MatchPair,
  Rubric,
  ScoringMethod,
  SequenceEntry,
  TableCellKeys,
  TableColumn,
  TableRow,
} from "@secure-test/schema";

export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    owner_sub: text("owner_sub").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    time_limit_seconds: integer("time_limit_seconds"),
    allow_llm_authoring: boolean("allow_llm_authoring").notNull().default(false),
    // Slice 69: may a student cut, copy or paste during this assessment?
    //
    // ONE flag, not separate copy and paste. The two are asked about together
    // in practice — a teacher deciding whether this test is a closed exercise
    // decides it for both — and two switches would mostly generate a
    // combination nobody wants (paste allowed, copy forbidden) plus a support
    // question about which one they set.
    //
    // Defaults to false: a secure-testing browser that permits the clipboard
    // unless told otherwise has the default backwards.
    allow_clipboard: boolean("allow_clipboard").notNull().default(false),
    allowed_accommodations: jsonb("allowed_accommodations")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // construct_altering is always a SUBSET of allowed_accommodations.
    // Postgres jsonb-array subset CHECKs are clunky; the invariant is
    // enforced in the API layer (lib/api/assessments.ts).
    construct_altering: jsonb("construct_altering")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("draft"),
    // Slice 63: who assigned this assessment, which decides whether a teacher's
    // per-student accommodation override may exceed the assessment's allowed
    // list. A teacher owns the construct decision on their own assessment; on
    // one handed down by the school or district they do not.
    //
    // Defaults to "teacher" because that is what every assessment is today —
    // nothing sets school or district yet, since no assignment flow exists.
    // Deliberately NOT settable through the authoring API: a teacher marking a
    // district assessment as their own would be marking away the very
    // constraint this column exists to impose.
    assigned_scope: text("assigned_scope").notNull().default("teacher"),
    // Client paging (docs/client-paging-design.md, D-1): how students move
    // through the test — "scroll" (one page, the default and what every
    // assessment authored before this column was) or "paged" (one question
    // at a time in the client). Rides the delivery bundle only as "paged".
    student_layout: text("student_layout").notNull().default("scroll"),
    // Archive (docs/archive-and-delete-design.md, D-2/D-3): null = live.
    // A timestamp rather than a boolean so a list can say "Archived 12 Sep"
    // and a later retention sweep has something to sort on. Archiving is NOT
    // a status change — a published assessment stays published while
    // archived, so unarchiving restores it exactly.
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerSubIdx: index("assessments_owner_sub_idx").on(t.owner_sub),
    assignedScopeCheck: check(
      "assessments_assigned_scope_check",
      sql`assigned_scope IN ('teacher', 'school', 'district')`,
    ),
    studentLayoutCheck: check(
      "assessments_student_layout_check",
      sql`student_layout IN ('scroll', 'paged')`,
    ),
  }),
);

export const ASSIGNED_SCOPES = ["teacher", "school", "district"] as const;
export type AssignedScope = (typeof ASSIGNED_SCOPES)[number];

export const ITEM_TYPES = [
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
  "essay",
  "match",
  "order",
  "hotspot",
  "drawing_upload",
  "table",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

// Slice 32: per-item type-specific extras, stored in the items.config jsonb
// bag. Sparse and evolving — essay's authoring metadata + slice 33's rubric.
// Integrity is enforced at the write boundary (lib/api/items.ts validates
// which keys may be persisted), not by the column itself. The jsonb column
// needs no migration to gain `rubric` — only this TS shape changes.
export type ItemConfig = {
  max_word_count?: number;
  placeholder?: string;
  rubric?: Rubric;
  // Rubric library slice 3 (D-4): the `rubrics` row this item's rubric was
  // COPIED from, if any. Editor metadata only — `rubric` above stays the
  // authoritative copy, and nothing downstream (scoring, delivery bundle,
  // export) reads this. Cleared when the teacher edits the rubric by hand
  // (detach) or when the library row is deleted.
  rubric_id?: string;
  // Slice 47: match items — the pair list IS the answer key (left belongs
  // with its own right; pair ids unique, enforced at the write boundary).
  pairs?: MatchPair[];
  // Slice 48: order items — entries in their correct order (the answer
  // key); entry ids unique, enforced at the write boundary.
  sequence?: SequenceEntry[];
  // Slice 49: hotspot items — image asset + normalized 0-1 regions;
  // correct_region_ids is the key. All optional: a hotspot may be a draft
  // (unconfigured = unscorable) while the teacher draws regions.
  image_asset_id?: string | null;
  regions?: HotspotRegion[];
  correct_region_ids?: string[];
  // Slice 50: drawing_upload (authoring-only) — optional reference image
  // + optional canvas dimensions the student client will enforce.
  prompt_asset_id?: string | null;
  canvas?: DrawingCanvas | null;
  // E3 slice 1: table items — the header row, the labelled rows, an optional
  // caption for the label column, and the expected text per keyed cell
  // (row id → column id → text). cell_keys IS the answer key and is the one
  // field the delivery bundle drops; absent = keyless draft (unscorable).
  columns?: TableColumn[];
  rows?: TableRow[];
  corner?: string;
  cell_keys?: TableCellKeys;
  // Slice 36: how the item is scored. Absent = type default (MC/short_text
  // → auto, essay → human; see effectiveScoringMethod in lib/api/items.ts).
  // Stored only when the teacher picked explicitly, so older rows/bundles
  // stay byte-stable.
  scoring_method?: ScoringMethod;
};

// E5 slice 1 (docs/stimulus-design.md, decisions 2026-09-01): an item set is
// one stimulus — a passage, a figure, a data table — shared by one or more
// items. "Sets of one" are the per-item case, so there is no separate
// per-item stimulus field. The set has NO position of its own: its items
// must be contiguous in `items.position` order and the set sits where its
// first item sits (the reorder route refuses an order that splits a set).
// An empty set is deleted by whichever route removed its last item.
// `stimulus_text` follows the stem's content rules — KaTeX (ADR 0009) and
// `![alt](asset:uuid)` refs (ADR 0010) — and is student-facing by definition
// (it ships in the delivery bundle). `layout`: 'inline' renders the stimulus
// once above its group; 'own_page' gives it a page of its own on the client
// and a page break in print.
// Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md, D-2):
// 'side_by_side' shows the sources beside the question on the client and
// prints like 'own_page'. The teacher picks it; it is never inferred.
export const ITEM_SET_LAYOUTS = ["inline", "own_page", "side_by_side"] as const;
export type ItemSetLayout = (typeof ITEM_SET_LAYOUTS)[number];

// Multi-source stimulus slice 2 (D-1): the labelled sources of a set, in
// order, as a JSON column rather than a child table — a source has no
// identity outside its set and nothing ever references one. `stimulus_text`
// stays and reads as the introduction above them.
export type StimulusSourceRow = { label: string; text: string };

export const item_sets = pgTable(
  "item_sets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    stimulus_text: text("stimulus_text").notNull().default(""),
    // Multi-source stimulus slice 2: ordered {label, text} entries; bounds
    // (label 1–80, text 20 000, at most 12) live at the write boundary in
    // lib/api/itemSets.ts, same posture as stimulus_text's own bound.
    sources: jsonb("sources").$type<StimulusSourceRow[]>().notNull().default(sql`'[]'::jsonb`),
    layout: text("layout").notNull().default("inline"),
    // E12 slice 1 (docs/e12-per-student-stimulus-design.md): an essay or
    // short-text question in ANOTHER assessment of the same owner whose
    // saved answer each student sees as this stimulus. Resolved per student
    // at delivery; nothing per student is stored here. Null = a plain
    // stimulus. Set null when the source question is deleted.
    // `AnyPgColumn` breaks the items ⇄ item_sets type cycle (items already
    // references item_sets.id) — drizzle's documented remedy.
    source_item_id: uuid("source_item_id").references((): AnyPgColumn => items.id, { onDelete: "set null" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assessmentIdIdx: index("item_sets_assessment_id_idx").on(t.assessment_id),
    layoutCheck: check(
      "item_sets_layout_check",
      sql`${t.layout} in ('inline', 'own_page', 'side_by_side')`,
    ),
  }),
);

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    // E5 slice 1: the set this item belongs to, if any. SET NULL on delete
    // so deleting a set frees its items rather than deleting them.
    item_set_id: uuid("item_set_id").references(() => item_sets.id, {
      onDelete: "set null",
    }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    stem: text("stem").notNull(),
    choices: jsonb("choices").notNull().default(sql`'[]'::jsonb`),
    correct_choice_ids: jsonb("correct_choice_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    correct_answer: text("correct_answer"),
    // Type-specific extras (slice 32). Empty {} for MC/short_text; essay
    // stores { max_word_count?, placeholder? }. Typed so app code can't read
    // it as untyped `any`.
    config: jsonb("config")
      .$type<ItemConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assessmentIdIdx: index("items_assessment_id_idx").on(t.assessment_id),
    positionUnq: unique("items_assessment_position_unq").on(
      t.assessment_id,
      t.position,
    ),
  }),
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    owner_sub: text("owner_sub").notNull(),
    content_type: text("content_type").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storage_provider: text("storage_provider").notNull(),
    storage_key: text("storage_key").notNull(),
    original_filename: text("original_filename"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assetsOwnerSubIdx: index("assets_owner_sub_idx").on(t.owner_sub),
    assetsOwnerSha256Unq: unique("assets_owner_sub_sha256_unq").on(
      t.owner_sub,
      t.sha256,
    ),
  }),
);

// Slice 23a: per-teacher student roster + per-(student, subject)
// accommodation rows. Imported from TIDE xlsx (canonical for its own
// bundle) and editable by the teacher; manual rows are a separate
// origin. See `lib/accommodations/tideCatalog.ts` for the TIDE→catalog
// mapping and `lib/api/students.ts` for the merge semantics.

export const TIDE_SUBJECTS = [
  "ELA-CAT",
  "ELA-PT",
  "Mathematics",
  "Science",
] as const;
export type TideSubject = (typeof TIDE_SUBJECTS)[number];

export const ACCOMMODATION_SOURCES = [
  "tide_import",
  "tide_then_edited",
  "manual",
] as const;
export type AccommodationSource = (typeof ACCOMMODATION_SOURCES)[number];

export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    owner_sub: text("owner_sub").notNull(),
    // Slice 78: nullable. A student who joins from the warehouse roster
    // before the SSID column exists there (ADR 0017 "Depends on" #1) still
    // needs an accommodations row to sit the test; it is keyed by
    // roster_ps_id until TIDE and the roster can be joined on SSID.
    ssid: text("ssid"),
    // Slice 78: the bridge from this per-teacher accommodations overlay to
    // roster_students.ps_id. Bound on the student's first admitted join —
    // by SSID when the row came from TIDE, or created outright when it did
    // not exist. Plain text, no FK: a roster row being deactivated must not
    // touch a teacher's accommodations.
    roster_ps_id: text("roster_ps_id"),
    name: text("name").notNull().default(""),
    grade: text("grade"),
    school: text("school"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerSubIdx: index("students_owner_sub_idx").on(t.owner_sub),
    ownerSsidUnq: unique("students_owner_sub_ssid_unq").on(
      t.owner_sub,
      t.ssid,
    ),
    // One overlay row per (teacher, roster student): two rows under one
    // teacher claiming the same child would make which row a login resolves
    // to depend on row order. NULLs are distinct, so TIDE rows that have not
    // been bound yet coexist. (Slice 59's ClassLink bridge — the
    // classlink_sourced_id column and its unique — was retired in slice 81.)
    ownerRosterUnq: unique("students_owner_sub_roster_ps_id_unq").on(
      t.owner_sub,
      t.roster_ps_id,
    ),
  }),
);

export const student_accommodations = pgTable(
  "student_accommodations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    student_id: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    tool_id: text("tool_id").notNull(),
    value: text("value").notNull(),
    // CHECK constraint enforces the source enum so a misbehaving
    // direct-DB writer can't insert an unknown source.
    source: text("source").notNull(),
    tide_code: text("tide_code"),
    // UX pass 2 slice 5 (P2-5): the TIDE code the teacher decided AGAINST
    // via "Keep mine". While it equals tide_code the diff stays decided;
    // a new TIDE assertion (different code) raises the diff again. Cleared
    // by a teacher edit and by accept-tide.
    kept_against_tide_code: text("kept_against_tide_code"),
    last_imported_at: timestamp("last_imported_at", { withTimezone: true }),
    edited_at: timestamp("edited_at", { withTimezone: true }),
    // Soft-removed rows are kept forever in MVP (audit trail). Excluded
    // from the partial unique index + default list views.
    removed_at: timestamp("removed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    studentIdIdx: index("student_accommodations_student_id_idx").on(
      t.student_id,
    ),
    // Partial unique: only enforce uniqueness on live rows. Soft-deleted
    // rows do NOT block a re-insert of the same (subject, tool) — a
    // student can be re-granted an accommodation that was previously
    // removed.
    liveTripleUnq: uniqueIndex("student_accommodations_live_triple_unq")
      .on(t.student_id, t.subject, t.tool_id)
      .where(sql`removed_at IS NULL`),
    sourceCheck: check(
      "student_accommodations_source_check",
      sql`source IN ('tide_import', 'tide_then_edited', 'manual')`,
    ),
  }),
);

// Slice 23b: per-assessment override of a student's roster-level
// accommodation. Lets a teacher grant or suppress one tool for one
// student on one assessment without mutating the student's baseline.
// The (assessment, student, tool) triple is unique — exactly one
// override per slot.
export const assessment_student_overrides = pgTable(
  "assessment_student_overrides",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    student_id: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    tool_id: text("tool_id").notNull(),
    value: text("value").notNull(),
    created_by_sub: text("created_by_sub").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assessmentIdIdx: index("assessment_student_overrides_assessment_id_idx").on(
      t.assessment_id,
    ),
    tripleUnq: unique("assessment_student_overrides_triple_unq").on(
      t.assessment_id,
      t.student_id,
      t.tool_id,
    ),
  }),
);

// Slice 28: safeguarding telemetry. One row per guardrail check (input
// or output) performed around an AI call. Written only when
// GUARDRAIL_PROVIDER is enabled (default "off" writes nothing). The
// admin review page (slice 30, tabled until an admin role exists — roles are
// staff/student by email domain since slice 77) reads from here. owner_sub is the teacher who triggered the
// AI call; CHECK constraints pin the surface/stage/action enums so a
// direct-DB writer can't insert an unknown value.

export const GUARDRAIL_SURFACES = [
  "item-gen",
  "math-translate",
  // Slice 38: AI essay scoring — checks the student's essay text (input)
  // and the model's rationale (output).
  "essay-score",
  // Slice 42: PDF item import — checks the extracted PDF text (input) and
  // the proposed item stems (output).
  "pdf-import",
  // Rubric upload slice 1 (docs/rubric-upload-design.md): rubric extraction
  // — checks the pasted / decoded rubric text (input; skipped on the
  // PDF/DOCX document path, as pdf-import does for scans) and the proposed
  // criterion names + descriptors (output).
  "rubric-extract",
] as const;
export type GuardrailSurfaceValue = (typeof GUARDRAIL_SURFACES)[number];

export const GUARDRAIL_STAGES = ["input", "output"] as const;
export const GUARDRAIL_ACTIONS = ["allow", "block"] as const;

export const guardrail_events = pgTable(
  "guardrail_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    owner_sub: text("owner_sub").notNull(),
    surface: text("surface").notNull(),
    stage: text("stage").notNull(),
    action: text("action").notNull(),
    provider_id: text("provider_id").notNull(),
    // REDACTION CONTRACT (phase-1-2 review, finding B4): `detail` on a
    // finding is a policy/category label, never the matched substring. PII
    // findings carry the Bedrock entity category (US_SOCIAL_SECURITY_NUMBER),
    // not the SSN. `redactFindings` in lib/safeguarding/guard.ts enforces this
    // at the single write path, so a provider that regresses cannot leak a
    // match into this column.
    findings: jsonb("findings").notNull().default(sql`'[]'::jsonb`),
    // Truncated copy of the text that was checked — enough context for
    // an admin to triage, capped in the wrapper so we never persist a
    // full prompt/response. Suppressed entirely (replaced with a marker) when
    // the check produced a sensitive finding: a PII block means the text
    // contains PII, so a 500-char window of it would defeat the filter.
    //
    // RETENTION: rows are never expired today. Before any production deploy,
    // add a retention sweep — this table is student/teacher-adjacent content.
    text_snippet: text("text_snippet").notNull().default(""),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerSubIdx: index("guardrail_events_owner_sub_idx").on(t.owner_sub),
    createdAtIdx: index("guardrail_events_created_at_idx").on(t.created_at),
    surfaceCheck: check(
      "guardrail_events_surface_check",
      sql`surface IN ('item-gen', 'math-translate', 'essay-score', 'pdf-import', 'rubric-extract')`,
    ),
    stageCheck: check(
      "guardrail_events_stage_check",
      sql`stage IN ('input', 'output')`,
    ),
    actionCheck: check(
      "guardrail_events_action_check",
      sql`action IN ('allow', 'block')`,
    ),
  }),
);

// Slice 35: attempts + responses — the data foundation for Phase 3 scoring
// (docs/phase-3-slices.md). One `attempts` row per (assessment, student)
// sitting — deliberately NOT unique on that pair, so re-sittings are
// representable; consumers order by started_at. One `responses` row per
// answered item; an unanswered item has no row. `response.type` must equal
// the answered item's `type` — enforced at the write boundary (the seed lib
// today; scoring reads and the future ingest API check it too).
//
// Written by the student plane since slice 61 (app/api/attempts); the
// dev-only seed script (scripts/seed-attempts.ts) predates it and remains.

export const ATTEMPT_STATUSES = ["in_progress", "submitted"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// Slice 60: a test SESSION is one teacher-created sitting of one assessment —
// the thing a student joins with a code. Codes belong to the sitting, not to
// the assessment, so the same assessment run by two teachers (or by one teacher
// in two periods) has two codes and two independently closable sittings.
//
// Auto-expiring: `expires_at` is required, so a sitting cannot be left open
// forever by a teacher who forgot to close it. Redemption checks BOTH status
// and expiry — a sitting past its expiry is closed for joining even if nobody
// has flipped its status yet.

export const TEST_SESSION_STATUSES = ["open", "closed"] as const;
export type TestSessionStatus = (typeof TEST_SESSION_STATUSES)[number];

export const test_sessions = pgTable(
  "test_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    // Denormalised from the assessment so redemption can scope the roster
    // lookup and a teacher can list their sittings without a join. Set once at
    // create time from the assessment row; never edited.
    owner_sub: text("owner_sub").notNull(),
    // Slice 78: the owner's verified email at create time — the join to
    // roster_section_teachers.teacher_email that decides which students may
    // join. Null on sittings created before slice 78; those admit only an
    // explicit list.
    owner_email: text("owner_email"),
    // Slice 78 scope. Both null = any section the owner actively teaches.
    // section_ps_id = that one section (slice 79's "a picked section").
    // student_ps_ids = exactly these roster students, no section check.
    section_ps_id: text("section_ps_id"),
    student_ps_ids: jsonb("student_ps_ids").$type<string[]>(),
    code: text("code").notNull(),
    status: text("status").notNull().default("open"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Archive (docs/archive-and-delete-design.md, D-2): null = live. Hides a
    // finished sitting from the Test sessions tab without deleting it —
    // attendance and the monitor's history keep working on an archived row.
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assessmentIdIdx: index("test_sessions_assessment_id_idx").on(t.assessment_id),
    ownerSubIdx: index("test_sessions_owner_sub_idx").on(t.owner_sub),
    // A code identifies at most one JOINABLE sitting at a time. Partial on
    // status so a code is released for reuse once its sitting is closed —
    // teachers reuse short codes, and holding every code ever issued would be a
    // needless constraint. Expiry cannot live in the predicate (now() is not
    // immutable), so an expired-but-unclosed sitting keeps its code until it is
    // closed; the create path sweeps those first.
    openCodeUnq: uniqueIndex("test_sessions_open_code_unq")
      .on(t.code)
      .where(sql`status = 'open'`),
    statusCheck: check(
      "test_sessions_status_check",
      sql`status IN ('open', 'closed')`,
    ),
  }),
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    student_id: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    // Slice 61: the sitting this attempt was last joined through — finding
    // 8.2 (2026-08-28) rebinds an in-progress attempt when the student rejoins
    // the assessment through a new sitting; no history of the original is
    // kept. Nullable because
    // attempts predate sittings (the dev seeder makes them without one) and
    // because deleting a sitting should not delete a student's work — hence
    // SET NULL rather than CASCADE.
    test_session_id: uuid("test_session_id").references(() => test_sessions.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("in_progress"),
    started_at: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set when status flips to 'submitted'; null while in progress.
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    // Time limit / unfinished attempts (docs/time-limit-and-unfinished-attempts-design.md):
    // WHO handed this attempt in. Null means the student did it themselves —
    // which is every row that predates this column, and the overwhelming
    // majority afterwards. A staff `sub` means a teacher forced the
    // submission through POST /api/attempts/[attemptId]/hand-in, and the
    // results surfaces say so beside `submitted_at`.
    submitted_by_sub: text("submitted_by_sub"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assessmentIdIdx: index("attempts_assessment_id_idx").on(t.assessment_id),
    studentIdIdx: index("attempts_student_id_idx").on(t.student_id),
    // Slice 61: one attempt per student per assessment, decided deliberately.
    // A student who joins a second sitting of the same assessment RESUMES the
    // work they already started rather than beginning a blank one — the
    // alternative silently strands their first set of answers somewhere the
    // results page would have to guess between.
    assessmentStudentUnq: unique("attempts_assessment_student_unq").on(
      t.assessment_id,
      t.student_id,
    ),
    statusCheck: check(
      "attempts_status_check",
      sql`status IN ('in_progress', 'submitted')`,
    ),
  }),
);

// Slice 91: client-reported events on an attempt — the anomaly stream the
// teacher monitor shows (Phase 3 in the plan). Append-only telemetry, never
// answers: rows are written by the student plane on the client's word and are
// displayed, not scored, so a fabricated event can annoy a teacher but cannot
// change a grade. The kinds are a closed set shared with the route's Zod enum;
// an unknown kind is a client/server drift to surface (400), not data to keep.

export const ATTEMPT_EVENT_KINDS = [
  "quit",
  "emergency_exit",
  "focus_loss",
  "focus_regained",
  "lockdown_begin",
  "lockdown_end",
  "lockdown_failed",
  "lockdown_interrupted",
  // Batch 3 slice 2 (D-4): an error the client hit DURING an attempt. The
  // out-of-attempt errors go to client_error_events via /api/client-errors;
  // this kind exists so an in-attempt failure reaches the teacher live
  // through the reporter that is already retrying lifecycle kinds.
  // detail is { kind, message } — never response text, never a stem.
  "client_error",
  // Time limit (D-2): the client's countdown reached zero and it ended the
  // secure session. The attempt deliberately stays in progress — this row is
  // how a teacher knows why the student stopped.
  "time_expired",
  // D-1/A: the teacher forced the submission through the hand-in route.
  // Server-written only; see CLIENT_ATTEMPT_EVENT_KINDS below.
  "teacher_hand_in",
] as const;
export type AttemptEventKind = (typeof ATTEMPT_EVENT_KINDS)[number];

/**
 * The subset a CLIENT may post to /api/attempts/[attemptId]/events.
 *
 * `teacher_hand_in` is a record of a staff action and is written by the
 * hand-in route alone; a student client that could post it could plant a
 * timeline line claiming a teacher did something they did not. Nothing is
 * scored off these rows, so the damage is confusion rather than grades — but
 * the fix costs one list, so the list exists.
 */
export type ClientAttemptEventKind = Exclude<AttemptEventKind, "teacher_hand_in">;
export const CLIENT_ATTEMPT_EVENT_KINDS = ATTEMPT_EVENT_KINDS.filter(
  (kind) => kind !== "teacher_hand_in",
) as [ClientAttemptEventKind, ...ClientAttemptEventKind[]];

// Kinds a teacher should be alerted about. `focus_loss` is the only one a
// later event (focus_regained) clears; the rest stay alerts for the attempt's
// lifetime — a quit or a broken lockdown is not undone by anything that
// happens afterwards.
export const ALERT_EVENT_KINDS = [
  "quit",
  "emergency_exit",
  "focus_loss",
  "lockdown_failed",
  "lockdown_interrupted",
  "client_error",
] as const;

export const attempt_events = pgTable(
  "attempt_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // Server-stamped on insert. The client's clock is not trusted with the
    // ordering that decides whether a focus_loss is still an active alert.
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => ({
    attemptIdIdx: index("attempt_events_attempt_id_idx").on(t.attempt_id),
    kindCheck: check(
      "attempt_events_kind_check",
      sql`kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error', 'time_expired', 'teacher_hand_in')`,
    ),
  }),
);

/**
 * On-demand peek (docs/on-demand-peek-design.md): one row per teacher request
 * for a look at one student's screen. The row IS the audit record — who
 * peeked whom, requested/delivered/viewed — and outlives the image, which is
 * base64 JPEG held only between the client's upload and the teacher's read:
 * nulled on view (delete-on-read) or by the 60 s TTL sweep, never S3, never
 * the filesystem, never a log line (decisions 6.3/6.4).
 *
 * Base64 in a text column rather than bytea on purpose: the image is
 * ~100-250 KB, lives for under a minute, and a custom bytea type is
 * complexity this table does not need.
 */
export const peek_requests = pgTable(
  "peek_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    /** The requesting teacher's sub — the audit's "who". */
    requested_by: text("requested_by").notNull(),
    requested_at: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the client uploads; null = the client has not answered yet. */
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    /** Set when the teacher reads; the same statement nulls the image. */
    viewed_at: timestamp("viewed_at", { withTimezone: true }),
    image_base64: text("image_base64"),
  },
  (t) => ({
    attemptIdIdx: index("peek_requests_attempt_id_idx").on(t.attempt_id),
  }),
);

export type PeekRequestRow = typeof peek_requests.$inferSelect;

export const responses = pgTable(
  "responses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    item_id: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    response: jsonb("response").$type<ItemResponse>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    attemptIdIdx: index("responses_attempt_id_idx").on(t.attempt_id),
    itemIdIdx: index("responses_item_id_idx").on(t.item_id),
    attemptItemUnq: unique("responses_attempt_item_unq").on(
      t.attempt_id,
      t.item_id,
    ),
  }),
);

// Slice 37: scores — append-only. A response accumulates score rows
// (proposed AI drafts, the human/auto final); rows are never updated in
// place, so the scoring history is the audit trail. The partial unique
// index enforces exactly one 'final' score per response. `method` records
// who actually produced the number (auto engine, AI model, or human), so
// a hybrid item's rows still say concretely where each score came from.
// `scorer` is "auto", a model id, or a teacher sub. Auto scores are
// written status=final directly (objective key, no review step); AI
// scores are always written status=proposed (slice 38) and only a human
// finalizes them (slice 39).

export const SCORE_METHODS = ["auto", "ai", "human"] as const;
export type ScoreMethod = (typeof SCORE_METHODS)[number];

export const SCORE_STATUSES = ["proposed", "final"] as const;
export type ScoreStatus = (typeof SCORE_STATUSES)[number];

// Slice 65: a registry row for a student file upload, created BEFORE the file
// exists. Uploads are registered rather than named by the client so a response
// can only reference a slot the server minted for that exact (attempt, item);
// a client-chosen key would let one student point their answer at another's
// file.
//
// Deliberately NOT the `assets` table. That one is a teacher's authoring
// library, keyed by (owner_sub, sha256) with size and digest NOT NULL — none of
// which is knowable when the bytes have not arrived yet, and a student's work
// is not an authoring asset.

export const UPLOAD_STATUSES = ["pending", "complete"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const response_uploads = pgTable(
  "response_uploads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    attempt_id: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    item_id: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    storage_provider: text("storage_provider").notNull(),
    storage_key: text("storage_key").notNull(),
    content_type: text("content_type").notNull(),
    status: text("status").notNull().default("pending"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    attemptIdIdx: index("response_uploads_attempt_id_idx").on(t.attempt_id),
    statusCheck: check(
      "response_uploads_status_check",
      sql`status IN ('pending', 'complete')`,
    ),
  }),
);

export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    response_id: uuid("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    points: doublePrecision("points").notNull(),
    max_points: doublePrecision("max_points").notNull(),
    // Per-criterion selections / model reasoning (slices 38-39). Auto
    // scoring writes null — the response row already holds the answer.
    rationale: jsonb("rationale"),
    scorer: text("scorer").notNull(),
    status: text("status").notNull(),
    reviewed_by_sub: text("reviewed_by_sub"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    responseIdIdx: index("scores_response_id_idx").on(t.response_id),
    oneFinalPerResponse: uniqueIndex("scores_one_final_per_response_unq")
      .on(t.response_id)
      .where(sql`status = 'final'`),
    methodCheck: check(
      "scores_method_check",
      sql`method IN ('auto', 'ai', 'human')`,
    ),
    statusCheck: check(
      "scores_status_check",
      sql`status IN ('proposed', 'final')`,
    ),
    pointsCheck: check(
      "scores_points_check",
      sql`points >= 0 AND max_points > 0 AND points <= max_points`,
    ),
  }),
);


// ---------------------------------------------------------------------------
// Slice 75 (ADR 0017): the roster snapshot from the PSD data warehouse.
//
// These four tables are a MIRROR of a nightly extract, not a thing teachers
// edit. The extract (docs/roster-extract.md) is the contract; the importer
// (lib/roster/importSnapshot.ts) is the only writer. Two rules carried in from
// AI Studio's OneRoster sync and from the ADR:
//
//   - Nothing is ever hard-deleted by sync. A row absent from a complete,
//     checksum-verified snapshot is DEACTIVATED (`is_active = false`), and a
//     row that reappears is reactivated by the same upsert.
//   - `last_seen_snapshot_id` is how absence is detected without a NOT IN
//     over thousands of keys: every row the snapshot carries is stamped with
//     its id, and whatever is still active with an older stamp was absent.
//
// Keys are PowerSchool ids carried as text (`ps_id`), never regenerated here,
// so a re-import is idempotent and a section keeps its identity across
// nights. `section_teachers` has no id of its own in PowerSchool; its natural
// key is (section, teacher, start_date).
//
// "Active" has two layers. `is_active` says the warehouse still reports the
// row. The date columns (`start_date`/`end_date`, `dateenrolled`/`dateleft`)
// say whether the relationship holds TODAY — PowerSchool always populates the
// end dates, with a future date for a current relationship — and that check
// belongs to the query layer, not the importer.
// ---------------------------------------------------------------------------

/** Columns every roster mirror table carries for the absence-deactivation rule. */
const rosterSyncColumns = {
  is_active: boolean("is_active").notNull().default(true),
  last_seen_snapshot_id: text("last_seen_snapshot_id").notNull(),
  first_seen_at: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  last_seen_at: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
};

export const roster_students = pgTable(
  "roster_students",
  {
    /** PowerSchool `students.id`. */
    ps_id: text("ps_id").primaryKey(),
    /** State student id (`state_studentnumber`) — the key TIDE accommodations
     * use. Nullable because the warehouse column is still being added
     * (ADR 0017 "Depends on" #1); the extract carries the column either way. */
    ssid: text("ssid"),
    /** Lowercased, trimmed at import. Null when PowerSchool has none — such a
     * student cannot sign in and is simply never resolved. */
    email: text("email"),
    first_name: text("first_name").notNull().default(""),
    last_name: text("last_name").notNull().default(""),
    grade: text("grade"),
    school_id: text("school_id"),
    /** PowerSchool enroll_status: 0 active, -1 pre-registered, 1 inactive,
     * 2 transferred, 3 graduated, 4 imported. Stored as sent. */
    enroll_status: integer("enroll_status").notNull(),
    ...rosterSyncColumns,
  },
  (t) => ({
    // Resolution is by lowercased email; the importer lowercases, so a plain
    // index serves the lookup. NOT unique: the warehouse has been seen to
    // carry the same address on two rows during transfers, and an import
    // must not fail on that — the resolver refuses an ambiguous match instead.
    emailIdx: index("roster_students_email_idx").on(t.email),
    ssidIdx: index("roster_students_ssid_idx").on(t.ssid),
  }),
);

export const roster_sections = pgTable("roster_sections", {
  /** PowerSchool `sections.id`. */
  ps_id: text("ps_id").primaryKey(),
  school_id: text("school_id"),
  course_code: text("course_code").notNull().default(""),
  course_name: text("course_name").notNull().default(""),
  term_id: text("term_id"),
  period_expression: text("period_expression").notNull().default(""),
  ...rosterSyncColumns,
});

export const roster_section_teachers = pgTable(
  "roster_section_teachers",
  {
    section_ps_id: text("section_ps_id")
      .notNull()
      .references(() => roster_sections.ps_id),
    /** PowerSchool `teachers.id` — per-school, so one person may hold several. */
    teacher_ps_id: text("teacher_ps_id").notNull(),
    /** Lowercased, trimmed. The join to a staff session's `email`. */
    teacher_email: text("teacher_email"),
    role_name: text("role_name").notNull().default(""),
    priority_order: integer("priority_order"),
    start_date: date("start_date").notNull(),
    end_date: date("end_date").notNull(),
    ...rosterSyncColumns,
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.section_ps_id, t.teacher_ps_id, t.start_date],
    }),
    teacherEmailIdx: index("roster_section_teachers_email_idx").on(
      t.teacher_email,
    ),
  }),
);

export const roster_enrollments = pgTable(
  "roster_enrollments",
  {
    /** PowerSchool `section_enrollments.id` (the CC record). */
    ps_id: text("ps_id").primaryKey(),
    student_ps_id: text("student_ps_id")
      .notNull()
      .references(() => roster_students.ps_id),
    section_ps_id: text("section_ps_id")
      .notNull()
      .references(() => roster_sections.ps_id),
    dateenrolled: date("dateenrolled").notNull(),
    dateleft: date("dateleft").notNull(),
    ...rosterSyncColumns,
  },
  (t) => ({
    studentIdx: index("roster_enrollments_student_idx").on(t.student_ps_id),
    sectionIdx: index("roster_enrollments_section_idx").on(t.section_ps_id),
  }),
);

export const ROSTER_SYNC_STATUSES = [
  "running",
  "succeeded",
  "refused",
  "failed",
] as const;
export type RosterSyncStatus = (typeof ROSTER_SYNC_STATUSES)[number];

/** One row per import attempt. `reason` is a code (plus a table name or line
 * number), never row content — this table is the sync log and must stay
 * PII-free. `counts` is per-table {received, upserted, deactivated}. */
export const roster_sync_runs = pgTable(
  "roster_sync_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    snapshot_id: text("snapshot_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
    started_at: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    startedAtIdx: index("roster_sync_runs_started_at_idx").on(t.started_at),
    statusCheck: check(
      "roster_sync_runs_status_check",
      sql`status IN ('running', 'succeeded', 'refused', 'failed')`,
    ),
  }),
);

export type AssessmentRow = typeof assessments.$inferSelect;
export type AssessmentInsert = typeof assessments.$inferInsert;
export type ItemRow = typeof items.$inferSelect;
export type ItemSetRow = typeof item_sets.$inferSelect;
export type ItemInsert = typeof items.$inferInsert;
export type AssetRow = typeof assets.$inferSelect;
export type AssetInsert = typeof assets.$inferInsert;
export type StudentRow = typeof students.$inferSelect;
export type StudentInsert = typeof students.$inferInsert;
export type StudentAccommodationRow =
  typeof student_accommodations.$inferSelect;
export type StudentAccommodationInsert =
  typeof student_accommodations.$inferInsert;
export type AssessmentStudentOverrideRow =
  typeof assessment_student_overrides.$inferSelect;
export type AssessmentStudentOverrideInsert =
  typeof assessment_student_overrides.$inferInsert;
export type GuardrailEventRow = typeof guardrail_events.$inferSelect;
export type GuardrailEventInsert = typeof guardrail_events.$inferInsert;
export type TestSessionRow = typeof test_sessions.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type AttemptInsert = typeof attempts.$inferInsert;
export type AttemptEventRow = typeof attempt_events.$inferSelect;
export type AttemptEventInsert = typeof attempt_events.$inferInsert;
export type ResponseRow = typeof responses.$inferSelect;
export type ResponseInsert = typeof responses.$inferInsert;
export type ResponseUploadRow = typeof response_uploads.$inferSelect;
export type ScoreRow = typeof scores.$inferSelect;
export type ScoreInsert = typeof scores.$inferInsert;
export type RosterStudentRow = typeof roster_students.$inferSelect;
export type RosterSectionRow = typeof roster_sections.$inferSelect;
export type RosterSectionTeacherRow = typeof roster_section_teachers.$inferSelect;
export type RosterEnrollmentRow = typeof roster_enrollments.$inferSelect;
export type RosterSyncRunRow = typeof roster_sync_runs.$inferSelect;

// Slice C (2026-09-01): staff-to-staff sharing, COPY semantics. The owner
// names a colleague by staff email; the colleague sees the offer on their
// dashboard and "Add to my assessments" makes them an independent copy via
// the export bundle → importBundleForOwner path. Nothing in the 50-odd
// owner_sub checks changes: the source stays single-owner, the copy is the
// recipient's to edit. School/district-level sharing later would reuse
// assessments.assigned_scope rather than this table.
export const assessment_shares = pgTable(
  "assessment_shares",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    // Lowercased at the write boundary; must be a STAFF_DOMAINS address.
    recipient_email: text("recipient_email").notNull(),
    shared_by_sub: text("shared_by_sub").notNull(),
    // The sharer's verified session email, so the recipient sees a name
    // they recognize instead of a Google sub.
    shared_by_email: text("shared_by_email").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    accepted_at: timestamp("accepted_at", { withTimezone: true }),
    // The recipient's copy. SET NULL on delete: the offer row survives so
    // "Add" is idempotent and re-adding is an explicit new share.
    copied_assessment_id: uuid("copied_assessment_id").references(
      () => assessments.id,
      { onDelete: "set null" },
    ),
  },
  (t) => ({
    oneOfferPerRecipient: uniqueIndex("assessment_shares_assessment_recipient_unq").on(
      t.assessment_id,
      t.recipient_email,
    ),
    recipientIdx: index("assessment_shares_recipient_email_idx").on(t.recipient_email),
  }),
);
export type AssessmentShareRow = typeof assessment_shares.$inferSelect;

// --- Observability (batch 3, docs/observability-design.md) -----------------
//
// Three tables, one migration (0028). They share a redaction contract, stated
// once here and enforced at each write boundary:
//
//   NEVER stored: request or response bodies, query strings, headers, tokens,
//   response text, item stems or choices, student names.
//   Stored: `sub`, uuids, route paths, status codes, digests, messages and
//   stacks truncated to 2 000 characters, and a stack hash for grouping.
//
// RETENTION: rows are never expired today — the same warning `guardrail_events`
// carries. One retention sweep covering all four tables is the follow-up; the
// CloudWatch log group is capped at 30 days (D-8) but the database is the
// record, so nothing here is deleted by that.

/** Truncation ceiling shared by every free-text column in this section. */
export const OBSERVABILITY_TEXT_MAX = 2000;

/**
 * One row per unhandled server error, written by `onRequestError`
 * (`instrumentation.ts`) beside the JSON log line that carries the same
 * fields. `request_id` is the handle a teacher reads off the error screen as
 * "ref", so a screenshot maps to a row and to a CloudWatch line.
 *
 * A write failure here is swallowed: the log line is the primary record and a
 * database that is already unhappy must not turn one 500 into two.
 */
export const server_error_events = pgTable(
  "server_error_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Minted in proxy.ts (or the ALB's x-amzn-trace-id). Null if absent. */
    request_id: text("request_id"),
    /** Resource path only — the query string is dropped at the boundary. */
    route: text("route").notNull(),
    method: text("method").notNull(),
    status: integer("status").notNull(),
    /** React/Next's error digest — what the boundary shows the user. */
    digest: text("digest"),
    message: text("message").notNull(),
    /** sha-256 of the normalised stack, for grouping without reading it. */
    stack_hash: text("stack_hash"),
    /** Truncated to OBSERVABILITY_TEXT_MAX. */
    stack: text("stack"),
    /** The session's sub when there was one; never an email, never a name. */
    sub: text("sub"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdAtIdx: index("server_error_events_created_at_idx").on(t.created_at),
    requestIdIdx: index("server_error_events_request_id_idx").on(t.request_id),
  }),
);

/**
 * The macOS client's error log, drained after a signed-in launch to
 * `POST /api/client-errors`. Out-of-attempt by design: a failed sign-in, a
 * refused bundle, or a crash captured on the previous run has no attempt to
 * hang off, which is exactly what `attempt_events` cannot carry.
 *
 * `occurred_at` is the CLIENT's clock (that is the point — the line was
 * written before this launch); `received_at` is server-stamped, and ordering
 * or alerting uses that one.
 */
export const client_error_events = pgTable(
  "client_error_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sub: text("sub").notNull(),
    app_version: text("app_version").notNull(),
    app_commit: text("app_commit").notNull(),
    /** A short code from the client (`bundle_rejected`, `signal_SIGABRT`). */
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    /** Small bag of ids/counts, capped at 4 KB and dropped if bigger. */
    context: jsonb("context").$type<Record<string, unknown>>(),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),
    received_at: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    receivedAtIdx: index("client_error_events_received_at_idx").on(t.received_at),
    subIdx: index("client_error_events_sub_idx").on(t.sub),
  }),
);

/**
 * "Send feedback" from the teacher header (slice 3). The row is the record;
 * the SNS email is only the notification, so a publish failure never fails the
 * request. Students have no button — they tell the teacher.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sub: text("sub").notNull(),
    /** The sender's verified session email — staff only, never a student. */
    email: text("email").notNull(),
    role: text("role").notNull(),
    /** The path they were on, so a report has a place attached. */
    path: text("path").notNull(),
    message: text("message").notNull(),
    user_agent: text("user_agent"),
    app_commit: text("app_commit"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdAtIdx: index("feedback_created_at_idx").on(t.created_at),
  }),
);

export type ServerErrorEventRow = typeof server_error_events.$inferSelect;
export type ServerErrorEventInsert = typeof server_error_events.$inferInsert;
export type ClientErrorEventRow = typeof client_error_events.$inferSelect;
export type ClientErrorEventInsert = typeof client_error_events.$inferInsert;
export type FeedbackRow = typeof feedback.$inferSelect;
export type FeedbackInsert = typeof feedback.$inferInsert;

/**
 * The audit record of a teacher deleting a student's attempt (roadmap
 * 2026-09, finding of the 2026-09-07 signed-build run). `attempt_events`
 * cascades with the attempt, so the record of the deletion has to live
 * beside it, not in it. The row keeps WHO (the owner's sub), WHAT (a snapshot
 * of the attempt's status and hand-in time plus what was removed with it) and
 * WHEN; never response text, never a stem. It cascades with the assessment
 * and the student — once those are gone there is nothing left to audit.
 */
export const attempt_deletions = pgTable(
  "attempt_deletions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** The deleted attempt's id — no FK, the row it names is gone. */
    attempt_id: uuid("attempt_id").notNull(),
    assessment_id: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    student_id: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    /** The deleting teacher's sub — the owner, by the route's rule. */
    deleted_by_sub: text("deleted_by_sub").notNull(),
    attempt_status: text("attempt_status").notNull(),
    attempt_started_at: timestamp("attempt_started_at", { withTimezone: true }).notNull(),
    attempt_submitted_at: timestamp("attempt_submitted_at", { withTimezone: true }),
    response_count: integer("response_count").notNull(),
    upload_count: integer("upload_count").notNull(),
    event_count: integer("event_count").notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    assessmentIdIdx: index("attempt_deletions_assessment_id_idx").on(t.assessment_id),
    deletedAtIdx: index("attempt_deletions_deleted_at_idx").on(t.deleted_at),
  }),
);

export type AttemptDeletionRow = typeof attempt_deletions.$inferSelect;
export type AttemptDeletionInsert = typeof attempt_deletions.$inferInsert;

// Rubric library (docs/rubric-upload-design.md §"Rubric library and reuse",
// D-4), slice 3. A per-teacher shelf of reusable rubrics. Owner-scoped like
// students/assessments; sharing between staff rides the existing
// assessment-share copy semantics later, not here.
//
// Copy-on-apply is the whole design: applying a library rubric to an essay
// writes a COPY into items.config.rubric (fresh criterion/level ids) and
// records where it came from in items.config.rubric_id. Editing the item's
// rubric afterwards detaches it (rubric_id cleared) — a change in the
// library must never rescore an item behind a teacher's back (E11 territory).
// So there is deliberately NO foreign key from items to this table: the id
// is provenance metadata, and deleting a library rubric only detaches.
export const RUBRIC_SOURCES = ["upload", "editor"] as const;
export type RubricSource = (typeof RUBRIC_SOURCES)[number];

export const rubrics = pgTable(
  "rubrics",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    owner_sub: text("owner_sub").notNull(),
    title: text("title").notNull(),
    /** The shared `RubricSchema` shape, validated at the write boundary
     * (lib/api/rubrics.ts) exactly as items.config.rubric is. */
    rubric: jsonb("rubric").$type<Rubric>().notNull(),
    /** Where the teacher got it: the upload dialog, or hand-authored. */
    source: text("source").notNull().default("upload"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerSubIdx: index("rubrics_owner_sub_idx").on(t.owner_sub),
    sourceCheck: check("rubrics_source_check", sql`source IN ('upload', 'editor')`),
  }),
);

export type RubricRow = typeof rubrics.$inferSelect;
export type RubricInsert = typeof rubrics.$inferInsert;
