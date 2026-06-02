import { sql as sqlTag } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { max: 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/** Lazily-created singleton for app code (tests create their own). */
let singleton: { db: Database; sql: postgres.Sql } | null = null;

export function getDb(): Database {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    singleton = createDb(url);
  }
  return singleton.db;
}

export function getSql(): postgres.Sql {
  getDb();
  return singleton!.sql;
}

/** Lightweight liveness probe for health checks. */
export async function ping(db: Database): Promise<void> {
  await db.execute(sqlTag`SELECT 1`);
}

export { schema };
