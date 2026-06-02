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
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
