import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { notFound } from "next/navigation";

/**
 * Row 67's page-shaped knob (2026-09-14): a server component that throws for
 * a signed-in staff member, so the dashboard error boundary (`Alert` +
 * "Try again" + `ref`) and the `onRequestError` record can be seen on the
 * origin. `proxy.ts` already turns anyone without a staff session away from
 * `/dashboard`; the explicit check keeps the page 404-shaped if that ever
 * changes. See `app/api/debug/throw/route.ts` for the route-shaped twin.
 */
export const dynamic = "force-dynamic";

export default async function DebugThrowPage() {
  const session = await readStaffSessionFromCookies();
  if (!session) notFound();
  throw new Error(`debug throw requested by staff (row 67) at ${new Date().toISOString()}`);
}
