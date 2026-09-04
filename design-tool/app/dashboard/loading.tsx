import { Skeleton } from "@/components/ui/skeleton";

/**
 * UX pass 1, slice 3: every dashboard page is force-dynamic and a resumed
 * Aurora cluster can take seconds, so the route shows the shape of what is
 * coming instead of a blank page or a bare "Loading…".
 */
export default function DashboardLoading() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12" aria-busy="true" aria-label="Loading">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="mt-8 space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </main>
  );
}
