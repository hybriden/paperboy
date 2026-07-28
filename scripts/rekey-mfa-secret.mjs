#!/usr/bin/env node
/**
 * Re-key everything encrypted with the MFA_SECRET KEK.
 *
 * `packages/db/src/totp.ts` derives ONE AES-256-GCM key as
 * `sha256(MFA_SECRET || SESSION_SECRET)` and uses it for three things:
 *   - users.totp_secret                        (2FA seeds)
 *   - site_setting.aiApiKey            {cipher}          (Anthropic key)
 *   - site_setting.stockImageProvider  {apiKey:{cipher}}  (stock provider key)
 *
 * So changing MFA_SECRET normally makes all of them undecryptable — and because a
 * 2FA-enabled account logs in PASSWORDLESSLY (email → code), losing the TOTP seed
 * locks that user out of the admin entirely. On a single-admin instance there is no
 * second account to recover with.
 *
 * This script decrypts with the OLD key and re-encrypts with the NEW one in a single
 * transaction, so a placeholder MFA_SECRET can be rotated with zero data loss and no
 * re-enrolment.
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
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

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

const keyOf = (secret) => createHash("sha256").update(secret).digest();
const OLD = keyOf(OLD_MFA_SECRET);
const NEW = keyOf(NEW_MFA_SECRET);

/** Mirrors totp.ts decryptSecret, with an explicit key. */
function decrypt(encrypted, key) {
  const [ivHex, tagHex, ctHex] = String(encrypted).split(":");
  if (!ivHex || !tagHex || !ctHex) throw new Error("malformed ciphertext");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(ctHex, "hex")), d.final()]).toString("utf8");
}

/** Mirrors totp.ts encryptSecret, with an explicit key. */
function encrypt(plain, key) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

/** Decrypt with OLD, re-encrypt with NEW. Throws if OLD is wrong (auth-tag failure). */
const rekey = (cipher) => encrypt(decrypt(cipher, OLD), NEW);

const sql = postgres(DATABASE_URL, { max: 1 });

try {
  // --- Phase 1: decrypt + re-encrypt EVERYTHING in memory. Any failure here
  // aborts before a single write, so a wrong OLD_MFA_SECRET is harmless.
  const plan = [];

  const users = await sql`SELECT id, email, totp_secret FROM users WHERE totp_secret IS NOT NULL`;
  for (const u of users) {
    plan.push({ kind: "user", id: u.id, what: `users.totp_secret (${u.email})`, next: rekey(u.totp_secret) });
  }

  const ai = await sql`SELECT value FROM site_setting WHERE key = 'aiApiKey'`;
  if (ai[0]?.value?.cipher) {
    plan.push({
      kind: "setting",
      key: "aiApiKey",
      what: "site_setting.aiApiKey",
      next: { ...ai[0].value, cipher: rekey(ai[0].value.cipher) },
    });
  }

  const stock = await sql`SELECT value FROM site_setting WHERE key = 'stockImageProvider'`;
  if (stock[0]?.value?.apiKey?.cipher) {
    const v = stock[0].value;
    plan.push({
      kind: "setting",
      key: "stockImageProvider",
      what: "site_setting.stockImageProvider.apiKey",
      next: { ...v, apiKey: { ...v.apiKey, cipher: rekey(v.apiKey.cipher) } },
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
      decrypt(row.totp_secret, NEW);
    } else if (p.key === "aiApiKey") {
      const [row] = await sql`SELECT value FROM site_setting WHERE key = 'aiApiKey'`;
      decrypt(row.value.cipher, NEW);
    } else {
      const [row] = await sql`SELECT value FROM site_setting WHERE key = 'stockImageProvider'`;
      decrypt(row.value.apiKey.cipher, NEW);
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
