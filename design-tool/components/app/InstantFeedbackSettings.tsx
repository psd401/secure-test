"use client";

import { useState } from "react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ReleaseAnswersControl } from "@/components/app/ReleaseAnswersControl";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import {
  ANSWERS_RELEASE_OPTIONS,
  FEEDBACK_LEVEL_OPTIONS,
  FEEDBACK_ON_RELEASE_NOTE,
  FEEDBACK_WHEN_NOTE,
  canReleaseAnswers,
  feedbackLevelLine,
  feedbackSettingsBody,
  showsAnswersReleaseChoice,
  showsReleasedLine,
  type AnswersReleaseSetting,
  type FeedbackLevelSetting,
} from "@/lib/feedback/settingsUi";

/**
 * Settings tab: "Instant feedback at hand-in" (docs/instant-feedback-design.md,
 * D-1 / D-4). Unlike the rest of the tab this is NOT locked while Published —
 * a teacher may turn answers on after the last period — so each change saves
 * at once with a PATCH carrying only these two fields (the server's
 * `isFeedbackSettingsOnlyPatch` door through the publish lock).
 */
export function InstantFeedbackSettings({
  assessmentId,
  initialLevel,
  initialRelease,
  initialReleasedAt,
  onSaved,
}: {
  assessmentId: string;
  initialLevel: FeedbackLevelSetting;
  initialRelease: AnswersReleaseSetting;
  /** ISO instant or null. */
  initialReleasedAt: string | null;
  onSaved?: () => void;
}) {
  const [level, setLevel] = useState<FeedbackLevelSetting>(initialLevel);
  const [release, setRelease] = useState<AnswersReleaseSetting>(initialRelease);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  async function persist(nextLevel: FeedbackLevelSetting, nextRelease: AnswersReleaseSetting) {
    const prev = { level, release };
    setLevel(nextLevel);
    setRelease(nextRelease);
    setSave({ kind: "saving" });
    try {
      const res = await fetch(`/api/assessments/${assessmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(feedbackSettingsBody(nextLevel, nextRelease)),
      });
      if (!res.ok) {
        setLevel(prev.level);
        setRelease(prev.release);
        setSave({ kind: "failed", message: "Couldn't save that. Try again." });
        return;
      }
      setSave({ kind: "saved", at: new Date() });
      onSaved?.();
    } catch {
      setLevel(prev.level);
      setRelease(prev.release);
      setSave({
        kind: "failed",
        message: "Couldn't reach the server. Check your connection and try again.",
      });
    }
  }

  const saving = save.kind === "saving";
  const canRelease = canReleaseAnswers(level, release, initialReleasedAt);

  return (
    <div className="border-t border-border pt-4">
      <label className="block">
        <span className="block text-sm font-medium">Instant feedback at hand-in</span>
        <NativeSelect
          size="sm"
          value={level}
          disabled={saving}
          onChange={(e) => void persist(e.target.value as FeedbackLevelSetting, release)}
          className="mt-1"
        >
          {FEEDBACK_LEVEL_OPTIONS.map((o) => (
            <NativeSelectOption key={o.value} value={o.value}>
              {o.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="block text-xs text-muted-foreground">{feedbackLevelLine(level)}</span>
      </label>

      {showsAnswersReleaseChoice(level) ? (
        <label className="mt-3 block">
          <span className="block text-sm font-medium">Show correct answers</span>
          <NativeSelect
            size="sm"
            value={release}
            disabled={saving}
            onChange={(e) => void persist(level, e.target.value as AnswersReleaseSetting)}
            className="mt-1"
          >
            {ANSWERS_RELEASE_OPTIONS.map((o) => (
              <NativeSelectOption key={o.value} value={o.value}>
                {o.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {release === "on_release" ? (
            <span className="block text-xs text-muted-foreground">{FEEDBACK_ON_RELEASE_NOTE}</span>
          ) : null}
        </label>
      ) : null}

      <div className="mt-2 flex items-center gap-3">
        <StatusLine state={save} />
      </div>

      {canRelease || showsReleasedLine(level, initialReleasedAt) ? (
        <div className="mt-3">
          <ReleaseAnswersControl
            assessmentId={assessmentId}
            releasedAt={initialReleasedAt}
            onReleased={onSaved}
          />
        </div>
      ) : null}

      {level !== "off" ? (
        <p className="mt-2 text-xs text-muted-foreground">{FEEDBACK_WHEN_NOTE}</p>
      ) : null}
    </div>
  );
}
