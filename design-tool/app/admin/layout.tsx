import { AppChrome } from "@/components/app/AppChrome";

/**
 * Access slice 5: /admin shares the dashboard's shell. The page itself is
 * what refuses a non-admin (404), the same way `/api/grants` does — the
 * layout only draws the header.
 */
export default async function AdminLayout({
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
