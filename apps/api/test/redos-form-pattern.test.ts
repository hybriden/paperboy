import { submissionSchemaFor } from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/**
 * An editor-supplied form-field `pattern` is compiled into the validator the
 * PUBLIC submit endpoint runs against anonymous visitor input. A
 * catastrophic-backtracking pattern (accidental or malicious) would block the
 * event loop for the whole instance on one anonymous request — the answer-length
 * cap does NOT save it (backtracking is exponential in the input, and Zod runs
 * the `.regex()` check even after `.max()` fails). The fix drops a
 * ReDoS-unsafe pattern (never compiles it into the hot path), exactly as it
 * already drops a syntactically-invalid one.
 */
const spec = (pattern: string) =>
  ({
    documentId: "d",
    fields: [{ name: "code", kind: "text", label: "Code", required: false, pattern }],
  }) as never;

describe("form-field pattern is ReDoS-safe (P?-review)", () => {
  it("does not hang on a catastrophic pattern — it is dropped, so the input is accepted fast", () => {
    // `(a+)+$` against many 'a's followed by a non-match is the classic
    // exponential blowup. If the pattern were compiled and applied, THIS parse
    // would hang for seconds→minutes and blow the test timeout (red pre-fix).
    const schema = submissionSchemaFor(spec("(a+)+$"));
    const evil = "a".repeat(40) + "!";
    const started = Date.now();
    const res = schema.safeParse({ code: evil });
    // Dropped pattern → no format constraint → the answer is accepted.
    expect(res.success).toBe(true);
    // And it returned effectively instantly, proving the regex never ran.
    expect(Date.now() - started).toBeLessThan(500);
  }, 4000);

  it("still enforces a SAFE pattern (linear, no nested quantifiers)", () => {
    const schema = submissionSchemaFor(spec("^[0-9]{3}$"));
    expect(schema.safeParse({ code: "abc" }).success).toBe(false); // enforced
    expect(schema.safeParse({ code: "123" }).success).toBe(true);
  });
});
