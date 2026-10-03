"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  MAX_STANDARDS,
  addTag,
  chipLabel,
  counterpartLine,
  shortText,
  tagScheme,
} from "@/lib/standards/tags";

// BG slice 2 (docs/batch-item-generation-design.md §Standards tags, §Crosswalk):
// the "Standards" field under every question's stem. Tags are picked from the
// shipped catalog through /api/standards (the catalog JSON never reaches the
// browser) or typed as a teacher's own designation. The parent owns the value
// and saves it through the item's ordinary save path — no save button here.

type Scheme = "wa2026" | "ccss2010" | "ngss";
type Subject = "math" | "ela" | "science";

interface SearchResult {
  tag: string;
  scheme: Scheme;
  code: string;
  text: string;
  counterparts: { tag: string; code: string; scheme: Scheme }[];
}

interface SearchResponse {
  results: SearchResult[];
  exact: string | null;
  facets: { grade_bands: Record<Subject, string[]>; courses: string[] };
}

type LookupEntry = { code: string; scheme: Scheme; text: string } | null;

// ── Picker preferences: one per browser, shared by every item card ─────────
// localStorage can throw (private window, blocked site data) or come back
// empty; the picker works without it.

export interface Prefs {
  subject: Subject | "";
  gradeBand: string;
  course: string;
  prefer: "wa2026" | "ccss2010";
}

const PREFS_KEY = "secure-test.standards-picker";
const DEFAULT_PREFS: Prefs = { subject: "", gradeBand: "", course: "", prefer: "wa2026" };
let prefs: Prefs | null = null;
const prefListeners = new Set<() => void>();

export function readPrefs(): Prefs {
  if (prefs) return prefs;
  let stored: Partial<Prefs> = {};
  try {
    stored = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    stored = {};
  }
  prefs = {
    subject: stored.subject === "math" || stored.subject === "ela" || stored.subject === "science" ? stored.subject : "",
    gradeBand: typeof stored.gradeBand === "string" ? stored.gradeBand : "",
    course: typeof stored.course === "string" ? stored.course : "",
    prefer: stored.prefer === "ccss2010" ? "ccss2010" : "wa2026",
  };
  return prefs;
}

export function writePrefs(next: Prefs) {
  prefs = next;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; the choice still applies to this page.
  }
  for (const l of prefListeners) l();
}

function subscribePrefs(listener: () => void) {
  prefListeners.add(listener);
  return () => prefListeners.delete(listener);
}

// ── Shared caches: chip lookups and the filter facets, one fetch per page ──

const entryCache = new Map<string, LookupEntry>();
const inFlight = new Set<string>();
// Every mounted picker re-renders when any lookup lands — a card whose tags a
// sibling fetched needs the chip text too.
const lookupListeners = new Set<() => void>();
let facetsPromise: Promise<SearchResponse["facets"] | null> | null = null;

export function loadFacets() {
  facetsPromise ??= fetch("/api/standards?limit=1")
    .then((r) => (r.ok ? (r.json() as Promise<SearchResponse>) : null))
    .then((b) => b?.facets ?? null)
    .catch(() => null);
  return facetsPromise;
}

function searchUrl(q: string, p: Prefs, limit: number): string {
  const params = new URLSearchParams({ q, limit: String(limit), prefer: p.prefer });
  if (p.subject) params.set("subject", p.subject);
  if (p.subject && p.gradeBand) params.set("grade_band", p.gradeBand);
  if (p.subject === "math" && p.gradeBand === "HS" && p.course) params.set("course", p.course);
  return `/api/standards?${params.toString()}`;
}

type Option = { tag: string; code: string; text: string | null; second: string | null };

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  /** Tags already used elsewhere on this assessment — offered first. */
  suggestions: string[];
  disabled?: boolean;
}

