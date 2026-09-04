import { cn } from "@/lib/utils";

/**
 * "n / N answered" as a bar plus the number — the number carries the meaning,
 * the bar is aria-hidden. Kept custom rather than pulling Radix Progress for
 * five lines.
 */
export function ProgressBar({
  value,
  max,
  done = false,
  className,
}: {
  value: number;
  max: number;
  /** Handed in: the bar fills in the success colour. */
  done?: boolean;
  className?: string;
}) {
  const pct = max > 0 ? Math.round((100 * value) / max) : 0;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="h-1.5 w-20 overflow-hidden rounded bg-muted" aria-hidden>
        <span
          className={cn("block h-full", done ? "bg-success-foreground" : "bg-info-foreground")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-sm tabular-nums">
        {value}/{max}
      </span>
    </span>
  );
}
