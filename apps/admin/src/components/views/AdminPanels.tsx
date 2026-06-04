import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { ContentTypeDef, RoleName } from "@paperboy/shared";
import { api, type ManagedUser } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { TypeIcon } from "../../lib/typeIcons.js";
import { useUser } from "../../lib/user.js";
import { ContentTypeEditor } from "../ContentTypeEditor.js";
import { Dialog, DialogContent } from "../ui/dialog.js";
import { useToast } from "../ui/toast.js";

const ROLES: RoleName[] = ["Admin", "Editor", "Author", "Viewer"];

function PanelShell({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {hint && <p className="mb-2 text-xs text-muted">{hint}</p>}
      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-panel">{children}</div>
    </section>
  );
}

/* --------------------------- Two-factor auth ------------------------------ */
export function TwoFactorPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["mfa-status"], queryFn: ({ signal }) => api.mfaStatus(signal) });
  const [step, setStep] = useState<"idle" | "qr" | "backup">("idle");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [disablePw, setDisablePw] = useState("");

  const setup = useMutation({
    mutationFn: () => api.mfaSetup(),
    onSuccess: (r) => { setSecret(r.secret); setUri(r.uri); setStep("qr"); },
    onError: (e) => toast.error("Couldn’t start setup", (e as Error).message),
  });
  const enable = useMutation({
    mutationFn: () => api.mfaEnable(code.trim()),
    onSuccess: (r) => { setBackupCodes(r.backupCodes); setStep("backup"); setCode(""); qc.invalidateQueries({ queryKey: ["mfa-status"] }); },
    onError: (e) => { toast.error("Couldn’t enable 2FA", (e as Error).message); setCode(""); },
  });
  const disable = useMutation({
    mutationFn: () => api.mfaDisable(disablePw),
    onSuccess: () => { setDisablePw(""); qc.invalidateQueries({ queryKey: ["mfa-status"] }); toast.success("Two-factor disabled"); },
    onError: (e) => toast.error("Couldn’t disable", (e as Error).message),
  });

  const enabled = status.data?.enabled;

  return (
    <PanelShell title="Two-factor authentication" hint="Require a time-based code from an authenticator app at sign-in.">
      <div className="p-4 text-sm">
        {enabled && step !== "backup" ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-published"><span className="h-2 w-2 rounded-full bg-published" /> 2FA is <strong>on</strong>. {status.data?.backupCodesRemaining} backup codes remaining.</p>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
              <label className="text-sm"><span className="field-label">Confirm password to disable</span>
                <input className="field-input" type="password" autoComplete="current-password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} /></label>
              <button className="btn-ghost text-danger" disabled={disable.isPending || !disablePw}>Disable 2FA</button>
            </form>
          </div>
        ) : step === "idle" ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted">Two-factor is <strong>off</strong>. Add an authenticator app for stronger account security.</p>
            <button className="btn-primary shrink-0" disabled={setup.isPending} onClick={() => setup.mutate()}>{setup.isPending ? "…" : "Enable 2FA"}</button>
          </div>
        ) : step === "qr" ? (
          <div className="space-y-3">
            <p className="text-muted">Scan with Google Authenticator, 1Password, Authy, etc. — then enter the 6-digit code.</p>
            <div className="flex items-start gap-5">
              <div className="rounded-lg bg-white p-3">{uri && <QRCodeSVG value={uri} size={168} level="M" />}</div>
              <div className="space-y-2 text-xs">
                <div className="text-muted">Can’t scan? Enter this key manually:</div>
                <code className="block break-all rounded bg-line/60 px-2 py-1 font-mono">{secret}</code>
                <form className="flex items-end gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
                  <label><span className="field-label">6-digit code</span>
                    <input className="field-input w-32 text-center font-mono tracking-widest" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" /></label>
                  <button className="btn-primary" disabled={enable.isPending || code.trim().length < 6}>{enable.isPending ? "…" : "Verify & enable"}</button>
                  <button type="button" className="btn-ghost" onClick={() => { setStep("idle"); setCode(""); }}>Cancel</button>
                </form>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="font-semibold text-fg">✅ Two-factor is enabled. Save these one-time backup codes somewhere safe:</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {backupCodes.map((c) => <code key={c} className="rounded bg-line/60 px-2 py-1 text-center font-mono text-xs">{c}</code>)}
            </div>
            <p className="text-xs text-muted">Each code works once if you lose your authenticator. They won’t be shown again.</p>
            <button className="btn-primary" onClick={() => setStep("idle")}>Done</button>
          </div>
        )}
      </div>
    </PanelShell>
  );
}

