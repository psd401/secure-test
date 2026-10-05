import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  google_doc_folders,
  google_doc_releases,
  item_sets,
  items,
  responses,
  scores,
  type AssessmentRow,
} from "@/db/schema";
import { rubricScoreRows } from "@/lib/reporting/rubricScoreView";
import { openAlertCountsByAttempt } from "@/lib/safeguarding/alertQueries";
import { buildResults, type ResultsRow } from "@/lib/scoring/results";
import {
  buildDocHtml,
  docTitle,
  type EssaySection,
  type ReleaseContents,
} from "@/lib/googleDocs/content";
import { DriveAuthError, DriveError, docUrl, type DriveClient } from "@/lib/googleDocs/drive";

// Row GD slice 3 (docs/google-docs-release-design.md): one Google Doc per
// student per assessment (D-10), holding every essay, in the sender's Drive
// under secure-test / <assessment> / <section> (D-4), shared with the student
// as editor (D-1). Skips are decided before anything touches Drive, so a send
// where everyone is skipped creates no folders.

type Db = ReturnType<typeof getDb>;

export const ROOT_FOLDER_NAME = "secure-test";
export const NO_SECTION_FOLDER_NAME = "No section";
const CONCURRENCY = 3;

export type ReleaseScope = { section: string } | { attemptId: string };

export interface ReleaseOptions {
  contents: ReleaseContents;
  /** D-5: skip students who already have a Doc from this sender, or make a new one. */
  mode: "skip" | "new";
  /** D-12: include attempts not handed in yet. */
  includeDrafts: boolean;
  /** D-3 / slice 5: hand each Doc's ownership to its student. */
  transferOwnership?: boolean;
}

export type SkipReason =
  | "not_handed_in"
  | "already_released"
  | "safeguarding_alert"
  | "no_email"
  | "no_essay"
  | "drive_auth_expired";

export interface StudentOutcome {
  attempt_id: string;
  name: string;
  status: "sent" | "skipped" | "failed";
  reason?: SkipReason | string;
  url?: string;
  /** Slice 5, only when ownership transfer was asked for. A failed transfer
   * leaves the Doc shared as editor; `ownership_error` carries Drive's code. */
  ownership?: "transferred" | "not_transferred";
  ownership_error?: string;
}

export type ReleaseResult =
  | { ok: true; outcomes: StudentOutcome[]; drive_auth_needed: boolean }
  | { ok: false; error: "no_essays" | "attempt_not_found" };

function studentName(row: ResultsRow): string {
  return row.student.name || row.student.student_number || "Student";
}

async function ensureFolder(
  db: Db,
  drive: DriveClient,
  ownerSub: string,
  scopeKey: string,
  assessmentId: string | null,
  name: string,
  parentId: string | null,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(google_doc_folders)
    .where(and(eq(google_doc_folders.owner_sub, ownerSub), eq(google_doc_folders.scope_key, scopeKey)))
    .limit(1);
  if (existing && (await drive.folderUsable(existing.drive_folder_id))) {
    return existing.drive_folder_id;
  }
  // Missing, deleted or trashed in Drive: make it again and remember the new id.
  const folderId = await drive.createFolder(name, parentId);
  await db
    .insert(google_doc_folders)
    .values({ owner_sub: ownerSub, scope_key: scopeKey, assessment_id: assessmentId, drive_folder_id: folderId })
    .onConflictDoUpdate({
      target: [google_doc_folders.owner_sub, google_doc_folders.scope_key],
      set: { drive_folder_id: folderId },
    });
  return folderId;
}

