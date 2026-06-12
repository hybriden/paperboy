import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ContentTypeDef, SEO_FIELD_NAMES, type ContentKind, type FieldOption, type FieldType, type FieldValidation, type SchemaFieldGap, type SchemaFieldSuggestion, resolveSchemaSuggestions, schemaFieldGaps, seoRoleEligible } from "@paperboy/shared";
import { api, ApiError } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { AI_OFF_HINT, useAiEnabled } from "../lib/useAiStatus.js";
import { TypeIcon, resolveIconBase, usePhosphorIconNames } from "../lib/typeIcons.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { Switch } from "./ui/switch.js";
import { useToast } from "./ui/toast.js";

const FIELD_TYPES: FieldType[] = ["text", "richtext", "boolean", "number", "datetime", "select", "link", "image", "reference", "contentArea"];
const KINDS: ContentKind[] = ["page", "block", "global"];

interface DraftField {
  _key: string;
  name: string;
  displayName: string;
  type: FieldType;
  localized: boolean;
  required: boolean;
  delivery: "public" | "private";
  group: string;
  allowedBlocks: string[];
  allowedTypes: string[];
  options: FieldOption[];
  multiple: boolean;
  validation?: FieldValidation;
  helpText?: string;
  seoRole?: "title" | "description" | "image" | "datePublished" | "dateModified" | "author" | "keywords";
  /** schema.org property this field feeds in the delivered JSON-LD (e.g. "startDate", "offers.price"). */
  schemaProp?: string;
}

const SEO_ROLES = ["title", "description", "image", "datePublished", "dateModified", "author", "keywords"] as const;
const SEO_ROLE_LABELS: Record<(typeof SEO_ROLES)[number], string> = {
  title: "Title",
  description: "Description",
  image: "Image (Open Graph)",
  datePublished: "Published date",
  dateModified: "Modified date",
  author: "Author",
  keywords: "Keywords",
};
// Field-type eligibility per SEO role comes from @paperboy/shared
// (seoRoleEligible), shared with the catalog's coverage computation.

// Common page-level schema.org @types for the dropdown. The stored value stays
// a free string (MCP can set any @type); this is just discoverable admin UX.
const SCHEMA_TYPES = [
  "WebPage",
  "Article",
  "BlogPosting",
  "NewsArticle",
  "CollectionPage",
  "AboutPage",
  "ContactPage",
  "FAQPage",
  "Product",
  "Event",
] as const;

let uid = 0;
const newField = (): DraftField => ({
  _key: `nf${uid++}`,
  name: "",
  displayName: "",
  type: "text",
  localized: false,
  required: false,
  delivery: "private",
  group: "Content",
  allowedBlocks: [],
  allowedTypes: [],
  options: [],
  multiple: false,
});

/** Visual icon picker: trigger shows the current icon; the popover is a searchable
 *  grid over the FULL Phosphor duotone set (~1.5k). Rendering is capped — search
 *  narrows; stored value is "ph:<name>". */
