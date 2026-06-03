import type {
  Asset,
  BlockSummary,
  ContentDetail,
  ContentTypeDef,
  Locale,
  RoleName,
  SessionUser,
  TreeNode,
} from "@paperboy/shared";

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  roles: RoleName[];
  sections: string[];
  locked: boolean;
  createdAt: string;
}
export interface DeliveryKeyRow {
  id: number;
  name: string;
  keyPrefix: string;
  type: "public" | "preview";
  createdAt: string;
  revokedAt: string | null;
}
export interface WebhookRow {
  id: number;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  lastStatus: number | null;
  lastAt: string | null;
  createdAt: string;
}
export interface AuditRow {
  id: number;
  ts: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  documentId: string | null;
  locale: string | null;
  ip: string | null;
  detail: unknown;
}
export interface TrashRow {
  documentId: string;
  type: string;
  kind: string;
  name: string;
  deletedAt: string;
}
/** Full payload of one version — for the compare/diff view. */
export interface VersionDetail {
  id: number;
  versionNumber: number;
  status: "draft" | "published";
  isCurrentPublished: boolean;
  name: string;
  slug: string | null;
  displayInNav: boolean;
  data: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
}
/** Write-only AI provider config status (the key itself is never returned). */
export interface AiConfigStatus {
  configured: boolean;
  source: "db" | "env" | "none";
  last4: string | null;
  model: string | null;
}
/** A content search hit (⌘K). */
export interface SearchResult {
  documentId: string;
  type: string;
  kind: "page" | "block" | "global";
  name: string;
  locale: string;
  urlPath: string | null;
}

const BASE = "/api/v1";

let csrfToken: string | null = null;
export function setCsrf(token: string | null) {
  csrfToken = token;
}

let onUnauthorized: (() => void) | null = null;
/** Registered by App so any mid-session 401 resets to the login screen. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {};
  const isMutation = method !== "GET" && method !== "HEAD";
  if (body !== undefined) headers["content-type"] = "application/json";
  if (isMutation && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 401 && path !== "/auth/login" && path !== "/auth/me") {
    onUnauthorized?.();
  }
  if (res.status === 204) return undefined as T;
  return parseResponse<T>(res);
}

/** Parse a JSON response, but degrade gracefully if a proxy returns HTML/text
 *  (e.g. an nginx 413/502 page) so the user sees a real message, not a
 *  "Unexpected token <" JSON SyntaxError. */
async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: { error?: string; message?: string } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined; // non-JSON body (proxy error page, etc.)
  }
  if (!res.ok) {
    const fallback =
      res.status === 413
        ? "File is too large (max 5 MB)."
        : res.statusText || `Request failed (${res.status})`;
    throw new ApiError(res.status, data?.error ?? "error", data?.message ?? fallback);
  }
  return data as T;
}

