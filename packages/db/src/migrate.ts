import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Minimal forward-only migration runner. Executes every .sql file in
 * ../migrations (lexical order) inside a transaction, tracking applied files in
 * a _migrations table. Idempotent and safe to run on every boot.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

export async function migrate(connectionString: string): Promise<string[]> {
  const sql = postgres(connectionString, { max: 1 });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const done = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`;
      if (done.length > 0) continue;
      const ddl = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return applied;
  } finally {
    await sql.end();
  }
}

// Run directly: `tsx src/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(
        applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations.",
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
