#!/usr/bin/env node
/**
 * Re-key everything encrypted with the MFA_SECRET KEK.
 *
 * `packages/db/src/totp.ts` derives ONE AES-256-GCM key as
 * `sha256(MFA_SECRET || SESSION_SECRET)` and uses it for three things:
 *   - users.totp_secret                        (2FA seeds)
 *   - site_setting.aiApiKey            {cipher}          (the AI provider key)
 *   - site_setting.stockImageProvider  {apiKey:{cipher}}  (stock provider key)
 *
 * So changing MFA_SECRET normally makes all of them undecryptable — and because a
 * 2FA-enabled account logs in PASSWORDLESSLY (email → code), losing the TOTP seed
 * locks that user out of the admin entirely. On a single-admin instance there is no
 * second account to recover with.
 *
 * This script decrypts with the OLD key and re-encrypts with the NEW one in a single
 * transaction, so a placeholder MFA_SECRET can be rotated with zero data loss and no
 * re-enrolment. The cipher is the package's own `encryptSecret`/`decryptSecret`
 * (loaded through tsx), never a copy: it reads both layouts the package has ever
 * written — legacy `iv:tag:ct` and purpose-bound `v2:<purpose>:iv:tag:ct` — and
 * writes every row back in the current one.
 *
 * Usage — dry run first (writes nothing):
 *   DATABASE_URL=… OLD_MFA_SECRET=… NEW_MFA_SECRET=… node scripts/rekey-mfa-secret.mjs
 *   DATABASE_URL=… OLD_MFA_SECRET=… NEW_MFA_SECRET=… node scripts/rekey-mfa-secret.mjs --commit
 *
 * AES-GCM carries an auth tag, so a wrong OLD_MFA_SECRET fails loudly here instead of
 * writing corrupted ciphertext. Nothing is written unless EVERY value decrypts first.
 *
 * Back up before running (ops/backup.sh). Afterwards set MFA_SECRET to the new value
 * and recreate the api (and mcp) containers so they boot with it.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `postgres` and `tsx` are dependencies of packages/db, not of the repo root, so a
// bare import does not resolve from scripts/ — require them from where they are
// installed (the same trick evals/mcp-eval.mjs uses for tsx).
const dbRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "package.json"));
const postgres = dbRequire("postgres");
const tsxApi = await import(pathToFileURL(dbRequire.resolve("tsx/esm/api")).href);
const tsImport = tsxApi.tsImport ?? tsxApi.default.tsImport;
const { encryptSecret, decryptSecret } = await tsImport("../packages/db/src/totp.ts", import.meta.url);

const { DATABASE_URL, OLD_MFA_SECRET, NEW_MFA_SECRET } = process.env;
const COMMIT = process.argv.includes("--commit");

if (!DATABASE_URL || !OLD_MFA_SECRET || !NEW_MFA_SECRET) {
  console.error("Required env: DATABASE_URL, OLD_MFA_SECRET, NEW_MFA_SECRET");
  process.exit(1);
}
if (OLD_MFA_SECRET === NEW_MFA_SECRET) {
  console.error("OLD_MFA_SECRET and NEW_MFA_SECRET are identical — nothing to do.");
  process.exit(1);
}
if (/change-me|please-override/i.test(NEW_MFA_SECRET) || NEW_MFA_SECRET.length < 16) {
  console.error("NEW_MFA_SECRET must be >= 16 chars and not a placeholder — the API's env guard would refuse it.");
  process.exit(1);
}

// totp.ts derives its key from MFA_SECRET on every call, so the key is chosen by setting it.
const decryptWith = (secret, cipher, purpose) => {
  process.env.MFA_SECRET = secret;
  return decryptSecret(cipher, purpose);
};
const encryptWith = (secret, plain, purpose) => {
  process.env.MFA_SECRET = secret;
  return encryptSecret(plain, purpose);
};

/** Decrypt with OLD, re-encrypt with NEW. Throws if OLD is wrong (auth-tag failure). */
const rekey = (cipher, purpose) => encryptWith(NEW_MFA_SECRET, decryptWith(OLD_MFA_SECRET, cipher, purpose), purpose);

const sql = postgres(DATABASE_URL, { max: 1 });

try {
  // --- Phase 1: decrypt + re-encrypt EVERYTHING in memory. Any failure here
  // aborts before a single write, so a wrong OLD_MFA_SECRET is harmless.
  const plan = [];

  const users = await sql`SELECT id, email, totp_secret FROM users WHERE totp_secret IS NOT NULL`;
  for (const u of users) {
    plan.push({ kind: "user", id: u.id, what: `users.totp_secret (${u.email})`, next: rekey(u.totp_secret, "totp") });
  }

  const ai = await sql`SELECT value FROM site_setting WHERE key = 'aiApiKey'`;
  if (ai[0]?.value?.cipher) {
    plan.push({
      kind: "setting",
      key: "aiApiKey",
      what: "site_setting.aiApiKey",
      next: { ...ai[0].value, cipher: rekey(ai[0].value.cipher, "ai.key") },
    });
  }

  const stock = await sql`SELECT value FROM site_setting WHERE key = 'stockImageProvider'`;
  if (stock[0]?.value?.apiKey?.cipher) {
    const v = stock[0].value;
    plan.push({
      kind: "setting",
      key: "stockImageProvider",
      what: "site_setting.stockImageProvider.apiKey",
      next: { ...v, apiKey: { ...v.apiKey, cipher: rekey(v.apiKey.cipher, "stock.key") } },
    });
  }

  if (plan.length === 0) {
    console.log("\nNothing is encrypted with this key — MFA_SECRET can be changed freely.\n");
    process.exit(0);
  }

  console.log(`\nAll ${plan.length} value(s) decrypted cleanly with OLD_MFA_SECRET:`);
  for (const p of plan) console.log(`  • ${p.what}`);

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit to apply.\n");
    process.exit(0);
  }

  // --- Phase 2: one transaction. Either everything is re-keyed or nothing is.
  await sql.begin(async (tx) => {
    for (const p of plan) {
      if (p.kind === "user") {
        await tx`UPDATE users SET totp_secret = ${p.next} WHERE id = ${p.id}`;
      } else {
        await tx`UPDATE site_setting SET value = ${tx.json(p.next)} WHERE key = ${p.key}`;
      }
    }
  });

  // --- Phase 3: read back and verify the NEW key decrypts what we wrote.
  for (const p of plan) {
    if (p.kind === "user") {
      const [row] = await sql`SELECT totp_secret FROM users WHERE id = ${p.id}`;
      decryptWith(NEW_MFA_SECRET, row.totp_secret, "totp");
    } else if (p.key === "aiApiKey") {
      const [row] = await sql`SELECT value FROM site_setting WHERE key = 'aiApiKey'`;
      decryptWith(NEW_MFA_SECRET, row.value.cipher, "ai.key");
    } else {
      const [row] = await sql`SELECT value FROM site_setting WHERE key = 'stockImageProvider'`;
      decryptWith(NEW_MFA_SECRET, row.value.apiKey.cipher, "stock.key");
    }
  }

  console.log(`\n✓ Re-keyed and verified ${plan.length} value(s) under the new key.`);
  console.log("Next: set MFA_SECRET to the NEW value in .env, then recreate api (and mcp).\n");
} catch (err) {
  console.error(`\n✗ Aborted: ${err.message}`);
  console.error("An auth-tag failure means OLD_MFA_SECRET is not the key this data was encrypted with.\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}
