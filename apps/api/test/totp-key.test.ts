import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@paperboy/db";

// S2-H3: docker-compose sets `MFA_SECRET: ${MFA_SECRET:-}` → the env var is the
// EMPTY STRING. `??` only falls through on null/undefined, so the old code derived
// the AES key from sha256("") — a public constant. It must treat "" as unset and
// fall back to SESSION_SECRET.
const save = { MFA_SECRET: process.env.MFA_SECRET, SESSION_SECRET: process.env.SESSION_SECRET };
afterEach(() => {
  if (save.MFA_SECRET === undefined) delete process.env.MFA_SECRET;
  else process.env.MFA_SECRET = save.MFA_SECRET;
  if (save.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = save.SESSION_SECRET;
});

describe("TOTP-secret encryption key (MFA_SECRET)", () => {
  it("treats an empty MFA_SECRET as unset and falls back to SESSION_SECRET (not sha256(''))", () => {
    process.env.SESSION_SECRET = "session-secret-used-for-totp-key-xyz";
    process.env.MFA_SECRET = ""; // the docker-compose default
    const ct = encryptSecret("JBSWY3DPEHPK3PXP");
    // The intended key is sha256(SESSION_SECRET). Set MFA_SECRET explicitly to the
    // same value and the ciphertext written under the empty default must decrypt.
    process.env.MFA_SECRET = "session-secret-used-for-totp-key-xyz";
    expect(decryptSecret(ct)).toBe("JBSWY3DPEHPK3PXP");
  });
});
