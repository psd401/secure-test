import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { getDb } from "@/db/client";
import {
  attempt_feedback,
  google_doc_folders,
  google_doc_releases,
  item_sets,
  items,
  response_feedback,
  responses,
  scores,
  type AssessmentRow,
  type ScoreRow,
} from "@/db/schema";
import {
  buildFeedbackRelease,
  type FeedbackBlock,
  type FeedbackQuestionInput,
} from "@/lib/reporting/feedbackRelease";
import { openAlertCountsByAttempt } from "@/lib/safeguarding/alertQueries";
import { buildResults, type ResultsRow } from "@/lib/scoring/results";
import {
  buildDocHtml,
  docTitle,
  type EssaySection,
  type ReleaseContents,
} from "@/lib/googleDocs/content";
import { essayRichHtml } from "@/lib/richText/renderEssayAnswer";
import { DriveAuthError, DriveError, docUrl, type DriveClient } from "@/lib/googleDocs/drive";
import { PRODUCT_NAME } from "@/lib/brand";

// Row GD slice 3 (docs/google-docs-release-design.md): one Google Doc per
// student per assessment (D-10), holding every essay, in the sender's Drive
// under SecureTest / <assessment> / <section> (D-4), shared with the student
// as editor (D-1). Skips are decided before anything touches Drive, so a send
// where everyone is skipped creates no folders.

type Db = ReturnType<typeof getDb>;

// Row NM (3.1): a teacher's first send (or one whose root was deleted in
// Drive) makes the folder under the product name; an existing root is found
// by its stored id and keeps its old name.
export const ROOT_FOLDER_NAME = PRODUCT_NAME;
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
  /** RT D-10 (docs/rich-text-essay-design.md): essays at line spacing 2.0. */
  doubleSpace?: boolean;
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

  // FR slice 3: every non-research row, not just the final — D-10's AI
  // feedback comes from the AI's own row, which after an override is a
  // proposal. The builder picks the final and the AI row itself.
  const responseIds = responseRows.map((r) => r.id);
  const scoreRows =
    responseIds.length > 0
      ? await db
          .select()
          .from(scores)
          .where(and(inArray(scores.response_id, responseIds), ne(scores.status, "research")))
      : [];
  const scoresByResponse = new Map<string, ScoreRow[]>();
  for (const s of scoreRows) {
    const list = scoresByResponse.get(s.response_id) ?? [];
    list.push(s);
    scoresByResponse.set(s.response_id, list);
  }

  // FR R-1 / D-4: the teacher's own comments. Student-record content — read
  // only into the Doc, never logged (D-14).
  const questionFeedback =
    responseIds.length > 0
      ? await db
          .select({ response_id: response_feedback.response_id, text: response_feedback.text })
          .from(response_feedback)
          .where(inArray(response_feedback.response_id, responseIds))
      : [];
  const feedbackByResponse = new Map(questionFeedback.map((f) => [f.response_id, f.text]));
  const overallFeedback =
    attemptIds.length > 0
      ? await db
          .select({ attempt_id: attempt_feedback.attempt_id, text: attempt_feedback.text })
          .from(attempt_feedback)
          .where(inArray(attempt_feedback.attempt_id, attemptIds))
      : [];
  const feedbackByAttempt = new Map(overallFeedback.map((f) => [f.attempt_id, f.text]));

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
  const toSend: Array<{ row: ResultsRow; essays: EssaySection[]; overall: FeedbackBlock | null }> = [];
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
    const questions: Array<FeedbackQuestionInput<ScoreRow>> = [];
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
      const rowsHere = resp ? (scoresByResponse.get(resp.id) ?? []) : [];
      questions.push({
        rubric:
          item.config.rubric ??
          rowsHere.find((r) => r.status === "final")?.rubric_snapshot ??
          rowsHere.find((r) => r.rubric_snapshot)?.rubric_snapshot ??
          null,
        scores: rowsHere,
        // FR slice 1: never `rationale.note` (a score-change reason); the
        // teacher's comment is its own row (R-1).
        teacher_feedback: resp ? (feedbackByResponse.get(resp.id) ?? null) : null,
        // D-10: an AI proposal left over from before a pass-back is about the
        // old answer; the builder drops AI rows older than the last edit.
        answer_updated_at: resp ? resp.updated_at : null,
      });
      essays.push({
        number: numberOf.get(item.id) ?? 0,
        stem: item.stem,
        stimulus: firstOfSet && set ? set.stimulus_text : null,
        sources: firstOfSet && set ? set.sources.map((s) => ({ label: s.label, text: s.text })) : [],
        answer: text,
        // RT slice 2: a formatted essay goes into the Doc formatted — its
        // stored html re-cleaned here (essayRichHtml), then mapped to
        // Docs-friendly tags by buildDocHtml.
        answer_html: text && resp ? essayRichHtml(resp.response) : null,
        feedback: [],
      });
    }
    if (!anyText) {
      skip("no_essay");
      continue;
    }
    // FR R-3: the labelled blocks for the boxes ticked (D-3, D-10, D-13, R-2).
    const release = buildFeedbackRelease(options.contents, {
      questions,
      overall_teacher_feedback: feedbackByAttempt.get(row.attempt_id) ?? null,
    });
    release.questions.forEach((blocks, i) => {
      essays[i]!.feedback = blocks;
    });
    toSend.push({ row, essays, overall: release.overall });
  }
  if (toSend.length === 0) return { ok: true, outcomes, drive_auth_needed: false };

  // ── Folders: SecureTest / <assessment> / <section>, made once per send.
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
      const { row, essays, overall } = job;
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
          overall,
          contents: options.contents,
          doubleSpace: options.doubleSpace ?? false,
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
