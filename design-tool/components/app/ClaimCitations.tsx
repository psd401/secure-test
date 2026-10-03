"use client";

import Link from "next/link";
import { questionAnchor, type PanelClaim } from "@/lib/insights/panelCopy";

/** The citation links under a report claim or a chat reply (shared). */
export function ClaimCitations({ assessmentId, claim }: { assessmentId: string; claim: PanelClaim }) {
  const { items, students } = claim.citations;
  if (items.length === 0 && students.length === 0) return null;
  return (
    <span className="ml-2 text-xs text-muted-foreground">
      {items.map((it) =>
        it.item_id ? (
          <a key={it.label} href={`#${questionAnchor(it.label)}`} className="mr-2 underline">
            {it.label}
          </a>
        ) : (
          <span key={it.label} className="mr-2">
            {it.label}
          </span>
        ),
      )}
      {students.map((st) =>
        st.attempt_id ? (
          <Link
            key={st.pseudonym}
            href={`/dashboard/${assessmentId}/results/${st.attempt_id}`}
            className="mr-2 underline"
          >
            {st.name}
          </Link>
        ) : (
          <span key={st.pseudonym} className="mr-2">
            {st.name}
          </span>
        ),
      )}
    </span>
  );
}
