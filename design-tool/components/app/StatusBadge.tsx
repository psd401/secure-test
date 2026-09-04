import type { ComponentProps } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §1.2 "status colours", §2.2): the
 * closed vocabulary a teacher sees for an assessment, a test session and a
 * student, each as icon + word on a tint. The wire/DB values are untouched;
 * only the label changes here. Colour never carries the state alone.
 */

type Variant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const ASSESSMENT: Record<string, { label: string; variant: Variant }> = {
  draft: { label: "Draft", variant: "neutral" },
  published: { label: "Published", variant: "success" },
};

export function AssessmentStatusBadge({ status }: { status: string }) {
  const s = ASSESSMENT[status] ?? { label: status, variant: "neutral" as Variant };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/**
 * A session is "open" only while its window is still running; a row whose
 * status is still `open` past `expires_at` reads as Ended (time up).
 */
export type SessionState = "open" | "closed" | "ended";

export function sessionState(
  s: { status: string; expires_at: string | Date },
  now: number = Date.now(),
): SessionState {
  if (s.status === "closed") return "closed";
  const exp = s.expires_at instanceof Date ? s.expires_at.getTime() : Date.parse(s.expires_at);
  return exp > now ? "open" : "ended";
}

const SESSION: Record<SessionState, { label: string; variant: Variant; Icon: typeof CircleDot }> = {
  open: { label: "Open", variant: "success", Icon: CircleDot },
  closed: { label: "Closed", variant: "neutral", Icon: CircleDashed },
  ended: { label: "Ended (time up)", variant: "neutral", Icon: CircleDashed },
};

export function SessionStatusBadge({ state }: { state: SessionState }) {
  const s = SESSION[state];
  return (
    <Badge variant={s.variant}>
      <s.Icon aria-hidden />
      {s.label}
    </Badge>
  );
}

/** Student states on the monitor and attendance surfaces (slices 6–7). */
export type StudentState = "not_joined" | "in_progress" | "idle" | "handed_in" | "needs_attention";

const STUDENT: Record<StudentState, { label: string; variant: Variant; Icon: typeof CircleDot }> = {
  not_joined: { label: "Not joined", variant: "neutral", Icon: CircleDashed },
  in_progress: { label: "In progress", variant: "info", Icon: PlayCircle },
  idle: { label: "Idle", variant: "warning", Icon: PauseCircle },
  handed_in: { label: "Handed in", variant: "success", Icon: CheckCircle2 },
  needs_attention: { label: "Needs attention", variant: "danger", Icon: AlertTriangle },
};

export function StudentStatusBadge({
  state,
  detail,
}: {
  state: StudentState;
  /** Appended after the label, e.g. "12 min" for Idle. */
  detail?: string;
}) {
  const s = STUDENT[state];
  return (
    <Badge variant={s.variant}>
      <s.Icon aria-hidden />
      {detail ? `${s.label} ${detail}` : s.label}
    </Badge>
  );
}