export async function releaseToGoogleDocs(
  db: Db,
  args: {
    assessment: AssessmentRow;
    senderSub: string;
    scope: ReleaseScope;
    options: ReleaseOptions;
    drive: DriveClient;
    now?: Date;
  },
): Promise<ReleaseResult> {
  const { assessment, senderSub, scope, options, drive } = args;
  const now = args.now ?? new Date();

  const essayItems = await db
    .select()
    .from(items)
    .where(and(eq(items.assessment_id, assessment.id), eq(items.type, "essay")))
    .orderBy(asc(items.position));
  if (essayItems.length === 0) return { ok: false, error: "no_essays" };

  const allItems = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.assessment_id, assessment.id))
    .orderBy(asc(items.position));
  const numberOf = new Map(allItems.map((it, i) => [it.id, i + 1]));

  // Practice attempts stay out (buildResults' default), as on every class reader.
  const results = await buildResults(assessment.id, { include_in_progress: true });
  let rows: ResultsRow[];
  if ("attemptId" in scope) {
    const one = results.rows.find((r) => r.attempt_id === scope.attemptId);
    if (!one) return { ok: false, error: "attempt_not_found" };
    rows = [one];
  } else {
    rows = results.rows.filter((r) => r.student.section === scope.section);
  }
  rows.sort((a, b) => studentName(a).localeCompare(studentName(b)));

  const attemptIds = rows.map((r) => r.attempt_id);
  const essayIds = essayItems.map((i) => i.id);
  const responseRows =
    attemptIds.length > 0
      ? await db
          .select()
          .from(responses)
          .where(and(inArray(responses.attempt_id, attemptIds), inArray(responses.item_id, essayIds)))
      : [];
  const responseByCell = new Map(responseRows.map((r) => [`${r.attempt_id}:${r.item_id}`, r]));

  const finalScores =
    responseRows.length > 0
      ? await db
          .select()
          .from(scores)
          .where(
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              eq(scores.status, "final"),
            ),
          )
      : [];
  const scoreByResponse = new Map(finalScores.map((s) => [s.response_id, s]));

  const openAlerts = await openAlertCountsByAttempt(db, attemptIds);

  const priorReleases =
    options.mode === "skip" && attemptIds.length > 0
      ? await db
          .select({ attempt_id: google_doc_releases.attempt_id })
          .from(google_doc_releases)
          .where(
            and(
              inArray(google_doc_releases.attempt_id, attemptIds),
              eq(google_doc_releases.sender_sub, senderSub),
            ),
          )
      : [];
  const released = new Set(priorReleases.map((r) => r.attempt_id));

  const setIds = [...new Set(essayItems.map((i) => i.item_set_id).filter((x): x is string => !!x))];
  const setRows =
    setIds.length > 0 ? await db.select().from(item_sets).where(inArray(item_sets.id, setIds)) : [];
  const setsById = new Map(setRows.map((s) => [s.id, s]));

  // ── Decide every student before Drive is touched.
  const outcomes: StudentOutcome[] = [];
  const toSend: Array<{ row: ResultsRow; essays: EssaySection[] }> = [];
  for (const row of rows) {
    const base = { attempt_id: row.attempt_id, name: studentName(row) };
    const skip = (reason: SkipReason) => outcomes.push({ ...base, status: "skipped", reason });
    if (row.status !== "submitted" && !options.includeDrafts) {
      skip("not_handed_in");
      continue;
    }
    // D-6: any open alert on the attempt holds the whole Doc back (D-10).
    if ((openAlerts.get(row.attempt_id) ?? 0) > 0) {
      skip("safeguarding_alert");
      continue;
    }
    if (!row.student.email) {
      skip("no_email");
      continue;
    }
    if (released.has(row.attempt_id)) {
      skip("already_released");
      continue;
    }
    const essays: EssaySection[] = [];
    const setShown = new Set<string>();
    let anyText = false;
    for (const item of essayItems) {
      const resp = responseByCell.get(`${row.attempt_id}:${item.id}`);
      const text =
        resp && resp.response.type === "essay" && resp.response.text.trim() ? resp.response.text : null;
      if (text) anyText = true;
      const set = item.item_set_id ? setsById.get(item.item_set_id) : undefined;
      const firstOfSet = set ? !setShown.has(set.id) : false;
      if (set) setShown.add(set.id);
      const score = resp ? scoreByResponse.get(resp.id) : undefined;
      const rationale = score?.rationale as Record<string, unknown> | null | undefined;
      const rubric = item.config.rubric ?? score?.rubric_snapshot ?? null;
      essays.push({
        number: numberOf.get(item.id) ?? 0,
        stem: item.stem,
        stimulus: firstOfSet && set ? set.stimulus_text : null,
        sources: firstOfSet && set ? set.sources.map((s) => ({ label: s.label, text: s.text })) : [],
        answer: text,
        score: score
          ? {
              points: score.points,
              max_points: score.max_points,
              teacher_note: typeof rationale?.note === "string" && rationale.note.trim() ? rationale.note : null,
              criteria: rubricScoreRows(rubric, rationale).map((c) => ({
                name: c.criterion_name,
                level: c.level_label,
                points: c.points,
                rationale: c.rationale,
              })),
              ai_overall:
                typeof rationale?.overall_rationale === "string" && rationale.overall_rationale.trim()
                  ? rationale.overall_rationale
                  : null,
              from_ai: score.method === "ai",
            }
          : null,
      });
    }
    if (!anyText) {
      skip("no_essay");
      continue;
    }
    toSend.push({ row, essays });
  }
  if (toSend.length === 0) return { ok: true, outcomes, drive_auth_needed: false };

  // ── Folders: secure-test / <assessment> / <section>, made once per send.
  let authLost = false;
  const sectionFolders = new Map<string, string>();
  let assessmentFolder: string;
  try {
    const root = await ensureFolder(db, drive, senderSub, "root", null, ROOT_FOLDER_NAME, null);
    assessmentFolder = await ensureFolder(
      db,
      drive,
      senderSub,
      `a:${assessment.id}`,
      assessment.id,
      assessment.name,
      root,
    );
    for (const { row } of toSend) {
      const label = row.student.section ?? "";
      if (sectionFolders.has(label)) continue;
      sectionFolders.set(
        label,
        await ensureFolder(
          db,
          drive,
          senderSub,
          `a:${assessment.id}:s:${label}`,
          assessment.id,
          label || NO_SECTION_FOLDER_NAME,
          assessmentFolder,
        ),
      );
    }
  } catch (err) {
    if (!(err instanceof DriveAuthError)) throw err;
    for (const { row } of toSend) {
      outcomes.push({
        attempt_id: row.attempt_id,
        name: studentName(row),
        status: "skipped",
        reason: "drive_auth_expired",
      });
    }
    return { ok: true, outcomes, drive_auth_needed: true };
  }

  // ── One Doc per student, a few at a time.
  const queue = [...toSend];
  async function worker() {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { row, essays } = job;
      const base = { attempt_id: row.attempt_id, name: studentName(row) };
      if (authLost) {
        outcomes.push({ ...base, status: "skipped", reason: "drive_auth_expired" });
        continue;
      }
      const draft = row.status !== "submitted";
      const title = docTitle(studentName(row), assessment.name, now);
      try {
        const html = buildDocHtml({
          studentName: studentName(row),
          assessmentName: assessment.name,
          draftAsOf: draft ? now : null,
          essays,
          contents: options.contents,
        });
        const fileId = await drive.uploadDoc(title, sectionFolders.get(row.student.section ?? "")!, html);
        const permissionId = await drive.shareWriter(fileId, row.student.email!);
        // Slice 5: the Doc is already shared, so a failed transfer is
        // reported, never a failed send.
        let ownership: Pick<StudentOutcome, "ownership" | "ownership_error"> = {};
        if (options.transferOwnership) {
          try {
            await drive.transferOwnership(fileId, permissionId);
            ownership = { ownership: "transferred" };
          } catch (err) {
            if (err instanceof DriveAuthError) authLost = true;
            else if (!(err instanceof DriveError)) throw err;
            ownership = {
              ownership: "not_transferred",
              ownership_error: err instanceof DriveError ? err.code : "drive_auth_expired",
            };
          }
        }
        await db.insert(google_doc_releases).values({
          attempt_id: row.attempt_id,
          sender_sub: senderSub,
          drive_file_id: fileId,
          title,
          contents: { ...options.contents },
          was_draft: draft,
          ownership_transferred_at: ownership.ownership === "transferred" ? new Date() : null,
        });
        outcomes.push({ ...base, status: "sent", url: docUrl(fileId), ...ownership });
      } catch (err) {
        if (err instanceof DriveAuthError) {
          authLost = true;
          outcomes.push({ ...base, status: "skipped", reason: "drive_auth_expired" });
        } else if (err instanceof DriveError) {
          outcomes.push({ ...base, status: "failed", reason: err.code });
        } else {
          throw err;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toSend.length) }, worker));

  const order = new Map(rows.map((r, i) => [r.attempt_id, i]));
  outcomes.sort((a, b) => (order.get(a.attempt_id) ?? 0) - (order.get(b.attempt_id) ?? 0));
  return { ok: true, outcomes, drive_auth_needed: authLost };
}
