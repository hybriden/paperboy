import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BlockInstance,
  type ContentDetail,
  type ContentTypeDef,
  type FieldDef,
  type Locale,
  SEO_CONVENTION,
  SEO_FIELD_NAMES,
  type SessionUser,
} from "@paperboy/shared";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type AiTask, type VersionDetail } from "../lib/api.js";
import { postCaret } from "../lib/caret.js";
import { applyRichTextStrings, collectRichTextStrings } from "../lib/richtext-strings.js";
import { pickTranslateSource } from "../lib/translate-offer.js";
import { reviewBadge } from "../lib/review-badge.js";
import { AI_OFF_HINT, useAiEnabled } from "../lib/useAiStatus.js";
import { blockInstanceFromDrop, type DropPayload } from "../lib/block-drop.js";
import { parsePreviewMessage } from "@paperboycms/preview/protocol";
import { ResizeHandle } from "./ui/resize.js";
import { Icon } from "../lib/icons.js";
import { TypeIcon } from "../lib/typeIcons.js";
import { BuildFromBriefDialog } from "./BuildFromBrief.js";
import { ContentArea } from "./fields/ContentArea.js";
import { MarkdownEditor } from "./fields/MarkdownEditor.js";
import { ReferenceField } from "./fields/ReferenceField.js";
import { RichText } from "./fields/RichText.js";
import { ImageField, StockQueryContext } from "./MediaLibrary.js";
import { type PbRect, type PreviewMode, PreviewPane, publicSiteUrl } from "./PreviewPane.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { Skeleton } from "./ui/skeleton.js";
import { useToast } from "./ui/toast.js";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Stringify a scalar field value; objects/arrays/null become "" (never "[object Object]"). */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

