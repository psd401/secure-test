"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface AssetSummary {
  id: string;
  content_type: string;
  size_bytes: number;
  original_filename: string | null;
}

interface Props {
  onInsert: (markdown: string) => void;
}

// Inline thumbnail picker. Click "Image…" to expand; click a thumbnail to
// emit `![filename](asset:<uuid>)` via onInsert(). The picker fetches
// the teacher's owned assets on first expand and caches the list — no
// background polling, since uploads happen on a different page.
export function ImagePicker({ onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || assets !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/assets");
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { assets: AssetSummary[] };
        if (!cancelled) setAssets(body.assets);
      } catch (e) {
        if (!cancelled) setError(`load: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, assets]);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
      >
        {open ? "Hide images" : "Image…"}
      </button>
      {open ? (
        <div className="mt-2 rounded-md border border-border bg-muted p-2">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : assets === null ? (
            <Skeleton className="h-16 w-full" aria-label="Loading images" />
          ) : assets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No uploads yet —{" "}
              <a className="underline" href="/dashboard/uploads">
                upload one
              </a>
              .
            </p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {assets.map((a) => {
                const alt = a.original_filename ?? a.id.slice(0, 8);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onInsert(`![${alt}](asset:${a.id})`);
                        setOpen(false);
                      }}
                      className="block w-full overflow-hidden rounded border border-border bg-background hover:opacity-90"
                      title={alt}
                    >
                      <div className="aspect-square">
                        {a.content_type.startsWith("image/") ? (
                          <img
                            src={`/api/assets/${a.id}`}
                            alt={alt}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-[10px]">
                            {a.content_type}
                          </div>
                        )}
                      </div>
                      <div className="truncate px-1 py-0.5 text-[10px] text-muted-foreground">
                        {alt}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