export const api = {
  // auth
  login: (email: string, password?: string) =>
    request<{ user: SessionUser; csrfToken: string } | { mfaRequired: true; mfaToken: string } | { passwordRequired: true }>(
      "POST",
      "/auth/login",
      password ? { email, password } : { email },
    ),
  loginMfa: (mfaToken: string, code: string) =>
    request<{ user: SessionUser; csrfToken: string }>("POST", "/auth/login/mfa", { mfaToken, code }),
  me: () => request<{ user: SessionUser; csrfToken: string }>("GET", "/auth/me"),
  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),

  // two-factor
  mfaStatus: (signal?: AbortSignal) => request<{ enabled: boolean; backupCodesRemaining: number }>("GET", "/auth/2fa/status", undefined, signal),
  mfaSetup: () => request<{ secret: string; uri: string }>("POST", "/auth/2fa/setup"),
  mfaEnable: (code: string) => request<{ backupCodes: string[] }>("POST", "/auth/2fa/enable", { code }),
  mfaDisable: (password: string) => request<{ ok: boolean }>("POST", "/auth/2fa/disable", { password }),

  // schema
  contentTypes: (signal?: AbortSignal) => request<ContentTypeDef[]>("GET", "/manage/content-types", undefined, signal),
  createContentType: (def: ContentTypeDef) => request<ContentTypeDef>("POST", "/manage/content-types", def),
  updateContentType: (name: string, def: ContentTypeDef) =>
    request<ContentTypeDef>("PUT", `/manage/content-types/${encodeURIComponent(name)}`, def),
  locales: (signal?: AbortSignal) => request<Locale[]>("GET", "/manage/locales", undefined, signal),
  localesAll: (signal?: AbortSignal) => request<Locale[]>("GET", "/manage/locales/all", undefined, signal),
  createLocale: (body: { code: string; displayName: string; fallbackLocaleCode?: string | null }) =>
    request<{ ok: boolean }>("POST", "/manage/locales", body),
  updateLocale: (code: string, body: { displayName?: string; fallbackLocaleCode?: string | null; enabled?: boolean }) =>
    request<{ ok: boolean }>("PATCH", `/manage/locales/${encodeURIComponent(code)}`, body),
  deleteLocale: (code: string) => request<{ ok: boolean }>("DELETE", `/manage/locales/${encodeURIComponent(code)}`),

  // content
  tree: (parentId?: string, signal?: AbortSignal) =>
    request<TreeNode[]>("GET", `/manage/content/tree${parentId ? `?parentId=${parentId}` : ""}`, undefined, signal),
  blocks: (signal?: AbortSignal) => request<BlockSummary[]>("GET", "/manage/blocks", undefined, signal),
  search: (q: string, signal?: AbortSignal) =>
    request<SearchResult[]>("GET", `/manage/content/search?q=${encodeURIComponent(q)}`, undefined, signal),
  pages: (signal?: AbortSignal) =>
    request<{ documentId: string; name: string; parentId: string | null }[]>("GET", "/manage/pages", undefined, signal),

  // site config (start page)
  site: (signal?: AbortSignal) => request<{ startPageId: string | null; previewBaseUrl: string }>("GET", "/manage/site", undefined, signal),
  setStartPage: (documentId: string | null) =>
    request<{ ok: boolean }>("POST", "/manage/site/start-page", { documentId }),
  setPreviewUrl: (url: string) =>
    request<{ ok: boolean }>("POST", "/manage/site/preview-url", { url }),
  aiConfig: (signal?: AbortSignal) =>
    request<AiConfigStatus>("GET", "/manage/site/ai", undefined, signal),
  setAiConfig: (body: { apiKey?: string | null; model?: string | null }) =>
    request<AiConfigStatus>("POST", "/manage/site/ai", body),

  // media
  assets: (signal?: AbortSignal) => request<Asset[]>("GET", "/manage/assets", undefined, signal),
  updateAssetAlt: (documentId: string, alt: string) => request<Asset>("PUT", `/manage/assets/${documentId}`, { alt }),
  deleteAsset: (documentId: string) => request<{ ok: boolean }>("DELETE", `/manage/assets/${documentId}`),
  uploadAsset: async (file: File): Promise<Asset> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/manage/assets`, {
      method: "POST",
      credentials: "include",
      headers: csrfToken ? { "x-csrf-token": csrfToken } : {}, // browser sets the multipart content-type/boundary
      body: fd,
    });
    if (res.status === 401) onUnauthorized?.();
    return parseResponse<Asset>(res);
  },
  get: (documentId: string, locale: string, signal?: AbortSignal) =>
    request<ContentDetail>("GET", `/manage/content/${documentId}?locale=${locale}`, undefined, signal),
  versions: (documentId: string, locale: string, signal?: AbortSignal) =>
    request<
      Array<{ id: number; versionNumber: number; status: string; isCurrentPublished: boolean; name: string; createdAt: string; createdBy: string | null; publishAt: string | null; expireAt: string | null }>
    >("GET", `/manage/content/${documentId}/versions?locale=${locale}`, undefined, signal),
  version: (documentId: string, locale: string, versionId: number, signal?: AbortSignal) =>
    request<VersionDetail>("GET", `/manage/content/${documentId}/versions/${versionId}?locale=${locale}`, undefined, signal),
  create: (body: { type: string; parentId: string | null; locale: string; name: string }) =>
    request<ContentDetail>("POST", "/manage/content", body),
  update: (
    documentId: string,
    locale: string,
    body: { name?: string; slug?: string | null; displayInNav?: boolean; data: Record<string, unknown> },
  ) => request<ContentDetail>("PUT", `/manage/content/${documentId}?locale=${locale}`, body),
  publish: (documentId: string, locale: string) =>
    request<ContentDetail>("POST", `/manage/content/${documentId}/publish?locale=${locale}`),
  schedule: (documentId: string, locale: string, body: { publishAt: string | null; expireAt: string | null }) =>
    request<ContentDetail>("POST", `/manage/content/${documentId}/schedule?locale=${locale}`, body),
  unpublish: (documentId: string, locale: string) =>
    request<ContentDetail>("POST", `/manage/content/${documentId}/unpublish?locale=${locale}`),
  discardDraft: (documentId: string, locale: string) =>
    request<{ ok: boolean }>("POST", `/manage/content/${documentId}/discard-draft?locale=${locale}`),
  move: (documentId: string, body: { parentId?: string | null; beforeId?: string | null; afterId?: string | null }) =>
    request<{ ok: boolean }>("POST", `/manage/content/${documentId}/move`, body),
  duplicate: (documentId: string, locale: string) =>
    request<ContentDetail>("POST", `/manage/content/${documentId}/duplicate?locale=${locale}`),
  trash: (documentId: string) =>
    request<{ ok: boolean; trashed: number }>("DELETE", `/manage/content/${documentId}`),
  restoreContent: (documentId: string) =>
    request<{ ok: boolean; restored: number }>("POST", `/manage/content/${documentId}/restore`),
  listTrash: (signal?: AbortSignal) => request<TrashRow[]>("GET", "/manage/content/trash", undefined, signal),
  emptyTrash: () => request<{ ok: boolean; purged: number }>("POST", "/manage/content/trash/empty"),
  restoreVersion: (documentId: string, locale: string, versionId: number) =>
    request<ContentDetail>("POST", `/manage/content/${documentId}/versions/${versionId}/restore?locale=${locale}`),

  // self-service password
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("POST", "/auth/change-password", { oldPassword, newPassword }),

  // platform admin
  users: (signal?: AbortSignal) => request<ManagedUser[]>("GET", "/manage/users", undefined, signal),
  createUser: (body: { email: string; name: string; password: string; roles: RoleName[]; sections?: string[] }) =>
    request<{ id: string }>("POST", "/manage/users", body),
  updateUser: (id: string, body: { name?: string; roles?: RoleName[]; sections?: string[] }) =>
    request<{ ok: boolean }>("PUT", `/manage/users/${id}`, body),
  deleteUser: (id: string) => request<{ ok: boolean }>("DELETE", `/manage/users/${id}`),

  deliveryKeys: (signal?: AbortSignal) => request<DeliveryKeyRow[]>("GET", "/manage/delivery-keys", undefined, signal),
  createDeliveryKey: (name: string, type: "public" | "preview") =>
    request<{ key: string }>("POST", "/manage/delivery-keys", { name, type }),
  renameDeliveryKey: (id: number, name: string) => request<{ ok: boolean }>("PUT", `/manage/delivery-keys/${id}`, { name }),
  revokeDeliveryKey: (id: number) => request<{ ok: boolean }>("POST", `/manage/delivery-keys/${id}/revoke`),

  // MCP tokens
  mcpTokens: (signal?: AbortSignal) =>
    request<{ id: number; name: string; userId: string; email: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[]>("GET", "/manage/mcp-tokens", undefined, signal),
  createMcpToken: (name: string, userId: string) => request<{ token: string }>("POST", "/manage/mcp-tokens", { name, userId }),
  revokeMcpToken: (id: number) => request<{ ok: boolean }>("POST", `/manage/mcp-tokens/${id}/revoke`),

  webhooks: (signal?: AbortSignal) => request<WebhookRow[]>("GET", "/manage/webhooks", undefined, signal),
  createWebhook: (body: { name: string; url: string; events?: string[] }) =>
    request<{ id: number; secret: string }>("POST", "/manage/webhooks", body),
  deleteWebhook: (id: number) => request<{ ok: boolean }>("DELETE", `/manage/webhooks/${id}`),

  audit: (limit = 100, signal?: AbortSignal) => request<AuditRow[]>("GET", `/manage/audit?limit=${limit}`, undefined, signal),

  // AI editorial assistant
  aiStatus: (signal?: AbortSignal) => request<{ enabled: boolean; tasks: string[] }>("GET", "/ai/status", undefined, signal),
  aiAssist: (task: AiTask, input: string, targetLocale?: string) =>
    request<{ result: string; provider: "anthropic" | "fallback" }>("POST", "/ai/assist", { task, input, targetLocale }),
};

export type AiTask = "meta_title" | "meta_description" | "summarize" | "improve" | "alt_text" | "translate";
