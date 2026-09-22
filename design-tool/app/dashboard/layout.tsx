import { AppChrome } from "@/components/app/AppChrome";

/**
 * UX pass 1, slice 2: every /dashboard route shares the app shell. proxy.ts
 * has already turned away anyone without a staff session, so the null branch
 * inside AppChrome only guards a matcher that was narrowed by accident.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppChrome />
      {children}
    </>
  );
}