const PICKER_CAP = 168;
function IconPicker({ id, value, onChange }: { id?: string; value: string; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const all = usePhosphorIconNames();
  const selected = resolveIconBase(value);
  const query = q.trim().toLowerCase();
  const matches = query ? all.filter((name) => name.includes(query)) : all;
  const shown = matches.slice(0, PICKER_CAP);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger id={id} className="field-input flex items-center gap-2 text-left" aria-label="Choose icon">
        <TypeIcon name={value} width={16} height={16} className="shrink-0 text-muted" />
        <span className="truncate">{selected}</span>
        <Icon.ChevronDown width={14} height={14} className="ml-auto shrink-0 text-muted" />
      </PopoverTrigger>
      <PopoverContent className="w-[296px]">
        <input
          className="field-input mb-2 py-1 text-sm"
          placeholder={`Search ${all.length || ""} icons…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search icons"
        />
        <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto" role="listbox" aria-label="Icons">
          {shown.map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={name === selected}
              title={name}
              onClick={() => { onChange(`ph:${name}`); setOpen(false); setQ(""); }}
              className={`grid h-8 w-8 place-items-center rounded ${
                name === selected ? "bg-accent/15 text-accent-700 ring-1 ring-accent" : "text-fg hover:bg-line/60"
              }`}
            >
              <TypeIcon name={`ph:${name}`} width={16} height={16} />
            </button>
          ))}
          {all.length === 0 && <p className="col-span-8 py-3 text-center text-xs text-muted">Loading icons…</p>}
          {all.length > 0 && shown.length === 0 && <p className="col-span-8 py-3 text-center text-xs text-muted">No icons match.</p>}
        </div>
        {matches.length > shown.length && (
          <p className="mt-1.5 text-center text-[11px] text-muted">Showing {shown.length} of {matches.length} — search to narrow.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Delete a content type — only enabled when totally unused; two-step confirm.
 *  `usage` undefined = counts not loaded yet (don't offer delete, don't claim
 *  in-use); zero counts = deletable; non-zero = in use. */
function DeleteTypeButton({ name, usage, onDeleted }: { name: string; usage?: { items: number; inlineIn: number }; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteContentType(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["content-types"] });
      qc.invalidateQueries({ queryKey: ["content-types-usage"] });
      toast.success("Content type deleted", name);
      onDeleted();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403) toast.error("Admins only", "You need the content-type permission.");
      else toast.error("Couldn’t delete", (e as Error).message);
    },
  });

  if (!usage) return null; // usage counts still loading
  const unused = usage.items === 0 && usage.inlineIn === 0;
  if (!unused) {
    return (
      <span className="text-xs text-muted" title="Only content types with no items and no inline usage can be deleted.">
        In use — can’t delete
      </span>
    );
  }
  if (!confirming) {
    return <button className="btn-ghost text-danger hover:bg-danger/10" onClick={() => setConfirming(true)}>Delete type</button>;
  }
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-danger">Delete “{name}”?</span>
      <button className="btn-danger px-2 py-1 text-xs" disabled={del.isPending} onClick={() => del.mutate()}>
        {del.isPending ? "Deleting…" : "Confirm"}
      </button>
      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}

interface Props {
  mode: "create" | "edit";
  initial?: ContentTypeDef;
  allTypes: ContentTypeDef[];
  /** Usage counts for this type, shown in the edit header. */
  usage?: { items: number; inlineIn: number };
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function ContentTypeEditor({ mode, initial, allTypes, usage, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [kind, setKind] = useState<ContentKind>(initial?.kind ?? "page");
  const [icon, setIcon] = useState(initial?.icon ?? "ph:file");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [schemaType, setSchemaType] = useState(initial?.schemaType ?? "");
  const [fields, setFields] = useState<DraftField[]>(
    // The reserved SEO group is injected on read but is system-managed — never
    // edited or stored here, so it can't be removed. Filter it out of the CRUD
    // list; a locked note tells the editor it's automatic on every page.
    () => (initial?.fields ?? [])
      .filter((f) => !SEO_FIELD_NAMES.has(f.name))
      .map((f) => ({ ...f, _key: `f${uid++}`, helpText: f.helpText })) as DraftField[],
  );
  const [errors, setErrors] = useState<string[]>([]);

  const blockTypeOptions = useMemo(() => allTypes.filter((t) => t.kind === "block").map((t) => t.name), [allTypes]);
  const refTypeOptions = useMemo(() => allTypes.map((t) => t.name), [allTypes]);

  const patchField = (key: string, patch: Partial<DraftField>) =>
    setFields((prev) => prev.map((f) => (f._key === key ? { ...f, ...patch } : f)));
  const removeField = (key: string) => setFields((prev) => prev.filter((f) => f._key !== key));
  // SEO mapping (one focused card): at most one field per role. Assigning a role
  // to a field clears it from any other (the contract enforces one-per-role).
  const fieldForRole = (role: NonNullable<DraftField["seoRole"]>) => fields.find((f) => f.seoRole === role)?._key ?? "";
  const assignSeoRole = (role: NonNullable<DraftField["seoRole"]>, key: string) =>
    setFields((prev) => prev.map((f) => (f._key === key ? { ...f, seoRole: role } : f.seoRole === role ? { ...f, seoRole: undefined } : f)));
  const moveField = (key: string, dir: -1 | 1) =>
    setFields((prev) => {
      const i = prev.findIndex((f) => f._key === key);
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  // schema.org coverage: what the chosen @type needs for its rich result vs
  // what the current fields carry (explicit role/schemaProp or delivery's name
  // convention). Catalog @types resolve statically; for custom @types the AI
  // proposes the same suggestion shape and it flows through the same resolver.
  const aiEnabled = useAiEnabled();
  const [aiSuggestions, setAiSuggestions] = useState<SchemaFieldSuggestion[] | null>(null);
  const suggest = useMutation({
    mutationFn: async () => {
      const r = await api.aiAssist("schema_fields", schemaType.trim(), {
        context: JSON.stringify(fields.filter((f) => f.name.trim()).map(({ name, type, seoRole, schemaProp }) => ({ name, type, seoRole, schemaProp }))),
      });
      return JSON.parse(r.result) as SchemaFieldSuggestion[]; // server-validated (normalizeSchemaFields)
    },
    onSuccess: setAiSuggestions,
    onError: (e) => toast.error("Couldn’t suggest fields", (e as Error).message),
  });
  const catalogGaps = useMemo(
    () => (kind === "page" && schemaType.trim() ? schemaFieldGaps(schemaType.trim(), fields) : null),
    [kind, schemaType, fields],
  );
  const unknownType = kind === "page" && Boolean(schemaType.trim()) && catalogGaps === null;
  const gaps = catalogGaps ?? (unknownType && aiSuggestions ? resolveSchemaSuggestions(aiSuggestions, fields) : null);
  const missingGaps = (gaps ?? []).filter((g) => !g.coveredBy);
  // Free-entry @type (any schema.org type, e.g. Recipe/JobPosting) — the AI
  // suggestion path serves these; the select alone would make it unreachable.
  const [customSchema, setCustomSchema] = useState(
    () => Boolean(initial?.schemaType && !(SCHEMA_TYPES as readonly string[]).includes(initial.schemaType)),
  );
  const nameTaken = (n: string) => fields.some((f) => f.name.toLowerCase() === n.toLowerCase());
  /** Close gaps: tag the same-named existing field where one exists, else add
   *  the suggested field (delivery: public — it exists to feed the JSON-LD). */
  const applySuggestions = (toApply: SchemaFieldGap[]) =>
    setFields((prev) => {
      let next = [...prev];
      for (const g of toApply) {
        const want = g.suggestion.field;
        if (g.tagField) {
          next = next.map((f) =>
            f.name === g.tagField ? { ...f, seoRole: want.seoRole ?? f.seoRole, schemaProp: want.schemaProp ?? f.schemaProp } : f,
          );
        } else if (!next.some((f) => f.name.toLowerCase() === want.name.toLowerCase())) {
          next.push({
            ...newField(),
            name: want.name,
            displayName: want.displayName,
            type: want.type,
            localized: want.localized ?? false,
            delivery: "public",
            ...(want.helpText ? { helpText: want.helpText } : {}),
            ...(want.seoRole ? { seoRole: want.seoRole } : {}),
            ...(want.schemaProp ? { schemaProp: want.schemaProp } : {}),
          });
        }
      }
      return next;
    });

  const save = useMutation({
    mutationFn: (def: ContentTypeDef) => (mode === "create" ? api.createContentType(def) : api.updateContentType(name, def)),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["content-types"] });
      toast.success(mode === "create" ? "Content type created" : "Content type updated", saved.displayName);
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403) toast.error("Admins only", "You need the content-type permission.");
      else setErrors([(e as Error).message]);
    },
  });

  function submit() {
    setErrors([]);
    const def = {
      name,
      displayName,
      kind,
      description,
      icon,
      ...(schemaType.trim() ? { schemaType: schemaType.trim() } : {}),
      fields: fields.map(({ _key, ...f }) => f),
    };
    const parsed = ContentTypeDef.safeParse(def);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join(".") || "type"}: ${i.message}`));
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={mode === "create" ? "New content type" : `Edit “${initial?.displayName}”`}
        description="Define the fields editors fill in. Fields marked public are exposed by the delivery API."
        className="w-[min(760px,94vw)]"
      >
        {mode === "edit" && usage && (
          <div className="mb-3 flex items-center gap-2 rounded-[var(--radius)] border border-line bg-canvas px-3 py-2 text-xs text-fg">
            <Icon.Content width={14} height={14} className="shrink-0 text-muted" />
            <span>
              <strong>Usage:</strong>{" "}
              {usage.items === 0 && usage.inlineIn === 0 ? (
                <span className="text-muted">Not used by any content yet.</span>
              ) : (
                <>
                  {usage.items > 0 && <>{usage.items} {kind === "block" ? "shared" : ""} {usage.items === 1 ? "item" : "items"}</>}
                  {usage.items > 0 && usage.inlineIn > 0 && " · "}
                  {usage.inlineIn > 0 && <>embedded inline in {usage.inlineIn} {usage.inlineIn === 1 ? "page" : "pages"}</>}
                </>
              )}
            </span>
          </div>
        )}
        {mode === "edit" && (
          <div className="mb-3 rounded-[var(--radius)] border border-draft/40 bg-draft/10 px-3 py-2 text-xs text-draft">
            Editing affects existing content: renaming or retyping a field orphans its stored value, and adding a
            <strong> required</strong> field will block re-publishing existing items until it’s filled. Name and kind are locked.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label" htmlFor="ct-name">Name (code)</label>
            <input id="ct-name" className="field-input font-mono" value={name} disabled={mode === "edit"}
              placeholder="StandardPage" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="ct-display">Display name</label>
            <input id="ct-display" className="field-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="ct-kind">Kind</label>
            <select id="ct-kind" className="field-input" value={kind} disabled={mode === "edit"}
              onChange={(e) => setKind(e.target.value as ContentKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="ct-icon">Icon</label>
            <IconPicker id="ct-icon" value={icon} onChange={setIcon} />
          </div>
          <div className="col-span-2">
            <label className="field-label" htmlFor="ct-desc">Description</label>
            <input id="ct-desc" className="field-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div className="mt-4 mb-1.5 flex items-center justify-between">
          <h4 className="text-[13px] font-bold uppercase tracking-wide text-muted">Fields</h4>
          <button className="btn-subtle px-2 py-1 text-xs" onClick={() => setFields((p) => [...p, newField()])}>
            <Icon.Plus width={14} height={14} /> Add field
          </button>
        </div>

        {kind === "page" && (
          <p className="mb-2 rounded-[var(--radius)] border border-line bg-canvas px-3 py-2 text-xs text-muted">
            🔒 Every page automatically includes the reserved <strong>SEO</strong> group (meta title/description,
            canonical, noindex, Open Graph, Twitter) — managed by the system, not editable here.
          </p>
        )}

        <div className="space-y-2">
          {fields.length === 0 && <p className="rounded border border-dashed border-line px-3 py-4 text-center text-sm text-muted">No fields yet.</p>}
          {fields.map((f) => (
            <div key={f._key} className="rounded-[var(--radius)] border border-line bg-canvas/60 p-2.5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input className="field-input py-1 font-mono text-xs" placeholder="fieldName" value={f.name} onChange={(e) => patchField(f._key, { name: e.target.value })} aria-label="Field name" />
                <input className="field-input py-1 text-xs" placeholder="Display name" value={f.displayName} onChange={(e) => patchField(f._key, { displayName: e.target.value })} aria-label="Field display name" />
                <select className="field-input py-1 text-xs" value={f.type} aria-label="Field type"
                  onChange={(e) => patchField(f._key, { type: e.target.value as FieldType, allowedBlocks: [], allowedTypes: [] })}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input className="field-input py-1 text-xs" placeholder="Group" value={f.group} onChange={(e) => patchField(f._key, { group: e.target.value })} aria-label="Field group" />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Switch checked={f.localized} onCheckedChange={(v) => patchField(f._key, { localized: v })} label="Localized" />
                <Switch checked={f.required} onCheckedChange={(v) => patchField(f._key, { required: v })} label="Required" />
                <label className="inline-flex items-center gap-1.5 text-sm">
                  <span className="text-muted">Delivery</span>
                  <select className="rounded border border-line bg-panel px-1.5 py-0.5 text-xs text-fg" value={f.delivery} aria-label="Field delivery"
                    onChange={(e) => patchField(f._key, { delivery: e.target.value as "public" | "private" })}>
                    <option value="private">private</option>
                    <option value="public">public</option>
                  </select>
                </label>
                {f.delivery === "public" && <span className="rounded bg-draft/10 px-1.5 py-0.5 text-[11px] text-draft">exposed to public API</span>}
                {f.schemaProp && (
                  <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent-700" title="Feeds this schema.org property in the delivered JSON-LD">
                    schema: {f.schemaProp}
                    <button type="button" aria-label={`Clear schema.org mapping ${f.schemaProp}`} className="hover:text-danger" onClick={() => patchField(f._key, { schemaProp: undefined })}>×</button>
                  </span>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  <button className="rounded p-1 text-muted hover:bg-line" aria-label="Move field up" onClick={() => moveField(f._key, -1)}><Icon.Up width={14} height={14} /></button>
                  <button className="rounded p-1 text-muted hover:bg-line" aria-label="Move field down" onClick={() => moveField(f._key, 1)}><Icon.Down width={14} height={14} /></button>
                  <button className="rounded p-1 text-danger hover:bg-danger/10" aria-label="Remove field" onClick={() => removeField(f._key)}><Icon.Trash width={14} height={14} /></button>
                </div>
              </div>

              {f.type === "contentArea" && (
                <ChipSelect label="Allowed blocks" options={blockTypeOptions} value={f.allowedBlocks} onChange={(v) => patchField(f._key, { allowedBlocks: v })} empty="any block" />
              )}
              {f.type === "reference" && (
                <ChipSelect label="Allowed types" options={refTypeOptions} value={f.allowedTypes} onChange={(v) => patchField(f._key, { allowedTypes: v })} empty="any type" />
              )}
              {f.type === "select" && (
                <OptionsEditor
                  options={f.options}
                  multiple={f.multiple}
                  onChange={(options) => patchField(f._key, { options })}
                  onMultiple={(multiple) => patchField(f._key, { multiple })}
                />
              )}
              {(f.type === "text" || f.type === "number") && (
                <ValidationEditor type={f.type} value={f.validation} onChange={(validation) => patchField(f._key, { validation })} />
              )}
            </div>
          ))}
        </div>

        {kind === "page" && (
          <div className="mt-4 rounded-[var(--radius)] border border-line bg-canvas/40 p-3">
            <h4 className="text-[13px] font-bold uppercase tracking-wide text-muted">SEO &amp; schema.org</h4>
            <p className="mb-3 mt-1 text-xs text-muted">
              Optional. Delivery builds the SEO / JSON-LD block automatically from field-name conventions — set these only to
              override that guess (e.g. force a schema.org type, or point a role at a differently-named field).
            </p>
            <div className="mb-3 flex items-end gap-2">
              <label className="block flex-1 text-sm" style={{ maxWidth: 280 }}>
                <span className="field-label">schema.org @type</span>
                <select
                  className="field-input"
                  value={customSchema ? "__custom" : schemaType}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiSuggestions(null);
                    if (v === "__custom") {
                      setCustomSchema(true);
                      setSchemaType("");
                    } else {
                      setCustomSchema(false);
                      setSchemaType(v);
                    }
                  }}
                  aria-label="schema.org type"
                >
                  <option value="">Auto (derived from the type)</option>
                  {SCHEMA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  <option value="__custom">Custom…</option>
                </select>
              </label>
              {customSchema && (
                <label className="block flex-1 text-sm" style={{ maxWidth: 220 }}>
                  <span className="field-label">Custom @type</span>
                  <input
                    className="field-input"
                    value={schemaType}
                    placeholder="e.g. Recipe, JobPosting"
                    onChange={(e) => { setSchemaType(e.target.value); setAiSuggestions(null); }}
                    aria-label="Custom schema.org type"
                  />
                </label>
              )}
            </div>
            {unknownType && !aiSuggestions && (
              <div className="mb-3 flex items-center gap-2 rounded-[var(--radius)] border border-line bg-panel/60 px-2.5 py-2 text-xs text-muted">
                <span className="min-w-0 flex-1">“{schemaType.trim()}” isn’t in the built-in catalog — AI can propose the fields its rich result needs.</span>
                {aiEnabled ? (
                  <button type="button" className="btn-subtle px-2 py-1 text-xs" disabled={suggest.isPending} onClick={() => suggest.mutate()}>
                    {suggest.isPending ? "Asking…" : "Suggest fields with AI"}
                  </button>
                ) : (
                  <span title={AI_OFF_HINT}>{AI_OFF_HINT}</span>
                )}
              </div>
            )}
            {gaps && (
              <div className="mb-3 rounded-[var(--radius)] border border-line bg-panel/60 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-fg">
                    {catalogGaps ? `What ${schemaType.trim()} needs for its rich result` : `AI-suggested fields for ${schemaType.trim()} — review before adding`}
                  </span>
                  {missingGaps.length > 0 ? (
                    <button type="button" className="btn-subtle px-2 py-1 text-xs" onClick={() => applySuggestions(missingGaps)}>
                      <Icon.Plus width={12} height={12} /> Add {missingGaps.length} missing {missingGaps.length === 1 ? "field" : "fields"}
                    </button>
                  ) : (
                    <span className="text-xs text-published">All covered</span>
                  )}
                </div>
                <ul className="mt-1.5 grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {gaps.map((g) => (
                    <li key={g.suggestion.prop} className="flex items-center gap-1.5 text-xs">
                      <span aria-hidden className={g.coveredBy ? "text-published" : "text-muted"}>{g.coveredBy ? "✓" : "·"}</span>
                      <code className="font-mono text-fg">{g.suggestion.prop}</code>
                      {g.suggestion.required && !g.coveredBy && <span className="rounded bg-danger/10 px-1 text-[10px] font-medium text-danger">required</span>}
                      <span className="min-w-0 truncate text-muted">
                        {g.coveredBy
                          ? `→ ${g.coveredBy}`
                          : g.tagField
                            ? `tags existing “${g.tagField}”`
                            : nameTaken(g.suggestion.field.name)
                              ? `“${g.suggestion.field.name}” is taken by an incompatible field`
                              : `adds “${g.suggestion.field.name}”`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {SEO_ROLES.map((role) => {
                const current = fieldForRole(role);
                const opts = fields.filter((f) => f.name.trim() && (seoRoleEligible(role, f.type) || f._key === current));
                return (
                  <label key={role} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted">{SEO_ROLE_LABELS[role]}</span>
                    <select className="field-input py-1 text-xs" style={{ maxWidth: 200 }} value={current}
                      onChange={(e) => assignSeoRole(role, e.target.value)} aria-label={`SEO ${role} field`}>
                      <option value="">Auto (by field name)</option>
                      {opts.map((f) => <option key={f._key} value={f._key}>{f.displayName || f.name}</option>)}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {errors.length > 0 && (
          <ul role="alert" className="mt-3 list-disc rounded border border-danger/40 bg-danger/10 px-5 py-2 text-xs text-danger">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-2">
          {mode === "edit" && (
            <DeleteTypeButton name={name} usage={usage} onDeleted={() => onOpenChange(false)} />
          )}
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost" onClick={() => onOpenChange(false)}>Cancel</button>
            <button className="btn-primary" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Saving…" : mode === "create" ? "Create type" : "Save changes"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OptionsEditor({
  options,
  multiple,
  onChange,
  onMultiple,
}: {
  options: FieldOption[];
  multiple: boolean;
  onChange: (o: FieldOption[]) => void;
  onMultiple: (m: boolean) => void;
}) {
  const patch = (i: number, p: Partial<FieldOption>) => onChange(options.map((o, j) => (j === i ? { ...o, ...p } : o)));
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Options</span>
        <Switch checked={multiple} onCheckedChange={onMultiple} label="Allow multiple" />
      </div>
      <div className="space-y-1">
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input className="field-input py-1 font-mono text-xs" placeholder="value" value={o.value} aria-label="Option value"
              onChange={(e) => patch(i, { value: e.target.value })} />
            <input className="field-input py-1 text-xs" placeholder="Label" value={o.label} aria-label="Option label"
              onChange={(e) => patch(i, { label: e.target.value })} />
            <button className="rounded p-1 text-danger hover:bg-danger/10" aria-label="Remove option" onClick={() => onChange(options.filter((_, j) => j !== i))}>
              <Icon.Trash width={13} height={13} />
            </button>
          </div>
        ))}
        <button className="btn-subtle px-2 py-0.5 text-xs" onClick={() => onChange([...options, { value: "", label: "" }])}>
          <Icon.Plus width={12} height={12} /> Add option
        </button>
      </div>
    </div>
  );
}

function ValidationEditor({
  type,
  value,
  onChange,
}: {
  type: "text" | "number";
  value: FieldValidation | undefined;
  onChange: (v: FieldValidation | undefined) => void;
}) {
  const v = value ?? {};
  const set = (p: Partial<FieldValidation>) => {
    const next = { ...v, ...p };
    // Drop empties so we don't persist an all-undefined object.
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, x]) => x !== undefined && x !== "" && !Number.isNaN(x)));
    onChange(Object.keys(cleaned).length ? (cleaned as FieldValidation) : undefined);
  };
  const num = (s: string) => (s === "" ? undefined : Number(s));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Validation</span>
      {type === "text" ? (
        <>
          <input className="field-input w-24 py-1 text-xs" type="number" placeholder="min len" value={v.minLength ?? ""} aria-label="Minimum length"
            onChange={(e) => set({ minLength: num(e.target.value) })} />
          <input className="field-input w-24 py-1 text-xs" type="number" placeholder="max len" value={v.maxLength ?? ""} aria-label="Maximum length"
            onChange={(e) => set({ maxLength: num(e.target.value) })} />
          <input className="field-input w-40 py-1 font-mono text-xs" placeholder="regex pattern" value={v.pattern ?? ""} aria-label="Pattern"
            onChange={(e) => set({ pattern: e.target.value || undefined })} />
        </>
      ) : (
        <>
          <input className="field-input w-24 py-1 text-xs" type="number" placeholder="min" value={v.min ?? ""} aria-label="Minimum"
            onChange={(e) => set({ min: num(e.target.value) })} />
          <input className="field-input w-24 py-1 text-xs" type="number" placeholder="max" value={v.max ?? ""} aria-label="Maximum"
            onChange={(e) => set({ max: num(e.target.value) })} />
        </>
      )}
    </div>
  );
}

function ChipSelect({
  label,
  options,
  value,
  onChange,
  empty,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label} <span className="font-normal normal-case text-muted/80">({value.length ? value.join(", ") : empty})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.length === 0 && <span className="text-xs text-muted">No block types yet.</span>}
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => toggle(o)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${value.includes(o) ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-line/60"}`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}
