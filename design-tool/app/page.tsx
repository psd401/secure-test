import { redirect } from "next/navigation";
import { readStaffSessionFromCookies } from "@/lib/auth/session";

// UX pass 1, slice 2: the site root is not a page. Signed-in staff land on
// their assessments; everyone else on sign-in.
export default async function HomePage() {
  const session = await readStaffSessionFromCookies();
  redirect(session ? "/dashboard" : "/login");
}
