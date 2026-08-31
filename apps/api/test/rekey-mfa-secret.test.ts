import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDb, decryptSecret, encryptSecret, getAccessContext, getStoredAiConfig, setAiConfig, setStockConfig } from "@paperboy/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * scripts/rekey-mfa-secret.mjs re-encrypts everything under the MFA_SECRET KEK
 * (TOTP seeds, the AI key, the stock key) from an old secret to a new one. It
 * must read BOTH cipher formats the package has ever written — the legacy
 * `iv:tag:ct` and the current purpose-bound `v2:<purpose>:iv:tag:ct` — and
 * always write the current one; a script that only knew the legacy layout
 * aborted on every v2 row ("OLD_MFA_SECRET is not the key"), which is every
 * row written since the AAD change.
 */
const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "rekey-mfa-secret.mjs");
const OLD = "old-mfa-secret-for-rekey-test-xx";
const NEW = "new-mfa-secret-for-rekey-test-yy";
const TOTP_PLAIN = "JBSWY3DPEHPK3PXP";
const LEGACY_PLAIN = "LEGACYSEEDABCDEF";
const AI_PLAIN = "sk-ant-rekey-test";
const STOCK_PLAIN = "unsplash-rekey-test";

/** The pre-AAD layout the package no longer writes: sha256(secret) key, no purpose. */
function legacyCipher(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

function runScript(commit: boolean): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...(commit ? ["--commit"] : [])],
      { env: { ...process.env, DATABASE_URL: TEST_DB, OLD_MFA_SECRET: OLD, NEW_MFA_SECRET: NEW }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: `${stdout}\n${stderr}` }),
    );
  });
}

describe("rekey-mfa-secret script", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let adminId: string;
  let editorId: string;
  const savedMfa = process.env.MFA_SECRET;

  beforeAll(async () => {
    s = await setupApi();
    const users = (await raw.sql`SELECT id, email FROM users WHERE email IN ('admin@paperboy.test', 'editor@paperboy.test')`) as unknown as { id: string; email: string }[];
    adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    editorId = users.find((u) => u.email === "editor@paperboy.test")!.id;
    // Everything below is written under OLD: one v2 TOTP seed, one legacy seed, the AI key, the stock key.
    process.env.MFA_SECRET = OLD;
    await raw.sql`UPDATE users SET totp_secret = ${encryptSecret(TOTP_PLAIN, "totp")}, totp_enabled = true WHERE id = ${adminId}`;
    await raw.sql`UPDATE users SET totp_secret = ${legacyCipher(LEGACY_PLAIN, OLD)}, totp_enabled = true WHERE id = ${editorId}`;
    const ctx = await getAccessContext(raw.db, adminId);
    await setAiConfig(raw.db, ctx, { apiKey: AI_PLAIN });
    await setStockConfig(raw.db, ctx, { apiKey: STOCK_PLAIN });
  });
  afterEach(() => {
    if (savedMfa === undefined) delete process.env.MFA_SECRET;
    else process.env.MFA_SECRET = savedMfa;
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  async function totpRow(id: string): Promise<string> {
    const [row] = (await raw.sql`SELECT totp_secret FROM users WHERE id = ${id}`) as unknown as { totp_secret: string }[];
    return row!.totp_secret;
  }

  it("dry run decrypts every row under OLD and writes nothing", async () => {
    const before = await totpRow(adminId);
    const { code, out } = await runScript(false);
    expect(code, out).toBe(0);
    expect(out).toMatch(/4 value\(s\) decrypted cleanly/);
    expect(out).toMatch(/DRY RUN/);
    expect(await totpRow(adminId)).toBe(before);
  });

  it("--commit re-keys v2 AND legacy rows to NEW, always as v2", async () => {
    const { code, out } = await runScript(true);
    expect(code, out).toBe(0);
    expect(out).toMatch(/Re-keyed and verified 4 value\(s\)/);

    process.env.MFA_SECRET = NEW;
    const adminRow = await totpRow(adminId);
    const editorRow = await totpRow(editorId);
    expect(adminRow.startsWith("v2:totp:")).toBe(true);
    expect(editorRow.startsWith("v2:totp:")).toBe(true);
    expect(decryptSecret(adminRow, "totp")).toBe(TOTP_PLAIN);
    expect(decryptSecret(editorRow, "totp")).toBe(LEGACY_PLAIN);
    expect((await getStoredAiConfig(raw.db)).apiKey).toBe(AI_PLAIN);
    const [stock] = (await raw.sql`SELECT value FROM site_setting WHERE key = 'stockImageProvider'`) as unknown as { value: { apiKey: { cipher: string } } }[];
    expect(stock!.value.apiKey.cipher.startsWith("v2:stock.key:")).toBe(true);
    expect(decryptSecret(stock!.value.apiKey.cipher, "stock.key")).toBe(STOCK_PLAIN);

    // The old key no longer opens anything.
    process.env.MFA_SECRET = OLD;
    expect(() => decryptSecret(adminRow, "totp")).toThrow();
  });
});
