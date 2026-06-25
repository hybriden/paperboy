import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";

/**
 * TOTP two-factor auth (RFC 6238). Uses the `otpauth`
 * library for codes, the secret AES-256-GCM encrypted at rest, and one-time
 * backup codes stored as sha-256 hashes.
 */

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

/** AES-256-GCM encrypt → "ivHex:tagHex:cipherHex". */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

export function decryptSecret(encrypted: string): string {
  const [ivHex, tagHex, ctHex] = encrypted.split(":");
  if (!ivHex || !tagHex || !ctHex) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

/** 10 readable one-time codes (no ambiguous characters). */
export function generateBackupCodes(count = 10): string[] {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let code = "";
    for (let j = 0; j < 8; j++) code += chars[bytes[j]! % chars.length];
    codes.push(code);
  }
  return codes;
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/\s/g, "")).digest("hex");
}
