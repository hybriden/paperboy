import {
  HONEYPOT_FIELD,
  MAX_ANSWER_LENGTH,
  MIN_FILL_MS,
  checkSpamHeuristics,
  coerceSubmissionValues,
  fieldSnapshot,
  formSpecFrom,
  parseChoices,
  submissionErrors,
  submissionSchemaFor,
} from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/**
 * Pure unit tests for the form contract in @paperboy/shared — no database, no
 * HTTP. This is the piece every other surface depends on: delivery renders from
 * the spec it builds, and the submit endpoint enforces the schema it compiles.
 */

const form = (fields: { blockType: string; inline: Record<string, unknown> }[], extra: Record<string, unknown> = {}) =>
  formSpecFrom({
    title: "Contact",
    submitLabel: "Send",
    confirmation: "message",
    ...extra,
    fields: fields.map((f, i) => ({ key: `k${i}`, blockType: f.blockType, display: "automatic", ref: null, inline: f.inline })),
  });

describe("parseChoices", () => {
  it("reads one option per line and splits value|Label", () => {
    expect(parseChoices("support|I need help\nsales|Buying\nplain")).toEqual([
      { value: "support", label: "I need help" },
      { value: "sales", label: "Buying" },
      { value: "plain", label: "plain" },
    ]);
  });

  it("ignores blank lines and comments, and never yields an empty value", () => {
    expect(parseChoices("\n# a comment\n  \nreal\n|only-label")).toEqual([
      { value: "real", label: "real" },
      { value: "only-label", label: "only-label" },
    ]);
  });

  it("returns nothing for a non-string", () => {
    expect(parseChoices(undefined)).toEqual([]);
    expect(parseChoices(42)).toEqual([]);
  });
});

describe("formSpecFrom", () => {
  it("keeps the editor's field order", () => {
    const spec = form([
      { blockType: "FormTextField", inline: { name: "a", label: "A" } },
      { blockType: "FormEmailField", inline: { name: "b", label: "B" } },
      { blockType: "FormTextareaField", inline: { name: "c", label: "C" } },
    ]);
    expect(spec.fields.map((f) => f.name)).toEqual(["a", "b", "c"]);
  });

  it("drops a field with no key — it could not store an answer", () => {
    const spec = form([
      { blockType: "FormTextField", inline: { label: "Nameless" } },
      { blockType: "FormTextField", inline: { name: "ok", label: "Fine" } },
    ]);
    expect(spec.fields.map((f) => f.name)).toEqual(["ok"]);
  });

  it("drops a DUPLICATE key rather than letting one answer overwrite the other", () => {
    const spec = form([
      { blockType: "FormTextField", inline: { name: "dup", label: "First" } },
      { blockType: "FormTextField", inline: { name: "dup", label: "Second" } },
    ]);
    expect(spec.fields).toHaveLength(1);
    expect(spec.fields[0]!.label).toBe("First");
  });

  it("ignores a block that isn't a form field", () => {
    const spec = form([
      { blockType: "HeroBlock", inline: { title: "Not a field" } },
      { blockType: "FormTextField", inline: { name: "ok", label: "Fine" } },
    ]);
    expect(spec.fields.map((f) => f.name)).toEqual(["ok"]);
  });

  it("forces consent to be required whatever the editor set", () => {
    const spec = form([{ blockType: "FormConsentField", inline: { name: "c", label: "I agree", required: false } }]);
    expect(spec.fields[0]!.required).toBe(true);
  });

  it("keeps static text as a field with no name", () => {
    const spec = form([{ blockType: "FormStaticText", inline: { heading: "Section" } }]);
    expect(spec.fields[0]).toMatchObject({ kind: "static", name: "", heading: "Section" });
  });

  it("reads the delivered shape (`data`) as well as the stored one (`inline`)", () => {
    // Delivery serializes an inline block as { blockType, data }, and the spec is
    // computed on both sides of that boundary.
    const spec = formSpecFrom({
      title: "T",
      fields: [{ key: "k", blockType: "FormTextField", display: "automatic", data: { name: "x", label: "X" } }],
    });
    expect(spec.fields.map((f) => f.name)).toEqual(["x"]);
  });

  it("reads the delivered SHARED shape, and asks the resolver for a shallow entry", () => {
    // Delivery serializes a shared field block as { shared:true, content } — the
    // resolved item at populate ≥ 1, a shallow { documentId, type } at populate 0.
    // A form whose consent box is a shared block delivered a spec without it, so
    // the submit validator accepted a submission with no consent.
    const spec = formSpecFrom(
      {
        title: "T",
        fields: [
          {
            key: "a",
            blockType: "FormConsentField",
            display: "automatic",
            shared: true,
            content: { documentId: "c1", type: "FormConsentField", kind: "block", data: { name: "consent", label: "I agree" } },
          },
          { key: "b", blockType: "FormTextField", display: "automatic", shared: true, content: { documentId: "t1", type: "FormTextField" } },
        ],
      },
      { sharedBlock: (id) => (id === "t1" ? { blockType: "FormTextField", data: { name: "note", label: "Note" } } : undefined) },
    );
    expect(spec.fields.map((f) => f.name)).toEqual(["consent", "note"]);
    expect(spec.fields[0]).toMatchObject({ kind: "consent", required: true });
  });

  it("resolves a STORED shared reference ({ref, inline:null}) through the resolver", () => {
    const spec = formSpecFrom(
      { title: "T", fields: [{ key: "a", blockType: "FormConsentField", display: "automatic", ref: "c1", inline: null }] },
      { sharedBlock: (id) => (id === "c1" ? { blockType: "FormConsentField", data: { name: "consent", label: "I agree" } } : undefined) },
    );
    expect(spec.fields.map((f) => f.name)).toEqual(["consent"]);
  });

  it("drops a shared reference the resolver cannot see (unpublished, trashed, another site)", () => {
    const spec = formSpecFrom(
      { title: "T", fields: [{ key: "a", blockType: "FormConsentField", display: "automatic", ref: "gone", inline: null }] },
      { sharedBlock: () => undefined },
    );
    expect(spec.fields).toEqual([]);
  });

  it("defaults the submit label and exposes the spam contract", () => {
    const spec = form([]);
    expect(spec.submitLabel).toBe("Send");
    expect(spec.honeypotField).toBe(HONEYPOT_FIELD);
    expect(spec.minFillMs).toBe(MIN_FILL_MS);
    expect(spec.turnstile).toBe(false);
  });

  it("turns on Turnstile only when the editor asked for it", () => {
    expect(form([], { spamProtection: "heuristics+turnstile" }).turnstile).toBe(true);
    expect(form([], { spamProtection: "heuristics" }).turnstile).toBe(false);
  });
});

