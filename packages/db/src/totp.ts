import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { Secret, TOTP } from "otpauth";

/**
 * TOTP two-factor auth (RFC 6238). Uses the `otpauth` library for codes, the
 * secret AES-256-GCM encrypted at rest and BOUND TO ITS PURPOSE (see
 * encryptSecret), and one-time backup codes hashed with argon2id — never the
 * old unsalted single-round SHA-256, which a read of `users` could crack
 * offline in minutes for what is a full passwordless login.
 */

/** A ciphertext's purpose, mixed in as AES-GCM additional authenticated data so
 *  a value encrypted for one slot cannot be decrypted in another. */
export type SecretPurpose = "totp" | "ai.key" | "stock.key";

const ISSUER = "Paperboy";

const MFA_DEV_FALLBACK = "dev-mfa-secret-change-me-please-32x";

/** Stable key for encrypting TOTP secrets at rest (derived from the app secret).
 *  Uses `||` (not `??`) so the docker-compose `MFA_SECRET: ${MFA_SECRET:-}`
 *  empty-string default falls through to SESSION_SECRET instead of deriving the
 *  key from sha256("") — a public constant identical across every install. */
function encKey(): Buffer {
  const secret = process.env.MFA_SECRET || process.env.SESSION_SECRET || MFA_DEV_FALLBACK;
  if (process.env.NODE_ENV === "production" && secret === MFA_DEV_FALLBACK) {
    throw new Error("Refusing to derive the TOTP encryption key from the dev default: set MFA_SECRET or SESSION_SECRET in production");
  }
  return createHash("sha256").update(secret).digest(); // 32 bytes for AES-256
}

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secret: string, account: string): string {
  return new TOTP({ issuer: ISSUER, label: account, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).toString();
}

/** Current 6-digit code for a secret (used by clients/tests; the server verifies). */
export function currentCode(secret: string): string {
  return new TOTP({ issuer: ISSUER, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate();
}

const TOTP_PERIOD = 30;

/** Validate a code and return the ABSOLUTE time-step it matched (for single-use
 *  enforcement), or null if invalid. window:1 → ±30s tolerance (3 steps). */
export function matchTotpStep(secret: string, code: string): number | null {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  const totp = new TOTP({ issuer: ISSUER, algorithm: "SHA1", digits: 6, period: TOTP_PERIOD, secret: Secret.fromBase32(secret) });
  const delta = totp.validate({ token, window: 1 }); // matched offset in steps, or null
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD) + delta;
}

export function verifyTotp(secret: string, code: string): boolean {
  return matchTotpStep(secret, code) !== null;
}

/**
 * AES-256-GCM encrypt, BOUND to `purpose` → "v2:purpose:ivHex:tagHex:cipherHex".
 *
 * The purpose is the GCM additional authenticated data, so a ciphertext written
 * for one slot fails the tag check if presented to another — the swap attack
 * that let one leaked/moved ciphertext become a decryption oracle across
 * users.totp_secret, the AI key and the stock key. randomBytes → randomInt is
 * unrelated; the IV is still a fresh 12 random bytes.
 */
export function encryptSecret(plain: string, purpose: SecretPurpose): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v2:${purpose}:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

export function decryptSecret(encrypted: string, purpose: SecretPurpose): string {
  if (encrypted.startsWith("v2:")) {
    const [, storedPurpose, ivHex, tagHex, ctHex] = encrypted.split(":");
    // A v2 value carries its own purpose; refuse it in the wrong slot BEFORE the
    // tag check, so the error names the mismatch rather than being a generic
    // auth failure.
    if (storedPurpose !== purpose) {
      throw new Error(`Encrypted secret is bound to "${storedPurpose}", refused for "${purpose}"`);
    }
    if (!ivHex || !tagHex || !ctHex) throw new Error("Invalid encrypted secret");
    const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivHex, "hex"));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
  }
  // Legacy (pre-AAD) value: iv:tag:ct, no purpose binding. Still readable so an
  // existing 2FA user isn't locked out and stored keys keep working; re-saving
  // any secret rewrites it as v2. These few legacy values are the only ones a
  // swap could still target — an ops re-encrypt clears the last of them.
  const [ivHex, tagHex, ctHex] = encrypted.split(":");
  if (!ivHex || !tagHex || !ctHex) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const BACKUP_LEN = 10; // 10 chars over 31 symbols ~= 49.5 bits

/** `count` readable one-time codes. randomInt is unbiased — the old `% 31` over
 *  a byte over-weighted the first few symbols. */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = "";
    for (let j = 0; j < BACKUP_LEN; j++) code += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
    codes.push(code);
  }
  return codes;
}

const normalizeBackup = (code: string): string => code.toUpperCase().replace(/\s/g, "");

/** Hash a backup code for storage. argon2id, not SHA-256: a backup code is a
 *  full passwordless login, and a slow salted KDF is what makes a `users` dump
 *  useless offline even at the codes' modest entropy. */
export function hashBackupCode(code: string): Promise<string> {
  return argon2.hash(normalizeBackup(code));
}

/**
 * Find which stored hash a presented code matches, or null. Sequential so only
 * one argon2 verify is in flight at a time. Accepts a LEGACY sha-256 hex hash
 * too (constant-time compared), so a user enrolled before this change keeps
 * their existing codes until they regenerate.
 */
export async function verifyBackupCode(code: string, storedHashes: string[]): Promise<string | null> {
  const normalized = normalizeBackup(code);
  const legacyHex = createHash("sha256").update(normalized).digest("hex");
  for (const hash of storedHashes) {
    if (hash.startsWith("$argon2")) {
      if (await argon2.verify(hash, normalized).catch(() => false)) return hash;
    } else if (hash.length === legacyHex.length && timingSafeEqual(Buffer.from(hash), Buffer.from(legacyHex))) {
      return hash;
    }
  }
  return null;
}
