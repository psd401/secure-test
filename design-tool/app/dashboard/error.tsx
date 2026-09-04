"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * UX pass 1, slice 3: a page that throws (a database that is not reachable,
 * most often on dev) says so in a sentence and offers to try again, instead
 * of Next's default unstyled error screen. The digest is what to hand IT.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Alert variant="destructive">
        <AlertTitle>This page couldn&apos;t load.</AlertTitle>
        <AlertDescription>
          <p>Try again in a moment. If it keeps happening, tell IT.</p>
          {error.digest ? <code className="text-xs">ref {error.digest}</code> : null}
        </AlertDescription>
      </Alert>
      <div className="mt-6 flex gap-2">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/dashboard">Assessments</Link>
        </Button>
      </div>
    </main>
  );
}
