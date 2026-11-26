ALTER TABLE "attempt_events" DROP CONSTRAINT "attempt_events_kind_check";--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "time_limit_mode" text DEFAULT 'working' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "working_seconds" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "last_tick_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "extension_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_time_limit_mode_check" CHECK (time_limit_mode IN ('working', 'wall'));--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_kind_check" CHECK (kind IN ('quit', 'emergency_exit', 'focus_loss', 'focus_regained', 'lockdown_begin', 'lockdown_end', 'lockdown_failed', 'lockdown_interrupted', 'client_error', 'time_expired', 'sitting_closed', 'speech_preflight', 'teacher_hand_in', 'deadline_extended', 'passed_back', 'gradebook_sent', 'score_changed', 'feedback_shown', 'answer_restored', 'feedback_edited', 'clock_gap'));--> statement-breakpoint
-- Working-time clock (docs/working-time-clock-design.md), D6: in-progress
-- attempts on timed tests get credit for time already spent. Each session is a
-- lockdown_begin up to the first end-type event after it (lockdown_end,
-- time_expired, sitting_closed, lockdown_interrupted) before the next begin;
-- a session with no end event runs to the attempt's last answer save in that
-- window, else counts nothing. An attempt with no lockdown_begin at all keeps
-- the clock time it has had (now - started_at, capped at the limit), so no
-- student gains time from missing events.
WITH timed AS (
  SELECT at.id AS attempt_id, at.started_at, a.time_limit_seconds AS limit_s
  FROM attempts at JOIN assessments a ON a.id = at.assessment_id
  WHERE at.status = 'in_progress' AND COALESCE(a.time_limit_seconds, 0) > 0
), begins AS (
  SELECT e.attempt_id, e.at AS began,
         LEAD(e.at) OVER (PARTITION BY e.attempt_id ORDER BY e.at) AS next_begin
  FROM attempt_events e JOIN timed t ON t.attempt_id = e.attempt_id
  WHERE e.kind = 'lockdown_begin'
), sessions AS (
  SELECT b.attempt_id, b.began,
    COALESCE(
      (SELECT MIN(x.at) FROM attempt_events x
        WHERE x.attempt_id = b.attempt_id
          AND x.kind IN ('lockdown_end', 'time_expired', 'sitting_closed', 'lockdown_interrupted')
          AND x.at > b.began AND (b.next_begin IS NULL OR x.at < b.next_begin)),
      (SELECT MAX(r.updated_at) FROM responses r
        WHERE r.attempt_id = b.attempt_id
          AND r.updated_at > b.began AND (b.next_begin IS NULL OR r.updated_at < b.next_begin)),
      b.began
    ) AS ended
  FROM begins b
), spent AS (
  SELECT attempt_id, SUM(EXTRACT(EPOCH FROM (ended - began))) AS seconds
  FROM sessions GROUP BY attempt_id
)
UPDATE attempts at SET working_seconds = COALESCE(
  (SELECT s.seconds FROM spent s WHERE s.attempt_id = at.id),
  LEAST(EXTRACT(EPOCH FROM (now() - t.started_at)), t.limit_s)
)
FROM timed t WHERE t.attempt_id = at.id;
--> statement-breakpoint
-- Q1: an extension granted under the wall clock (an absolute end time) becomes
-- extra seconds on the working-time limit, so no extended student loses time:
-- the seconds the override added past `started_at + limit`.
UPDATE attempts at SET extension_seconds = GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
  at.deadline_override_at - (at.started_at + make_interval(secs => a.time_limit_seconds))
))))::integer
FROM assessments a
WHERE a.id = at.assessment_id AND at.status = 'in_progress'
  AND at.deadline_override_at IS NOT NULL AND COALESCE(a.time_limit_seconds, 0) > 0;