/* ----------------------------- Content model ------------------------------ */
type KindFilter = "all" | "page" | "block" | "global";
const KIND_TABS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "page", label: "Pages" },
  { key: "block", label: "Blocks" },
  { key: "global", label: "Globals" },
];

/** One-line usage summary: pages/globals → instances; blocks → shared + inline. */
function usageLabel(kind: string, u: { items: number; inlineIn: number } | undefined): string {
  if (!u) return "Unused";
  if (kind === "block") {
    const parts: string[] = [];
    if (u.items) parts.push(`${u.items} shared`);
    if (u.inlineIn) parts.push(`used in ${u.inlineIn} page${u.inlineIn === 1 ? "" : "s"}`);
    return parts.length ? parts.join(" · ") : "Unused";
  }
  return u.items ? `${u.items} ${u.items === 1 ? "item" : "items"}` : "Unused";
}

export function ContentTypesPanel() {
  const { user } = useUser();
  const canManage = user.permissions.includes("contenttype.manage");
  const types = useQuery({ queryKey: ["content-types"], queryFn: ({ signal }) => api.contentTypes(signal) });
  const usage = useQuery({ queryKey: ["content-types-usage"], queryFn: ({ signal }) => api.contentTypeUsage(signal) });
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; initial?: ContentTypeDef } | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");

  const all = types.data ?? [];
  const counts: Record<KindFilter, number> = {
    all: all.length,
    page: all.filter((t) => t.kind === "page").length,
    block: all.filter((t) => t.kind === "block").length,
    global: all.filter((t) => t.kind === "global").length,
  };
  const shown = kind === "all" ? all : all.filter((t) => t.kind === kind);

  return (
    <PanelShell
      title="Content types"
      hint="The data model: pages, blocks and globals editors fill in. Public fields are exposed by the Delivery API."
      action={canManage ? <button className="btn-subtle px-2 py-1 text-xs" onClick={() => setEditor({ mode: "create" })}><Icon.Plus width={14} height={14} /> New content type</button> : undefined}
    >
      {/* Kind filter */}
      <div className="flex gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Filter by kind">
        {KIND_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={kind === t.key}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${kind === t.key ? "bg-accent/15 text-accent-700" : "text-muted hover:bg-line/60 hover:text-fg"}`}
            onClick={() => setKind(t.key)}>
            {t.label} <span className="opacity-60">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {shown.map((t) => (
        <div key={t.name} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          <TypeIcon name={t.icon} width={16} height={16} className="shrink-0 text-muted" />
          <span className="font-medium text-fg">{t.displayName}</span>
          <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{t.name}</code>
          <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-muted">{t.kind}</span>
          <span className="ml-auto flex items-center gap-3 text-xs text-muted">
            <span title="How many content items use this type">{usageLabel(t.kind, usage.data?.[t.name])}</span>
            <span className="text-line">·</span>
            <span>{t.fields.length} fields</span>
          </span>
          {canManage && (
            <button className="rounded px-2 py-0.5 text-xs text-accent-700 hover:bg-accent/10" onClick={() => setEditor({ mode: "edit", initial: t })}>Edit</button>
          )}
        </div>
      ))}
      {shown.length === 0 && <p className="p-4 text-sm text-muted">{all.length === 0 ? "No content types." : "None of this kind."}</p>}
      {editor && (
        <ContentTypeEditor
          mode={editor.mode}
          initial={editor.initial}
          allTypes={all}
          // Once usage has loaded, a type absent from the map has zero usage
          // (deletable). undefined only while the query is still loading.
          usage={editor.initial && usage.isSuccess ? (usage.data[editor.initial.name] ?? { items: 0, inlineIn: 0 }) : undefined}
          open
          onOpenChange={(o) => !o && setEditor(null)}
        />
      )}
    </PanelShell>
  );
}

/* ------------------------------- Languages -------------------------------- */
export function LanguagesPanel() {
  const { user } = useUser();
  const canManage = user.permissions.includes("contenttype.manage");
  const qc = useQueryClient();
  const toast = useToast();
  // Managers see every locale (incl. disabled) so they can re-enable/remove them; others get the live set.
  const locales = useQuery({
    queryKey: ["locales", canManage ? "all" : "enabled"],
    queryFn: ({ signal }) => (canManage ? api.localesAll(signal) : api.locales(signal)),
  });
  const list = locales.data ?? [];

  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [fallback, setFallback] = useState("");
  const [editing, setEditing] = useState<{ code: string; displayName: string; fallback: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["locales"] });
  const create = useMutation({
    mutationFn: () => api.createLocale({ code: code.trim(), displayName: displayName.trim(), fallbackLocaleCode: fallback || null }),
    onSuccess: () => { setCode(""); setDisplayName(""); setFallback(""); invalidate(); toast.success("Language added"); },
    onError: (e) => toast.error("Couldn’t add language", (e as Error).message),
  });
  const update = useMutation({
    mutationFn: (v: { code: string; patch: { displayName?: string; fallbackLocaleCode?: string | null; enabled?: boolean } }) =>
      api.updateLocale(v.code, v.patch),
    onSuccess: () => { invalidate(); setEditing(null); toast.success("Language updated"); },
    onError: (e) => toast.error("Couldn’t update", (e as Error).message),
  });
  const del = useMutation({
    mutationFn: (c: string) => api.deleteLocale(c),
    onSuccess: () => { invalidate(); toast.success("Language deleted"); },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });

  return (
    <PanelShell
      title="Languages"
      hint="Document-level localization with a per-locale fallback chain."
      action={
        canManage ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => { e.preventDefault(); if (code.trim() && displayName.trim()) create.mutate(); }}
          >
            <input className="field-input py-1 text-xs" style={{ width: 64 }} placeholder="code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Language code" />
            <input className="field-input py-1 text-xs" placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="Display name" />
            <select className="field-input py-1 text-xs" value={fallback} onChange={(e) => setFallback(e.target.value)} aria-label="Fallback language">
              <option value="">no fallback</option>
              {list.map((l) => <option key={l.code} value={l.code}>↳ {l.code}</option>)}
            </select>
            <button className="btn-subtle px-2 py-1 text-xs" disabled={create.isPending || !code.trim() || !displayName.trim()}><Icon.Plus width={14} height={14} /> Add</button>
          </form>
        ) : undefined
      }
    >
      {list.map((l) => (
        <div key={l.code} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          {editing?.code === l.code ? (
            <form
              className="flex flex-1 items-center gap-1.5"
              onSubmit={(e) => { e.preventDefault(); if (editing.displayName.trim()) update.mutate({ code: l.code, patch: { displayName: editing.displayName.trim(), fallbackLocaleCode: editing.fallback || null } }); }}
            >
              <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{l.code}</code>
              <input className="field-input py-0.5 text-xs" value={editing.displayName} autoFocus aria-label="Display name" onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} />
              <select className="field-input py-0.5 text-xs" value={editing.fallback} aria-label="Fallback language" onChange={(e) => setEditing({ ...editing, fallback: e.target.value })}>
                <option value="">no fallback</option>
                {list.filter((o) => o.code !== l.code).map((o) => <option key={o.code} value={o.code}>↳ {o.code}</option>)}
              </select>
              <button className="btn-primary px-2 py-0.5 text-xs" disabled={update.isPending || !editing.displayName.trim()}>Save</button>
              <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setEditing(null)}>Cancel</button>
            </form>
          ) : (
            <>
              <span className="font-medium text-fg">{l.displayName}</span>
              <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{l.code}</code>
              {l.isDefault && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-fg">default</span>}
              {!l.enabled && <span className="rounded bg-line px-1.5 py-0.5 text-[11px] text-muted">disabled</span>}
              {l.fallbackLocaleCode && <span className="text-xs text-muted">falls back → {l.fallbackLocaleCode}</span>}
              {canManage && (
                <div className="ml-auto flex items-center gap-1">
                  <button className="rounded px-2 py-0.5 text-xs text-accent-700 hover:bg-accent/10" onClick={() => setEditing({ code: l.code, displayName: l.displayName, fallback: l.fallbackLocaleCode ?? "" })}>Edit</button>
                  {!l.isDefault && (
                    <button className="rounded px-2 py-0.5 text-xs text-muted hover:bg-line/60" disabled={update.isPending} onClick={() => update.mutate({ code: l.code, patch: { enabled: !l.enabled } })}>
                      {l.enabled ? "Disable" : "Enable"}
                    </button>
                  )}
                  {!l.isDefault && (
                    <button className="rounded px-2 py-0.5 text-xs text-danger hover:bg-danger/10" onClick={() => { if (confirm(`Delete language “${l.displayName}” (${l.code})? This can’t be undone.`)) del.mutate(l.code); }}>Delete</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {list.length === 0 && <p className="p-4 text-sm text-muted">No languages.</p>}
    </PanelShell>
  );
}

/* ------------------------------- Your account ----------------------------- */
export function SitePanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const site = useQuery({ queryKey: ["site"], queryFn: ({ signal }) => api.site(signal) });
  const [edited, setEdited] = useState<string | null>(null);
  const value = edited ?? site.data?.previewBaseUrl ?? "";
  const save = useMutation({
    mutationFn: () => api.setPreviewUrl(value.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["site"] });
      setEdited(null);
      toast.success("Preview URL saved", "The editor preview now loads from here.");
    },
    onError: (e) => toast.error("Couldn’t save", (e as Error).message),
  });
  return (
    <PanelShell title="Site" hint="Where the editor preview loads from — your front-end origin (the published site or a staging host).">
      <form className="flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="grow text-sm" style={{ minWidth: 320 }}>
          <span className="field-label">Preview base URL</span>
          <input
            className="field-input"
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            value={value}
            onChange={(e) => setEdited(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Preview opens <code>{(value || "<origin>").replace(/\/+$/, "")}/&lt;locale&gt;&lt;path&gt;?pb=…</code>. Empty = fall back to the admin host on :8092.
          </span>
        </label>
        <button className="btn-primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
      </form>
    </PanelShell>
  );
}

/* ----------------------------- AI assistant ------------------------------- */
export function AiPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["ai-config"], queryFn: ({ signal }) => api.aiConfig(signal) });
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const status = cfg.data;
  const modelValue = model ?? status?.model ?? "";

  const save = useMutation({
    mutationFn: () =>
      api.setAiConfig({
        apiKey: keyInput.trim() ? keyInput.trim() : undefined, // blank = keep current
        model: model !== null ? model.trim() || null : undefined, // untouched = unchanged
      }),
    onSuccess: (s) => {
      qc.setQueryData(["ai-config"], s);
      setKeyInput("");
      setModel(null);
      toast.success("AI settings saved", s.configured ? "The assistant is enabled." : "No key set — AI runs in basic mode.");
    },
    onError: (e) => toast.error("Couldn’t save", (e as Error).message),
  });
  const clearKey = useMutation({
    mutationFn: () => api.setAiConfig({ apiKey: null }),
    onSuccess: (s) => {
      qc.setQueryData(["ai-config"], s);
      toast.success("Key cleared", s.source === "env" ? "Falling back to the environment key." : "AI now runs in basic mode.");
    },
    onError: (e) => toast.error("Couldn’t clear", (e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api.aiStatus(),
    onSuccess: (s) =>
      s.enabled
        ? toast.success("AI is live", "A provider key is configured.")
        : toast.error("AI is offline", "No key configured — add one above."),
    onError: (e) => toast.error("Couldn’t check", (e as Error).message),
  });

  const statusText =
    status?.source === "db"
      ? `Key configured in the CMS (ending ••${status.last4})`
      : status?.source === "env"
        ? `Using the ANTHROPIC_API_KEY environment value (ending ••${status.last4})`
        : "No key configured — the assistant runs in basic (offline) mode.";

  return (
    <PanelShell title="AI assistant" hint="Connect an Anthropic API key so the editor’s ✨ AI features (SEO text, summaries, translation) use Claude. The key is stored encrypted and never shown again; it overrides the server environment value.">
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2 text-sm">
          <span className={`h-2 w-2 rounded-full ${status?.configured ? "bg-published" : "bg-draft"}`} />
          <span className="text-muted">{statusText}</span>
        </div>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <label className="grow text-sm" style={{ minWidth: 320 }}>
            <span className="field-label">Anthropic API key</span>
            <input
              className="field-input"
              type="password"
              autoComplete="off"
              placeholder={status?.configured ? "•••••••• (leave blank to keep)" : "sk-ant-…"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <span className="mt-1 block text-xs text-muted">Stored encrypted at rest. Leave blank to keep the current key.</span>
          </label>
          <label className="text-sm" style={{ minWidth: 220 }}>
            <span className="field-label">Model</span>
            <input className="field-input" placeholder="claude-haiku-4-5-20251001" value={modelValue} onChange={(e) => setModel(e.target.value)} />
          </label>
          <button className="btn-primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
          <button type="button" className="btn-subtle" disabled={test.isPending} onClick={() => test.mutate()}>Test</button>
          {status?.source === "db" && (
            <button type="button" className="btn-subtle" disabled={clearKey.isPending} onClick={() => clearKey.mutate()}>Clear key</button>
          )}
        </form>
      </div>
    </PanelShell>
  );
}

export function PasswordPanel() {
  const toast = useToast();
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword(oldPassword, newPassword),
    onSuccess: () => {
      toast.success("Password changed", "Sign in again with your new password.");
      // All sessions were invalidated server-side; reload to the login screen.
      setTimeout(() => window.location.reload(), 1200);
    },
    onError: (e) => toast.error("Couldn’t change password", (e as Error).message),
  });
  return (
    <PanelShell title="Your account" hint="Changing your password signs you out of all sessions.">
      <form
        className="flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e) => { e.preventDefault(); change.mutate(); }}
      >
        <label className="text-sm">
          <span className="field-label">Current password</span>
          <input className="field-input" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="field-label">New password (min 10)</span>
          <input className="field-input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={change.isPending || newPassword.length < 10 || !oldPassword}>
          {change.isPending ? "Saving…" : "Change password"}
        </button>
      </form>
    </PanelShell>
  );
}

/* --------------------------------- Users ---------------------------------- */
export function UsersPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ["users"], queryFn: ({ signal }) => api.users(signal) });
  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; user: ManagedUser } | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast.success("User deleted"); },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });

  return (
    <PanelShell
      title="Users & roles"
      action={<button className="btn-subtle px-2 py-1 text-xs" onClick={() => setDialog({ mode: "create" })}><Icon.Plus width={14} height={14} /> New user</button>}
    >
      {(users.data ?? []).map((u) => (
        <div key={u.id} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          <span className="font-medium text-fg">{u.name}</span>
          <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{u.email}</code>
          <span className="flex gap-1">{u.roles.map((r) => <span key={r} className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-fg">{r}</span>)}</span>
          {u.sections.length > 0 && <span className="text-[11px] text-muted">· {u.sections.length} section(s)</span>}
          {u.locked && <span className="rounded bg-draft/10 px-1.5 py-0.5 text-[11px] text-draft">locked</span>}
          <div className="ml-auto flex gap-1">
            <button className="rounded px-2 py-0.5 text-xs text-accent-700 hover:bg-accent/10" onClick={() => setDialog({ mode: "edit", user: u })}>Edit</button>
            <button className="rounded px-2 py-0.5 text-xs text-danger hover:bg-danger/10" onClick={() => { if (confirm(`Delete ${u.email}?`)) del.mutate(u.id); }}>Delete</button>
          </div>
        </div>
      ))}
      {users.data?.length === 0 && <p className="p-4 text-sm text-muted">No users.</p>}
      {dialog && (
        <UserDialog
          dialog={dialog}
          pages={pages.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["users"] }); setDialog(null); }}
        />
      )}
    </PanelShell>
  );
}

function UserDialog({
  dialog,
  pages,
  onClose,
  onSaved,
}: {
  dialog: { mode: "create" } | { mode: "edit"; user: ManagedUser };
  pages: { documentId: string; name: string; parentId: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const editing = dialog.mode === "edit" ? dialog.user : null;
  const [email, setEmail] = useState(editing?.email ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<RoleName[]>(editing?.roles ?? ["Author"]);
  const [sections, setSections] = useState<string[]>(editing?.sections ?? []);

  const toggleRole = (r: RoleName) => setRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  const toggleSection = (id: string) => setSections((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // Author is the only role that is section-scoped; site-wide roles ignore sections.
  const scoped = roles.includes("Author") && !roles.some((r) => r === "Admin" || r === "Editor" || r === "Viewer");

  const save = useMutation({
    mutationFn: async () => {
      if (editing) await api.updateUser(editing.id, { name, roles, sections });
      else await api.createUser({ email, name, password, roles, sections });
    },
    onSuccess: () => { toast.success(editing ? "User updated" : "User created"); onSaved(); },
    onError: (e) => toast.error("Couldn’t save user", (e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={editing ? `Edit ${editing.email}` : "New user"} description="Assign roles; Authors are scoped to the sections you select." className="w-[min(560px,94vw)]">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm"><span className="field-label">Email</span>
            <input className="field-input" value={email} disabled={!!editing} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="text-sm"><span className="field-label">Name</span>
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {!editing && (
            <label className="col-span-2 text-sm"><span className="field-label">Temporary password (min 10)</span>
              <input className="field-input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          )}
        </div>
        <div className="mt-3">
          <span className="field-label">Roles</span>
          <div className="flex flex-wrap gap-1.5">
            {ROLES.map((r) => (
              <button key={r} type="button" onClick={() => toggleRole(r)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${roles.includes(r) ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-line/60"}`}>{r}</button>
            ))}
          </div>
        </div>
        {scoped && (
          <div className="mt-3">
            <span className="field-label">Sections (Author scope)</span>
            <div className="max-h-40 space-y-1 overflow-auto rounded border border-line p-2">
              {pages.filter((p) => p.parentId === null).map((p) => (
                <label key={p.documentId} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={sections.includes(p.documentId)} onChange={() => toggleSection(p.documentId)} />
                  <span>{p.name}</span>
                </label>
              ))}
              {pages.filter((p) => p.parentId === null).length === 0 && <p className="text-xs text-muted">No top-level pages to scope to.</p>}
            </div>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || roles.length === 0 || (!editing && (password.length < 10 || !email))} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : editing ? "Save" : "Create user"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- Delivery keys ------------------------------ */
export function DeliveryKeysPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useQuery({ queryKey: ["delivery-keys"], queryFn: ({ signal }) => api.deliveryKeys(signal) });
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"public" | "preview">("public");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  const create = useMutation({
    mutationFn: () => api.createDeliveryKey(name || `${type} key`, type),
    onSuccess: (r) => { setCreated(r.key); setName(""); qc.invalidateQueries({ queryKey: ["delivery-keys"] }); },
    onError: (e) => toast.error("Couldn’t create key", (e as Error).message),
  });
  const rename = useMutation({
    mutationFn: (v: { id: number; name: string }) => api.renameDeliveryKey(v.id, v.name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["delivery-keys"] }); setEditing(null); toast.success("Key renamed"); },
    onError: (e) => toast.error("Couldn’t rename", (e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeDeliveryKey(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["delivery-keys"] }); toast.success("Key revoked"); },
    onError: (e) => toast.error("Couldn’t revoke", (e as Error).message),
  });

  return (
    <PanelShell
      title="Delivery API keys"
      hint="Public keys read published content; preview keys read drafts. The secret is shown once at creation."
      action={
        <div className="flex items-center gap-1.5">
          <input className="field-input py-1 text-xs" placeholder="Key name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" />
          <select className="field-input py-1 text-xs" value={type} onChange={(e) => setType(e.target.value as "public" | "preview")} aria-label="Key type">
            <option value="public">public</option>
            <option value="preview">preview</option>
          </select>
          <button className="btn-subtle px-2 py-1 text-xs" onClick={() => create.mutate()}><Icon.Plus width={14} height={14} /> Create</button>
        </div>
      }
    >
      {created && (
        <div className="border-b border-line bg-accent/5 px-4 py-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-accent-700">Copy this key now — it won’t be shown again:</div>
          <code className="block break-all rounded bg-line/60 px-2 py-1 font-mono text-xs">{created}</code>
          <button className="mt-1 text-xs text-muted hover:text-fg" onClick={() => setCreated(null)}>Dismiss</button>
        </div>
      )}
      {(keys.data ?? []).map((k) => (
        <div key={k.id} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          <Icon.Api width={15} height={15} className="shrink-0 text-muted" />
          {editing?.id === k.id ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) rename.mutate({ id: k.id, name: editing.name.trim() }); }}
            >
              <input className="field-input py-0.5 text-xs" value={editing.name} autoFocus aria-label="Key name"
                onChange={(e) => setEditing({ id: k.id, name: e.target.value })} />
              <button className="btn-primary px-2 py-0.5 text-xs" disabled={rename.isPending}>Save</button>
              <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setEditing(null)}>Cancel</button>
            </form>
          ) : (
            <>
              <span className="font-medium text-fg">{k.name}</span>
              {!k.revokedAt && (
                <button className="rounded px-1 text-xs text-accent-700 hover:bg-accent/10" title="Rename" aria-label={`Rename ${k.name}`} onClick={() => setEditing({ id: k.id, name: k.name })}>
                  <Icon.Edit width={13} height={13} />
                </button>
              )}
            </>
          )}
          <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{k.keyPrefix}…</code>
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${k.type === "preview" ? "bg-draft/10 text-draft" : "bg-published/10 text-published"}`}>{k.type}</span>
          {k.revokedAt ? <span className="rounded bg-line px-1.5 py-0.5 text-[11px] text-muted">revoked</span> : null}
          {!k.revokedAt && (
            <button className="ml-auto rounded px-2 py-0.5 text-xs text-danger hover:bg-danger/10" onClick={() => { if (confirm(`Revoke “${k.name}”?`)) revoke.mutate(k.id); }}>Revoke</button>
          )}
        </div>
      ))}
      {keys.data?.length === 0 && <p className="p-4 text-sm text-muted">No delivery keys.</p>}
    </PanelShell>
  );
}

/* ------------------------------- MCP tokens ------------------------------- */
export function McpTokensPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const tokens = useQuery({ queryKey: ["mcp-tokens"], queryFn: ({ signal }) => api.mcpTokens(signal) });
  const users = useQuery({ queryKey: ["users"], queryFn: ({ signal }) => api.users(signal) });
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [userId, setUserId] = useState("");

  const create = useMutation({
    mutationFn: () => api.createMcpToken(name || "MCP token", userId || users.data?.[0]?.id || ""),
    onSuccess: (r) => { setCreated(r.token); setName(""); qc.invalidateQueries({ queryKey: ["mcp-tokens"] }); },
    onError: (e) => toast.error("Couldn’t create token", (e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeMcpToken(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["mcp-tokens"] }); toast.success("Token revoked"); },
    onError: (e) => toast.error("Couldn’t revoke", (e as Error).message),
  });

  return (
    <PanelShell
      title="MCP tokens"
      hint="Tokens the MCP server presents instead of a password. A token acts AS the chosen user (inherits its roles). Run the MCP with MCP_TOKEN=… — the secret is shown once."
      action={
        <div className="flex items-center gap-1.5">
          <input className="field-input py-1 text-xs" placeholder="Token name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" />
          <select className="field-input py-1 text-xs" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Acts as user">
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select>
          <button className="btn-subtle px-2 py-1 text-xs" disabled={create.isPending || !(users.data?.length)} onClick={() => create.mutate()}>
            <Icon.Plus width={14} height={14} /> Create
          </button>
        </div>
      }
    >
      {created && (
        <div className="border-b border-line bg-accent/5 px-4 py-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-accent-700">Copy this token now — it won’t be shown again:</div>
          <code className="block break-all rounded bg-line/60 px-2 py-1 font-mono text-xs">{created}</code>
          <p className="mt-2 text-xs text-muted">Use it by running the MCP server with <code className="font-mono">MCP_TOKEN={created.slice(0, 12)}…</code></p>
          <button className="mt-1 text-xs text-muted hover:text-fg" onClick={() => setCreated(null)}>Dismiss</button>
        </div>
      )}
      {(tokens.data ?? []).map((t) => (
        <div key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          <Icon.Api width={15} height={15} className="shrink-0 text-muted" />
          <span className="font-medium text-fg">{t.name}</span>
          <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">mcp_…</code>
          <span className="text-xs text-muted">acts as {t.email}</span>
          <span className="text-[11px] text-muted">{t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}</span>
          {t.revokedAt ? <span className="rounded bg-line px-1.5 py-0.5 text-[11px] text-muted">revoked</span> : null}
          {!t.revokedAt && (
            <button className="ml-auto rounded px-2 py-0.5 text-xs text-danger hover:bg-danger/10" onClick={() => { if (confirm(`Revoke “${t.name}”?`)) revoke.mutate(t.id); }}>Revoke</button>
          )}
        </div>
      ))}
      {tokens.data?.length === 0 && <p className="p-4 text-sm text-muted">No MCP tokens yet.</p>}
    </PanelShell>
  );
}

/* -------------------------------- Webhooks -------------------------------- */
export function WebhooksPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const hooks = useQuery({ queryKey: ["webhooks"], queryFn: ({ signal }) => api.webhooks(signal) });
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const create = useMutation({
    mutationFn: () => api.createWebhook({ name, url }),
    onSuccess: (r) => { setCreated(r.secret); setName(""); setUrl(""); qc.invalidateQueries({ queryKey: ["webhooks"] }); },
    onError: (e) => toast.error("Couldn’t create webhook", (e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteWebhook(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["webhooks"] }); toast.success("Webhook removed"); },
    onError: (e) => toast.error("Couldn’t delete", (e as Error).message),
  });

  return (
    <PanelShell
      title="Webhooks"
      hint="POSTed (HMAC-SHA256 signed) on publish/unpublish — wire up ISR revalidation or a CDN purge."
      action={
        <div className="flex items-center gap-1.5">
          <input className="field-input py-1 text-xs" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Webhook name" />
          <input className="field-input py-1 text-xs" placeholder="https://…/hook" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Webhook URL" />
          <button className="btn-subtle px-2 py-1 text-xs" disabled={!url || !name} onClick={() => create.mutate()}><Icon.Plus width={14} height={14} /> Add</button>
        </div>
      }
    >
      {created && (
        <div className="border-b border-line bg-accent/5 px-4 py-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-accent-700">Signing secret (shown once):</div>
          <code className="block break-all rounded bg-line/60 px-2 py-1 font-mono text-xs">{created}</code>
          <button className="mt-1 text-xs text-muted hover:text-fg" onClick={() => setCreated(null)}>Dismiss</button>
        </div>
      )}
      {(hooks.data ?? []).map((h) => (
        <div key={h.id} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          <Icon.Link width={15} height={15} className="text-muted" />
          <span className="font-medium text-fg">{h.name}</span>
          <code className="max-w-[280px] truncate rounded bg-line/70 px-1 font-mono text-[11px] text-muted" title={h.url}>{h.url}</code>
          {h.lastStatus != null && <span className={`rounded px-1.5 py-0.5 text-[11px] ${h.lastStatus >= 200 && h.lastStatus < 300 ? "bg-published/10 text-published" : "bg-danger/10 text-danger"}`}>last {h.lastStatus}</span>}
          <button className="ml-auto rounded px-2 py-0.5 text-xs text-danger hover:bg-danger/10" onClick={() => { if (confirm(`Delete webhook “${h.name}”?`)) del.mutate(h.id); }}>Delete</button>
        </div>
      ))}
      {hooks.data?.length === 0 && <p className="p-4 text-sm text-muted">No webhooks.</p>}
    </PanelShell>
  );
}

/* --------------------------------- Trash ---------------------------------- */
export function TrashPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const trash = useQuery({ queryKey: ["trash"], queryFn: ({ signal }) => api.listTrash(signal) });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreContent(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["tree", "root"] });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      toast.success("Restored", "Re-publish to make it live again.");
    },
    onError: (e) => toast.error("Couldn’t restore", (e as Error).message),
  });
  const empty = useMutation({
    mutationFn: () => api.emptyTrash(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["trash"] });
      toast.success("Trash emptied", `Permanently deleted ${r.purged} item${r.purged === 1 ? "" : "s"}.`);
    },
    onError: (e) => toast.error("Couldn’t empty trash", (e as Error).message),
  });
  const count = trash.data?.length ?? 0;
  return (
    <PanelShell
      title="Trash"
      hint="Deleted content is unpublished and recoverable here."
      action={
        count > 0 ? (
          <button
            className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={empty.isPending}
            onClick={() => { if (confirm(`Permanently delete all ${count} item${count === 1 ? "" : "s"} in the trash? This cannot be undone.`)) empty.mutate(); }}
          >
            <Icon.Trash width={13} height={13} /> Empty trash
          </button>
        ) : undefined
      }
    >
      {(trash.data ?? []).map((t) => (
        <div key={t.documentId} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-0">
          <Icon.Trash width={15} height={15} className="text-muted" />
          <span className="font-medium text-fg">{t.name}</span>
          <code className="rounded bg-line/70 px-1 font-mono text-[11px] text-muted">{t.type}</code>
          <span className="text-[11px] text-muted">deleted {new Date(t.deletedAt).toLocaleString()}</span>
          <button className="ml-auto btn-subtle px-2 py-0.5 text-xs" onClick={() => restore.mutate(t.documentId)}>
            <Icon.History width={13} height={13} /> Restore
          </button>
        </div>
      ))}
      {trash.data?.length === 0 && <p className="p-4 text-sm text-muted">Trash is empty.</p>}
    </PanelShell>
  );
}

/* ------------------------------- Audit log -------------------------------- */
export function AuditPanel() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: ({ signal }) => api.audit(100, signal) });
  return (
    <PanelShell title="Audit log" hint="Append-only record of every privileged action.">
      <div className="max-h-[420px] overflow-auto">
        {(audit.data ?? []).map((a) => (
          <div key={a.id} className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs last:border-0">
            <span className="font-mono text-muted">{new Date(a.ts).toLocaleString()}</span>
            <span className="rounded bg-line/70 px-1.5 py-0.5 font-medium text-fg">{a.action}</span>
            {a.actorName && <span className="text-muted">by {a.actorName}</span>}
            {a.documentId && <code className="text-muted">{a.documentId.slice(0, 8)}…</code>}
            {a.locale && <span className="text-muted">[{a.locale}]</span>}
            {a.ip && <span className="ml-auto text-muted">{a.ip}</span>}
          </div>
        ))}
        {audit.data?.length === 0 && <p className="p-4 text-sm text-muted">No audit entries.</p>}
      </div>
    </PanelShell>
  );
}
