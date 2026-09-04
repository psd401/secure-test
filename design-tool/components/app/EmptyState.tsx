import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §2.3): the one empty-state shape.
 * Names what is missing, says what will appear (or why it hasn't), and puts
 * the way forward inside the box — never a bare sentence in a dashed border.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty className="border border-dashed bg-card">
      <EmptyHeader>
        {icon ? (
          <EmptyMedia variant="icon" className="bg-accent text-brand-ink">
            {icon}
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
