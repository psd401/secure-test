"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/** What a row needs to be draggable: the node ref + style for the row, and props for its handle. */
export interface DragBits {
  setNodeRef: (el: HTMLElement | null) => void;
  style: CSSProperties;
  handleProps: Record<string, unknown>;
  isDragging: boolean;
}

/**
 * R-7 (docs/editor-redesign-design.md, Phase 4 slice B): a vertical list whose
 * rows drag by a handle (@dnd-kit; pointer, or keyboard: Space to lift, arrow
 * keys, Space to drop). Every caller also renders a click path (Move up /
 * Move down) — WCAG 2.2 SC 2.5.7 — so dragging is never the only way.
 * dnd-kit announces keyboard drags in its own live region using `describe`.
 */
export function SortableRows({
  ids,
  onMove,
  describe,
  disabled = false,
  children,
}: {
  ids: string[];
  onMove: (from: number, to: number) => void;
  /** "Question 3", "Choice B": what the drag announcements call a row. */
  describe: (id: string) => string;
  disabled?: boolean;
  children: (id: string, index: number, drag: DragBits) => ReactNode;
}) {
  const sensors = useSensors(
    // A few pixels before a drag starts, so a click on the handle stays a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const position = (id: string | number) => ids.indexOf(String(id)) + 1;

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from >= 0 && to >= 0) onMove(from, to);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To move this, press Space, then the up and down arrow keys, then Space again to drop it or Escape to cancel. Or use the Move up and Move down buttons.",
        },
        announcements: {
          onDragStart: ({ active }) => `Picked up ${describe(String(active.id))}.`,
          onDragOver: ({ active, over }) =>
            over ? `${describe(String(active.id))} is over position ${position(over.id)} of ${ids.length}.` : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? `${describe(String(active.id))} dropped at position ${position(over.id)} of ${ids.length}.`
              : `${describe(String(active.id))} dropped.`,
          onDragCancel: ({ active }) => `Moving ${describe(String(active.id))} was cancelled.`,
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={disabled}>
        {ids.map((id, index) => (
          <SortableRow key={id} id={id} index={index} disabled={disabled}>
            {children}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  index,
  disabled,
  children,
}: {
  id: string;
  index: number;
  disabled: boolean;
  children: (id: string, index: number, drag: DragBits) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <>
      {children(id, index, {
        setNodeRef,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
          position: "relative",
          zIndex: isDragging ? 10 : undefined,
        },
        handleProps: { ...attributes, ...listeners },
        isDragging,
      })}
    </>
  );
}

/** The polite live region a click-path move writes to. */
export function MoveAnnouncer({ message }: { message: string }) {
  return (
    <p aria-live="polite" role="status" className="sr-only">
      {message}
    </p>
  );
}
