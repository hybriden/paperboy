import { useId, useState } from "react";
import { fieldKeyFromLabel, fieldSpecFromBlock, parseChoices } from "@paperboy/shared";
import type { BlockInstance, ContentTypeDef, FieldDef, FormFieldSpec } from "@paperboy/shared";
import { Icon } from "../../lib/icons.js";

/**
 * The forms builder's question editor: a purpose-built arrangement of a form
 * field block's OWN fields (FORMS_PLAN.md §9 still governs — same storage,
 * same ordering, no parallel model; this is presentation over the identical
 * BlockInstance).
 *
 * Essentials first (Label, Required, the type's extras), the technical half
 * (submission key, length/pattern rules, error copy) behind a disclosure —
 * a question is its label and whether it's required 95% of the time. The
 * visitor-eye preview at the top renders from `fieldSpecFromBlock`, the same
 * function delivery compiles specs with, so the preview can't drift from what
 * the frontend will actually receive.
 */

/** Essentials, in the order an editor thinks about a question. Anything a
 *  future field type adds lands here too (unknown-name fallthrough), so a new
 *  knob is never silently hidden behind the disclosure. */
const ESSENTIALS = ["label", "required", "choices", "placeholder", "helpText", "rows", "min", "max", "heading", "text"];
/** The technical half: the storage key and the answer's validation contract. */
const RULES = ["name", "minLength", "maxLength", "pattern", "errorMessage"];

interface Props {
  type: ContentTypeDef;
  block: BlockInstance;
  disabled: boolean;
  onUpdate: (patch: Partial<BlockInstance>) => void;
  /** ContentArea's generic leaf editor (keeps the label→key commit wiring and
   *  on-page-editing attributes in their one home). `custom` swaps the inner
   *  control while keeping that wrapper — how the choices editor stays wired
   *  for on-page-editing focus like every other field. */
  renderField: (f: FieldDef, custom?: React.ReactNode) => React.ReactNode;
}

