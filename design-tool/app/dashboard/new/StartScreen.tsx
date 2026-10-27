"use client";

import Link from "next/link";
import { useState } from "react";
import { FileJson, FilePlus2, FileText, LayoutTemplate, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/app/SubmitButton";
import type { StartChoice } from "@/lib/authoring/startScreen";
import { PRODUCT_NAME } from "@/lib/brand";
import { createFromTemplate } from "./actions";
import { NewAssessmentForm } from "./NewAssessmentForm";

/** A template as the start screen lists it (built on the server from lib/authoring/templates.ts). */
export interface StartTemplate {
  id: string;
  title: string;
  summary: string;
  /** e.g. "1 Multiple choice · 1 Short answer". */
  contents: string;
}

const CHOICES: { id: StartChoice; title: string; hint: string; icon: typeof FilePlus2 }[] = [
  {
    id: "blank",
    title: "Blank",
    hint: "Start from nothing, with an example question if you like.",
    icon: FilePlus2,
  },
  {
    id: "import",
    title: "Import from PDF or Word",
    hint: "Turn questions in a document into editable questions. You review each one first.",
    icon: FileText,
  },
  {
    id: "ai",
    title: "Draft with AI",
    hint: "Describe what you need and review AI-written questions before adding any.",
    icon: Sparkles,
  },
];

/**
 * Editor redesign Phase 8 (D-5): the start screen, R-12 flag on only. Three
 * choices that make a named draft through the New assessment form (blank,
 * PDF / Word import, AI draft), the district templates, and "Open a file"
 * (a .json export, through the Phase 7 preview at /dashboard/import).
 */
export function StartScreen({
  templates,
  showCancel = true,
}: {
  templates: StartTemplate[];
  /** False on /dashboard itself, where Cancel (a link to /dashboard) would go nowhere. */
  showCancel?: boolean;
}) {
  const [choice, setChoice] = useState<StartChoice>("blank");

  return (
    <div className="mt-8 space-y-10">
      <section aria-labelledby="start-new" className="space-y-4">
        <h2 id="start-new" className="text-lg font-semibold">
          Start a new assessment
        </h2>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="sr-only">How do you want to start?</legend>
          {CHOICES.map((c) => {
            const Icon = c.icon;
            const selected = choice === c.id;
            return (
              <label
                key={c.id}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border bg-card p-4 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                  selected ? "border-primary ring-1 ring-primary" : ""
                }`}
              >
                <input
                  type="radio"
                  name="start-choice"
                  value={c.id}
                  checked={selected}
                  onChange={() => setChoice(c.id)}
                  className="sr-only"
                />
                <span className="flex items-center gap-2 font-medium">
                  <Icon aria-hidden className="size-4" />
                  {c.title}
                </span>
                <span className="text-muted-foreground">{c.hint}</span>
              </label>
            );
          })}
        </fieldset>
        <div className="rounded-lg border bg-card p-5">
          {/* Keyed on the choice so each starts with its own empty form state. */}
          <NewAssessmentForm key={choice} start={choice} showCancel={showCancel} />
        </div>
      </section>

      <section aria-labelledby="start-templates" className="space-y-4">
        <h2 id="start-templates" className="flex items-center gap-2 text-lg font-semibold">
          <LayoutTemplate aria-hidden className="size-5" />
          Templates
        </h2>
        <p className="text-sm text-muted-foreground">
          Ready-made examples from the district. You get your own draft to change.
        </p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
              <span className="font-medium">{t.title}</span>
              <span className="text-sm text-muted-foreground">{t.summary}</span>
              <span className="text-xs text-muted-foreground">{t.contents}</span>
              <form action={createFromTemplate} className="mt-auto pt-2">
                <input type="hidden" name="template" value={t.id} />
                <SubmitButton size="sm" variant="outline" pendingLabel="Creating…" aria-label={`Use the ${t.title} template`}>
                  Use this template
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="start-file" className="space-y-3">
        <h2 id="start-file" className="flex items-center gap-2 text-lg font-semibold">
          <FileJson aria-hidden className="size-5" />
          Open a file
        </h2>
        <p className="text-sm text-muted-foreground">
          An assessment exported from {PRODUCT_NAME} (.json). You see what it will create before
          anything is made.
        </p>
        <Button asChild variant="outline">
          <Link href="/dashboard/import">Open a file…</Link>
        </Button>
      </section>
    </div>
  );
}