export function StandardsTagInput({ value, onChange, suggestions, disabled }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const p = useSyncExternalStore(subscribePrefs, readPrefs, () => DEFAULT_PREFS);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [facets, setFacets] = useState<SearchResponse["facets"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setLookupTick] = useState(0);
  useEffect(() => {
    const bump = () => setLookupTick((n) => n + 1);
    lookupListeners.add(bump);
    return () => {
      lookupListeners.delete(bump);
    };
  }, []);
  const searchSeq = useRef(0);
  const atMax = value.length >= MAX_STANDARDS;

  useEffect(() => {
    let cancelled = false;
    void loadFacets().then((f) => {
      if (!cancelled) setFacets(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Chip text for catalog tags (this item's and the suggestions), deduped.
  const wanted = [...new Set([...value, ...suggestions])].filter(
    (t) => tagScheme(t) !== null && !entryCache.has(t) && !inFlight.has(t),
  );
  const wantedKey = wanted.join(",");
  useEffect(() => {
    if (!wantedKey) return;
    // Re-check at effect time: every card on the page renders before any of
    // their effects run, so a sibling (or Strict Mode's second run) may have
    // claimed these tags already — the module-level cache is shared.
    const tags = wantedKey
      .split(",")
      .filter((t) => !entryCache.has(t) && !inFlight.has(t))
      .slice(0, 20);
    if (tags.length === 0) return;
    for (const t of tags) inFlight.add(t);
    void fetch(`/api/standards/lookup?tags=${encodeURIComponent(tags.join(","))}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: Record<string, LookupEntry> }>) : null))
      .then((b) => {
        for (const t of tags) entryCache.set(t, b?.entries[t] ?? null);
      })
      .catch(() => {
        for (const t of tags) entryCache.set(t, null);
      })
      .finally(() => {
        for (const t of tags) inFlight.delete(t);
        for (const notify of lookupListeners) notify();
      });
  }, [wantedKey]);

  // Debounced search while the list is open (typing, or browsing a subject).
  const browse = query.trim() !== "" || p.subject !== "";
  useEffect(() => {
    if (!open || !browse) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void fetch(searchUrl(query, p, 20))
        .then((r) => (r.ok ? (r.json() as Promise<SearchResponse>) : null))
        .then((b) => {
          if (seq !== searchSeq.current || !b) return;
          for (const r of b.results) entryCache.set(r.tag, { code: r.code, scheme: r.scheme, text: r.text });
          setResults(b.results);
          setActive(-1);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [open, browse, query, p]);

  const options: Option[] = [];
  if (query.trim() === "") {
    for (const tag of suggestions) {
      if (value.includes(tag)) continue;
      const label = chipLabel(tag, entryCache.get(tag));
      options.push({ tag, code: label.code, text: label.text, second: "Used on this assessment" });
    }
  }
  for (const r of results) {
    if (value.includes(r.tag) || options.some((o) => o.tag === r.tag)) continue;
    options.push({ tag: r.tag, code: r.code, text: shortText(r.text, 140), second: counterpartLine(r.counterparts) });
  }
  const showList = open && !disabled && !atMax && options.length > 0;

  function add(tag: string) {
    const result = addTag(value, tag);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onChange(result.next);
    setQuery("");
    setActive(-1);
    // G-2 (2026-10-02 hand-run): close the list after an add. With a subject
    // filter on, an open list kept browsing and covered the fields below, so
    // the next click aimed at another field picked a standard instead. Typing
    // or ArrowDown reopens it.
    setOpen(false);
  }

  async function addTyped() {
    const text = query.trim();
    if (!text) return;
    // A typed code that exists in exactly one scheme is that catalog tag (D-1).
    let tag = text;
    try {
      const res = await fetch(searchUrl(text, p, 1));
      if (res.ok) tag = ((await res.json()) as SearchResponse).exact ?? text;
    } catch {
      // Offline: keep it as typed.
    }
    add(tag);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (options.length === 0) return;
      // -1 = nothing highlighted (Enter then adds what was typed); wraps both ways.
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => {
        const next = i + delta;
        if (next >= options.length) return -1;
        if (next < -1) return options.length - 1;
        return next;
      });
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showList && active >= 0 && options[active]) add(options[active]!.tag);
      else void addTyped();
    }
  }

  function setPrefs(patch: Partial<Prefs>) {
    const next = { ...p, ...patch };
    if (patch.subject !== undefined) {
      next.gradeBand = "";
      next.course = "";
    }
    if (patch.gradeBand !== undefined && patch.gradeBand !== "HS") next.course = "";
    writePrefs(next);
  }

  const bands = p.subject && facets ? facets.grade_bands[p.subject] ?? [] : [];

  return (
    <div className="mt-3">
      <label htmlFor={`${id}-input`} className="block text-sm font-medium">
        Standards{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      {value.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Standards on this question">
          {value.map((tag) => {
            const label = chipLabel(tag, entryCache.get(tag));
            return (
              <li
                key={tag}
                title={label.title}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs"
              >
                <span className="font-medium">{label.code}</span>
                {label.text ? <span className="truncate text-muted-foreground">{label.text}</span> : null}
                {!disabled ? (
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((t) => t !== tag))}
                    className="ml-0.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={`Remove ${label.code}`}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="relative mt-1">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-describedby={hintId}
          value={query}
          disabled={disabled || atMax}
          placeholder={atMax ? "" : "Search by code or words, or type your own"}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setError(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        />
        {showList ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching standards"
            className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-background py-1 shadow-md"
          >
            {options.map((o, i) => (
              <li
                key={o.tag}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(o.tag);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? "bg-accent text-accent-foreground" : ""}`}
              >
                <span className="font-medium">{o.code}</span>
                {o.text ? <span className="ml-2 text-muted-foreground">{o.text}</span> : null}
                {o.second ? <span className="block text-xs text-muted-foreground">{o.second}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p id={hintId} className="mt-1 text-xs text-muted-foreground">
        {atMax
          ? `${MAX_STANDARDS} standards — the most a question can carry. Remove one to add another.`
          : "Enter adds the highlighted standard, or what you typed as your own."}
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {!disabled ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <NativeSelect
            size="sm"
            aria-label="Subject"
            value={p.subject}
            onChange={(e) => setPrefs({ subject: e.target.value as Prefs["subject"] })}
          >
            <NativeSelectOption value="">Any subject</NativeSelectOption>
            <NativeSelectOption value="math">Math</NativeSelectOption>
            <NativeSelectOption value="ela">ELA</NativeSelectOption>
            <NativeSelectOption value="science">Science</NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            size="sm"
            aria-label="Grade band"
            value={p.gradeBand}
            disabled={!p.subject}
            onChange={(e) => setPrefs({ gradeBand: e.target.value })}
          >
            <NativeSelectOption value="">Any grade</NativeSelectOption>
            {bands.map((b) => (
              <NativeSelectOption key={b} value={b}>
                {b === "K" ? "Kindergarten" : /^\d+$/.test(b) ? `Grade ${b}` : b}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {p.subject === "math" && p.gradeBand === "HS" ? (
            <NativeSelect
              size="sm"
              aria-label="High school course"
              value={p.course}
              onChange={(e) => setPrefs({ course: e.target.value })}
            >
              <NativeSelectOption value="">Any course</NativeSelectOption>
              {(facets?.courses ?? []).map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {c}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {p.subject !== "science" ? (
            <NativeSelect
              size="sm"
              aria-label="Which codes to list first"
              value={p.prefer}
              onChange={(e) => setPrefs({ prefer: e.target.value as Prefs["prefer"] })}
            >
              <NativeSelectOption value="wa2026">2026 codes first</NativeSelectOption>
              <NativeSelectOption value="ccss2010">2011 codes first</NativeSelectOption>
            </NativeSelect>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
