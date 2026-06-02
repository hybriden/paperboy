import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";

/**
 * TOTP two-factor auth (RFC 6238). Uses the `otpauth`
 * library for codes, the secret AES-256-GCM encrypted at rest, and one-time
 * backup codes stored as sha-256 hashes.
 */

const ISSUER = "Paperboy";

/** Stable key for encrypting TOTP secrets at rest (derived from the app secret). */
function encKey(): Buffer {
  const secret = process.env.MFA_SECRET ?? process.env.SESSION_SECRET ?? "dev-mfa-secret-change-me-please-32x";
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

export function verifyTotp(secret: string, code: string): boolean {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  const totp = new TOTP({ issuer: ISSUER, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });
  return totp.validate({ token, window: 1 }) !== null; // ±30s tolerance
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