export function FormQuestionEditor({ type, block, disabled, onUpdate, renderField }: Props) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const inline = block.inline ?? {};

  // The key answers are stored under: the saved one, else what leaving the
  // Label will derive (the editor should never have to guess).
  const storedKey = typeof inline.name === "string" ? inline.name.trim() : "";
  const keyPreview = storedKey || fieldKeyFromLabel(typeof inline.label === "string" ? inline.label : "");

  // fieldSpecFromBlock is the DELIVERY compiler, which rightly drops a field
  // with no key (it can't store an answer). A question mid-authoring has no
  // key until the label commits — substitute the derived one so the preview
  // shows the work in progress; nothing is written.
  const spec = fieldSpecFromBlock(block.blockType, { ...inline, name: keyPreview || "draft" });

  const byName = new Map(type.fields.map((f) => [f.name, f]));
  const ruleSet = new Set(RULES);
  const essentials = [
    ...ESSENTIALS.flatMap((n) => byName.get(n) ?? []),
    ...type.fields.filter((f) => !ESSENTIALS.includes(f.name) && !ruleSet.has(f.name)),
  ];
  const rules = RULES.flatMap((n) => byName.get(n) ?? []);

  return (
    <div className="space-y-5">
      {spec && <QuestionPreview spec={spec} />}

      {essentials.map((f) =>
        f.name === "choices"
          ? renderField(
              f,
              <ChoicesEditor
                field={f}
                value={inline.choices}
                disabled={disabled}
                onChange={(v) => onUpdate({ inline: { ...block.inline, choices: v } })}
              />,
            )
          : renderField(f),
      )}

      {byName.has("name") && keyPreview && (
        <p data-testid="question-key" className="text-xs text-muted">
          Answers are stored under <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-fg">{keyPreview}</code>
          {!storedKey && " (derived from the label when you leave it)"}
        </p>
      )}

      {rules.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={rulesOpen}
            onClick={() => setRulesOpen((o) => !o)}
            className="flex items-center gap-1.5 text-[13px] font-medium text-fg"
          >
            <Icon.Chevron width={14} height={14} className={`text-muted transition-transform ${rulesOpen ? "rotate-90" : ""}`} />
            Answer rules &amp; key
          </button>
          {rulesOpen && (
            <div className="mt-3 space-y-5 rounded-(--radius) border border-line bg-canvas/50 p-3">
              {rules.map((f) => renderField(f))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the visitor will see, rendered from the delivery spec. Deliberately
 * DIVS styled as controls, not real inputs: it is a picture, never a control
 * (no focus, no labels-for-inputs machinery), and aria-hidden because every
 * value it mirrors is editable right below.
 */
function QuestionPreview({ spec }: { spec: FormFieldSpec }) {
  const boxKinds = new Set(["checkbox", "consent"]);
  return (
    <div data-testid="question-preview" className="rounded-(--radius) border border-line bg-canvas/60 px-3 pb-3 pt-2">
      <p className="eyebrow mb-2 text-[10px]">As the visitor sees it</p>
      <div aria-hidden>
        {spec.kind === "static" ? (
          <>
            {spec.heading && <p className="text-sm font-semibold text-fg">{spec.heading}</p>}
            <p className="text-xs italic text-muted">Text between questions — collects no answer.</p>
          </>
        ) : boxKinds.has(spec.kind) ? (
          <span className="flex items-start gap-2 text-sm text-fg">
            <span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-line bg-panel" />
            <span>
              {spec.label || "…"}
              {spec.required && <span className="text-danger"> *</span>}
            </span>
          </span>
        ) : (
          <>
            <p className="text-sm font-medium text-fg">
              {spec.label || "…"}
              {spec.required && <span className="text-danger"> *</span>}
            </p>
            <PreviewControl spec={spec} />
          </>
        )}
        {spec.helpText && <p className="mt-1 text-xs text-muted">{spec.helpText}</p>}
      </div>
    </div>
  );
}

function PreviewControl({ spec }: { spec: FormFieldSpec }) {
  const ghost = <span className="text-muted/70">{spec.placeholder ?? ""}</span>;
  if (spec.kind === "textarea") {
    return (
      <div className="field-textarea mt-1.5 bg-panel" style={{ minHeight: `${Math.min(spec.rows ?? 5, 6) * 1.4}rem` }}>
        {ghost}
      </div>
    );
  }
  if (spec.kind === "select") {
    return (
      <div className="field-input mt-1.5 justify-between bg-panel">
        <span className="text-muted/70">{spec.placeholder ?? "Choose…"}</span>
        <Icon.ChevronDown width={12} height={12} className="text-muted" />
      </div>
    );
  }
  if (spec.kind === "radio") {
    const shown = (spec.choices ?? []).slice(0, 4);
    return (
      <div className="mt-1.5 space-y-1">
        {shown.length === 0 && <p className="text-xs italic text-muted">Add options below.</p>}
        {shown.map((c, i) => (
          <span key={`${c.value}-${i}`} className="flex items-center gap-2 text-sm text-fg">
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-line bg-panel" />
            {c.label}
          </span>
        ))}
        {(spec.choices?.length ?? 0) > shown.length && (
          <p className="text-xs text-muted">+ {(spec.choices?.length ?? 0) - shown.length} more</p>
        )}
      </div>
    );
  }
  return <div className="field-input mt-1.5 bg-panel">{ghost}</div>;
}

/**
 * Options for dropdowns and radio groups: the same one-line-per-option
 * `value|Label` text the delivery parser reads (`parseChoices` IS that parser,
 * so the chips below are exactly the options the visitor will get) — in a
 * plain textarea instead of the markdown editor that used to render a
 * formatting toolbar over option lines.
 */
function ChoicesEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const raw = typeof value === "string" ? value : "";
  const choices = parseChoices(raw);
  const values = choices.map((c) => c.value);
  const dupes = [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
  // A line starting or ending with "|" is a half-typed split: parseChoices
  // coalesces it (one side becomes BOTH value and label), which is absorbing
  // but rarely what the bar meant — detectable only on the raw lines, since
  // the parsed choice looks like any bare-line option.
  const halfBar = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && (l.startsWith("|") || l.endsWith("|"))).length;

  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {field.displayName}
      </label>
      <textarea
        id={id}
        className="field-textarea"
        rows={Math.min(Math.max(3, raw.split("\n").length + 1), 10)}
        value={raw}
        disabled={disabled}
        placeholder={"One option per line\nvalue|Label stores value, shows Label"}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.helpText && <p className="mt-1 text-xs text-muted">{field.helpText}</p>}
      {choices.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted">Visitors choose from:</span>
          {choices.map((c, i) => (
            <span
              key={`${c.value}-${i}`}
              data-testid="option-chip"
              title={c.value === c.label ? undefined : `stored as “${c.value}”`}
              className="rounded-full border border-line bg-canvas px-2 py-0.5 text-xs text-fg"
            >
              {c.label}
            </span>
          ))}
        </div>
      )}
      {dupes.length > 0 && (
        <p role="alert" className="mt-1 text-xs text-danger">
          Duplicate stored value{dupes.length > 1 ? "s" : ""}: {dupes.join(", ")} — each option must store a unique value.
        </p>
      )}
      {halfBar > 0 && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {halfBar} line{halfBar > 1 ? "s start" : " starts"} or end{halfBar > 1 ? "" : "s"} with “|” — the other side is
          used as both value and label. Write “value|Label”, or a bare line for the same text as both.
        </p>
      )}
    </div>
  );
}
