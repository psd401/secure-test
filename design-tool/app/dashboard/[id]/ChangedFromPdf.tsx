import type { CandidateChange } from "@/lib/pdfImport/extractCore";

// Beta feedback 2026-10-07: what the importer deliberately changed from the
// printed text — an instruction a student cannot do on screen ("Underline
// the significant digits"), or a symbol it had to guess. Blue (the info
// token) on purpose: amber on these cards means "check this", blue means
// "we changed this on purpose — here is what and why".
export function ChangedFromPdf({ changes }: { changes: readonly CandidateChange[] }) {
  if (changes.length === 0) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="inline-flex cursor-pointer list-none rounded bg-info px-1.5 py-0.5 text-[11px] font-medium text-info-foreground">
        Changed from the PDF ({changes.length}) — show
      </summary>
      <ul className="mt-1 space-y-1 border-l-2 border-info-foreground/40 pl-2 text-info-foreground">
        {changes.map((c, i) => (
          <li key={i}>
            <span className="text-muted-foreground">Printed:</span> “{c.original}”{" "}
            <span className="text-muted-foreground">→</span>{" "}
            {c.changed_to ? <>“{c.changed_to}”</> : <em>removed</em>}
            {c.reason ? <span className="text-muted-foreground"> · {c.reason}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
