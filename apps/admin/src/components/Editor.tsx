import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BlockInstance,
  ContentDetail,
  ContentTypeDef,
  FieldDef,
  Locale,
  SessionUser,
} from "@paperboy/shared";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type AiTask, type VersionDetail } from "../lib/api.js";
import { ResizeHandle } from "./ui/resize.js";
import { Icon } from "../lib/icons.js";
import { TypeIcon } from "../lib/typeIcons.js";
import { ContentArea } from "./fields/ContentArea.js";
import { MarkdownEditor } from "./fields/MarkdownEditor.js";
import { RichText } from "./fields/RichText.js";
import { ImageField } from "./MediaLibrary.js";
import { PreviewPane } from "./PreviewPane.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { useToast } from "./ui/toast.js";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface EditorProps {
  documentId: string;
  locale: string;
  setLocale: (l: string) => void;
  locales: Locale[];
  types: ContentTypeDef[];
  user: SessionUser;
  onName?: (name: string | null) => void;
  /** When the assets pane is hidden, bias the freed width to the preview (not the form). */
  widePreview?: boolean;
  /** Phone layout: single full-width column, no live-preview split. */
  mobile?: boolean;
}

export function Editor({ documentId, locale, setLocale, locales, types, user, onName, widePreview = false, mobile = false }: EditorProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [showVersions, setShowVersions] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [hideTranslateOffer, setHideTranslateOffer] = useState(false);
  const detail = useQuery({
    queryKey: ["content", documentId, locale],
    queryFn: ({ signal }) => api.get(documentId, locale, signal),
  });

  // Same key + shape as the asset pane (BlockSummary[]) — sharing the key with a
  // different shape would let one consumer overwrite the other's cache.
  const sharedBlocks = useQuery({ queryKey: ["blocks"], queryFn: ({ signal }) => api.blocks(signal) });

  const type = useMemo(
    () => types.find((t) => t.name === detail.data?.type),
    [types, detail.data?.type],
  );
  // Default the open tab to the type's FIRST group (not a hardcoded "Content"
  // that some types — e.g. the Frontpage — don't have, which showed an empty tab).
  useEffect(() => {
    if (!type) return;
    const gs = [...new Set(type.fields.map((f) => f.group))];
    setTab((prev) => (gs.includes(prev) ? prev : gs[0] ?? "Content"));
  }, [type]);

  // ----- local working copy + save state machine -----
  const [form, setForm] = useState<ContentDetail | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [tab, setTab] = useState("Content");
  // Persisted so the preview pane stays open across re-renders/remounts (e.g.
  // toggling a side pane remounts the editor) instead of collapsing on a click.
  const [showPreview, setShowPreviewState] = useState<boolean>(() => {
    try { return localStorage.getItem("pb-show-preview") === "1"; } catch { return false; }
  });
  const setShowPreview = (next: boolean) => {
    setShowPreviewState(next);
    try { localStorage.setItem("pb-show-preview", next ? "1" : "0"); } catch { /* ignore */ }
  };
  const [previewRefresh, setPreviewRefresh] = useState(0);
  // Editor → preview sync: focusing/clicking a property highlights its region in
  // the preview. The counter re-triggers even when the same field is re-focused.
  const [propFocus, setPropFocus] = useState<{ field: string; n: number } | null>(null);
  const propCounter = useRef(0);
  const activateProp = (e: React.FocusEvent | React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.("[data-pb-prop]");
    const field = el?.getAttribute("data-pb-prop");
    if (field) setPropFocus({ field, n: ++propCounter.current });
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<ContentDetail | null>(null);
  // Holds not-yet-persisted edits; null once a save has been initiated for them.
  const pendingRef = useRef<ContentDetail | null>(null);
  // Tracks which (document, locale) the working copy belongs to, so we only
  // re-initialise the form on a genuine switch — never on a same-variant refetch.
  const loadedKey = useRef<string | null>(null);
  const variantKey = `${documentId}:${locale}`;

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  // On unmount (e.g. switching language/page): cancel the debounce and FLUSH any
  // pending edits with a fire-and-forget save, so unsaved work is never lost.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const p = pendingRef.current;
      if (p) {
        void api
          .update(documentId, locale, { name: p.name, slug: p.slug, displayInNav: p.displayInNav, data: p.data })
          .catch(() => undefined);
        pendingRef.current = null;
      }
    };
    // documentId/locale are constant for this mount (Shell remounts on change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialise the working copy from the server when the variant changes
  // (mount, or switching document/locale). Same-variant refetches do NOT reset
  // the form, so an in-flight autosave is never clobbered by a stale fetch.
  useEffect(() => {
    if (detail.data && loadedKey.current !== variantKey) {
      loadedKey.current = variantKey;
      setForm(detail.data);
      formRef.current = detail.data;
      setSaveState("idle");
      setHideTranslateOffer(false);
    }
  }, [detail.data, variantKey]);

  // Report the document name up for the breadcrumb / tab title.
  useEffect(() => {
    if (form) onName?.(form.name);
  }, [form, onName]);

  const canEdit = user.permissions.includes("content.update");
  const canPublish = user.permissions.includes("content.publish");

  // Untranslated variant: this locale has no saved version yet (the server returns
  // a blank scaffold with versionNumber 0). If the default locale HAS content, we
  // offer to seed this translation from it (AI-translating the text fields).
  const defaultLocale = useMemo(() => locales.find((l) => l.isDefault)?.code ?? "en", [locales]);
  const untranslated = !!detail.data && detail.data.versionNumber === 0 && locale !== defaultLocale;
  const source = useQuery({
    queryKey: ["content", documentId, defaultLocale],
    queryFn: ({ signal }) => api.get(documentId, defaultLocale, signal),
    enabled: untranslated,
  });
  const canTranslate = untranslated && (source.data?.versionNumber ?? 0) > 0;

  const save = useMutation({
    mutationFn: (f: ContentDetail) =>
      api.update(documentId, locale, {
        name: f.name,
        slug: f.slug,
        displayInNav: f.displayInNav,
        data: f.data,
      }),
    onSuccess: (updated) => {
      setSaveState("saved");
      // Keep the query cache authoritative so switching away and back shows the
      // latest saved state (not the initial fetch).
      qc.setQueryData(["content", documentId, locale], updated);
      // Sync the server-computed URL path live (derived, not user-edited).
      setForm((prev) => (prev ? { ...prev, urlPath: updated.urlPath } : prev));
      formRef.current = formRef.current ? { ...formRef.current, urlPath: updated.urlPath } : formRef.current;
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      setPreviewRefresh((n) => n + 1); // reload the preview with the saved draft
    },
    onError: (e) => {
      setSaveState("error");
      toast.error("Couldn’t save", (e as Error).message);
    },
  });

  // Debounced autosave. Uses functional state + a ref so rapid sequential edits
  // never clobber each other (the saved payload is always the merged latest).
  function patch(updater: (prev: ContentDetail) => ContentDetail) {
    setForm((prev) => {
      const next = updater(prev!);
      formRef.current = next;
      pendingRef.current = next; // unsaved until a save is initiated
      return next;
    });
    setSaveState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const latest = formRef.current;
      if (!latest) return;
      pendingRef.current = null; // a save is now in flight for these edits
      setSaveState("saving");
      save.mutate(latest);
    }, 700);
  }

  // Warn on navigation with unsaved changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);

  const publish = useMutation({
    mutationFn: async () => {
      if (timer.current) clearTimeout(timer.current);
      if ((saveState === "dirty" || saveState === "saving") && formRef.current) {
        pendingRef.current = null;
        await save.mutateAsync(formRef.current);
      }
      return api.publish(documentId, locale);
    },
    onSuccess: (updated) => {
      setForm(updated);
      formRef.current = updated;
      setSaveState("idle");
      qc.setQueryData(["content", documentId, locale], updated);
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Published", `“${updated.name}” is live in ${locale.toUpperCase()}.`);
    },
    onError: (e) => toast.error("Publish failed", (e as Error).message),
  });

  const unpublish = useMutation({
    mutationFn: () => api.unpublish(documentId, locale),
    onSuccess: (updated) => {
      setForm(updated);
      formRef.current = updated;
      qc.setQueryData(["content", documentId, locale], updated);
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Unpublished", `Removed from the public delivery API.`);
    },
    onError: (e) => toast.error("Couldn’t unpublish", (e as Error).message),
  });

  const discard = useMutation({
    mutationFn: async () => {
      if (timer.current) clearTimeout(timer.current);
      pendingRef.current = null;
      await api.discardDraft(documentId, locale);
    },
    onSuccess: () => {
      loadedKey.current = null; // force re-init from server
      qc.invalidateQueries({ queryKey: ["content", documentId, locale] });
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Draft discarded");
    },
    onError: (e) => toast.error("Couldn’t discard draft", (e as Error).message),
  });

  const canDelete = user.permissions.includes("content.delete");
  const canCreate = user.permissions.includes("content.create");

  const duplicate = useMutation({
    mutationFn: () => api.duplicate(documentId, locale),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Duplicated", `Created “${created.name}”.`);
      navigate(`/edit/${created.documentId}${locale !== "en" ? `?lang=${locale}` : ""}`);
    },
    onError: (e) => toast.error("Couldn’t duplicate", (e as Error).message),
  });

  const trash = useMutation({
    mutationFn: () => api.trash(documentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Moved to trash", "Restore it from Settings → Trash.");
      navigate("/edit");
    },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });

  // ----- AI editorial assistant (SEO meta generation from the page content) -----
  const hasField = (name: string) => Boolean(type?.fields.some((f) => f.name === name));
  function pageText(): string {
    const d = (formRef.current ?? form)?.data ?? {};
    const parts = [String((formRef.current ?? form)?.name ?? ""), typeof d.heading === "string" ? d.heading : "", docToText(d.intro)];
    return parts.filter(Boolean).join("\n").slice(0, 8000);
  }
  const ai = useMutation({
    mutationFn: (v: { task: AiTask; field: string }) => api.aiAssist(v.task, pageText()).then((r) => ({ ...r, field: v.field })),
    onSuccess: (r) => {
      setField(r.field, r.result);
      if (r.provider === "fallback") toast.success("Draft suggestion added", "Basic mode — set ANTHROPIC_API_KEY for full AI.");
      else toast.success("AI suggestion applied");
    },
    onError: (e) => toast.error("AI request failed", (e as Error).message),
  });
  async function aiSeoBoth() {
    if (hasField("metaTitle")) await ai.mutateAsync({ task: "meta_title", field: "metaTitle" });
    if (hasField("metaDescription")) await ai.mutateAsync({ task: "meta_description", field: "metaDescription" });
  }
  const showAi = canEdit && (hasField("metaTitle") || hasField("metaDescription"));

  // Seed this locale from the default-locale version, AI-translating the text
  // fields (text/markdown) + name; other fields (richtext, blocks, references…)
  // are copied as a starting point. Falls back to copying when AI is offline.
  const translate = useMutation({
    mutationFn: async () => {
      const src = source.data;
      if (!src) throw new Error("No source content to translate from");
      // Collect all translatable strings (name + text/markdown fields) and send
      // them in ONE request — one /assist call per field would trip the rate limit
      // on a large page (e.g. the Frontpage's ~34 fields).
      const keys: string[] = [];
      const texts: string[] = [];
      if (src.name?.trim()) {
        keys.push("__name");
        texts.push(src.name);
      }
      for (const f of type?.fields ?? []) {
        const v = src.data[f.name];
        if ((f.type === "text" || f.type === "markdown") && typeof v === "string" && v.trim()) {
          keys.push(f.name);
          texts.push(v);
        }
      }
      const { results, provider } = texts.length
        ? await api.aiTranslate(texts, locale)
        : { results: [] as string[], provider: "fallback" as const };
      const translated = new Map<string, string>();
      keys.forEach((k, i) => translated.set(k, results[i] ?? texts[i]!));
      // Translated text fields; every other field copied from the source as a start.
      const data: Record<string, unknown> = {};
      for (const f of type?.fields ?? []) {
        const v = src.data[f.name];
        if (v === undefined) continue;
        data[f.name] = translated.has(f.name) ? translated.get(f.name)! : v;
      }
      const name = translated.get("__name") ?? src.name;
      return { name, slug: src.slug, data, usedFallback: provider === "fallback" };
    },
    onSuccess: (res) => {
      const base = formRef.current ?? form;
      if (!base) return;
      const next = { ...base, name: res.name, slug: res.slug, data: res.data };
      setForm(next);
      formRef.current = next;
      pendingRef.current = null;
      setSaveState("saving");
      save.mutate(next);
      setHideTranslateOffer(true);
      toast.success(
        res.usedFallback ? "Draft seeded from source" : "Translated draft created",
        res.usedFallback
          ? "AI is offline — text was copied for manual translation. Review and publish."
          : "Review the AI translation, then publish.",
      );
    },
    onError: (e) => toast.error("Couldn’t translate", (e as Error).message),
  });

  // Visual on-page editing: the preview iframe posts which field/block was
  // clicked → switch to its tab and scroll/focus it here.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: string; field?: string | null; blockIndex?: number | null } | null;
      if (!d || d.type !== "paperboy:edit") return;
      const fieldName = typeof d.field === "string" ? d.field : null;
      const def = fieldName ? type?.fields.find((f) => f.name === fieldName) : undefined;
      if (def) setTab(def.group);
      setTimeout(() => {
        const id = d.blockIndex != null ? `pb-block-${d.blockIndex}` : fieldName ? `f-${fieldName}` : null;
        if (!id) return;
        const el = document.getElementById(id);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (el) { el.classList.add("pb-flash"); setTimeout(() => el.classList.remove("pb-flash"), 1400); }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
      }, 80);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [type]);

  // ⌘S / Ctrl+S — force an immediate save of pending edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        const latest = formRef.current;
        if (latest && (saveState === "dirty" || saveState === "saving")) {
          pendingRef.current = null;
          setSaveState("saving");
          save.mutate(latest);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState]);

  // Error first: on a failed load `form` never initialises, so the loading
  // check would swallow the error and spin forever (e.g. a deleted document).
  if (detail.isError) {
    const err = detail.error;
    const msg = err instanceof ApiError && err.status === 403 ? "You don't have access to this content." : "Failed to load content.";
    return <div className="grid h-full place-items-center text-muted">{msg}</div>;
  }
  if (detail.isLoading || !form) {
    return <div className="grid h-full place-items-center text-muted">Loading editor…</div>;
  }

  const groups = type ? [...new Set(type.fields.map((f) => f.group))] : ["Content"];
  const isPage = form.kind === "page";
  // Live preview is a desktop-only split pane; never open it on phones.
  const previewOpen = showPreview && !mobile;
  const setField = (name: string, value: unknown) =>
    patch((prev) => ({ ...prev, data: { ...prev.data, [name]: value } }));

  // Tabs + property fields. Shared between the desktop split pane and the
  // full-width phone column.
  const formSection = (
    <section className="h-full overflow-auto">
      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-line bg-panel px-4" role="tablist" aria-label="Property groups">
        {groups.map((g) => (
          <button key={g} role="tab" aria-selected={tab === g}
            className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${tab === g ? "border-accent text-accent-700" : "border-transparent text-muted hover:text-ink"}`}
            onClick={() => setTab(g)}>
            {g}
          </button>
        ))}
      </div>

      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6" onFocusCapture={activateProp} onClickCapture={activateProp}>
        {type?.fields
          .filter((f) => f.group === tab)
          .map((f) => (
            <div key={f.name} data-pb-prop={f.name}>
              <Field
                field={f}
                value={form.data[f.name]}
                disabled={!canEdit}
                types={types}
                sharedBlocks={sharedBlocks.data ?? []}
                onChange={(v) => setField(f.name, v)}
              />
            </div>
          ))}
        {type && type.fields.filter((f) => f.group === tab).length === 0 && (
          <p className="text-sm text-muted">No properties in this group.</p>
        )}
      </div>
    </section>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Workflow toolbar */}
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-1.5">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
            form.status === "published" ? "bg-published/10 text-published" : "bg-draft/10 text-draft"
          }`}>
            <span className={`h-2 w-2 rounded-full ${form.status === "published" ? "bg-published" : "bg-draft"}`} />
            {form.status === "published" ? (form.hasUnpublishedChanges ? "Published · changes" : "Published") : "Draft"}
          </span>
          <SaveIndicator state={saveState} />
        </div>

        {/* Language selector */}
        <label className="ml-2 flex items-center gap-1.5 text-sm text-muted">
          <Icon.Globe width={16} height={16} />
          <select
            className="rounded border border-line bg-panel px-2 py-1 text-sm text-fg"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            aria-label="Language"
          >
            {locales.map((l) => (
              <option key={l.code} value={l.code}>{l.displayName}{l.isDefault ? " (default)" : ""}</option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          {showAi && !mobile && (
            <Menu>
              <MenuTrigger className="btn-subtle" aria-label="AI assistant" disabled={ai.isPending}>
                <span aria-hidden>✨</span> {ai.isPending ? "Thinking…" : "AI"}
              </MenuTrigger>
              <MenuContent>
                {hasField("metaTitle") && hasField("metaDescription") && (
                  <MenuItem onSelect={() => void aiSeoBoth()}>Generate SEO title + description</MenuItem>
                )}
                {hasField("metaTitle") && <MenuItem onSelect={() => ai.mutate({ task: "meta_title", field: "metaTitle" })}>Generate SEO title</MenuItem>}
                {hasField("metaDescription") && <MenuItem onSelect={() => ai.mutate({ task: "meta_description", field: "metaDescription" })}>Generate SEO description</MenuItem>}
              </MenuContent>
            </Menu>
          )}
          <Menu>
            <MenuTrigger className="btn-subtle px-2" aria-label="Content actions">
              <Icon.Dots width={16} height={16} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setShowVersions(true)}>Version history…</MenuItem>
              {canCreate && <MenuItem onSelect={() => duplicate.mutate()}>Duplicate</MenuItem>}
              {canDelete && (
                <>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => trash.mutate()}>Move to trash</MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
          {!mobile && (
            <button className={`btn-subtle ${showPreview ? "ring-2 ring-accent" : ""}`} onClick={() => setShowPreview(!showPreview)}>
              <Icon.Eye width={16} height={16} /> Preview
            </button>
          )}
          {canPublish && (
            <div className="flex items-stretch">
              <button
                className="btn-primary rounded-r-none"
                onClick={() => publish.mutate()}
                disabled={publish.isPending || !canEdit}
              >
                {publish.isPending ? "Publishing…" : "Publish"}
              </button>
              <Menu>
                <MenuTrigger
                  className="btn-primary rounded-l-none border-l border-accent-fg/25 px-1.5"
                  aria-label="More publish actions"
                >
                  <Icon.ChevronDown width={15} height={15} />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setShowSchedule(true)}>Schedule publish…</MenuItem>
                  {form.status === "published" && (
                    <>
                      <MenuSeparator />
                      <MenuItem onSelect={() => unpublish.mutate()}>Unpublish</MenuItem>
                    </>
                  )}
                  {form.hasUnpublishedChanges && (
                    <>
                      {form.status !== "published" && <MenuSeparator />}
                      <MenuItem destructive onSelect={() => discard.mutate()}>Discard draft changes</MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </div>
          )}
        </div>
      </div>

      {/* Untranslated-locale → offer an AI translation seeded from the default locale */}
      {untranslated && canTranslate && !hideTranslateOffer && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-accent/10 px-4 py-2 text-sm">
          <span className="text-fg">
            Not translated to <strong>{locales.find((l) => l.code === locale)?.displayName ?? locale}</strong> yet.
          </span>
          <div className="ml-auto flex items-center gap-2">
            {canEdit && (
              <button className="btn-primary px-3 py-1 text-xs" disabled={translate.isPending} onClick={() => translate.mutate()}>
                <span aria-hidden>✨</span>{" "}
                {translate.isPending
                  ? "Translating…"
                  : `Translate from ${locales.find((l) => l.code === defaultLocale)?.displayName ?? defaultLocale}`}
              </button>
            )}
            <button className="btn-subtle px-3 py-1 text-xs" onClick={() => setHideTranslateOffer(true)}>
              Start blank
            </button>
          </div>
        </div>
      )}

      {/* Scheduled publish / expiry banner */}
      {(form.publishAt || form.expireAt) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-accent/5 px-4 py-1.5 text-xs">
          {form.publishAt && (
            <span className="inline-flex items-center gap-1.5 font-medium text-accent-700">
              <Icon.History width={13} height={13} /> Scheduled to publish {new Date(form.publishAt).toLocaleString()}
            </span>
          )}
          {form.expireAt && (
            <span className="inline-flex items-center gap-1.5 text-muted">
              Expires {new Date(form.expireAt).toLocaleString()}
            </span>
          )}
          {canPublish && (
            <button className="ml-auto btn-subtle px-2 py-0.5 text-xs" onClick={() => setShowSchedule(true)}>Edit schedule…</button>
          )}
        </div>
      )}

      {/* Basic-info row — one slim line (name + URL chip + type) so the canvas
          and preview get the vertical space. Slug/nav settings live in the
          URL chip's popover. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-canvas px-4 py-2">
        <input className="field-input w-auto min-w-0 max-w-sm flex-1 basis-44 py-1 font-medium" value={form.name} disabled={!canEdit}
          onChange={(e) => patch((prev) => ({ ...prev, name: e.target.value }))} aria-label="Name" />
        {isPage ? (
          <Popover>
            <PopoverTrigger className="btn-subtle min-w-0 max-w-[45%] gap-1.5 px-2.5 py-1 text-xs"
              aria-label="URL settings" title={form.urlPath ?? undefined}>
              <span className="truncate font-mono">{form.urlPath ?? "—"}</span>
              <Icon.ChevronDown width={13} height={13} className="shrink-0 text-muted" />
            </PopoverTrigger>
            <PopoverContent className="w-80 space-y-3">
              <div>
                <label className="field-label" htmlFor="pb-url-slug">Name in URL (segment)</label>
                <input id="pb-url-slug" className="field-input" value={form.slug ?? ""} disabled={!canEdit}
                  onChange={(e) => patch((prev) => ({ ...prev, slug: e.target.value }))} aria-label="Slug" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.displayInNav} disabled={!canEdit}
                  onChange={(e) => patch((prev) => ({ ...prev, displayInNav: e.target.checked }))} />
                <span>Display in navigation (menus)</span>
              </label>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">URL (from page hierarchy)</div>
                <code className="block truncate rounded bg-line/60 px-2 py-1 font-mono text-xs text-fg" title={form.urlPath ?? ""}>
                  {form.urlPath ?? "—"}
                </code>
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="rounded bg-accent/15 px-2 py-1 text-xs font-medium text-fg">Shared block · lives in the asset pane</span>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
          <TypeIcon name={type?.icon} fallback={form.kind === "block" ? "blocks" : "file"} width={15} height={15} className="shrink-0 text-muted" />
          <span className="truncate font-medium">{type?.displayName ?? form.type}</span>
          <code className="rounded bg-line/70 px-1 text-[11px] text-muted" title={form.documentId}>{form.documentId.slice(0, 10)}…</code>
        </div>
      </div>

      {/* Canvas + (optional) preview. On phones it's just the full-width form;
          on desktop a resizable split — drag the divider to give the on-page
          preview more room. */}
      {mobile ? (
        <div className="min-h-0 flex-1">{formSection}</div>
      ) : (
        <PanelGroup direction="horizontal" autoSaveId={`paperboy-editor-split-${widePreview ? "w" : "n"}`} className="flex min-h-0 flex-1">
          <Panel id="form" order={1} defaultSize={widePreview ? 32 : 42} minSize={24} className="min-w-0">
            {formSection}
          </Panel>
          {previewOpen && <ResizeHandle />}
          {previewOpen && (
            <Panel id="preview" order={2} defaultSize={widePreview ? 68 : 58} minSize={20} className="min-w-0 border-l border-line bg-panel">
              <PreviewPane locale={locale} urlPath={form.urlPath} documentId={documentId} refreshSignal={previewRefresh} focusField={propFocus} />
            </Panel>
          )}
        </PanelGroup>
      )}

      {showVersions && (
        <VersionsDialog
          documentId={documentId}
          locale={locale}
          type={type}
          canRestore={canEdit}
          open={showVersions}
          onOpenChange={setShowVersions}
          onRestored={(updated) => {
            setForm(updated);
            formRef.current = updated;
            loadedKey.current = variantKey;
            setSaveState("idle");
            qc.setQueryData(["content", documentId, locale], updated);
            qc.invalidateQueries({ queryKey: ["tree", "root"] });
          }}
        />
      )}

      {showSchedule && (
        <ScheduleDialog
          documentId={documentId}
          locale={locale}
          publishAt={form.publishAt}
          expireAt={form.expireAt}
          open={showSchedule}
          onOpenChange={setShowSchedule}
          onDone={(updated) => {
            setForm(updated);
            formRef.current = updated;
            setSaveState("idle");
            qc.setQueryData(["content", documentId, locale], updated);
            qc.invalidateQueries({ queryKey: ["tree", "root"] });
            qc.invalidateQueries({ queryKey: ["versions", documentId, locale] });
          }}
        />
      )}
    </div>
  );
}

function VersionsDialog({
  documentId,
  locale,
  type,
  canRestore,
  open,
  onOpenChange,
  onRestored,
}: {
  documentId: string;
  locale: string;
  type: ContentTypeDef | undefined;
  canRestore: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRestored: (updated: ContentDetail) => void;
}) {
  const toast = useToast();
  const versions = useQuery({
    queryKey: ["versions", documentId, locale],
    queryFn: ({ signal }) => api.versions(documentId, locale, signal),
  });
  const restore = useMutation({
    mutationFn: (versionId: number) => api.restoreVersion(documentId, locale, versionId),
    onSuccess: (updated) => {
      toast.success("Version restored", "Loaded into a draft — review and publish.");
      onRestored(updated);
      onOpenChange(false);
    },
    onError: (e) => toast.error("Couldn’t restore", (e as Error).message),
  });
  const rows = versions.data ?? [];

  // A↔B selection for the compare view. Default to the two most recent versions
  // (rows are sorted newest-first): A = older of the two, B = newest.
  const [selA, setSelA] = useState<number | null>(null);
  const [selB, setSelB] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    if (rows.length >= 2 && selA == null && selB == null) {
      setSelB(rows[0]!.id);
      setSelA(rows[1]!.id);
    }
  }, [rows, selA, selB]);
  const canCompare = selA != null && selB != null && selA !== selB;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={comparing ? "Compare versions" : "Version history"}
        description={comparing ? `Differences in ${locale.toUpperCase()}.` : `All saved versions for this content in ${locale.toUpperCase()}.`}
        className="w-[min(820px,96vw)]"
      >
        {comparing && canCompare ? (
          <CompareView
            documentId={documentId}
            locale={locale}
            type={type}
            aId={selA!}
            bId={selB!}
            onBack={() => setComparing(false)}
          />
        ) : (
          <>
            {versions.isLoading && <p className="py-6 text-center text-sm text-muted">Loading…</p>}
            {!versions.isLoading && rows.length === 0 && <p className="py-6 text-center text-sm text-muted">No versions yet.</p>}
            {rows.length >= 2 && (
              <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted">
                <span>Pick two versions (A = older, B = newer) to compare.</span>
                <button className="btn-primary px-2.5 py-1 text-xs" disabled={!canCompare} onClick={() => setComparing(true)}>
                  <Icon.History width={13} height={13} /> Compare A ↔ B
                </button>
              </div>
            )}
            <ul className="max-h-[60vh] space-y-1 overflow-auto">
              {rows.map((v) => (
                <li key={v.id} className="flex items-center gap-3 rounded border border-line px-3 py-2 text-sm">
                  {rows.length >= 2 && (
                    <span className="flex items-center gap-1.5" aria-label={`Select version ${v.versionNumber} for comparison`}>
                      <label className="flex items-center gap-0.5 text-[10px] font-semibold text-muted">
                        <input type="radio" name="cmp-a" checked={selA === v.id} onChange={() => setSelA(v.id)} disabled={selB === v.id} /> A
                      </label>
                      <label className="flex items-center gap-0.5 text-[10px] font-semibold text-muted">
                        <input type="radio" name="cmp-b" checked={selB === v.id} onChange={() => setSelB(v.id)} disabled={selA === v.id} /> B
                      </label>
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted">v{v.versionNumber}</span>
                  <span className="font-medium text-fg">{v.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.isCurrentPublished ? "bg-published/10 text-published" : v.status === "draft" ? "bg-draft/10 text-draft" : "bg-line text-muted"}`}>
                    {v.isCurrentPublished ? "live" : v.status}
                  </span>
                  <span className="ml-auto text-xs text-muted">{new Date(v.createdAt).toLocaleString()}</span>
                  {canRestore && !v.isCurrentPublished && (
                    <button className="btn-subtle px-2 py-0.5 text-xs" disabled={restore.isPending} onClick={() => restore.mutate(v.id)}>
                      <Icon.History width={13} height={13} /> Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** ISO (UTC) ↔ datetime-local input value (local time) conversions. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  return new Date(v).toISOString(); // browser parses datetime-local as local time
}

function ScheduleDialog({
  documentId,
  locale,
  publishAt,
  expireAt,
  open,
  onOpenChange,
  onDone,
}: {
  documentId: string;
  locale: string;
  publishAt: string | null;
  expireAt: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (updated: ContentDetail) => void;
}) {
  const toast = useToast();
  const [pub, setPub] = useState(() => toLocalInput(publishAt));
  const [exp, setExp] = useState(() => toLocalInput(expireAt));

  const save = useMutation({
    mutationFn: (body: { publishAt: string | null; expireAt: string | null }) => api.schedule(documentId, locale, body),
    onSuccess: (updated) => {
      toast.success(
        updated.publishAt ? "Publish scheduled" : updated.status === "published" ? "Published" : "Schedule updated",
        updated.publishAt
          ? `Goes live ${new Date(updated.publishAt).toLocaleString()}.`
          : updated.expireAt
            ? `Expires ${new Date(updated.expireAt).toLocaleString()}.`
            : "Schedule cleared.",
      );
      onDone(updated);
      onOpenChange(false);
    },
    onError: (e) => toast.error("Couldn’t update schedule", (e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Schedule publish" description={`Timed go-live and expiry for ${locale.toUpperCase()}.`} className="w-[min(480px,94vw)]">
        <div className="space-y-4">
          <div>
            <label className="field-label" htmlFor="sched-pub">Publish at</label>
            <input id="sched-pub" type="datetime-local" className="field-input" value={pub} onChange={(e) => setPub(e.target.value)} />
            <p className="mt-1 text-xs text-muted">A future time schedules the current draft to go live automatically. Empty/past publishes now.</p>
          </div>
          <div>
            <label className="field-label" htmlFor="sched-exp">Expire (unpublish) at</label>
            <input id="sched-exp" type="datetime-local" className="field-input" value={exp} onChange={(e) => setExp(e.target.value)} />
            <p className="mt-1 text-xs text-muted">After this time the content is removed from the public delivery API.</p>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              className="btn-subtle text-xs"
              disabled={save.isPending || (!publishAt && !expireAt && !pub && !exp)}
              onClick={() => save.mutate({ publishAt: null, expireAt: null })}
            >
              Clear schedule
            </button>
            <div className="flex gap-2">
              <button className="btn-subtle" onClick={() => onOpenChange(false)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={save.isPending}
                onClick={() => save.mutate({ publishAt: fromLocalInput(pub), expireAt: fromLocalInput(exp) })}
              >
                {save.isPending ? "Saving…" : "Save schedule"}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Field-by-field diff of two versions. Text-like fields get an inline word-diff. */
function CompareView({
  documentId,
  locale,
  type,
  aId,
  bId,
  onBack,
}: {
  documentId: string;
  locale: string;
  type: ContentTypeDef | undefined;
  aId: number;
  bId: number;
  onBack: () => void;
}) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const a = useQuery({ queryKey: ["version", documentId, locale, aId], queryFn: ({ signal }) => api.version(documentId, locale, aId, signal) });
  const b = useQuery({ queryKey: ["version", documentId, locale, bId], queryFn: ({ signal }) => api.version(documentId, locale, bId, signal) });

  if (a.isLoading || b.isLoading || !a.data || !b.data) {
    return <p className="py-6 text-center text-sm text-muted">Loading versions…</p>;
  }
  const fields = diffFields(type, a.data, b.data);
  const changed = fields.filter((f) => f.changed);
  const shown = showUnchanged ? fields : changed;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <button className="btn-subtle px-2 py-1 text-xs" onClick={onBack}>← Back to list</button>
        <span className="text-muted">
          <span className="font-mono text-danger">A v{a.data.versionNumber}</span> →{" "}
          <span className="font-mono text-published">B v{b.data.versionNumber}</span> · {changed.length} changed field{changed.length === 1 ? "" : "s"}
        </span>
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} /> Show unchanged
        </label>
      </div>
      {shown.length === 0 && <p className="py-6 text-center text-sm text-muted">No differences between these versions.</p>}
      <div className="max-h-[60vh] space-y-3 overflow-auto pr-1">
        {shown.map((f) => (
          <div key={f.key} className={`rounded border px-3 py-2 ${f.changed ? "border-line" : "border-line/50 opacity-70"}`}>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {f.label}
              {!f.changed && <span className="rounded bg-line px-1 text-[10px] normal-case text-muted">unchanged</span>}
            </div>
            {f.changed ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
                {wordDiff(f.aText, f.bText).map((s, i) =>
                  s.t === "eq" ? (
                    <span key={i}>{s.s}</span>
                  ) : s.t === "del" ? (
                    <del key={i} className="bg-danger/15 text-danger line-through decoration-1">{s.s}</del>
                  ) : (
                    <ins key={i} className="bg-published/15 text-published no-underline">{s.s}</ins>
                  ),
                )}
                {f.aText === "" && f.bText === "" && <span className="text-muted">(structural change)</span>}
              </p>
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm text-muted">{f.bText || <span className="italic">empty</span>}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Flatten a TipTap doc (or any nested {text,content}) to plain text for AI context. */
function docToText(doc: unknown): string {
  const node = doc as { text?: string; content?: unknown[] } | null | undefined;
  if (!node) return "";
  let s = node.text ?? "";
  for (const c of node.content ?? []) s += ` ${docToText(c)}`;
  return s.replace(/\s+/g, " ").trim();
}

/* ----------------------------- version diff ------------------------------- */

interface FieldDiff {
  key: string;
  label: string;
  aText: string;
  bText: string;
  changed: boolean;
}

function diffEmpty(x: unknown): boolean {
  return x == null || x === "";
}
function diffDeepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (diffEmpty(a) && diffEmpty(b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Render any field value as comparable plain text (uniform word-diff input). */
function diffTextOf(fieldType: string, value: unknown): string {
  if (value == null) return "";
  switch (fieldType) {
    case "richtext":
      return docToText(value);
    case "boolean":
      return value ? "Yes" : "No";
    case "link": {
      const v = value as { href?: string; text?: string };
      return [v.text, v.href].filter(Boolean).join(" — ");
    }
    case "reference": {
      const v = value as { documentId?: string; type?: string };
      return v.documentId ? `${v.type ?? "ref"}:${v.documentId}` : "";
    }
    case "contentArea": {
      if (!Array.isArray(value)) return "";
      const blocks = value as Array<{ blockType?: string }>;
      const types = blocks.map((bl) => bl.blockType ?? "block").join(", ");
      return blocks.length ? `${types} (${blocks.length} block${blocks.length === 1 ? "" : "s"})` : "";
    }
    case "select":
      return Array.isArray(value) ? (value as string[]).join(", ") : String(value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

function diffFields(type: ContentTypeDef | undefined, a: VersionDetail, b: VersionDetail): FieldDiff[] {
  const out: FieldDiff[] = [];
  const meta: Array<{ key: string; label: string; av: unknown; bv: unknown; ft: string }> = [
    { key: "__name", label: "Name", av: a.name, bv: b.name, ft: "text" },
    { key: "__slug", label: "URL segment", av: a.slug ?? "", bv: b.slug ?? "", ft: "text" },
    { key: "__nav", label: "Show in navigation", av: a.displayInNav, bv: b.displayInNav, ft: "boolean" },
  ];
  for (const m of meta) {
    out.push({ key: m.key, label: m.label, aText: diffTextOf(m.ft, m.av), bText: diffTextOf(m.ft, m.bv), changed: !diffDeepEq(m.av, m.bv) });
  }
  for (const f of type?.fields ?? []) {
    const av = a.data[f.name];
    const bv = b.data[f.name];
    out.push({ key: f.name, label: f.displayName, aText: diffTextOf(f.type, av), bText: diffTextOf(f.type, bv), changed: !diffDeepEq(av, bv) });
  }
  return out;
}

/** Word-level LCS diff (whitespace kept as tokens). Field text is small/bounded. */
function wordDiff(aText: string, bText: string): Array<{ t: "eq" | "del" | "ins"; s: string }> {
  const a = aText ? aText.split(/(\s+)/) : [];
  const b = bText ? bText.split(/(\s+)/) : [];
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<{ t: "eq" | "del" | "ins"; s: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "eq", s: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ t: "del", s: a[i]! });
      i++;
    } else {
      out.push({ t: "ins", s: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", s: a[i++]! });
  while (j < m) out.push({ t: "ins", s: b[j++]! });
  return out;
}

function SaveIndicator({ state }: { state: SaveState }) {
  const map: Record<SaveState, { text: string; cls: string }> = {
    idle: { text: "", cls: "" },
    dirty: { text: "Unsaved changes", cls: "text-draft" },
    saving: { text: "Saving…", cls: "text-muted" },
    saved: { text: "All changes saved", cls: "text-published" },
    error: { text: "Save failed", cls: "text-red-600" },
  };
  const s = map[state];
  if (!s.text) return null;
  return <span className={`text-xs ${s.cls}`} aria-live="polite" data-testid="save-indicator">{s.text}</span>;
}

function Field({
  field,
  value,
  onChange,
  disabled,
  types,
  sharedBlocks,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  types: ContentTypeDef[];
  sharedBlocks: { documentId: string; name: string; type: string }[];
}) {
  const id = `f-${field.name}`;
  if (field.type === "contentArea") {
    return (
      <div>
        <div className="field-label flex items-center gap-2">
          {field.displayName}
          {field.delivery === "private" && <span className="rounded bg-line px-1 text-[10px] text-muted">private</span>}
        </div>
        <ContentArea
          field={field}
          value={(value as BlockInstance[]) ?? []}
          onChange={onChange}
          types={types}
          sharedBlocks={sharedBlocks}
        />
      </div>
    );
  }
  return (
    <div>
      <label className="field-label flex items-center gap-2" htmlFor={id}>
        {field.displayName}
        {field.required && <span className="text-red-500" title="Required to publish">*</span>}
        {field.delivery === "private" && <span className="rounded bg-line px-1 text-[10px] text-muted">private</span>}
      </label>
      {field.helpText && <p className="mb-1 text-xs text-muted">{field.helpText}</p>}
      {field.type === "text" && (
        <div>
          <input id={id} className="field-input" value={(value as string) ?? ""} disabled={disabled}
            onChange={(e) => onChange(e.target.value)} />
          {field.validation?.maxLength != null && (
            <div className={`mt-0.5 text-right text-[11px] ${((value as string) ?? "").length > field.validation.maxLength ? "text-danger" : "text-muted"}`}>
              {((value as string) ?? "").length} / {field.validation.maxLength}
            </div>
          )}
        </div>
      )}
      {field.type === "markdown" && (
        <MarkdownEditor id={id} value={(value as string) ?? ""} disabled={disabled} onChange={(v) => onChange(v)} />
      )}
      {field.type === "richtext" && <RichText id={id} value={value} onChange={onChange} />}
      {field.type === "boolean" && (
        <input id={id} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.type === "number" && (
        <input id={id} type="number" className="field-input" value={(value as number) ?? ""} disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))} />
      )}
      {field.type === "datetime" && (
        <input id={id} type="datetime-local" className="field-input" value={(value as string) ?? ""} disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)} />
      )}
      {field.type === "select" && <SelectField id={id} field={field} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "link" && <LinkField id={id} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "image" && (
        <ImageField id={id} value={value} disabled={disabled} onChange={onChange} />
      )}
      {field.type === "media" && (
        <input id={id} className="field-input" placeholder="Asset documentId" value={(value as string) ?? ""} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function SelectField({ id, field, value, disabled, onChange }: { id: string; field: FieldDef; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  if (field.multiple) {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (v: string) => onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={id}>
        {field.options.map((o) => (
          <button key={o.value} type="button" disabled={disabled} onClick={() => toggle(o.value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${arr.includes(o.value) ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-line/60"}`}>
            {o.label}
          </button>
        ))}
        {field.options.length === 0 && <span className="text-xs text-muted">No options configured.</span>}
      </div>
    );
  }
  return (
    <select id={id} className="field-input" value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— choose —</option>
      {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function LinkField({ id, value, disabled, onChange }: { id: string; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  const v = (value as { href?: string; text?: string; target?: string; title?: string } | null) ?? {};
  const set = (patch: Record<string, string | undefined>) => {
    const next = { ...v, ...patch };
    onChange(next.href || next.text || next.title ? next : null);
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <input id={id} className="field-input col-span-2" placeholder="https://… or /path" value={v.href ?? ""} disabled={disabled} onChange={(e) => set({ href: e.target.value })} aria-label="Link URL" />
      <input className="field-input" placeholder="Link text" value={v.text ?? ""} disabled={disabled} onChange={(e) => set({ text: e.target.value })} aria-label="Link text" />
      <select className="field-input" value={v.target ?? "_self"} disabled={disabled} onChange={(e) => set({ target: e.target.value })} aria-label="Link target">
        <option value="_self">Same tab</option>
        <option value="_blank">New tab</option>
      </select>
    </div>
  );
}
