// Slice 53: regenerates the Swift client's delivery-bundle test fixture from
// the REAL route, so SecureTestCore's decoder is verified against bytes the
// design tool actually emits rather than a hand-written approximation of them.
//
// Run when DeliveryBundleSchema or the delivery route changes:
//   cd design-tool
//   DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test \
//     bun scripts/generate-delivery-fixture.ts
//
// Writes to client/SecureTestCore/Tests/SecureTestCoreTests/Fixtures/.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  assets,
  attempts,
  item_sets,
  items,
  student_accommodations,
  students,
} from "../db/schema";
import { resolveEffectiveAccommodations } from "../lib/accommodations/effective";
import { buildDeliveryBundle } from "../lib/api/buildDeliveryBundle";
import { localFsProvider } from "../lib/storage/localFsProvider";
import type { Rubric } from "@secure-test/schema";

const OUT = resolve(
  import.meta.dir,
  "../../client/SecureTestCore/Tests/SecureTestCoreTests/Fixtures/delivery-bundle.json",
);

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("secure_test_design_tool_test")) {
  throw new Error(`refusing to seed a non-test DB; got: ${url}`);
}
const VISIBLE_RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "cr1",
      name: "Use of evidence",
      levels: [
        { id: "l1", label: "Emerging", points: 1, descriptor: "Cites no evidence." },
        { id: "l2", label: "Proficient", points: 3, descriptor: "Cites relevant evidence." },
      ],
    },
  ],
  student_visibility: { during_test: true },
};

const db = getDb();
await db.execute(sql`truncate table assessments restart identity cascade`);
await db.execute(sql`truncate table assets restart identity cascade`);
await db.execute(sql`truncate table students restart identity cascade`);

// A real asset, stored through the real provider, so the fixture exercises the
// bundling path rather than a hand-written `assets` map. 1x1 PNG — hotspot
// regions are normalised 0-1, so the pixel dimensions are irrelevant to what is
// being tested.
const IMAGE_ID = "33333333-3333-4333-8333-333333333333";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const { storage_key } = await localFsProvider.put({
  id: IMAGE_ID,
  bytes: new Uint8Array(PNG),
  content_type: "image/png",
});
await db.insert(assets).values({
  id: IMAGE_ID,
  owner_sub: "fixture-teacher",
  content_type: "image/png",
  size_bytes: PNG.byteLength,
  sha256: createHash("sha256").update(PNG).digest("hex"),
  storage_provider: localFsProvider.id,
  storage_key,
  original_filename: "cell.png",
});

const [a] = await db
  .insert(assessments)
  .values({
    owner_sub: "fixture-teacher",
    name: "Delivery Fixture",
    // The gate: color_contrast is allowed here, highlighter is allowed but the
    // student has it Off, and a tool the student has is dropped if not listed.
    allowed_accommodations: ["spell_check", "highlighter", "color_contrast"],
    construct_altering: ["spell_check"],
  })
  .returning();
if (!a) throw new Error("no assessment");

const seededItems = await db.insert(items).values([
  {
    assessment_id: a.id,
    position: 1,
    type: "multiple_choice_single",
    stem: "Which organelle produces ATP?",
    choices: [
      { id: "c1", text: "Mitochondrion" },
      { id: "c2", text: "Ribosome" },
      { id: "c3", text: "Golgi apparatus" },
    ],
    correct_choice_ids: ["c1"],
  },
  {
    assessment_id: a.id,
    position: 2,
    type: "multiple_choice_multi",
    // Deliberately markup-shaped: proves the client renders it as text and
    // that JSONEmbedding neutralises it on the way into the page.
    stem: "Select all prime numbers. </script><b>not markup</b>",
    choices: [
      { id: "c1", text: "2" },
      { id: "c2", text: "4" },
      { id: "c3", text: "7" },
    ],
    correct_choice_ids: ["c1", "c3"],
  },
  {
    assessment_id: a.id,
    position: 3,
    type: "short_text",
    stem: "Name the process shown here: ![cell diagram](asset:33333333-3333-4333-8333-333333333333)",
    correct_answer: "photosynthesis",
  },
  {
    assessment_id: a.id,
    position: 4,
    type: "essay",
    stem: "Explain how the author builds their argument. Use $E = mc^2$ if relevant.",
    config: {
      max_word_count: 400,
      placeholder: "Write your response here…",
      rubric: VISIBLE_RUBRIC,
      scoring_method: "ai",
    },
  },
  {
    assessment_id: a.id,
    position: 5,
    type: "match",
    stem: "Match each animal to its young.",
    config: {
      pairs: [
        { id: "p1", left: "Dog", right: "Puppy" },
        { id: "p2", left: "Cat", right: "Kitten" },
        { id: "p3", left: "Cow", right: "Calf" },
      ],
    },
  },
  {
    assessment_id: a.id,
    position: 6,
    type: "order",
    stem: "Put the water-cycle stages in order.",
    config: {
      sequence: [
        { id: "e1", label: "Evaporation" },
        { id: "e2", label: "Condensation" },
        { id: "e3", label: "Precipitation" },
        { id: "e4", label: "Collection" },
      ],
    },
  },
  {
    assessment_id: a.id,
    position: 7,
    type: "hotspot",
    stem: "Click the nucleus.",
    config: {
      image_asset_id: "33333333-3333-4333-8333-333333333333",
      regions: [
        { id: "r1", x: 0.1, y: 0.1, w: 0.25, h: 0.25 },
        { id: "r2", x: 0.6, y: 0.55, w: 0.3, h: 0.3 },
      ],
      correct_region_ids: ["r2"],
    },
  },
  {
    assessment_id: a.id,
    position: 8,
    type: "drawing_upload",
    stem: "Sketch the free-body diagram.",
    // Drawing background: the fixture carries `axes` so the Swift decoder is
    // verified against a bundle that names a background (an older client
    // ignores the key and shows a blank canvas).
    config: { canvas: { width: 1000, height: 700, background: "axes" } },
  },
  {
    // E3 slice 3: a keyed table — the key must NOT reach the fixture (the
    // Swift suite asserts the bytes carry no cell_keys).
    assessment_id: a.id,
    position: 9,
    type: "table",
    stem: "Enter the counts from your chi-square work.",
    config: {
      columns: [
        { id: "c1", label: "Observed (o)" },
        { id: "c2", label: "Expected (e)" },
      ],
      rows: [
        { id: "r1", label: "Middle" },
        { id: "r2", label: "**Total**" },
      ],
      corner: "Chamber position",
      cell_keys: { r1: { c1: "12" } },
    },
  },
]).returning({ id: items.id, position: items.position });

