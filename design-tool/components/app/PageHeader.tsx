import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface Crumb {
  label: string;
  href: string;
}

/**
 * UX pass 1, slice 2: the trail above a page below home. The last crumb is
 * the page itself and reads the same as the h1 (NN/g: a breadcrumb that
 * ends on the current page needs no separate "you are here"). Also used on
 * its own inside client components whose heading is not yet a PageHeader
 * (the editor and the monitor, reworked in slices 4 and 7).
 */
export function Crumbs({ crumbs, current }: { crumbs: Crumb[]; current: ReactNode }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c) => (
          <Fragment key={c.href}>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={c.href}>{c.label}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * Page heading block: breadcrumb (when below home), h1 with an optional
 * status badge beside it, a one-line description, and an actions slot on
 * the right. One shape for every loop page from slice 2 on.
 */
export function PageHeader({
  crumbs = [],
  title,
  description,
  status,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {crumbs.length > 0 ? <Crumbs crumbs={crumbs} current={title} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {status}
          </div>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
