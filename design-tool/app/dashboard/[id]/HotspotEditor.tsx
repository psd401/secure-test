"use client";

import { useRef, useState } from "react";
import type { HotspotRegion } from "@secure-test/schema";
import { ImagePicker } from "./ImagePicker";
import { ASSET_REF_ONE_RE } from "@/lib/items/extractAssetRefs";

// Slice 49: hotspot authoring. The teacher picks an image (reusing the
// asset-library ImagePicker — its markdown insert is parsed for the asset
// uuid rather than adding a second selection UI), drags rectangles onto it
// (stored normalized 0-1 so every consumer renders them at any width), and
// checks which regions are correct. v1 has no move/resize — delete and
// redraw. The correct-region checkboxes are teacher-only; the preview
// never receives the key.

interface Props {
  imageAssetId: string | null;
  regions: HotspotRegion[];
  correctRegionIds: string[];
  onChange: (patch: {
    image_asset_id?: string | null;
    regions?: HotspotRegion[];
    correct_region_ids?: string[];
  }) => void;
  disabled: boolean;
}

function nextRegionId(regions: HotspotRegion[]): string {
  const ids = new Set(regions.map((r) => r.id));
  let n = regions.length + 1;
  while (ids.has(`r${n}`)) n += 1;
  return `r${n}`;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function HotspotEditor({
  imageAssetId,
  regions,
  correctRegionIds,
  onChange,
  disabled,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Drag-in-progress rectangle, normalized. null when not dragging.
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  function norm(e: React.MouseEvent): { x: number; y: number } {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }

  function finishDrag(d: { x0: number; y0: number; x1: number; y1: number }) {
    setDrag(null);
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0);
    const h = Math.abs(d.y1 - d.y0);
    // Ignore accidental clicks — a real region needs some area.
    if (w < 0.01 || h < 0.01) return;
    onChange({
      regions: [
        ...regions,
        {
          id: nextRegionId(regions),
          x,
          y,
          w: Math.min(w, 1 - x),
          h: Math.min(h, 1 - y),
        },
      ],
    });
  }

  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Hotspot image{" "}
        <span className="font-normal text-muted-foreground">
          (drag on the image to draw regions; check the correct ones)
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ImagePicker
          onInsert={(md) => {
            const m = md.match(ASSET_REF_ONE_RE);
            if (m) onChange({ image_asset_id: m[1]!.toLowerCase() });
          }}
        />
        {imageAssetId ? (
          <button
            onClick={() =>
              // Regions were drawn against THIS image's geometry — clearing
              // the image clears them too rather than leaving orphaned
              // rectangles for whatever image comes next.
              onChange({ image_asset_id: null, regions: [], correct_region_ids: [] })
            }
            disabled={disabled}
            className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
          >
            Remove image &amp; regions
          </button>
        ) : null}
      </div>
      {imageAssetId ? (
        <div
          ref={wrapRef}
          className="relative inline-block max-w-full select-none"
          style={{ cursor: disabled ? "default" : "crosshair" }}
          onMouseDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            const p = norm(e);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onMouseMove={(e) => {
            if (!drag) return;
            const p = norm(e);
            setDrag({ ...drag, x1: p.x, y1: p.y });
          }}
          onMouseUp={() => drag && finishDrag(drag)}
          onMouseLeave={() => drag && finishDrag(drag)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/assets/${imageAssetId}`}
            alt="Hotspot base"
            className="block h-auto max-w-full rounded border border-border"
            draggable={false}
          />
          {regions.map((r, i) => (
            <span
              key={r.id}
              className="absolute rounded-sm border-2 border-info-foreground bg-info-foreground/10"
              style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
            >
              <span className="absolute -left-px -top-px rounded-br bg-info-foreground px-1 text-[11px] font-semibold text-white">
                {i + 1}
              </span>
            </span>
          ))}
          {drag ? (
            <span
              className="absolute border-2 border-dashed border-info-foreground/60"
              style={{
                left: pct(Math.min(drag.x0, drag.x1)),
                top: pct(Math.min(drag.y0, drag.y1)),
                width: pct(Math.abs(drag.x1 - drag.x0)),
                height: pct(Math.abs(drag.y1 - drag.y0)),
              }}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No image selected yet — pick one from the asset library above.
        </p>
      )}
      {regions.length > 0 ? (
        <ul className="space-y-1">
          {regions.map((r, i) => {
            const checked = correctRegionIds.includes(r.id);
            return (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-xs text-muted-foreground">
                  {i + 1}.
                </span>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() =>
                      onChange({
                        correct_region_ids: checked
                          ? correctRegionIds.filter((id) => id !== r.id)
                          : [...correctRegionIds, r.id],
                      })
                    }
                  />
                  correct
                </label>
                <button
                  onClick={() =>
                    onChange({
                      regions: regions.filter((x) => x.id !== r.id),
                      correct_region_ids: correctRegionIds.filter((id) => id !== r.id),
                    })
                  }
                  disabled={disabled}
                  className="rounded-md border border-border px-2 py-0.5 text-xs disabled:opacity-40"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
