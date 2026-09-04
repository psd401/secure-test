# Roster extract — the file contract between the PSD warehouse and secure-test

Status: **draft for the data engineer, 2026-08-26** (ADR 0017, slice 75). This is the
whole interface. secure-test never reads the warehouse's tables; it reads
these files. Anything not in this document is not relied on.

The code that enforces it is `design-tool/lib/roster/extract.ts`; a fictional
example that passes every check is `design-tool/test/fixtures/roster/complete/`.

## Shape

One snapshot = one S3 prefix holding five objects:

```
s3://<bucket>/roster/<snapshot_id>/manifest.json
s3://<bucket>/roster/<snapshot_id>/students.csv
s3://<bucket>/roster/<snapshot_id>/sections.csv
s3://<bucket>/roster/<snapshot_id>/section_teachers.csv
s3://<bucket>/roster/<snapshot_id>/enrollments.csv
```

Write the four CSVs first and `manifest.json` **last** — the manifest's
arrival is the trigger (slice 76), and it is what says the other four are
complete.

- `snapshot_id`: any `[A-Za-z0-9._:-]{1,64}`; a UTC timestamp such as
  `20260901T083000Z` is the suggestion. It is the folder name, the manifest
  field, and the value stamped on every imported row.
- Bucket and prefix: settled in slice 76 (`design-tool/infra`); account
  `<account-id>`, us-west-2. The data engineer receives a single put-only IAM principal
  or role to assume — details with the bucket.
