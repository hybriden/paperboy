import { createDb, databaseHoldsData, isPgliteUrl, migrate, pgliteDataDir, seed, startPglite } from "@paperboy/db";
import { buildApp } from "./app.js";
import { EMBEDDED_MCP_PORT, loadEnv } from "./env.js";
import { startEmbeddedMcp } from "./mcp-embedded.js";

async function main() {
  const env = loadEnv();
  // PGlite mode: Postgres runs in this process, so there is no `init` container.
  // Point everything (this process, the embedded MCP child) at its socket.
  const pglite = isPgliteUrl(env.DATABASE_URL) ? await startPglite(pgliteDataDir(env.DATABASE_URL)) : undefined;
  if (pglite) env.DATABASE_URL = process.env.DATABASE_URL = pglite.url;
  // Apply migrations on boot (idempotent).
  await migrate(env.DATABASE_URL);
  // ...and seed it on first boot, like `init` would. Never a reseed: a database
  // holding data is left alone (delete the data folder to start over).
  if (pglite) await seedIfEmpty(env.DATABASE_URL);
  const app = await buildApp({ env });
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  app.log.info(`Paperboy API listening on :${env.API_PORT}`);
  const mcp = env.MCP_EMBEDDED
    ? startEmbeddedMcp({ port: EMBEDDED_MCP_PORT, publicUrl: env.PUBLIC_URL ?? env.CORS_ORIGIN, log: app.log })
    : undefined;
  // Docker stops with SIGTERM; closing the app finishes in-flight requests and
  // releases the pool instead of dropping connections at the kill deadline.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info(`${signal} received — shutting down`);
      mcp?.stop();
      app
        .close()
        .then(() => pglite?.stop())
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          app.log.error({ err }, "shutdown failed");
          process.exit(1);
        });
    });
  }
}

async function seedIfEmpty(url: string) {
  const { sql } = createDb(url);
  try {
    if (await databaseHoldsData(sql)) return;
  } finally {
    await sql.end();
  }
  await seed(url);
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