describe("submissionSchemaFor", () => {
  const spec = form([
    { blockType: "FormTextField", inline: { name: "name", label: "Name", required: true, minLength: 2, maxLength: 10 } },
    { blockType: "FormEmailField", inline: { name: "email", label: "Email", required: true } },
    { blockType: "FormNumberField", inline: { name: "age", label: "Age", min: 18, max: 120 } },
    { blockType: "FormSelectField", inline: { name: "topic", label: "Topic", choices: "a|A\nb|B" } },
    { blockType: "FormConsentField", inline: { name: "consent", label: "I agree" } },
    { blockType: "FormTextField", inline: { name: "phone", label: "Phone", pattern: "^\\+?[0-9]{6,}$", errorMessage: "Enter a phone number with country code." } },
  ]);
  const parse = (values: Record<string, unknown>) =>
    submissionSchemaFor(spec).safeParse(coerceSubmissionValues(spec, values));

  const valid = { name: "Ada", email: "ada@example.com", consent: true };

  it("accepts a valid submission", () => {
    expect(parse(valid).success).toBe(true);
  });

  it("requires the required fields", () => {
    const res = parse({ email: "ada@example.com", consent: true });
    expect(res.success).toBe(false);
    expect(Object.keys(submissionErrors(res.error!))).toContain("name");
  });

  it("uses the editor's own error copy when a required field is ABSENT, not just empty", () => {
    // Found while building the demo site: the editor wrote a message, the visitor
    // got "Invalid input: expected string, received undefined". An omitted key
    // failed the TYPE check before the presence refine could run, so the copy the
    // editor wrote was never reached — the one case where a helpful message
    // matters most, since the field is the one they forgot.
    const withCopy = form([
      { blockType: "FormTextField", inline: { name: "message", label: "Message", required: true, errorMessage: "A sentence or two is plenty." } },
    ]);
    const res = submissionSchemaFor(withCopy).safeParse({});
    expect(res.success).toBe(false);
    expect(submissionErrors(res.error!).message).toBe("A sentence or two is plenty.");
  });

  it("treats an empty string as missing for a required field", () => {
    const res = parse({ ...valid, name: "" });
    expect(res.success).toBe(false);
  });

  it("treats an empty string as UNANSWERED for an optional field", () => {
    // The other half of the case above, and the half that shipped broken. A
    // browser submits every control it renders, so an optional field the visitor
    // skipped arrives as "": apps/web sends `data.get(name) ?? ""` for every
    // non-checkbox field and its select's placeholder option is value="".
    // `.optional().nullable()` accepts undefined and null but NOT "", so an
    // optional email, number, select or pattern field made the whole form
    // unsubmittable — 422 on every attempt, with a message that never said the
    // field was optional.
    const res = parse({ ...valid, age: "", topic: "", phone: "" });
    expect(res.success, JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("records a skipped optional field as absent, not as an empty string", () => {
    // A blank answer is "not answered". Persisting "" in a number slot would be
    // a type lie in the record that field_snapshot freezes as evidence.
    const res = parse({ ...valid, age: "", topic: "" });
    expect(res.success).toBe(true);
    expect("age" in (res.data as Record<string, unknown>)).toBe(false);
    expect("topic" in (res.data as Record<string, unknown>)).toBe(false);
  });

  it("still rejects an unknown key when its value is blank", () => {
    // Blank-means-unanswered must not become a hole in the strict rule: an
    // unknown key is stale or hostile whatever it carries.
    const res = parse({ ...valid, surprise: "" });
    expect(res.success).toBe(false);
  });

  it("enforces the editor's length rules", () => {
    expect(parse({ ...valid, name: "A" }).success).toBe(false);
    expect(parse({ ...valid, name: "A".repeat(11) }).success).toBe(false);
  });

  it("validates an email address", () => {
    const res = parse({ ...valid, email: "not-an-email" });
    expect(res.success).toBe(false);
    expect(submissionErrors(res.error!).email).toMatch(/valid email/i);
  });

  it("uses the editor's own error message when they wrote one (WCAG 3.3.3)", () => {
    const res = parse({ ...valid, phone: "abc" });
    expect(submissionErrors(res.error!).phone).toBe("Enter a phone number with country code.");
  });

  it("enforces a number range and coerces the string a form actually sends", () => {
    expect(parse({ ...valid, age: "42" }).success).toBe(true);
    expect(parse({ ...valid, age: "17" }).success).toBe(false);
    expect(parse({ ...valid, age: "not a number" }).success).toBe(false);
  });

  it("only accepts options the editor defined", () => {
    expect(parse({ ...valid, topic: "a" }).success).toBe(true);
    expect(parse({ ...valid, topic: "z" }).success).toBe(false);
  });

  it("refuses an unticked consent box", () => {
    expect(parse({ ...valid, consent: false }).success).toBe(false);
    expect(parse({ name: "Ada", email: "ada@example.com" }).success).toBe(false);
  });

  it("REJECTS an unknown field rather than storing or dropping it", () => {
    const res = parse({ ...valid, role: "admin" });
    expect(res.success).toBe(false);
  });

  it("survives an unparseable stored pattern instead of failing every visitor", () => {
    const broken = form([{ blockType: "FormTextField", inline: { name: "x", label: "X", pattern: "([unclosed" } }]);
    expect(submissionSchemaFor(broken).safeParse({ x: "anything" }).success).toBe(true);
  });

  describe("date", () => {
    const dates = form([
      { blockType: "FormDateField", inline: { name: "when", label: "When", required: true } },
      { blockType: "FormDateField", inline: { name: "until", label: "Until" } },
    ]);
    const parseDates = (values: Record<string, unknown>) =>
      submissionSchemaFor(dates).safeParse(coerceSubmissionValues(dates, values));

    it("accepts an ISO date (what <input type=date> posts) and a date-time", () => {
      expect(parseDates({ when: "2026-05-31" }).success).toBe(true);
      expect(parseDates({ when: "2026-05-31T09:00" }).success).toBe(true);
    });

    it("rejects a value that is clearly not a date", () => {
      // Date.parse("1") is a valid instant in V8 (year 2001), so a lone digit
      // used to be stored as an answer to "When?".
      for (const bad of ["1", "next tuesday", "31/05/2026", "2026-13-45"]) {
        expect(parseDates({ when: bad }).success, bad).toBe(false);
      }
    });

    it("blank: rejected when required, unanswered when optional", () => {
      expect(parseDates({ when: "" }).success).toBe(false);
      const res = parseDates({ when: "2026-05-31", until: "" });
      expect(res.success).toBe(true);
      expect("until" in (res.data as Record<string, unknown>)).toBe(false);
    });
  });

  describe("checkbox", () => {
    const boxes = form([
      { blockType: "FormCheckboxField", inline: { name: "must", label: "Must", required: true } },
      { blockType: "FormCheckboxField", inline: { name: "may", label: "May" } },
    ]);
    const parseBoxes = (values: Record<string, unknown>) =>
      submissionSchemaFor(boxes).safeParse(coerceSubmissionValues(boxes, values));

    it("accepts a ticked box in boolean and browser spellings", () => {
      expect(parseBoxes({ must: true }).success).toBe(true);
      expect(parseBoxes({ must: "on" }).success).toBe(true);
    });

    it("rejects an unticked or absent REQUIRED box", () => {
      expect(parseBoxes({ must: false }).success).toBe(false);
      expect(parseBoxes({ must: "" }).success).toBe(false);
      expect(parseBoxes({}).success).toBe(false);
    });

    it("accepts an unticked or absent OPTIONAL box", () => {
      expect(parseBoxes({ must: true, may: false }).success).toBe(true);
      expect(parseBoxes({ must: true, may: "" }).success).toBe(true);
      expect(parseBoxes({ must: true }).success).toBe(true);
    });

    it("rejects a value that is neither ticked nor unticked", () => {
      expect(parseBoxes({ must: true, may: "maybe" }).success).toBe(false);
    });
  });

  describe("radio", () => {
    const radios = form([
      { blockType: "FormRadioField", inline: { name: "size", label: "Size", required: true, choices: "s|Small\nl|Large" } },
      { blockType: "FormRadioField", inline: { name: "colour", label: "Colour", choices: "red\nblue" } },
    ]);
    const parseRadios = (values: Record<string, unknown>) =>
      submissionSchemaFor(radios).safeParse(coerceSubmissionValues(radios, values));

    it("accepts a declared option and rejects an undeclared one", () => {
      expect(parseRadios({ size: "s" }).success).toBe(true);
      expect(parseRadios({ size: "xl" }).success).toBe(false);
      expect(parseRadios({ size: "l", colour: "blue" }).success).toBe(true);
      expect(parseRadios({ size: "l", colour: "green" }).success).toBe(false);
    });

    it("blank: rejected when required, unanswered when optional", () => {
      expect(parseRadios({ size: "" }).success).toBe(false);
      const res = parseRadios({ size: "s", colour: "" });
      expect(res.success).toBe(true);
      expect("colour" in (res.data as Record<string, unknown>)).toBe(false);
    });
  });

  describe("length boundaries", () => {
    const lengths = form([
      { blockType: "FormTextField", inline: { name: "capped", label: "Capped", maxLength: 10 } },
      { blockType: "FormTextField", inline: { name: "floored", label: "Floored", minLength: 2 } },
      { blockType: "FormTextareaField", inline: { name: "open", label: "Open" } },
    ]);
    const parseLengths = (values: Record<string, unknown>) =>
      submissionSchemaFor(lengths).safeParse(coerceSubmissionValues(lengths, values));

    it("maxLength is inclusive: exactly 10 passes, 11 fails", () => {
      expect(parseLengths({ capped: "A".repeat(10) }).success).toBe(true);
      expect(parseLengths({ capped: "A".repeat(11) }).success).toBe(false);
    });

    it("minLength is inclusive: 1 fails, 2 passes", () => {
      expect(parseLengths({ floored: "A" }).success).toBe(false);
      expect(parseLengths({ floored: "AB" }).success).toBe(true);
    });

    it("a field without maxLength is capped at MAX_ANSWER_LENGTH (5000)", () => {
      expect(MAX_ANSWER_LENGTH).toBe(5000);
      expect(parseLengths({ open: "A".repeat(5000) }).success).toBe(true);
      expect(parseLengths({ open: "A".repeat(5001) }).success).toBe(false);
    });
  });
});

describe("coerceSubmissionValues", () => {
  const spec = form([
    { blockType: "FormTextField", inline: { name: "name", label: "Name" } },
    { blockType: "FormNumberField", inline: { name: "n", label: "N" } },
    { blockType: "FormCheckboxField", inline: { name: "ok", label: "OK" } },
  ]);

  it("trims text, numbers numbers, and reads a checkbox's 'on'", () => {
    expect(coerceSubmissionValues(spec, { name: "  Ada  ", n: "7", ok: "on" })).toEqual({
      name: "Ada",
      n: 7,
      ok: true,
    });
  });

  it("leaves an ambiguous value alone so validation can reject it", () => {
    // Guessing here would be the meaning-destroying coercion rule #1 forbids.
    expect(coerceSubmissionValues(spec, { n: "twelve" }).n).toBe("twelve");
  });

  it("treats an absent checkbox as false, not missing", () => {
    expect(coerceSubmissionValues(spec, { ok: "" }).ok).toBe(false);
  });

  it("keeps unknown keys so the strict schema can reject them", () => {
    expect(coerceSubmissionValues(spec, { surprise: 1 })).toHaveProperty("surprise");
  });

  it("reads every spelling of a ticked box, case-insensitively", () => {
    // A checkbox posted as value="1" was stored as FALSE with a 202, and a
    // required consent posted as "1" failed "Please confirm" although ticked.
    for (const v of ["1", "true", "yes", "on", "TRUE", " on "]) {
      expect(coerceSubmissionValues(spec, { ok: v }).ok, JSON.stringify(v)).toBe(true);
    }
  });

  it("reads every spelling of an unticked box", () => {
    for (const v of ["0", "false", "off", "", "no"]) {
      expect(coerceSubmissionValues(spec, { ok: v }).ok, JSON.stringify(v)).toBe(false);
    }
  });

  it("leaves an ambiguous checkbox value alone so the validator rejects it, keyed by field", () => {
    const coerced = coerceSubmissionValues(spec, { ok: "maybe" });
    expect(coerced.ok).toBe("maybe");
    const res = submissionSchemaFor(spec).safeParse(coerced);
    expect(res.success).toBe(false);
    expect(submissionErrors(res.error!).ok).toMatch(/ticked or left unticked/);
  });
});

describe("checkSpamHeuristics", () => {
  it("rejects a filled honeypot", () => {
    expect(checkSpamHeuristics({ honeypot: "buy pills" })).toEqual({ ok: false, reason: "honeypot" });
  });

  it("accepts an empty or whitespace honeypot", () => {
    expect(checkSpamHeuristics({ honeypot: "" }).ok).toBe(true);
    expect(checkSpamHeuristics({ honeypot: "   " }).ok).toBe(true);
  });

  it("rejects an implausibly fast submission", () => {
    expect(checkSpamHeuristics({ elapsedMs: 50 })).toEqual({ ok: false, reason: "too_fast" });
  });

  it("accepts a human-paced one", () => {
    expect(checkSpamHeuristics({ elapsedMs: MIN_FILL_MS + 1 }).ok).toBe(true);
  });

  it("accepts a MISSING timer — a JS-disabled visitor is not a bot", () => {
    expect(checkSpamHeuristics({}).ok).toBe(true);
    expect(checkSpamHeuristics({ elapsedMs: "nonsense" }).ok).toBe(true);
  });
});

describe("fieldSnapshot", () => {
  it("freezes the label and kind of every answering field", () => {
    const spec = form([
      { blockType: "FormTextField", inline: { name: "name", label: "Your name" } },
      { blockType: "FormConsentField", inline: { name: "consent", label: "I agree to the terms" } },
      { blockType: "FormStaticText", inline: { heading: "Ignored" } },
    ]);
    expect(fieldSnapshot(spec)).toEqual([
      { name: "name", label: "Your name", kind: "text" },
      { name: "consent", label: "I agree to the terms", kind: "consent" },
    ]);
  });
});
