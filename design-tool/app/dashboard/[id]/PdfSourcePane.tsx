"use client";

import { useEffect, useState } from "react";
import type { CandidateRegion } from "@/lib/pdfImport/regions";

// Editor redesign Phase 7 slice A (R-8): the uploaded PDF, page by page, with
// a numbered box over each proposed question the import could place. Pages
// are drawn in the browser by the pdf.js build that ships inside `unpdf`
// (already the server's PDF reader — no new dependency), loaded only when
// this pane opens. The file never leaves the browser again: it is read from
// the File the teacher picked. If pdf.js cannot draw it, the browser's own
// PDF viewer shows the file instead, without boxes; the cards still say
// which page each question is on.

/** Past this many pages the pane draws the first ones and says so. */
export const MAX_SOURCE_PAGES = 40;
/** CSS width each page is drawn for (sharper on a high-density screen). */
const PAGE_CSS_WIDTH = 640;

export interface SourceRegion {
  /** The card this region belongs to (the panel's own key). */
  key: string;
  /** Short label drawn on the box: the card's number. */
  label: string;
  /** Read by screen readers, e.g. "Question 5". */
  name: string;
  region: CandidateRegion;
  /** A question the import could not convert: drawn dashed. */
  unconverted?: boolean;
}

interface Props {
  file: File;
  regions: readonly SourceRegion[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Bumped by the panel to scroll a region (or its page) into view. */
  focusRequest: { key: string; n: number } | null;
}

export function regionDomId(key: string): string {
  return `pdf-region-${key}`;
}

export function PdfSourcePane({ file, regions, activeKey, onSelect, focusRequest }: Props) {
  const [pages, setPages] = useState<{ url: string; width: number; height: number }[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    setPages([]);
    setState("loading");
    (async () => {
      try {
        const { getDocumentProxy } = await import("unpdf");
        const doc = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
        if (cancelled) return;
        setPageCount(doc.numPages);
        const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
        for (let p = 1; p <= Math.min(doc.numPages, MAX_SOURCE_PAGES); p++) {
          const page = await doc.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (PAGE_CSS_WIDTH / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport }).promise;
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("page did not draw");
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          made.push(url);
          setPages((prev) => [...prev, { url, width: base.width, height: base.height }]);
        }
        await doc.destroy();
        if (!cancelled) setState("ready");
      } catch (err) {
        console.warn("pdf source pane: falling back to the browser's PDF viewer", err instanceof Error ? err.message : err);
        if (!cancelled) setState("fallback");
      }
    })();
    return () => {
      cancelled = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [file]);

  useEffect(() => {
    if (!focusRequest) return;
    const hit = regions.find((r) => r.key === focusRequest.key);
    const el =
      document.getElementById(regionDomId(focusRequest.key)) ??
      (hit ? document.getElementById(`pdf-page-${hit.region.page}`) : null);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusRequest, regions]);

  if (state === "fallback") {
    return (
      <div className="space-y-2">
        <p className="rounded border border-warning-foreground/30 p-2 text-xs text-warning-foreground">
          This PDF could not be drawn here, so it is shown in the browser&apos;s own viewer, without the
          numbered boxes. Each question on the right says which page it is on.
        </p>
        {fileUrl ? (
          <object data={fileUrl} type="application/pdf" className="h-[75vh] w-full rounded border border-border">
            <a href={fileUrl} target="_blank" rel="noreferrer" className="text-sm underline">
              Open the PDF
            </a>
          </object>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state === "loading" ? (
        <p className="text-xs text-muted-foreground" role="status">
          Drawing the PDF… {pages.length > 0 ? `page ${pages.length} of ${Math.min(pageCount, MAX_SOURCE_PAGES)}` : ""}
        </p>
      ) : null}
      {pageCount > MAX_SOURCE_PAGES && state === "ready" ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {MAX_SOURCE_PAGES} of {pageCount} pages.
        </p>
      ) : null}
      {pages.map((pg, i) => {
        const p = i + 1;
        const here = regions.filter((r) => r.region.page === p);
        const boxed = here.filter((r) => r.region.top !== null && r.region.bottom !== null);
        const loose = here.filter((r) => r.region.top === null || r.region.bottom === null);
        return (
          <section key={p} id={`pdf-page-${p}`} aria-label={`Page ${p}`} className="space-y-1">
            <p className="text-[11px] text-muted-foreground">Page {p}</p>
            <div className="relative overflow-hidden rounded border border-border bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pg.url} alt={`Page ${p} of the PDF`} className="block w-full" />
              {boxed.map((r) => {
                const active = r.key === activeKey;
                return (
                  <button
                    key={r.key}
                    id={regionDomId(r.key)}
                    type="button"
                    onClick={() => onSelect(r.key)}
                    aria-pressed={active}
                    aria-label={`${r.name}, page ${p} — show its proposal`}
                    className={`absolute left-0 right-0 border-2 text-left transition-colors ${
                      r.unconverted ? "border-dashed" : ""
                    } ${
                      active
                        ? "border-primary bg-primary/10"
                        : "border-primary/30 bg-transparent hover:border-primary/70 hover:bg-primary/5"
                    }`}
                    style={{
                      top: `${(r.region.top ?? 0) * 100}%`,
                      height: `${Math.max(0.02, (r.region.bottom ?? 0) - (r.region.top ?? 0)) * 100}%`,
                    }}
                  >
                    <span
                      className={`absolute -left-0 top-0 rounded-br px-1 text-[11px] font-semibold ${
                        active ? "bg-primary text-primary-foreground" : "bg-primary/70 text-primary-foreground"
                      }`}
                    >
                      {r.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {loose.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                On this page, position not found:
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
          </section>
        );
      })}
    </div>
  );
}