// Unique keys for blocks dropped onto the preview (matches fields/ContentArea).
let blockKeyCounter = 0;
const newBlockKey = () => `b_${Date.now().toString(36)}_${blockKeyCounter++}`;
/** The Episerver-style editor views: form only / side-by-side / on-page edit. */
type EditorView = "props" | "split" | "onpage";

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
  const [showBrief, setShowBrief] = useState(false);
  const [hideTranslateOffer, setHideTranslateOffer] = useState(false);
  const detail = useQuery({
    queryKey: ["content", documentId, locale],
    queryFn: ({ signal }) => api.get(documentId, locale, signal),
  });

  // Same key + shape as the asset pane (BlockSummary[]) — sharing the key with a
  // different shape would let one consumer overwrite the other's cache.
  const sharedBlocks = useQuery({ queryKey: ["blocks"], queryFn: ({ signal }) => api.blocks(signal) });

  // Site config (preview base URL + start page) for the "View on site" shortcut.
  // Same query key as PreviewPane, so the request is shared, not duplicated.
  const site = useQuery({ queryKey: ["site"], queryFn: ({ signal }) => api.site(signal) });

  // The agent-review gate (Settings → MCP). The "Needs review" badge is the
  // visible side of this gate, so it only shows when review is actually required.
  // Same query key as the settings panel, so the request is shared.
  const reviewGate = useQuery({ queryKey: ["agent-review"], queryFn: ({ signal }) => api.agentReview(signal) });

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
  // Editor view — the Episerver-style trio. Persisted so it survives
  // re-renders/remounts (e.g. toggling a side pane remounts the editor):
  //   props   = all-properties form only
  //   split   = form + live preview side by side (click preview → focus field)
  //   onpage  = full-width preview, click an element → edit it in place
  const [view, setViewState] = useState<EditorView>(() => {
    try {
      const v = localStorage.getItem("pb-editor-view");
      if (v === "props" || v === "split" || v === "onpage") return v;
      // Migrate the previous two-flag persistence.
      if (localStorage.getItem("pb-show-preview") === "1") {
        return localStorage.getItem("pb-preview-mode") === "edit" ? "onpage" : "split";
      }
      return "props";
    } catch { return "props"; }
  });
  const setView = (next: EditorView) => {
    setViewState(next);
    if (next !== "onpage") closeOpeRef.current?.();
    try { localStorage.setItem("pb-editor-view", next); } catch { /* ignore */ }
  };
  const [previewRefresh, setPreviewRefresh] = useState(0);
  // Editor → preview sync: focusing/clicking a property highlights its region in
  // the preview. The counter re-triggers even when the same field is re-focused.
  const [propFocus, setPropFocus] = useState<{ field: string; n: number } | null>(null);
  const propCounter = useRef(0);

  // ---- On-page edit (Optimizely-style OPE) ----------------------------------
  // Derived from the view: in "onpage" the preview clicks open anchored overlay
  // editors; in "split" they focus the sidebar field (classic side-by-side).
  const opeMode: PreviewMode = view === "onpage" ? "edit" : "inspect";
  // The open overlay: which field, anchored where. `rect` is the element's
  // bridge-reported rect; `ox`/`oy` is the CLICK offset within the element, so
  // the card opens where the editor clicked — a 2000px-tall richtext body
  // would otherwise anchor the card at its far-away bottom edge.
  const [ope, setOpe] = useState<{ field: string; rect: PbRect; ox: number; oy: number; n: number } | null>(null);
  const opeRef = useRef<typeof ope>(null);
  useEffect(() => { opeRef.current = ope; }, [ope]);
  const opeModeRef = useRef(opeMode);
  useEffect(() => { opeModeRef.current = opeMode; }, [opeMode]);
  // Saves that happened while the overlay was open (reload deferred to close).
  const opeDirtyRef = useRef(false);
  const closeOpeRef = useRef<(() => void) | null>(null);
  // Live patch for the page DOM (no reload while typing in the overlay).
  const [livePatch, setLivePatch] = useState<{ field: string; text?: string; html?: string; n: number } | null>(null);
  const livePatchCounter = useRef(0);
  const activeFieldRef = useRef<string | null>(null);
  const activateProp = (e: React.FocusEvent | React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.("[data-pb-prop]");
    const field = el?.getAttribute("data-pb-prop");
    if (!field) return;
    // Defer to the NEXT FRAME (not a microtask, which still flushes mid-click
    // sequence): running setPropFocus synchronously in the capture phase
    // re-renders the field between a click's mousedown/focus and its click,
    // which swallows the click on controlled inputs — a boolean checkbox would
    // never toggle. Also skip when the field is unchanged so re-focusing the
    // same field (e.g. clicking a checkbox already focused) issues no re-render.
    if (field === activeFieldRef.current) return;
    activeFieldRef.current = field;
    requestAnimationFrame(() => setPropFocus({ field, n: ++propCounter.current }));
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

  // A variant is "empty" when it has no saved version (scaffold, versionNumber
  // 0) OR a version with no field values yet (e.g. a page just created in the
  // default locale carries name+slug but data {}). Offer to seed THIS locale
  // from any OTHER locale that has real content — preferring the default — in
  // either direction (2026-06-07: an nb-only article opened in en got no offer
  // because the old logic was one-way AND only checked versionNumber 0).
  const defaultLocale = useMemo(() => locales.find((l) => l.isDefault)?.code ?? "en", [locales]);
  const isEmptyVariant = (d?: ContentDetail) =>
    !d || d.versionNumber === 0 || Object.keys(d.data ?? {}).length === 0;
  const untranslated = !!detail.data && isEmptyVariant(detail.data);
  const otherLocales = useMemo(() => locales.filter((l) => l.code !== locale).map((l) => l.code), [locales, locale]);
  const probes = useQueries({
    queries: otherLocales.map((code) => ({
      queryKey: ["content", documentId, code],
      queryFn: ({ signal }: { signal?: AbortSignal }) => api.get(documentId, code, signal),
      enabled: untranslated,
    })),
  });
  // A locale "has content" only when its variant is NOT empty (an empty draft
  // is nothing to translate from).
  const localesWithContent = otherLocales.filter((_, i) => !isEmptyVariant(probes[i]?.data));
  const sourceLocale = untranslated
    ? pickTranslateSource({ currentLocale: locale, defaultLocale, localesWithContent })
    : null;
  const sourceData = sourceLocale ? probes[otherLocales.indexOf(sourceLocale)]?.data : undefined;
  const canTranslate = !!sourceLocale && !!sourceData;

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
      // Sync the server-computed metadata live (derived, never user-edited —
      // user-typed name/data must NOT be clobbered by the round-trip): the URL
      // path and the publish status. Without the status sync, editing a
      // published page didn't show "Published · changes" (or enable "Discard
      // draft changes") until a full reload.
      const meta = {
        urlPath: updated.urlPath,
        status: updated.status,
        hasUnpublishedChanges: updated.hasUnpublishedChanges,
        publishAt: updated.publishAt,
        expireAt: updated.expireAt,
      };
      setForm((prev) => (prev ? { ...prev, ...meta } : prev));
      formRef.current = formRef.current ? { ...formRef.current, ...meta } : formRef.current;
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["blocks"] });
      // Reload the preview with the saved draft — but NOT while an on-page
      // overlay is open (the reload would yank the page out from under the
      // editor mid-typing; live patches keep it current, and the deferred
      // reload reconciles on overlay close).
      if (opeRef.current) opeDirtyRef.current = true;
      else setPreviewRefresh((n) => n + 1);
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
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["blocks"] });
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
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["blocks"] });
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
      void qc.invalidateQueries({ queryKey: ["content", documentId, locale] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["blocks"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Draft discarded");
    },
    onError: (e) => toast.error("Couldn’t discard draft", (e as Error).message),
  });

  const canDelete = user.permissions.includes("content.delete");
  const canCreate = user.permissions.includes("content.create");

  const duplicate = useMutation({
    mutationFn: () => api.duplicate(documentId, locale),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Duplicated", `Created “${created.name}”.`);
      void navigate(`/edit/${created.documentId}${locale !== "en" ? `?lang=${locale}` : ""}`);
    },
    onError: (e) => toast.error("Couldn’t duplicate", (e as Error).message),
  });

  // Human approval of an agent-written draft (clears the needs-review flag).
  const approve = useMutation({
    mutationFn: () => api.approveReview(documentId, locale),
    onSuccess: (updated) => {
      const meta = { needsReview: updated.needsReview, updatedVia: updated.updatedVia };
      setForm((prev) => (prev ? { ...prev, ...meta } : prev));
      formRef.current = formRef.current ? { ...formRef.current, ...meta } : formRef.current;
      qc.setQueryData(["content", documentId, locale], updated);
      toast.success("Draft approved", "The agent-written draft is marked as reviewed.");
    },
    onError: (e) => toast.error("Couldn’t approve", (e as Error).message),
  });

  const trash = useMutation({
    mutationFn: () => api.trash(documentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["blocks"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Moved to trash", "Restore it from Settings → Trash.");
      void navigate("/edit");
    },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });

  // ----- AI editorial assistant (SEO meta generation from the page content) -----
  const hasField = (name: string) => Boolean(type?.fields.some((f) => f.name === name));
  // The page text is harvested SCHEMA-AWARE — seoRole-tagged fields first,
  // then delivery's name conventions, then every remaining text-bearing field —
  // so the copy desk reads the page the same way the delivered seo block does,
  // whatever the type's fields are called. (It used to read only 'heading' +
  // 'intro', which starved every other type down to just the page name.)
  function pageText(): string {
    const current = formRef.current ?? form;
    const d = current?.data ?? {};
    const all = (type?.fields ?? []).filter((f) => !SEO_FIELD_NAMES.has(f.name)); // never feed meta back into meta
    const textOf = (f: FieldDef): string => {
      const v = d[f.name];
      if (typeof v === "string") return v;
      if (f.type === "richtext") return docToText(v);
      return "";
    };
    const byRole = (role: "title" | "description"): FieldDef | undefined => {
      const tagged = all.find((f) => f.seoRole === role);
      if (tagged) return tagged;
      const names = SEO_CONVENTION[role] ?? [];
      return all.find((f) => names.includes(f.name.toLowerCase()));
    };
    const prioritized = [byRole("title"), byRole("description")].filter((f): f is FieldDef => Boolean(f));
    const rest = all.filter((f) => !prioritized.includes(f) && (f.type === "text" || f.type === "markdown" || f.type === "richtext"));
    const parts = [String(current?.name ?? ""), ...[...prioritized, ...rest].map(textOf)];
    return parts.filter(Boolean).join("\n").slice(0, 8000);
  }
  const ai = useMutation({
    mutationFn: (v: { task: AiTask; field: string }) => api.aiAssist(v.task, pageText()).then((r) => ({ ...r, field: v.field })),
    onSuccess: (r) => {
      setField(r.field, r.result);
      if (r.provider === "fallback") toast.success("Draft suggestion added", "Basic mode — add an AI key in Settings → AI for real suggestions.");
      else toast.success("Suggestion applied");
    },
    onError: (e) => toast.error("Copy desk failed", (e as Error).message),
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
      const src = sourceData;
      if (!src) throw new Error("No source content to translate from");
      // Collect all translatable strings — name + text/markdown fields AND the
      // text inside richtext fields (an article's `body` lives there; copying it
      // verbatim left the page untranslated, 2026-06-08) — and send them in ONE
      // request (one call per field would trip the rate limit on a large page).
      // Each segment records how many strings it owns so the batch slices back.
      type Seg = { kind: "name" } | { kind: "text"; field: string } | { kind: "rich"; field: string; count: number };
      const segs: Seg[] = [];
      const texts: string[] = [];
      if (src.name?.trim()) {
        segs.push({ kind: "name" });
        texts.push(src.name);
      }
      for (const f of type?.fields ?? []) {
        const v = src.data[f.name];
        if ((f.type === "text" || f.type === "markdown") && typeof v === "string" && v.trim()) {
          segs.push({ kind: "text", field: f.name });
          texts.push(v);
        } else if (f.type === "richtext" && v && typeof v === "object") {
          const strings = collectRichTextStrings(v);
          if (strings.length) {
            segs.push({ kind: "rich", field: f.name, count: strings.length });
            texts.push(...strings);
          }
        }
      }
      const { results, provider } = texts.length
        ? await api.aiTranslate(texts, locale)
        : { results: [] as string[], provider: "fallback" as const };
      // Start from a verbatim copy (untranslatable fields: contentArea, refs,
      // images, booleans…), then overwrite each translated segment in order.
      const data: Record<string, unknown> = {};
      for (const f of type?.fields ?? []) if (src.data[f.name] !== undefined) data[f.name] = src.data[f.name];
      let name = src.name;
      let i = 0;
      for (const seg of segs) {
        if (seg.kind === "name") {
          name = results[i] ?? texts[i]!;
          i += 1;
        } else if (seg.kind === "text") {
          data[seg.field] = results[i] ?? texts[i]!;
          i += 1;
        } else {
          data[seg.field] = applyRichTextStrings(src.data[seg.field], results.slice(i, i + seg.count));
          i += seg.count;
        }
      }
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
          ? "The copy desk is offline — text was copied for manual translation. Review and publish."
          : "Review the AI translation, then publish.",
      );
    },
    onError: (e) => toast.error("Couldn’t translate", (e as Error).message),
  });

  // Field types that get an anchored on-page overlay in edit mode; structural
  // fields (contentArea/reference) genuinely want the sidebar's context, and
  // block clicks keep the classic focus flow too.
  const OPE_FIELD_TYPES = new Set(["text", "markdown", "richtext", "boolean", "number", "datetime", "select", "link", "image"]);

  // Visual on-page editing: the preview iframe posts which field/block was
  // clicked. In INSPECT mode → switch to its tab and scroll/focus the sidebar
  // field (classic). In EDIT mode → open an anchored overlay editor on the page
  // (paperboy:rect keeps the anchor tracking page scroll/resize).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = parsePreviewMessage(e.data);
      if (!msg) return; // unknown/garbage (and forward-compat: future message types)
      if (msg.type === "paperboy:rect") {
        // Anchor update for the open overlay (same field only).
        if (msg.rect && opeRef.current && msg.field === opeRef.current.field && msg.blockIndex == null) {
          setOpe((prev) => (prev ? { ...prev, rect: msg.rect } : prev));
        }
        return;
      }
      if (msg.type === "paperboy:drop") {
        // A shared block (or page → teaser) was dragged from the Assets pane and
        // dropped onto a content area in the rendered preview. Append it to that
        // field; autosave + the preview reload then show it in place.
        const fieldName = typeof msg.field === "string" ? msg.field : null;
        const def = fieldName ? type?.fields.find((f) => f.name === fieldName) : undefined;
        if (!fieldName || !def) {
          // A drop zone whose data-pb-area doesn't name a real field is a
          // frontend annotation bug — surface it instead of swallowing the drop.
          toast.error("Couldn’t drop here", `The preview marks this area as “${fieldName ?? "?"}”, which isn’t a field of ${type?.name ?? "this type"}. data-pb-area must name the contentArea field.`);
          return;
        }
        const payload = (msg.payload ?? {}) as DropPayload;
        const res = blockInstanceFromDrop(payload, def, newBlockKey());
        if (!res.ok) {
          if (res.reason === "not-allowed") {
            toast.error("Block not allowed here", `This area doesn’t accept ${payload.blockType ?? "that"} blocks.`);
          }
          return;
        }
        const cur = formRef.current?.data?.[fieldName];
        const current = Array.isArray(cur) ? (cur as BlockInstance[]) : [];
        setField(fieldName, [...current, res.block]);
        toast.success("Block added", payload.name ? `Added “${payload.name}”.` : "Added to the content area.");
        return;
      }
      if (msg.type !== "paperboy:edit") return;
      const d = msg;
      const fieldName = typeof d.field === "string" ? d.field : null;
      const def = fieldName ? type?.fields.find((f) => f.name === fieldName) : undefined;

      // Click-to-caret: the bridge reports where INSIDE the field the click
      // landed (text snippet + offset). Long richtext/markdown fields use it to
      // open at the clicked text, not the top. Mailbox: the target editor may
      // mount later (OPE overlay / lazy TipTap chunk).
      const caret = (d as { caret?: { snippet?: string; offset?: number } }).caret;
      if (fieldName && def && (def.type === "richtext" || def.type === "markdown") && typeof caret?.snippet === "string" && caret.snippet.length > 0) {
        postCaret(`f-${fieldName}`, { snippet: caret.snippet, offset: typeof caret.offset === "number" ? caret.offset : 0 });
      }

      if (opeModeRef.current === "edit") {
        if (d.blockIndex == null && d.rect) {
          const click = (d as { click?: { x: number; y: number } }).click;
          const anchor = {
            rect: d.rect,
            // Anchor the card at the click, not the element box — clamped inside.
            ox: click ? Math.max(0, click.x - d.rect.x) : 0,
            oy: click ? Math.max(0, click.y - d.rect.y) : d.rect.h,
            n: ++propCounter.current,
          };
          // The page NAME is marked on most frontends but isn't a data field —
          // it's still on-page-editable (a plain text value on the version).
          if (fieldName === "name") {
            setOpe({ field: "name", ...anchor });
            return;
          }
          if (def && OPE_FIELD_TYPES.has(def.type)) {
            setOpe({ field: def.name, ...anchor });
            return;
          }
          // A marker that doesn't map to anything editable: do nothing rather
          // than yanking the editor out of on-page mode.
          if (!def) return;
        }
        // Structural targets (blocks, content areas, references) want the form
        // panel — which on-page edit hides for real estate. Drop to
        // side-by-side so the sidebar flow below has somewhere to land.
        setView("split");
      }

      if (def) setTab(def.group);
      const id = d.blockIndex != null ? `pb-block-${d.blockIndex}` : fieldName ? `f-${fieldName}` : null;
      if (id) {
        // Poll for the target: switching out of on-page mode REMOUNTS the form
        // panel, so a fixed delay raced the new DOM (clicking an empty content
        // area dropped to side-by-side but never scrolled to its block palette).
        let tries = 0;
        const land = () => {
          const el = document.getElementById(id);
          if (!el) {
            if (tries++ < 25) setTimeout(land, 40); // ~1s budget
            return;
          }
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("pb-flash");
          setTimeout(() => el.classList.remove("pb-flash"), 1400);
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
        };
        setTimeout(land, 40);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // Close the on-page overlay; if anything was saved while it was open, do the
  // deferred preview reload now (the bridge restores the scroll position).
  function closeOpe() {
    setOpe(null);
    if (opeDirtyRef.current) {
      opeDirtyRef.current = false;
      setPreviewRefresh((n) => n + 1);
    }
  }
  closeOpeRef.current = closeOpe;

  // Compact page context for AI tasks launched from the overlay — name + the
  // page's short string fields, so suggestions match the page's subject/tone.
  function pageAiContext(): string {
    const f = formRef.current;
    if (!f) return "";
    const bits = [`Page: ${f.name}`];
    for (const [k, v] of Object.entries(f.data ?? {})) {
      if (typeof v === "string" && v.trim() && v.length <= 500) bits.push(`${k}: ${v.trim()}`);
    }
    return bits.join("\n").slice(0, 3000);
  }

  // Overlay typing → live DOM patch in the preview (text swaps directly;
  // richtext renders to HTML via a lazily-loaded TipTap serializer chunk).
  function pushLivePatch(fieldDef: FieldDef, value: unknown) {
    if (fieldDef.type === "text" || fieldDef.type === "number") {
      setLivePatch({ field: fieldDef.name, text: asText(value), n: ++livePatchCounter.current });
    } else if (fieldDef.type === "richtext") {
      void import("../lib/richtextHtml.js").then(({ richTextHtml }) => {
        const html = richTextHtml(value);
        if (html != null) setLivePatch({ field: fieldDef.name, html, n: ++livePatchCounter.current });
      });
    }
    // Other types: no in-place patch — the deferred reload on close reconciles.
  }

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
    return (
      <div className="space-y-4 p-6" aria-busy>
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const groups = type ? [...new Set(type.fields.map((f) => f.group))] : ["Content"];
  const isPage = form.kind === "page";
  // Live preview is a desktop-only split pane; never open it on phones.
  const previewOpen = view !== "props" && !mobile;
  // Hoisted on purpose: the preview message handler (registered while the
  // editor may still be loading) closes over this — a `const` here would stay
  // un-initialized in that closure (TDZ) and crash the first drop.
  function setField(name: string, value: unknown) {
    patch((prev) => ({ ...prev, data: { ...prev.data, [name]: value } }));
  }

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

      <div className="max-w-3xl space-y-5 p-4 sm:p-6" onFocusCapture={activateProp} onClickCapture={activateProp}>
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

  // Seed image pickers' stock search with the page subject (name + heading).
  const stockQuery = [form.name, typeof form.data.heading === "string" ? form.data.heading : ""]
    .filter(Boolean).join(" ").trim().slice(0, 120);

  return (
    <StockQueryContext.Provider value={stockQuery}>
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
          {/* Agent provenance. The actionable "Needs review" badge only shows when
              the site requires agent review (Settings → MCP); otherwise an agent
              write is surfaced as a passive "agent-edited" label. */}
          {reviewBadge(form, reviewGate.data?.required ?? false) === "needs-review" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-draft/10 px-2.5 py-1 text-xs font-semibold text-draft" title="The working draft was written by an agent (via MCP) and the site requires human review before agents publish. Approve it or edit it to clear the flag.">
              <span aria-hidden>🤖</span> Needs review
              {canEdit && (
                <button
                  type="button"
                  className="ml-0.5 rounded bg-draft/15 px-1.5 py-0.5 text-[11px] font-semibold hover:bg-draft/25"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  {approve.isPending ? "Approving…" : "Approve"}
                </button>
              )}
            </span>
          )}
          {reviewBadge(form, reviewGate.data?.required ?? false) === "agent-edited" && (
            <span className="text-[11px] text-muted" title="The working version was last written by an agent via MCP.">
              <span aria-hidden>🤖</span> agent-edited
            </span>
          )}
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
          {(showAi || canCreate) && !mobile && (
            <Menu>
              {/* The newsroom name for what this does: the copy desk polishes
                  copy, writes headlines and standfirsts, and drafts on a brief. */}
              <MenuTrigger className="btn-subtle" aria-label="Copy desk" disabled={ai.isPending}>
                <Icon.Edit width={14} height={14} aria-hidden /> {ai.isPending ? "Working…" : "Copy desk"}
              </MenuTrigger>
              <MenuContent>
                {canCreate && (
                  <MenuItem onSelect={() => setShowBrief(true)}>Build from brief…</MenuItem>
                )}
                {canCreate && showAi && <MenuSeparator />}
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
            // Episerver-style view trio: form / side-by-side / on-page edit.
            <div className="flex rounded border border-line p-0.5" role="group" aria-label="Editor view">
              {(
                [
                  ["props", "Properties", "All-properties form"],
                  ["split", "Side by side", "Form + live preview"],
                  ["onpage", "On-page", "Edit directly on the page"],
                ] as const
              ).map(([v, label, title]) => (
                <button
                  key={v}
                  className={`rounded px-2 py-0.5 text-xs ${view === v ? "bg-accent/15 font-semibold text-accent-700" : "text-muted hover:bg-canvas"}`}
                  aria-pressed={view === v}
                  title={title}
                  onClick={() => setView(v)}
                >
                  {label}
                </button>
              ))}
            </div>
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
                  {form.status === "published" && form.urlPath != null && (
                    <>
                      <MenuItem
                        onSelect={() =>
                          window.open(publicSiteUrl(site.data, locale, form.urlPath, documentId), "_blank", "noopener")
                        }
                      >
                        View on site ↗
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  )}
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

      {/* Untranslated-locale → offer an AI translation seeded from any locale with content */}
      {untranslated && canTranslate && !hideTranslateOffer && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-accent/10 px-4 py-2 text-sm">
          <span className="text-fg">
            Not translated to <strong>{locales.find((l) => l.code === locale)?.displayName ?? locale}</strong> yet.
          </span>
          <div className="ml-auto flex items-center gap-2">
            {canEdit && (
              <button className="btn-primary px-3 py-1 text-xs" disabled={translate.isPending} onClick={() => translate.mutate()}>
                {translate.isPending
                  ? "Translating…"
                  : `Translate from ${locales.find((l) => l.code === sourceLocale)?.displayName ?? sourceLocale}`}
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
                <input type="checkbox" checked={form.displayInNav} disabled={!canEdit} aria-label="Display in navigation"
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
          preview more room. In on-page edit mode the preview takes the WHOLE
          row (the all-properties form needs no real estate until you exit). */}
      {(() => {
        const previewPaneEl = previewOpen ? (
          <PreviewPane
            locale={locale}
            urlPath={form.urlPath}
            documentId={documentId}
            kind={form.kind}
            refreshSignal={previewRefresh}
            focusField={propFocus}
            mode={opeMode}
            livePatch={livePatch}
            overlay={(() => {
              if (!ope || !type) return null;
              const isName = ope.field === "name";
              const def = isName ? null : type.fields.find((f) => f.name === ope.field);
              if (!isName && !def) return null;
              const current = isName ? form.name : form.data[def!.name];
              const liveText = (text: string) => setLivePatch({ field: "name", text, n: ++livePatchCounter.current });
              const patchName = (v: string) => patch((prev) => ({ ...prev, name: v }));
              return {
                rect: ope.rect,
                ox: ope.ox,
                oy: ope.oy,
                onClose: closeOpe,
                content: (
                  <div>
                    <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
                      <span className="text-xs font-semibold text-fg">Edit on page</span>
                      <SaveIndicator state={saveState} />
                      <button className="ml-auto rounded p-1 text-muted hover:bg-line hover:text-fg" aria-label="Close" onClick={closeOpe}>✕</button>
                    </div>
                    <div className="max-h-[55vh] overflow-y-auto p-3">
                      {isName ? (
                        <div>
                          <label className="field-label" htmlFor="ope-name">Name</label>
                          <input
                            id="ope-name"
                            aria-label="Name"
                            className="field-input"
                            value={form.name}
                            disabled={!canEdit}
                            onChange={(e) => {
                              patchName(e.target.value);
                              liveText(e.target.value);
                            }}
                          />
                        </div>
                      ) : (
                        <Field
                          field={def!}
                          value={current}
                          disabled={!canEdit}
                          types={types}
                          sharedBlocks={sharedBlocks.data ?? []}
                          onChange={(v) => {
                            setField(def!.name, v);
                            pushLivePatch(def!, v);
                          }}
                        />
                      )}
                      {canEdit && (isName || def!.type === "text" || def!.type === "markdown") && (
                        <OverlayAi
                          current={asText(current)}
                          context={pageAiContext()}
                          onApply={(v) => {
                            if (isName) {
                              patchName(v);
                              liveText(v);
                            } else {
                              setField(def!.name, v);
                              pushLivePatch(def!, v);
                            }
                          }}
                          onPreview={(v) => {
                            const f = formRef.current ?? form;
                            if (isName) liveText(v ?? f.name);
                            else pushLivePatch(def!, v ?? asText(f.data[def!.name]));
                          }}
                        />
                      )}
                    </div>
                  </div>
                ),
              };
            })()}
          />
        ) : null;

        if (mobile) return <div className="min-h-0 flex-1">{formSection}</div>;
        if (view === "onpage" && previewPaneEl) {
          return <div className="min-h-0 flex-1 border-l border-line bg-panel">{previewPaneEl}</div>;
        }
        return (
          <PanelGroup direction="horizontal" autoSaveId={`paperboy-editor-split-${widePreview ? "w" : "n"}`} className="flex min-h-0 flex-1">
            <Panel id="form" order={1} defaultSize={widePreview ? 32 : 42} minSize={24} className="min-w-0">
              {formSection}
            </Panel>
            {previewOpen && <ResizeHandle />}
            {previewOpen && (
              <Panel id="preview" order={2} defaultSize={widePreview ? 68 : 58} minSize={20} className="min-w-0 border-l border-line bg-panel">
                {previewPaneEl}
              </Panel>
            )}
          </PanelGroup>
        );
      })()}

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
            void qc.invalidateQueries({ queryKey: ["tree"] });
          }}
        />
      )}

      {showBrief && (
        <BuildFromBriefDialog
          parentId={isPage ? documentId : null}
          parentName={isPage ? form.name : null}
          locale={locale}
          open={showBrief}
          onOpenChange={setShowBrief}
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
            void qc.invalidateQueries({ queryKey: ["tree"] });
            void qc.invalidateQueries({ queryKey: ["versions", documentId, locale] });
          }}
        />
      )}
    </div>
    </StockQueryContext.Provider>
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
  const rows = useMemo(() => versions.data ?? [], [versions.data]);

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
                        <input type="radio" name="cmp-a" aria-label="Select as version A" checked={selA === v.id} onChange={() => setSelA(v.id)} disabled={selB === v.id} /> A
                      </label>
                      <label className="flex items-center gap-0.5 text-[10px] font-semibold text-muted">
                        <input type="radio" name="cmp-b" aria-label="Select as version B" checked={selB === v.id} onChange={() => setSelB(v.id)} disabled={selA === v.id} /> B
                      </label>
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted">v{v.versionNumber}</span>
                  <span className="font-medium text-fg">{v.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.isCurrentPublished ? "bg-published/10 text-published" : v.status === "draft" ? "bg-draft/10 text-draft" : "bg-line text-muted"}`}>
                    {v.isCurrentPublished ? "live" : v.status}
                  </span>
                  {(v.createdVia === "mcp" || v.createdVia === "agent") && (
                    <span className="rounded-full bg-line px-2 py-0.5 text-[11px] font-semibold text-muted" title="Written by an agent via MCP">
                      <span aria-hidden>🤖</span> agent
                    </span>
                  )}
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
      <DialogContent title="Schedule publish" description={`Timed go-live and expiry for ${locale.toUpperCase()}.`} size="md">
        <div className="space-y-4">
          <div>
            <label className="field-label" htmlFor="sched-pub">Publish at</label>
            <input id="sched-pub" aria-label="Publish at" type="datetime-local" className="field-input" value={pub} onChange={(e) => setPub(e.target.value)} />
            <p className="mt-1 text-xs text-muted">A future time schedules the current draft to go live automatically. Empty/past publishes now.</p>
          </div>
          <div>
            <label className="field-label" htmlFor="sched-exp">Expire (unpublish) at</label>
            <input id="sched-exp" aria-label="Expire at" type="datetime-local" className="field-input" value={exp} onChange={(e) => setExp(e.target.value)} />
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
          <input type="checkbox" aria-label="Show unchanged" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} /> Show unchanged
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
      return Array.isArray(value) ? (value as string[]).join(", ") : asText(value);
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
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
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
    error: { text: "Save failed", cls: "text-danger" },
  };
  const s = map[state];
  if (!s.text) return null;
  return <span className={`text-xs ${s.cls}`} aria-live="polite" data-testid="save-indicator">{s.text}</span>;
}

/**
 * The copy desk inside the on-page overlay (text/markdown fields): quick
 * improve, a free-form instruction ("shorten to 8 words"), and TRY-ON VARIANTS
 * — hovering a suggestion live-patches it into the real page so you see it in
 * the actual design before committing; click applies it. Module-level (see Btn).
 */
function OverlayAi({
  current,
  context,
  onApply,
  onPreview,
}: {
  current: string;
  context: string;
  onApply: (v: string) => void;
  /** Live try-on: patch the page with v; null restores the current value. */
  onPreview: (v: string | null) => void;
}) {
  const toast = useToast();
  const [instruction, setInstruction] = useState("");
  const [variants, setVariants] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<AiTask | null>(null);
  // Improve/variants/rewrite all need a real model — with no key the whole
  // strip is replaced by an honest hint instead of buttons that 409.
  const aiEnabled = useAiEnabled();

  async function run(task: AiTask, opts?: { instruction?: string }) {
    if (!current.trim() || busy) return;
    setBusy(task);
    try {
      const r = await api.aiAssist(task, current, { ...opts, context });
      if (task === "variants") {
        // The server normalizes to a JSON array; the cleanup here is defensive.
        const cleaned = r.result.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        let list: string[] = [];
        try {
          const parsed = JSON.parse(cleaned) as unknown;
          if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === "string");
        } catch {
          list = cleaned
            .split("\n")
            .map((s) => s.replace(/^[-*\d.\s"[\]]+|[",[\]]+$/g, "").trim())
            .filter((s) => s && !s.startsWith("```"))
            .slice(0, 3);
        }
        setVariants(list.length ? list : [cleaned]);
        if (r.provider === "fallback") toast.success("Basic mode", "Set an AI key in Settings → Site for real suggestions.");
      } else {
        onApply(r.result);
        setInstruction("");
        if (r.provider === "fallback") toast.success("Basic mode", "Set an AI key in Settings → Site for full AI.");
      }
    } catch (e) {
      toast.error("Copy desk failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!aiEnabled) {
    return (
      <div className="mt-3 border-t border-line pt-2.5">
        <p className="text-xs text-muted">{AI_OFF_HINT}</p>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Copy desk</span>
        <button type="button" className="btn-subtle px-2 py-0.5 text-xs" disabled={!!busy || !current.trim()} onClick={() => void run("improve")}>
          {busy === "improve" ? "Improving…" : "Improve"}
        </button>
        <button type="button" className="btn-subtle px-2 py-0.5 text-xs" disabled={!!busy || !current.trim()} onClick={() => void run("variants")}>
          {busy === "variants" ? "Thinking…" : "Suggest variants"}
        </button>
      </div>
      <form
        className="mt-1.5 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (instruction.trim()) void run("rewrite", { instruction: instruction.trim() });
        }}
      >
        <input
          className="field-input min-w-0 flex-1 py-1 text-xs"
          placeholder="Ask the desk… e.g. shorten to 8 words"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          aria-label="Copy desk instruction"
        />
        <button type="submit" className="btn-subtle px-2 py-0.5 text-xs" disabled={!!busy || !instruction.trim() || !current.trim()}>
          {busy === "rewrite" ? "…" : "Go"}
        </button>
      </form>
      {variants && (
        <ul className="m-0 mt-2 list-none space-y-1 p-0" aria-label="Suggestions — hover to try on the page">
          {variants.map((v, i) => (
            <li key={i}>
              <button
                type="button"
                className="w-full rounded border border-line px-2 py-1.5 text-left text-xs text-fg hover:border-accent hover:bg-accent/5"
                title="Hover to preview on the page · click to apply"
                onMouseEnter={() => onPreview(v)}
                onMouseLeave={() => onPreview(null)}
                onFocus={() => onPreview(v)}
                onBlur={() => onPreview(null)}
                onClick={() => {
                  onApply(v);
                  setVariants(null);
                }}
              >
                {v}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
        {field.required && <span className="text-danger" title="Required to publish">*</span>}
        {field.delivery === "private" && <span className="rounded bg-line px-1 text-[10px] text-muted">private</span>}
      </label>
      {field.helpText && <p className="mb-1 text-xs text-muted">{field.helpText}</p>}
      {field.type === "text" && (
        <div>
          <input id={id} aria-label={field.displayName} className="field-input" value={(value as string) ?? ""} disabled={disabled}
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
        <input id={id} aria-label={field.displayName} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.type === "number" && (
        <input id={id} aria-label={field.displayName} type="number" className="field-input" value={(value as number) ?? ""} disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))} />
      )}
      {field.type === "datetime" && (
        <input id={id} aria-label={field.displayName} type="datetime-local" className="field-input" value={(value as string) ?? ""} disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)} />
      )}
      {field.type === "select" && <SelectField id={id} field={field} types={types} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "reference" && <ReferenceField id={id} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "link" && <LinkField id={id} value={value} disabled={disabled} onChange={onChange} />}
      {field.type === "image" && (
        <ImageField id={id} value={value} disabled={disabled} onChange={onChange} />
      )}
      {field.type === "media" && (
        <input id={id} aria-label={field.displayName} className="field-input" placeholder="Asset documentId" value={(value as string) ?? ""} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function SelectField({ id, field, types, value, disabled, onChange }: { id: string; field: FieldDef; types: ContentTypeDef[]; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  // optionsFromContentTypes: the dropdown reflects the INSTALLED page content
  // types (reality), not a hardcoded option list (2026-06-07: a list page could
  // be set to list "ArticlePage" when no such type existed). The current value
  // is always shown — even if its type is missing — so a misconfigured page is
  // visible rather than silently blank.
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
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={id}>
        {options.map((o) => (
          <button key={o.value} type="button" disabled={disabled} onClick={() => toggle(o.value)}
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
