import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;
let cachedSql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  cachedSql = postgres(url, { max: 5 });
  cached = drizzle(cachedSql, { schema });
  return cached;
}

export async function closeDb() {
  if (cachedSql) {
    await cachedSql.end({ timeout: 1 });
    cachedSql = null;
    cached = null;
  }
}

export { schema };
