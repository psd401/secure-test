"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { outlineBlocks, type Positioned } from "@/lib/authoring/outline";
import { MoveAnnouncer, SortableRows } from "./SortableRows";

interface RailItem extends Positioned {
  stem: string;
}

/** A short plain-text excerpt of a stem for the rail (markers and math dropped). */
export function outlineExcerpt(stem: string, max = 48): string {
  const plain = stem
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[picture]")
    .replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, "[math]")
    .replace(/\[\[[^\]]+\]\]/g, "___")
    .replace(/\\\$/g, "$")
    .replace(/\*\*|_/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "(no question text yet)";
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/**
 * R-6 / R-7 (docs/editor-redesign-design.md, Phase 4 slice B), new editor
 * only: the outline beside the question list. Each row is a block — one
 * question, or a stimulus with its questions, which move together because
 * the reorder route refuses to split a set. Two ways to move a block:
 * drag its handle, or select it and use Move up / Move down (WCAG 2.2
 * SC 2.5.7); both announce the result in a live region.
 */
export function OutlineRail<T extends RailItem>({
  items,
  disabled,
  locked,
  onMoveBlock,
  onShow,
  announcement,
}: {
  items: T[];
  disabled: boolean;
  /** Published: the note says why nothing moves. */
  locked: boolean;
  /** Move block `from` to block index `to`; the editor saves it through the reorder route. */
  onMoveBlock: (from: number, to: number) => void;
  /** Scroll the list to this question (the rail keeps focus). */
  onShow: (itemId: string) => void;
  announcement: string;
}) {
  const blocks = outlineBlocks(items);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedIndex = blocks.findIndex((b) => b.key === selected);
  const describe = (key: string) => {
    const b = blocks.find((x) => x.key === key);
    if (!b) return "this question";
    return b.items.length === 1
      ? `Question ${b.start + 1}`
      : `Questions ${b.start + 1} to ${b.start + b.items.length}`;
  };

  return (
    <nav aria-label="Question outline" className="rounded-lg border bg-card p-3 text-sm lg:sticky lg:top-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outline</h2>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={selectedIndex >= 0 ? `Move ${describe(selected!)} up` : "Move up (select a question first)"}
            title="Move up"
            disabled={disabled || selectedIndex <= 0}
            onClick={() => onMoveBlock(selectedIndex, selectedIndex - 1)}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={selectedIndex >= 0 ? `Move ${describe(selected!)} down` : "Move down (select a question first)"}
            title="Move down"
            disabled={disabled || selectedIndex < 0 || selectedIndex >= blocks.length - 1}
            onClick={() => onMoveBlock(selectedIndex, selectedIndex + 1)}
          >
            <ArrowDown aria-hidden />
          </Button>
        </div>
      </div>
      <ol className="space-y-1">
        <SortableRows ids={blocks.map((b) => b.key)} onMove={onMoveBlock} describe={describe} disabled={disabled}>
          {(key, index, drag) => {
            const block = blocks[index]!;
            const isSelected = key === selected;
            return (
              <li
                ref={drag.setNodeRef}
                style={drag.style}
                className={`flex items-start gap-1 rounded-md border ${
                  isSelected ? "border-primary bg-primary/10" : "border-transparent"
                } ${drag.isDragging ? "bg-card shadow" : ""} ${block.setId ? "border-l-4 border-l-primary/40" : ""}`}
              >
                <button
                  type="button"
                  className="mt-0.5 cursor-grab rounded p-0.5 text-muted-foreground hover:bg-accent disabled:cursor-default disabled:opacity-40"
                  aria-label={`Drag ${describe(key)}`}
                  disabled={disabled}
                  {...drag.handleProps}
                >
                  <GripVertical className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded px-1 py-0.5 text-left hover:bg-accent"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelected(isSelected ? null : key);
                    onShow(block.items[0]!.id);
                  }}
                >
                  {block.setId ? (
                    <span className="block text-xs font-medium text-muted-foreground">Stimulus</span>
                  ) : null}
                  {block.items.map((it, i) => (
                    <span key={it.id} className="block truncate">
                      <span className="text-muted-foreground">{block.start + i + 1}.</span> {outlineExcerpt(it.stem)}
                    </span>
                  ))}
                </button>
              </li>
            );
          }}
        </SortableRows>
      </ol>
      {locked ? (
        <p className="mt-2 text-xs text-muted-foreground">Unpublish to change the order.</p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">Drag a handle, or select a question and use the arrows.</p>
      )}
      <MoveAnnouncer message={announcement} />
    </nav>
  );
}
