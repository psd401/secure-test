"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Batch 3 slice 2: the root error boundary. `app/dashboard/error.tsx` has
 * covered the dashboard since UX pass 1; everything else — /login, /preview,
 * the home page — had nothing, so a throw there showed Next's unstyled
 * default. Same shape as the dashboard's, one level up.
 *
 * The digest is the whole point of the screen: it is what `onRequestError`
 * wrote into the `server_error_events` row and the log line, so a teacher who
 * reads it out gives IT the row.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong.</AlertTitle>
        <AlertDescription>
          <p>Try again in a moment. If it keeps happening, tell IT and give them the ref below.</p>
          {error.digest ? <code className="text-xs">ref {error.digest}</code> : null}
        </AlertDescription>
      </Alert>
      <div className="mt-6 flex gap-2">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
