import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, generateBackupCodes, hashBackupCode, verifyBackupCode } from "@paperboy/db";
import { describe, expect, it } from "vitest";

/**
 * Two crypto findings from the review, both about a secret at rest.
 *
 * #4 — ONE key protects users.totp_secret, the AI key and the stock key, with no
 * AAD, so a ciphertext is interchangeable between the three slots: an attacker
 * with DB WRITE pastes a victim's TOTP ciphertext into the AI-key slot, points
 * baseUrl at their host, and the next "improve" click ships the decrypted secret
 * as a Bearer token. Binding each ciphertext to its purpose closes it.
 *
 * #3 — backup codes were unsalted single-round SHA-256 of a ~40-bit value, and a
 * backup code alone is a full passwordless login, so a read of `users` was a
 * few GPU-minutes from account takeover.
 */
describe("KEK ciphertexts are bound to their purpose (P1 #4)", () => {
  it("round-trips with the matching purpose", () => {
    const enc = encryptSecret("s3cret-value", "totp");
    expect(decryptSecret(enc, "totp")).toBe("s3cret-value");
  });

  it("REFUSES to decrypt under a different purpose (the swap attack)", () => {
    const enc = encryptSecret("victim-totp-secret", "totp");
    // Pasted into the AI-key slot and read back as an AI key: must fail, not leak.
    expect(() => decryptSecret(enc, "ai.key")).toThrow();
  });

  it("still decrypts a legacy (pre-AAD) ciphertext, matching purpose or not", () => {
    // A v1 value written before this change: iv:tag:ct, no AAD. Pin SESSION_SECRET
    // (MFA_SECRET unset) so this test and the module derive the identical key,
    // and reproduce the old format so the compat path is exercised. Restore after.
    const saved = { mfa: process.env.MFA_SECRET, session: process.env.SESSION_SECRET };
    try {
      delete process.env.MFA_SECRET;
      process.env.SESSION_SECRET = "legacy-compat-session-secret-000000";
      const key = createHash("sha256").update(process.env.SESSION_SECRET).digest();
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update("legacy-secret", "utf8"), c.final()]);
      const legacy = `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
      // No purpose binding on a legacy value, so any purpose reads it.
      expect(decryptSecret(legacy, "ai.key")).toBe("legacy-secret");
    } finally {
      if (saved.mfa === undefined) delete process.env.MFA_SECRET; else process.env.MFA_SECRET = saved.mfa;
      if (saved.session === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved.session;
    }
  });
});

describe("backup codes resist an offline crack (P1 #3)", () => {
  it("hashes with a slow KDF, not raw SHA-256", async () => {
    const h = await hashBackupCode("ABCDEFGHJK");
    expect(h.startsWith("$argon2")).toBe(true);
    expect(h).not.toMatch(/^[0-9a-f]{64}$/); // the old unsalted sha256 shape
  });

  it("verifies a correct code and rejects a wrong one", async () => {
    const h = await hashBackupCode("ABCDEFGHJK");
    expect(await verifyBackupCode("abcdefghjk", [h])).toBe(h); // case-insensitive, returns the matched hash
    expect(await verifyBackupCode("WRONGCODE0", [h])).toBeNull();
  });

  it("still accepts a legacy sha-256 backup code (compat for an enrolled user)", async () => {
    const legacy = createHash("sha256").update("ABCDEFGHJK").digest("hex");
    expect(await verifyBackupCode("ABCDEFGHJK", [legacy])).toBe(legacy);
  });

  it("generates readable high-entropy codes", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    // 10 chars from a 31-symbol alphabet ~= 49.5 bits, up from 8 chars (~39.6).
    for (const c of codes) expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
    expect(new Set(codes).size).toBe(10);
  });
});
