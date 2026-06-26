/**
 * Redaction for safe logging. The MCP tool wrapper writes failed-call args to
 * stdout/docker logs (the rule-#6 diagnostic trail); some tools (e.g. create_user)
 * carry cleartext secrets in those args. Mask secret-bearing keys before logging
 * while keeping the rest of the args for diagnosability.
 */

/** Lower-cased keys whose values are secrets and must never reach a log. */
const SECRET_KEYS = new Set([
  "password",
  "newpassword",
  "oldpassword",
  "currentpassword",
  "code",
  "token",
  "secret",
  "apikey",
  "mfa",
  "totp",
  "backupcode",
]);

/** Shallow-redact secret-bearing fields of a plain object. Non-objects (and
 *  arrays) pass through unchanged — args are always a flat record at the call site. */
export function redactForLog(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}
