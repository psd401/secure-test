import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { isAdmin, isImpersonating } from "@/lib/auth/admin";
import { AppHeader } from "@/components/app/AppHeader";

/**
 * The app shell's header, resolved from the session.
 *
 * Access slice 5 pulled this out of `app/dashboard/layout.tsx` because
 * `/admin` needs exactly the same header and the three facts it needs —
 * identity, the act-as actor, whether the session is an admin — are all read
 * from the session in the same two calls. A second copy in the admin layout
 * would be the place the banner goes missing.
 */
export async function AppChrome() {
  const session = await readStaffSessionFromCookies();
  if (!session) return null;
  return (
    <AppHeader
      identity={session.email ?? session.sub}
      // `actor_sub` is the authoritative signal (D-8); the address is what
      // the banner shows, and falls back to the sub rather than silently
      // hiding the banner if a session somehow carries one without the other.
      actorEmail={
        isImpersonating(session)
          ? (session.actor_email || session.actor_sub) ?? null
          : null
      }
      admin={isAdmin(session)}
    />
  );
}
