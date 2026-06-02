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
import { api, ApiError, type AiTask } from "../lib/api.js";
import { ResizeHandle } from "./ui/resize.js";
import { Icon } from "../lib/icons.js";
import { ContentArea } from "./fields/ContentArea.js";
import { RichText } from "./fields/RichText.js";
import { ImageField } from "./MediaLibrary.js";
import { PreviewPane } from "./PreviewPane.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu.js";
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
}

export function Editor({ documentId, locale, setLocale, locales, types, user, onName, widePreview = false }: EditorProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [showVersions, setShowVersions] = useState(false);
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
    }
  }, [detail.data, variantKey]);

  // Report the document name up for the breadcrumb / tab title.
  useEffect(() => {
    if (form) onName?.(form.name);
  }, [form, onName]);

  const canEdit = user.permissions.includes("content.update");
  const canPublish = user.permissions.includes("content.publish");

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

  if (detail.isLoading || !form) {
    return <div className="grid h-full place-items-center text-muted">Loading editor…</div>;
  }
  if (detail.isError) {
    const err = detail.error;
    const msg = err instanceof ApiError && err.status === 403 ? "You don't have access to this content." : "Failed to load content.";
    return <div className="grid h-full place-items-center text-muted">{msg}</div>;
  }

  const groups = type ? [...new Set(type.fields.map((f) => f.group))] : ["Content"];
  const isPage = form.kind === "page";
  const setField = (name: string, value: unknown) =>
    patch((prev) => ({ ...prev, data: { ...prev.data, [name]: value } }));

  return (
    <div className="flex h-full flex-col">
      {/* Workflow toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
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
          {showAi && (
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
          <button className={`btn-subtle ${showPreview ? "ring-2 ring-accent" : ""}`} onClick={() => setShowPreview(!showPreview)}>
            <Icon.Eye width={16} height={16} /> Preview
          </button>
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
                  {form.status === "published" && (
                    <MenuItem onSelect={() => unpublish.mutate()}>Unpublish</MenuItem>
                  )}
                  {form.hasUnpublishedChanges && (
                    <>
                      {form.status === "published" && <MenuSeparator />}
                      <MenuItem destructive onSelect={() => discard.mutate()}>Discard draft changes</MenuItem>
                    </>
                  )}
                  {form.status !== "published" && !form.hasUnpublishedChanges && (
                    <MenuItem disabled>No actions available</MenuItem>
                  )}
                </MenuContent>
              </Menu>
            </div>
          )}
        </div>
      </div>

      {/* Basic-info header */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-line bg-canvas px-4 py-3 md:grid-cols-4">
        <Meta label="Name">
          <input className="field-input py-1" value={form.name} disabled={!canEdit}
            onChange={(e) => patch((prev) => ({ ...prev, name: e.target.value }))} aria-label="Name" />
        </Meta>
        {isPage ? (
          <>
            <Meta label="Name in URL (segment)">
              <input className="field-input py-1" value={form.slug ?? ""} disabled={!canEdit}
                onChange={(e) => patch((prev) => ({ ...prev, slug: e.target.value }))} aria-label="Slug" />
            </Meta>
            <Meta label="Display in navigation">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.displayInNav} disabled={!canEdit}
                  onChange={(e) => patch((prev) => ({ ...prev, displayInNav: e.target.checked }))} />
                <span className="text-muted">Show in menus</span>
              </label>
            </Meta>
            <Meta label="URL (from page hierarchy)">
              <code className="block truncate rounded bg-line/60 px-2 py-1 font-mono text-xs text-fg" title={form.urlPath ?? ""}>
                {form.urlPath ?? "—"}
              </code>
            </Meta>
          </>
        ) : (
          <Meta label="Asset">
            <span className="rounded bg-accent/15 px-2 py-1 text-xs font-medium text-fg">Shared block · lives in the asset pane</span>
          </Meta>
        )}
        <Meta label="Type / ID">
          <div className="text-sm">
            <span className="font-medium">{type?.displayName ?? form.type}</span>
            <code className="ml-2 rounded bg-line/70 px-1 text-[11px] text-muted">{form.documentId.slice(0, 10)}…</code>
          </div>
        </Meta>
      </div>

      {/* Canvas + (optional) preview — resizable split: drag the divider to give
          the on-page preview more room. */}
      <PanelGroup direction="horizontal" autoSaveId={`paperboy-editor-split-${widePreview ? "w" : "n"}`} className="flex min-h-0 flex-1">
        <Panel id="form" order={1} defaultSize={widePreview ? 32 : 42} minSize={24} className="min-w-0">
          <section className="h-full overflow-auto">
            {/* tabs */}
            <div className="flex gap-1 border-b border-line bg-panel px-4" role="tablist" aria-label="Property groups">
              {groups.map((g) => (
                <button key={g} role="tab" aria-selected={tab === g}
                  className={`border-b-2 px-3 py-2.5 text-sm font-medium ${tab === g ? "border-accent text-accent-700" : "border-transparent text-muted hover:text-ink"}`}
                  onClick={() => setTab(g)}>
                  {g}
                </button>
              ))}
            </div>

            <div className="mx-auto max-w-3xl space-y-5 p-6" onFocusCapture={activateProp} onClickCapture={activateProp}>
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
        </Panel>
        {showPreview && <ResizeHandle />}
        {showPreview && (
          <Panel id="preview" order={2} defaultSize={widePreview ? 68 : 58} minSize={20} className="min-w-0 border-l border-line bg-panel">
            <PreviewPane locale={locale} urlPath={form.urlPath} documentId={documentId} refreshSignal={previewRefresh} focusField={propFocus} />
          </Panel>
        )}
      </PanelGroup>

      {showVersions && (
        <VersionsDialog
          documentId={documentId}
          locale={locale}
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
    </div>
  );
}

function VersionsDialog({
  documentId,
  locale,
  canRestore,
  open,
  onOpenChange,
  onRestored,
}: {
  documentId: string;
  locale: string;
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Version history" description={`All saved versions for this content in ${locale.toUpperCase()}.`} className="w-[min(620px,94vw)]">
        {versions.isLoading && <p className="py-6 text-center text-sm text-muted">Loading…</p>}
        {!versions.isLoading && rows.length === 0 && <p className="py-6 text-center text-sm text-muted">No versions yet.</p>}
        <ul className="max-h-[60vh] space-y-1 overflow-auto">
          {rows.map((v) => (
            <li key={v.id} className="flex items-center gap-3 rounded border border-line px-3 py-2 text-sm">
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
      </DialogContent>
    </Dialog>
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

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      {children}
    </div>
  );
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
        <textarea id={id} className="field-input min-h-[280px] font-mono text-[13px] leading-relaxed" value={(value as string) ?? ""} disabled={disabled}
          spellCheck={false} onChange={(e) => onChange(e.target.value)} placeholder="# Markdown… (headings, **bold**, lists, `code`, tables)" />
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
