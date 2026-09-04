import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { AppHeader } from "@/components/app/AppHeader";

/**
 * UX pass 1, slice 2: every /dashboard route shares the app shell. proxy.ts
 * has already turned away anyone without a staff session, so the null branch
 * only guards a matcher that was narrowed by accident.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await readStaffSessionFromCookies();
  return (
    <>
      {session ? <AppHeader identity={session.email ?? session.sub} /> : null}
      {children}
    </>
  );
}
