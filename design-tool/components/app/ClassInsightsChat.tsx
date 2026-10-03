"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ClaimCitations } from "@/components/app/ClaimCitations";
import {
  CHAT_DELETE_CONFIRM,
  CHAT_HEADING,
  CHAT_INTRO,
  CHAT_MAX_CHARS,
  CHAT_STALE_NOTE,
  CHAT_STARTERS,
  chatErrorCopy,
  counterText,
  readAnswersText,
  sectionParam,
  turnsLeftText,
  type PanelTurn,
} from "@/lib/insights/panelCopy";

interface ChatPayload {
  ok?: boolean;
  error?: string;
  stage?: string;
  turns?: PanelTurn[];
  turns_left?: number;
}

/**
 * Class insights slice 5 (docs/class-insights-design.md, D-4): the teacher's
 * own conversation about this section, under the report. The routes need
 * `edit`, so the panel renders this only for editors.
 */
export function ClassInsightsChat({
  assessmentId,
  section,
}: {
  assessmentId: string;
  section: string;
}) {
  const endpoint = `/api/assessments/${assessmentId}/class-insights/chat`;
  const [turns, setTurns] = useState<PanelTurn[]>([]);
  const [turnsLeft, setTurnsLeft] = useState<number>(40);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`${endpoint}?section=${encodeURIComponent(sectionParam(section))}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as ChatPayload | null;
        if (!live) return;
        if (body?.ok && body.turns) {
          setTurns(body.turns);
          if (typeof body.turns_left === "number") setTurnsLeft(body.turns_left);
        } else setError(chatErrorCopy(body?.error ?? ""));
        setLoaded(true);
      })
      .catch(() => {
        if (!live) return;
        setError(chatErrorCopy("network"));
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [endpoint, section]);

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ section: sectionParam(section), message }),
      });
      const body = (await res.json().catch(() => null)) as ChatPayload | null;
      if (body?.ok && body.turns) {
        const added = body.turns;
        setTurns((prev) => [...prev, ...added]);
        if (typeof body.turns_left === "number") setTurnsLeft(body.turns_left);
        setDraft("");
      } else {
        // The typed message stays so a retry is one click.
        setError(chatErrorCopy(body?.error ?? `http_${res.status}`, body?.stage));
      }
    } catch {
      setError(chatErrorCopy("network"));
    } finally {
      setSending(false);
    }
  }

  async function startNew() {
    setError(null);
    try {
      const res = await fetch(`${endpoint}?section=${encodeURIComponent(sectionParam(section))}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTurns([]);
      setTurnsLeft(40);
      setConfirming(false);
    } catch {
      setError(chatErrorCopy("network"));
    }
  }

  const full = turnsLeft === 0;
  const counter = counterText(draft.length);
  const left = turnsLeftText(turnsLeft);

  return (
    <div className="mt-8 space-y-3 border-t border-border pt-4" data-testid="class-insights-chat">
      <h3 id="class-insights-chat" className="text-base font-semibold">
        {CHAT_HEADING}
      </h3>
      <p className="text-sm text-muted-foreground">{CHAT_INTRO}</p>

      <div
        role="log"
        aria-live="polite"
        aria-labelledby="class-insights-chat"
        className="space-y-3"
      >
        {turns.map((t) => (
          <div
            key={t.position}
            data-role={t.role}
            className={
              t.role === "teacher"
                ? "ml-8 rounded-md bg-muted px-3 py-2 text-sm"
                : "mr-8 rounded-md border border-border px-3 py-2 text-sm"
            }
          >
            <div className={t.stale_turn ? "text-muted-foreground" : undefined}>
              <span className="sr-only">{t.role === "teacher" ? "You: " : "AI: "}</span>
              {t.text}
              {t.role === "assistant" ? (
                <ClaimCitations assessmentId={assessmentId} claim={t} />
              ) : null}
            </div>
            {t.stale_turn ? (
              <p className="mt-1 text-xs text-muted-foreground">{CHAT_STALE_NOTE}</p>
            ) : null}
            {t.role === "assistant" && readAnswersText(t.read_answers) ? (
              <p className="mt-1 text-xs text-muted-foreground">{readAnswersText(t.read_answers)}</p>
            ) : null}
          </div>
        ))}
        {sending ? (
          <p className="mr-8 text-sm text-muted-foreground" role="status">
            Thinking…
          </p>
        ) : null}
      </div>

      {loaded && turns.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {CHAT_STARTERS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => {
                setDraft(s);
                inputRef.current?.focus();
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="class-insights-chat-input" className="sr-only">
          Your question about this class
        </label>
        <Textarea
          id="class-insights-chat-input"
          ref={inputRef}
          value={draft}
          maxLength={CHAT_MAX_CHARS}
          rows={2}
          disabled={sending || full}
          placeholder="Ask a question about this class"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={() => void send()}
            disabled={sending || full || draft.trim() === ""}
          >
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {sending ? "Thinking…" : "Send"}
          </Button>
          {turns.length > 0 && !confirming ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => setConfirming(true)}
            >
              Start a new conversation
            </Button>
          ) : null}
          {counter ? <span className="text-xs text-muted-foreground">{counter}</span> : null}
          {left ? <span className="text-xs text-muted-foreground">{left}</span> : null}
        </div>
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" role="alertdialog" aria-label="Start a new conversation">
            <span>{CHAT_DELETE_CONFIRM}</span>
            <Button type="button" size="sm" variant="destructive" onClick={() => void startNew()}>
              Delete and start new
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
