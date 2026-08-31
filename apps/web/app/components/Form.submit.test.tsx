// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSpec } from "@paperboycms/client";
import { Form, type FormProps } from "./Form";

// Interactive behaviour (a real submit, a real failed response) — SSR markup
// can't exercise it, so this file runs in a DOM.
const spec: FormSpec = {
  title: "Contact",
  fields: [
    { kind: "text", name: "fullName", label: "Your name", required: true },
    { kind: "radio", name: "color", label: "Colour", required: true, choices: [{ value: "r", label: "Red" }, { value: "b", label: "Blue" }] },
  ],
  submitLabel: "Send",
  confirmation: "message",
  turnstile: false,
  honeypotField: "pb_contact_reason",
  minFillMs: 0,
};
const rejected = { ok: false as const, fields: { fullName: "Required", color: "Pick one" } };
const accepted = { ok: true as const, confirmation: { type: "message" } };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount(action: FormProps["action"]): Promise<HTMLFormElement> {
  await act(async () => root.render(<Form spec={spec} formId="f1" action={action} />));
  return container.querySelector("form")!;
}
const submit = (form: HTMLFormElement) =>
  act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("Form — submit", () => {
  it("sends ONE idempotency key per form instance, and mints a new one after success", async () => {
    // The action minted a fresh key per invocation, so a retry of the same
    // attempt never deduplicated — the opposite of what the key is for.
    const mint = vi.spyOn(crypto, "randomUUID");
    const action = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce(rejected).mockResolvedValueOnce(accepted);
    const form = await mount(action);
    expect(mint).toHaveBeenCalledTimes(1);

    await submit(form);
    await submit(form);
    const keys = action.mock.calls.map(([input]) => (input as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toMatch(/\S/);
    expect(keys[1]).toBe(keys[0]);
    expect(mint).toHaveBeenCalledTimes(1);

    await submit(form);
    expect(mint).toHaveBeenCalledTimes(2); // success → the next submission is a new one
  });

  it("marks a failed radio question invalid on a radiogroup — the one role that supports aria-invalid", async () => {
    // aria-invalid sat on the bare fieldset (role group), which ARIA 1.2 does not
    // support; nor does `radio`. `radiogroup` does.
    const form = await mount(vi.fn().mockResolvedValue(rejected));
    await submit(form);
    const fieldset = container.querySelector("fieldset")!;
    expect(fieldset.getAttribute("role")).toBe("radiogroup");
    expect(fieldset.getAttribute("aria-invalid")).toBe("true");
    for (const radio of container.querySelectorAll('input[type="radio"]')) expect(radio.hasAttribute("aria-invalid")).toBe(false);
  });
});
