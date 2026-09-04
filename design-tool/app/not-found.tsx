import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * UX pass 1, slice 3: a wrong or stale link (and, deliberately, anything
 * that is not yours — the owner checks call notFound()) lands here with a
 * way home rather than Next's default 404.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">There&apos;s nothing at this address.</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The link may be old, or the page may belong to another teacher.
      </p>
      <Button asChild className="mt-6">
        <Link href="/dashboard">Go to Assessments</Link>
      </Button>
    </main>
  );
}
