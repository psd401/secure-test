"use client";

import { Fragment, useEffect, type ReactNode } from "react";
import { docxGroups, type WordBlock, type WordParagraph } from "@/lib/docxImport/document";
import { regionDomId, type SourceRegion } from "./PdfSourcePane";

// Editor redesign Phase 7 slice B (R-10): the import review's left pane for
// a Word document. The server read the .docx into blocks (paragraphs with
// bold / italic, list numbers and headings; tables; picture placeholders —
// lib/docxImport/document.ts) and this draws them as plain React elements:
// a simple rendering of the document's text and structure, not a page
// layout (Word has no fixed pages). Each proposal the import could place by
// its printed number gets a numbered outline around the paragraphs it
// covers, linked both ways to its card, as on the PDF pane.

interface Props {
  blocks: readonly WordBlock[];
  /** Pictures in the document (none is imported). */
  pictures: number;
  regions: readonly SourceRegion[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  focusRequest: { key: string; n: number } | null;
}

function Paragraph({ p }: { p: WordParagraph }) {
  const body = p.runs.map((r, i) => {
    if ("picture" in r) {
      return (
        <span key={i} className="mx-0.5 rounded bg-muted px-1 text-[11px] text-muted-foreground">
          [picture]
        </span>
      );
    }
    let node: ReactNode = r.text;
    if (r.italic) node = <em>{node}</em>;
    if (r.bold) node = <strong>{node}</strong>;
    return <Fragment key={i}>{node}</Fragment>;
  });
  const cls = p.heading ? (p.heading <= 2 ? "text-base font-semibold" : "text-sm font-semibold") : "text-sm";
  return (
    <p
      className={`min-h-[1em] whitespace-pre-wrap ${cls}`}
      style={p.level ? { paddingLeft: `${p.level * 1.25}rem` } : undefined}
    >
      {p.label ? <span className="mr-1.5">{p.label}</span> : null}
      {body}
    </p>
  );
}

function Block({ b }: { b: WordBlock }) {
  if (b.kind === "paragraph") return <Paragraph p={b} />;
  return (
    <table className="my-1 border-collapse text-sm">
      <tbody>
        {b.rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci} className="border border-border px-2 py-1 align-top">
                {cell.map((p, pi) => (
                  <Paragraph key={pi} p={p} />
                ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DocxSourcePane({ blocks, pictures, regions, activeKey, onSelect, focusRequest }: Props) {
  useEffect(() => {
    if (!focusRequest) return;
    document.getElementById(regionDomId(focusRequest.key))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusRequest]);

  const groups = docxGroups(regions, blocks.length);
  const grouped = new Set(groups.flatMap((g) => g.regions.map((r) => r.key)));
  const loose = regions.filter((r) => !grouped.has(r.key));
  const out: ReactNode[] = [];
  let i = 0;
  for (const g of groups) {
    for (; i < g.start; i++) out.push(<Block key={`b${i}`} b={blocks[i]!} />);
    const active = g.regions.some((r) => r.key === activeKey);
    out.push(
      <div
        key={`g${g.start}`}
        className={`relative rounded border-2 px-2 pb-1 pt-5 ${
          active ? "border-primary bg-primary/10" : "border-primary/30"
        } ${g.regions.some((r) => r.unconverted) ? "border-dashed" : ""}`}
      >
        <div className="absolute left-0 top-0 flex gap-1">
          {g.regions.map((r) => (
            <button
              key={r.key}
              id={regionDomId(r.key)}
              type="button"
              onClick={() => onSelect(r.key)}
              aria-pressed={r.key === activeKey}
              aria-label={`${r.name} — show its proposal`}
              className={`rounded-br px-1 text-[11px] font-semibold text-primary-foreground ${
                r.key === activeKey ? "bg-primary" : "bg-primary/70"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {blocks.slice(g.start, g.end).map((b, k) => (
          <Block key={`b${g.start + k}`} b={b} />
        ))}
      </div>,
    );
    i = g.end;
  }
  for (; i < blocks.length; i++) out.push(<Block key={`b${i}`} b={blocks[i]!} />);

  return (
    <div className="space-y-2">
      {pictures > 0 ? (
        <p className="rounded border border-warning-foreground/30 p-2 text-xs text-warning-foreground">
          {pictures} picture{pictures === 1 ? "" : "s"} in this document {pictures === 1 ? "is" : "are"} not
          imported. Add {pictures === 1 ? "it" : "them"} to the questions in the editor with Image….
        </p>
      ) : null}
      {loose.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          Position not found:
          {loose.map((r) => (
            <button
              key={r.key}
              id={regionDomId(r.key)}
              type="button"
              onClick={() => onSelect(r.key)}
              aria-pressed={r.key === activeKey}
              className={`rounded border px-1 ${r.key === activeKey ? "border-primary bg-primary/10" : "border-border"}`}
            >
              {r.name}
            </button>
          ))}
        </p>
      ) : null}
      <article aria-label="The Word document" className="space-y-1 rounded border border-border bg-background p-4">
        {out}
      </article>
    </div>
  );
}
