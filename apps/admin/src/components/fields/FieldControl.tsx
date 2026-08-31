import type { ContentTypeDef, FieldDef } from "@paperboy/shared";
import { numberInputValue } from "../../lib/number-input.js";
import { ImageField } from "../MediaLibrary.js";
import { FieldError } from "../ui/field-error.js";
import { LinkField } from "./LinkField.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { ReferenceField } from "./ReferenceField.js";
import { RichText } from "./RichText.js";

/**
 * The editor for one field, whether it sits on a page or inside a block: ONE
 * switch over the field types, so a block's select honours `multiple` exactly
 * the way a page's does. Content areas stay with the callers — they recurse.
 */
export function FieldControl({
  field,
  id,
  value,
  onChange,
  onCommit,
  disabled,
  types,
  error,
}: {
  field: FieldDef;
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Fired when the editor leaves a text field, for edits that should land
   *  once rather than per keystroke (deriving a form field's key from it). */
  onCommit?: (v: string) => void;
  disabled: boolean;
  /** Installed types, for a select that lists page types (`optionsFromContentTypes`). */
  types: ContentTypeDef[];
  error?: string;
}) {
  const invalid = error ? true : undefined;
  const text = (value as string) ?? "";
  return (
    <div>
      <label className="field-label flex items-center gap-2" htmlFor={id}>
        {field.displayName}
        {field.required && <span className="text-danger" title="Required to publish">*</span>}
        {field.delivery === "private" && <span className="rounded bg-line px-1 text-[10px] text-muted">private</span>}
      </label>
      {field.helpText && <p className="mb-1 text-xs text-muted">{field.helpText}</p>}
      {field.type === "text" && (
        <div>
          <input id={id} aria-label={field.displayName} aria-invalid={invalid} className="field-input" value={text} disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onCommit ? (e) => onCommit(e.target.value) : undefined} />
          {field.validation?.maxLength != null && (
            <div className={`mt-0.5 text-right text-[11px] ${text.length > field.validation.maxLength ? "text-danger" : "text-muted"}`}>
              {text.length} / {field.validation.maxLength}
            </div>
          )}
        </div>
      )}
      {field.type === "markdown" && <MarkdownEditor id={id} value={text} disabled={disabled} onChange={(v) => onChange(v)} />}
      {field.type === "richtext" && <RichText id={id} value={value} onChange={onChange} disabled={disabled} />}
      {field.type === "boolean" && (
        <input id={id} aria-label={field.displayName} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.type === "number" && (
        <input id={id} aria-label={field.displayName} aria-invalid={invalid} type="number" className="field-input" value={(value as number) ?? ""} disabled={disabled}
          onChange={(e) => { const n = numberInputValue(e.target); if (n !== undefined) onChange(n); }} />
      )}
      {field.type === "datetime" && (
        <input id={id} aria-label={field.displayName} aria-invalid={invalid} type="datetime-local" className="field-input" value={text} disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)} />
      )}
      {field.type === "select" && <SelectField id={id} field={field} types={types} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "reference" && <ReferenceField id={id} allowedTypes={field.allowedTypes} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "link" && <LinkField id={id} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "image" && <ImageField id={id} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "media" && (
        <input id={id} aria-label={field.displayName} aria-invalid={invalid} className="field-input" placeholder="Asset documentId" value={text} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} />
      )}
      <FieldError>{error}</FieldError>
    </div>
  );
}

function SelectField({ id, field, types, value, disabled, onChange }: { id: string; field: FieldDef; types: ContentTypeDef[]; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  // optionsFromContentTypes: the dropdown reflects the INSTALLED page content
  // types, not a hardcoded option list. The current value is always shown —
  // even if its type is missing — so a misconfigured page is visible rather
  // than silently blank.
  const options = field.optionsFromContentTypes
    ? (() => {
        const installed = types.filter((t) => t.kind === "page").map((t) => ({ value: t.name, label: t.displayName || t.name }));
        const cur = typeof value === "string" ? value : "";
        if (cur && !installed.some((o) => o.value === cur)) installed.push({ value: cur, label: `${cur} (not installed)` });
        return installed;
      })()
    : field.options;
  if (field.multiple) {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (v: string) => onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={field.displayName}>
        {options.map((o) => (
          <button key={o.value} type="button" disabled={disabled} aria-pressed={arr.includes(o.value)} onClick={() => toggle(o.value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${arr.includes(o.value) ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-line/60"}`}>
            {o.label}
          </button>
        ))}
        {options.length === 0 && <span className="text-xs text-muted">No options configured.</span>}
      </div>
    );
  }
  return (
    <select id={id} className="field-input" value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— choose —</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
