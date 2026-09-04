import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";

export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  const rows = await db
    .select()
    .from(assets)
    .where(eq(assets.owner_sub, auth.session.sub))
    .orderBy(desc(assets.created_at));
  return NextResponse.json({ assets: rows });
}