// E5 slice 2: one stimulus shared by positions 2–3 (the multi-select and the
// short-text — the fixture's Index constants stay put). A fixed id keeps the
// committed file stable. own_page so the client's fallback-to-inline is what
// the fixture exercises.
const FIXTURE_SET_ID = "55555555-5555-4555-8555-555555555555";
await db.insert(item_sets).values({
  id: FIXTURE_SET_ID,
  assessment_id: a.id,
  stimulus_text:
    "Cells at work: ![cell diagram](asset:33333333-3333-4333-8333-333333333333) Use the diagram for the next two questions.",
  layout: "own_page",
});
await db
  .update(items)
  .set({ item_set_id: FIXTURE_SET_ID })
  .where(inArray(items.id, seededItems.filter((r) => r.position === 2 || r.position === 3).map((r) => r.id)));

// Slice 62: the route requires a student principal now, so the fixture is built
// through the same builder the route calls rather than by faking a session. A
// real roster student with real accommodation rows, so the fixture exercises the
// effective-accommodations resolver rather than a hand-written map.
const [student] = await db
  .insert(students)
  .values({
    owner_sub: "fixture-teacher",
    ssid: "WA-FIXTURE",
    roster_ps_id: "fixture-ps-id",
    name: "Fixture Student",
  })
  .returning();
if (!student) throw new Error("no student");

await db.insert(student_accommodations).values([
  {
    student_id: student.id,
    subject: "ELA-CAT",
    tool_id: "spell_check",
    value: "On",
    source: "tide_import",
  },
  {
    student_id: student.id,
    subject: "ELA-CAT",
    tool_id: "color_contrast",
    value: "Black on Rose",
    source: "tide_import",
  },
  {
    // Off in TIDE — present as a row, but not an entitlement, so it must not
    // reach the bundle.
    student_id: student.id,
    subject: "ELA-CAT",
    tool_id: "highlighter",
    value: "Off",
    source: "tide_import",
  },
]);

// Slice 64: match/order ids are sealed per ATTEMPT, so the fixture needs one.
// A fixed attempt id keeps the committed file stable across regenerations —
// derived ids would otherwise change every run and produce a noisy diff.
const FIXTURE_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
await db.insert(attempts).values({
  id: FIXTURE_ATTEMPT_ID,
  assessment_id: a.id,
  student_id: student.id,
  status: "in_progress",
});

const accommodations = await resolveEffectiveAccommodations(db, a, student.id);
type Identified = { id: string };
type FixtureBundle = {
  items: { type: string; rights?: Identified[]; entries?: Identified[] }[];
};
const { bundle: built } = await buildDeliveryBundle(db,
  a,
  accommodations,
  FIXTURE_ATTEMPT_ID,
    student.id,
  );
const bundle = built as FixtureBundle;

// The route shuffles match rights and order entries. A fixture that changed on
// every regeneration would produce noisy diffs and unstable tests, so sort them
// by id here. The shuffle itself is asserted in design-tool's own route tests.
for (const item of bundle.items) {
  item.rights?.sort((x, y) => x.id.localeCompare(y.id));
  item.entries?.sort((x, y) => x.id.localeCompare(y.id));
}

writeFileSync(OUT, JSON.stringify(bundle, null, 2) + "\n");
console.log(`wrote ${OUT} (${bundle.items.length} items)`);

await db.execute(sql`truncate table assessments restart identity cascade`);
await db.execute(sql`truncate table assets restart identity cascade`);
await db.execute(sql`truncate table students restart identity cascade`);
await closeDb();