- Cadence: nightly is the design assumption (ADR 0017 — "if the warehouse is
  late one night, secure-test runs on yesterday's roster"). Exact time: open
  question 3.1 in `docs/phase-6-slices.md`.

## manifest.json

```json
{
  "format_version": 1,
  "snapshot_id": "20260901T083000Z",
  "generated_at": "2026-09-01T08:30:00Z",
  "source": "psd_warehouse.ai_workspace",
  "files": {
    "students":         { "path": "students.csv",         "rows": 9312,  "sha256": "<64 hex>" },
    "sections":         { "path": "sections.csv",         "rows": 2140,  "sha256": "<64 hex>" },
    "section_teachers": { "path": "section_teachers.csv", "rows": 2388,  "sha256": "<64 hex>" },
    "enrollments":      { "path": "enrollments.csv",      "rows": 41077, "sha256": "<64 hex>" }
  }
}
```

- `files` may be the map above, keyed by table, **or a list** of the same
  `{path, rows, sha256}` entries — the warehouse DAG writes the list form
  (2026-08-27). In the list form the file name identifies the table
  (`students.csv`, `sections.csv`, `section_teachers.csv`, `enrollments.csv`);
  any other name, a duplicate, or a missing table refuses the snapshot.
- `format_version` is literally `1`. A future breaking change bumps it and
  the importer refuses the version it does not know.
- `path` is a bare file name (no directories) inside the snapshot prefix.
- `rows` is the number of **data** rows, excluding the header line.
- `sha256` is the lowercase hex SHA-256 of the file's exact bytes.
- `generated_at` is RFC 3339 with a zone offset. `source` is free text, optional.

## The CSV files

All four: UTF-8, RFC 4180 (`"` quoting, `""` escape), a header line, LF or
CRLF, one file per table (`UNLOAD … PARALLEL OFF` if it comes from Redshift).
Column order does not matter — the header is read by name, case-insensitive.
Columns beyond the ones listed are ignored. A column listed here that is
absent refuses the extract.

"Required" below means the cell must be non-empty on every row. Everything
else may be empty, and an empty cell is stored as NULL.

Scope: **the current school year.** Every section, teacher assignment and
enrollment whose term falls in the current `school_years` row, plus every
student those enrollments reference (regardless of `enroll_status`). Rows
outside that window need not be sent; a row that was sent one night and is
absent the next is *deactivated* on our side, never deleted.

### students.csv

| column | required | from | notes |
|---|---|---|---|
| `ps_id` | yes | PowerSchool **student number** (the visible ID) | Confirmed 2026-08-27: the DAG sends the student number, not the internal `students.id`. Unique, stable across snapshots; an opaque join key on our side (`enrollments.student_ps_id`, the accommodations overlay's `roster_ps_id`) — never dereferenced as an internal id |
| `ssid` | no | PowerSchool `state_studentnumber` | **The column that does not exist in `ai_workspace.students` yet** (ADR 0017 "Depends on" #1). Send the column with empty cells until it does; accommodations from TIDE are keyed by it. |
| `email` | no | `students.email` | Google Workspace address. Matched case-insensitively; we lowercase. A student without one cannot sign in. |
| `first_name` | no | | |
| `last_name` | no | | |
| `grade` | no | `grade_level` | as text; "K" or "0" both fine |
| `school_id` | no | `schoolid` | |
| `enroll_status` | yes | `enroll_status` | integer as PowerSchool defines it (0 active, -1 pre-registered, 1 inactive, 2 transferred, 3 graduated, 4 imported) |

### sections.csv

| column | required | from |
|---|---|---|
| `ps_id` | yes | `sections.id`; unique |
| `school_id` | no | `sections.schoolid` |
| `course_code` | no | `sections.course_code` |
| `course_name` | no | `courses.course_name` (joined on `courseid`) — what teachers see |
| `term_id` | no | `sections.termid` |
| `period_expression` | no | `sections.period_expression` |

### section_teachers.csv

| column | required | from | notes |
|---|---|---|---|
| `section_ps_id` | yes | `section_teachers.sectionid` | must appear in `sections.csv` |
| `teacher_ps_id` | yes | `section_teachers.teacherid` | per-school teacher id |
| `teacher_email` | no | `teachers.email` (joined on `teacherid`) | the join to a signed-in staff account; lowercased on import Blank once a teacher separates — the warehouse only carries active staff; the row stays and the email empties on the next snapshot. Imported as null: that section leaves the teacher's "my sections", and a sitting scoped to it admits nobody until the section is reassigned (2026-08-27). |
| `role_name` | no | `section_teachers.role_name` | |
| `priority_order` | no | `section_teachers.priorityorder` | integer |
| `start_date` | yes | `section_teachers.start_date` | `YYYY-MM-DD` |
| `end_date` | yes | `section_teachers.end_date` | `YYYY-MM-DD`; PowerSchool gives a future date for a current assignment |

Key: (`section_ps_id`, `teacher_ps_id`, `start_date`) — unique within the file.

### enrollments.csv

| column | required | from | notes |
|---|---|---|---|
| `ps_id` | yes | `section_enrollments.id` | the CC record id; unique |
| `student_ps_id` | yes | `section_enrollments.studentid` | must appear in `students.csv` |
| `section_ps_id` | yes | `section_enrollments.sectionid` | must appear in `sections.csv` |
| `dateenrolled` | yes | `section_enrollments.dateenrolled` | `YYYY-MM-DD` |
| `dateleft` | yes | `section_enrollments.dateleft` | `YYYY-MM-DD`; the section's end date or the withdrawal date — always present |

Dates are calendar dates only. A timestamp (`2026-09-01 00:00:00`) refuses
the row's file — it is the sign the producing query picked the wrong column.

## What the importer does with it

1. Reads the manifest. Reads all four files. Checks every SHA-256 and every
   row count against the manifest. Parses every row. Checks keys are unique
   and that every reference (`student_ps_id`, `section_ps_id`) resolves within
   the same snapshot.
2. If **anything** in step 1 fails, nothing is written. The previous roster
   stays in force and a `roster_sync_runs` row records the reason as a code —
   e.g. `checksum_mismatch:students`, `row_count_mismatch:enrollments`,
   `empty_table:sections`, `invalid_row:students:3812` (a line number, never
   the line). A table with zero data rows is a failure by definition.
3. Otherwise, table by table (students → sections → section_teachers →
   enrollments), each in its own transaction: upsert every row by its key,
   then mark any row still active from an earlier snapshot as inactive.
   Nothing is deleted.
4. The same snapshot imported twice is a no-op the second time.

Whether a relationship holds *today* (a teacher's `end_date`, an enrollment's
`dateleft`) is decided at query time from the dates you send, not by the
importer — so send the dates as PowerSchool has them and let the window be
ours to interpret.

## How to check a snapshot before we do

```bash
for f in students sections section_teachers enrollments; do
  printf '%s rows=%s sha256=%s\n' "$f" "$(( $(wc -l < $f.csv) - 1 ))" "$(shasum -a 256 $f.csv | cut -d' ' -f1)"
done
```

Those four lines are what the manifest must say. The design tool's own test
suite (`design-tool/test/roster-extract.test.ts`) runs the same checks against
the fixture; pointing `loadExtract` at a real snapshot directory is the
quickest way to validate one offline.

## Open with the data engineer

- 3.1 Push to S3 from the MWAA DAG (this document assumes it), or a read-only
  Redshift role and we pull? Push is preferred (ADR 0017).
- 3.2 `ssid` — is `state_studentnumber` the right PowerSchool column, and when
  can `ai_workspace.students` carry it?
- Cadence and the time of night.
