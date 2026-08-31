import { migrate } from "@paperboy/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

async function main() {
  const env = loadEnv();
  // Apply migrations on boot (idempotent).
  await migrate(env.DATABASE_URL);
  const app = await buildApp({ env });
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  app.log.info(`Paperboy API listening on :${env.API_PORT}`);
  // Docker stops with SIGTERM; closing the app finishes in-flight requests and
  // releases the pool instead of dropping connections at the kill deadline.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info(`${signal} received — shutting down`);
      app
        .close()
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          app.log.error({ err }, "shutdown failed");
          process.exit(1);
        });
    });
  }
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
