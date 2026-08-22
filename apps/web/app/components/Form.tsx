"use client";

import { type FormField, type FormSpec, fieldAttrs, formTimer, honeypotAttrs } from "@paperboycms/client";
import { useMemo, useRef, useState } from "react";

/**
 * The reference form renderer.
 *
 * Paperboy delivers a form as a SCHEMA, never as markup — so this component is
 * an example a customer copies and restyles, not a black box. Optimizely's first
 * headless forms API returned pre-rendered HTML inside its JSON and frontends
 * could never take control of the markup; the whole point of the spec contract
 * is that this file is yours.
 *
 * What it demonstrates, and what any replacement should keep:
 *
 *  - **Accessible by construction.** Every control has a real `<label for>`;
 *    help and error text are wired through `aria-describedby`; a failed field
 *    gets `aria-invalid`; radio groups are a `<fieldset>` with a `<legend>`;
 *    the error summary is focused on failure so a screen-reader user learns the
 *    submission did not go through (WCAG 3.3.1 / 3.3.3).
 *  - **The server is the authority.** Browser validation is a courtesy; the
 *    endpoint recompiles the rules from the published definition and its
 *    per-field messages are what get displayed.
 *  - **Invisible spam defence.** A honeypot hidden from sight and from
 *    assistive technology, plus the real fill time. No CAPTCHA unless the
 *    editor asked for one.
 */

export interface FormProps {
  /** The delivered form spec (`content.form`). */
  spec: FormSpec;
  /** The Form document's id — where the submission is posted. */
  formId: string;
  /** POSTs to the CMS. Server action or route handler; keeps the key server-side. */
  action: (input: {
    formId: string;
    values: Record<string, unknown>;
    elapsedMs: number;
    honeypot: string;
    turnstileToken?: string;
  }) => Promise<{ ok: true; confirmation: { type: string; text?: unknown } } | { ok: false; fields: Record<string, string> }>;
}

type Status = "editing" | "sending" | "sent";

/** FormData yields `string | File | null`; a File is never a valid answer here. */
function fieldText(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export function Form({ spec, formId, action }: FormProps) {
  const timer = useMemo(() => formTimer(), []);
  const honeypot = honeypotAttrs(spec);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>("editing");
  const summaryRef = useRef<HTMLDivElement>(null);

  const answered = spec.fields.filter((f) => f.kind !== "static" && f.name);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (status === "sending") return;
    const data = new FormData(e.currentTarget);
    const values: Record<string, unknown> = {};
    for (const f of answered) {
      if (f.kind === "checkbox" || f.kind === "consent") values[f.name] = data.get(f.name) != null;
      else values[f.name] = data.get(f.name) ?? "";
    }
    setStatus("sending");
    const res = await action({
      formId,
      values,
      elapsedMs: timer.elapsed(),
      honeypot: fieldText(data.get(honeypot.name)),
      turnstileToken: spec.turnstile ? fieldText(data.get("cf-turnstile-response")) : undefined,
    });
    if (res.ok) {
      setErrors({});
      setStatus("sent");
      return;
    }
    setErrors(res.fields);
    setStatus("editing");
    // Move focus to the summary: without this, a screen-reader user gets no
    // signal at all that the submission failed.
    requestAnimationFrame(() => summaryRef.current?.focus());
  }

  if (status === "sent") {
    return (
      <div className="pb-form pb-form--sent">
        <h2>{spec.title}</h2>
        {/* aria-live so the confirmation is announced, not just painted. */}
        <p role="status" aria-live="polite">
          Thank you — your message has been sent.
        </p>
      </div>
    );
  }

  const summary = Object.entries(errors);

  return (
    <form className="pb-form" onSubmit={onSubmit} noValidate>
      <h2>{spec.title}</h2>

      {summary.length > 0 && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className="pb-form-errors"
          aria-labelledby="pb-form-errors-title"
        >
          <strong id="pb-form-errors-title">Please fix the following:</strong>
          <ul>
            {summary.map(([name, message]) => {
              const field = answered.find((f) => f.name === name);
              return (
                <li key={name}>
                  {field ? <a href={`#${fieldAttrs(field).id}`}>{message}</a> : message}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {spec.fields.map((field, i) => (
        <Field key={field.name || `static-${i}`} field={field} error={errors[field.name]} />
      ))}

      {/* Hidden from sight AND from assistive technology, never focusable. */}
      <div style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}>
        <label htmlFor="pb-hp">Leave this field empty</label>
        <input id="pb-hp" name={honeypot.name} type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      </div>

      {spec.turnstile && <div className="cf-turnstile" data-sitekey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />}

      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : spec.submitLabel}
      </button>
    </form>
  );
}

function Field({ field, error }: { field: FormField; error?: string }): React.ReactElement | null {
  const a = fieldAttrs(field, { error });

  if (field.kind === "static") {
    return (
      <div className="pb-form-static">
        {field.heading && <h3>{field.heading}</h3>}
      </div>
    );
  }

  const help = field.helpText ? (
    <p className="pb-form-help" id={a.helpId}>
      {field.helpText}
    </p>
  ) : null;
  const errorText = error ? (
    <p className="pb-form-error" id={a.errorId}>
      {error}
    </p>
  ) : null;

  // A radio group is a GROUP: the question has to be announced once, which is
  // what fieldset/legend does and a bare label cannot.
  if (field.kind === "radio") {
    return (
      <fieldset className="pb-form-field" aria-describedby={a.describedBy} aria-invalid={error ? true : undefined}>
        <legend>
          {field.label}
          {field.required && <RequiredMark />}
        </legend>
        {help}
        {(field.choices ?? []).map((c) => (
          <label key={c.value} className="pb-form-choice">
            <input type="radio" name={field.name} value={c.value} required={field.required} />
            {c.label}
          </label>
        ))}
        {errorText}
      </fieldset>
    );
  }

  if (field.kind === "checkbox" || field.kind === "consent") {
    return (
      <div className="pb-form-field pb-form-field--check">
        <label htmlFor={a.id}>
          <input {...a.input} type="checkbox" value="true" />
          {field.label}
          {field.required && <RequiredMark />}
        </label>
        {help}
        {errorText}
      </div>
    );
  }

  return (
    <div className="pb-form-field">
      <label htmlFor={a.id}>
        {field.label}
        {field.required && <RequiredMark />}
      </label>
      {help}
      {field.kind === "textarea" ? (
        <textarea {...a.input} rows={field.rows ?? 5} />
      ) : field.kind === "select" ? (
        <select id={a.id} name={field.name} required={field.required} aria-describedby={a.describedBy} aria-invalid={error ? true : undefined}>
          <option value="">Choose…</option>
          {(field.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : (
        <input {...a.input} />
      )}
      {errorText}
    </div>
  );
}

/** Required marked visually AND programmatically — an asterisk alone is not a
 *  signal to a screen reader (the input carries aria-required as well). */
function RequiredMark(): React.ReactElement {
  return (
    <>
      <span aria-hidden="true"> *</span>
      <span className="pb-sr-only"> (required)</span>
    </>
  );
}
