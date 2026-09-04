import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStudent } from "@/lib/api/requireSession";
import { listMySittings } from "@/lib/api/mySittings";

/**
 * Slice 83: "Your tests" — the open sittings this student is admitted to,
 * with the attempt they already have in each, if any. The client joins one
 * with `POST /api/attempts { test_session_id }`; the code path stays for
 * ad-hoc sittings.
 *
 * Account-level problems (no email on the session, not on the roster, two
 * roster rows sharing the address) come back as 200 with an empty list and a
 * `reason` — facts about the caller's own account, which the client can put
 * into words. There is no oracle here: the list only ever names sittings the
 * caller could join by code anyway.
 */
export async function GET() {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const result = await listMySittings(getDb(), auth.session);
  if (!result.ok) {
    return NextResponse.json({ sittings: [], reason: result.reason });
  }
  return NextResponse.json({ sittings: result.sittings });
}
