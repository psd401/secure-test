import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { listSharesForRecipient } from "@/lib/api/shares";

// Slice C: offers addressed to the signed-in staff member. A session with
// no email (pre-slice-78 token) simply sees none rather than an error.
export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const email = auth.session.email;
  if (!email) return NextResponse.json({ shares: [] });
  return NextResponse.json({ shares: await listSharesForRecipient(email) });
}
