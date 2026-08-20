import { AiSchemaFieldSuggestions } from "./schema-catalog.js";

/**
 * AI editorial assistant. Real editorial use-cases the editor needs help with:
 * SEO title/description generation, summarising, copy improvement, image alt
 * text, and translation. Two providers, one seam: Anthropic (Messages API) or
 * any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Groq,
 * Mistral, Ollama, LM Studio, vLLM, LiteLLM…) — selected by AiConfig.provider.
 * Without a key, only the deterministic truncation tasks keep a fallback
 * (meta_title/meta_description/summarize — genuinely useful offline, labeled
 * provider:"fallback"); tasks that REQUIRE a model refuse with a self-teaching
 * AiUnavailableError instead of returning the input dressed up as a result
 * (rule #1: never garbage-in-success-out — the old "improve" fallback returned
 * the source with a capital letter as success, and an MCP translate call with
 * no key returned the untranslated source as success).
 */

export const AI_TASKS = ["meta_title", "meta_description", "summarize", "improve", "alt_text", "translate", "rewrite", "variants", "write", "schema_fields"] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Tasks with no honest offline approximation — a model is required. */
const REQUIRES_MODEL: ReadonlySet<AiTask> = new Set(["improve", "rewrite", "translate", "variants", "alt_text", "write", "schema_fields"]);

/** Thrown when a model-requiring task is asked for and no provider is usable. */
export class AiUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        "AI is not configured — this task needs a real model. Add an API key in Settings → AI " +
          "(Anthropic, or any OpenAI-compatible endpoint), or set ANTHROPIC_API_KEY / OPENAI_API_KEY.",
    );
    this.name = "AiUnavailableError";
  }
}

export interface AiRequest {
  task: AiTask;
  input: string;
  targetLocale?: string;
  /** For `rewrite`: the editor's free-form instruction ("shorten to 8 words"). */
  instruction?: string;
  /** Surrounding page context (name/intro/etc.) — informs tone and subject. */
  context?: string;
}

export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
/** What AiResult.provider may carry (the wire enum: providers + offline fallback). */
export const AI_RESULT_PROVIDERS = ["anthropic", "openai", "fallback"] as const;

export interface AiResult {
  result: string;
  provider: (typeof AI_RESULT_PROVIDERS)[number];
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Model used when none is configured, per provider. */
export const DEFAULT_AI_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
};

export interface AiConfig {
  /** Which dialect the endpoint speaks. Default: "anthropic". */
  provider?: AiProvider;
  apiKey?: string;
  model: string;
  /** openai only: the endpoint base ("https://api.openai.com/v1", "http://localhost:11434/v1", …). */
  baseUrl?: string;
}

const providerOf = (cfg: AiConfig): AiProvider => cfg.provider ?? "anthropic";

/* --------------------------- provider chat seam --------------------------- */
// ONE single-turn chat function, two dialects. Every model call in the product
// (assist tasks, vision alt text, batch translate — and the content agent's
// tool loop via the exported low-level posts) goes through these, so adding a
// dialect is one place, not five.

interface ChatRequest {
  system: string;
  user: string;
  /** Optional vision input (the actual image bytes, base64). */
  image?: { base64: string; mediaType: string };
  maxTokens: number;
  timeoutMs: number;
}

/** Trim a provider error body to something short and self-teaching. */
function errExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat ? ` — ${flat.slice(0, 200)}` : "";
}

/**
 * POST to the Anthropic Messages API. Exported for the content agent (tool
 * loop), which builds its own payload but must share auth/timeout/error shape.
 */
export async function postAnthropicMessages(
  cfg: AiConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}${errExcerpt(await res.text().catch(() => ""))}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST to an OpenAI-compatible /chat/completions endpoint. Exported for the
 * content agent. Newer OpenAI models reject `max_tokens` in favour of
 * `max_completion_tokens`, while many compatible servers (Ollama, vLLM, older
 * proxies) only accept the classic name — send the classic one and retry once
 * with the new name when the endpoint says so, so both worlds work unconfigured.
 */
export async function postOpenAiChat(
  cfg: AiConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const base = (cfg.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const attempt = async (body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; text: string }> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey!}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => "") };
      return { ok: true, data: (await res.json()) as Record<string, unknown> };
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await attempt(payload);
  if (first.ok) return first.data;
  if (first.status === 400 && /max_tokens/.test(first.text) && "max_tokens" in payload) {
    const { max_tokens, ...rest } = payload;
    const second = await attempt({ ...rest, max_completion_tokens: max_tokens });
    if (second.ok) return second.data;
    throw new Error(`OpenAI-compatible ${second.status}${errExcerpt(second.text)}`);
  }
  throw new Error(`OpenAI-compatible ${first.status}${errExcerpt(first.text)}`);
}

/** Extract the text of an OpenAI chat response (string or content-part array). */
export function openAiMessageText(data: Record<string, unknown>): string {
  const choice = (data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("")
      .trim();
  }
  return "";
}

function anthropicMessageText(data: Record<string, unknown>): string {
  const content = (data.content ?? []) as Array<{ type: string; text?: string }>;
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

/** Single-turn chat against the configured provider; returns the reply text. */
async function chat(cfg: AiConfig, req: ChatRequest): Promise<string> {
  let text: string;
  if (providerOf(cfg) === "openai") {
    const content = req.image
      ? [
          { type: "image_url", image_url: { url: `data:${req.image.mediaType};base64,${req.image.base64}` } },
          { type: "text", text: req.user },
        ]
      : req.user;
    const data = await postOpenAiChat(
      cfg,
      {
        model: cfg.model,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content },
        ],
      },
      req.timeoutMs,
    );
    text = openAiMessageText(data);
  } else {
    const content = req.image
      ? [
          { type: "image", source: { type: "base64", media_type: req.image.mediaType, data: req.image.base64 } },
          { type: "text", text: req.user },
        ]
      : req.user;
    const data = await postAnthropicMessages(
      cfg,
      { model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content }] },
      req.timeoutMs,
    );
    text = anthropicMessageText(data);
  }
  if (!text) throw new Error("Empty AI response");
  return text;
}

const SYSTEM =
  "You are an expert editorial assistant inside a headless CMS. Follow the instruction exactly and return ONLY the requested text — no preamble, no quotes, no code fences. PRESERVE the input's formatting and markup: Markdown in → Markdown out (keep headings, lists, emphasis, links); plain text in → plain text out (do not add markup).";

function instruction(req: AiRequest): string {
  // Page context informs tone/subject without being copied into the output.
  const ctx = req.context?.trim()
    ? `\n\nContext about the page this text belongs to (for tone and subject — do NOT copy it verbatim):\n${req.context.trim()}`
    : "";
  switch (req.task) {
    case "meta_title":
      return `Write a compelling SEO <title> (max 60 characters) for the following page content.\n\n${req.input}${ctx}`;
    case "meta_description":
      return `Write an SEO meta description (max 155 characters, active voice, no clickbait) summarising the following page content.\n\n${req.input}${ctx}`;
    case "summarize":
      return `Summarise the following content in one or two clear sentences.\n\n${req.input}${ctx}`;
    case "improve":
      return `Improve the clarity, grammar and flow of the following text. Preserve its meaning, its formatting/markup, and keep a similar length.\n\n${req.input}${ctx}`;
    case "alt_text":
      return `Write concise, descriptive alt text (max 120 characters) for an image. The image's filename/description is:\n\n${req.input}${ctx}`;
    case "translate":
      return `Translate the following text into ${req.targetLocale ?? "the target language"}. Preserve meaning and tone.\n\n${req.input}${ctx}`;
    case "rewrite":
      return `Rewrite the following text according to this instruction: "${req.instruction ?? "improve it"}". Keep the same language as the input. Return ONLY the rewritten text.\n\n${req.input}${ctx}`;
    case "variants":
      return `Write exactly 3 alternative versions of the following text — same language, same intent, meaningfully different angles (e.g. punchier, warmer, more concrete). Keep each roughly the same length as the original. Return ONLY a JSON array of 3 strings — no preamble, no code fences.\n\n${req.input}${ctx}`;
    case "write":
      // The richtext "Write about this" item: the selection is a TOPIC (often a
      // heading or fragment); the result is inserted AFTER it as paragraphs, so
      // plain prose only — markdown syntax would render literally in TipTap.
      return `Write 2–4 well-crafted paragraphs about the following topic, as body text that could follow it in a document. Match the language of the topic. Return ONLY plain prose paragraphs separated by a blank line — no headings, no lists, no markdown syntax, no preamble.\n\nTopic:\n${req.input}${ctx}`;
    case "schema_fields":
      // Field proposals for a custom schema.org @type the static catalog
      // doesn't know. The reply is validated against AiSchemaFieldSuggestions
      // before anything reaches the editor.
      return [
        `You are configuring a content type in a headless CMS. Its schema.org @type is "${req.input}".`,
        `Propose the content fields this type needs so its delivered JSON-LD qualifies for the Google rich result of that @type (fall back to schema.org's required/recommended properties when Google defines none).`,
        `Return ONLY a JSON array (no code fences, no prose) of 4–8 objects, most impactful first:`,
        `{"prop": "<schema.org property it feeds>", "required": <true if the rich result requires it>, "field": {"name": "<camelCase>", "displayName": "<label>", "type": "<one of: text, markdown, richtext, boolean, number, datetime, select, link, image>", "localized": <true for human-language text>, "seoRole": "<ONLY for the universal meta — one of title, description, image, datePublished, dateModified, author, keywords>", "schemaProp": "<ONLY for @type-specific properties, e.g. startDate or offers.price — at most one dot>", "helpText": "<short editor hint>"}}`,
        `Rules: every suggestion carries EITHER seoRole OR schemaProp, never both and never neither. Use the universal seoRole for title/description/image/dates/author/keywords; use schemaProp for everything specific to "${req.input}".`,
        req.context?.trim() ? `The type already has these fields (do NOT re-propose properties they cover):\n${req.context.trim()}` : "",
      ].filter(Boolean).join("\n");
  }
}

/**
 * Normalize a `schema_fields` reply to a guaranteed-valid JSON string of
 * AiSchemaFieldSuggestions — fences stripped, shape Zod-validated. Garbage
 * throws (surfaced as a provider failure) instead of reaching the editor.
 */
export function normalizeSchemaFields(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const tryParse = (s: string): string | null => {
    try {
      const parsed = AiSchemaFieldSuggestions.safeParse(JSON.parse(s));
      return parsed.success ? JSON.stringify(parsed.data) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const embedded = text.match(/\[[\s\S]*\]/);
  const fromEmbedded = embedded ? tryParse(embedded[0]) : null;
  if (fromEmbedded) return fromEmbedded;
  throw new Error("the model returned an unusable field-suggestion list");
}

async function callModel(req: AiRequest, cfg: AiConfig): Promise<string> {
  return chat(cfg, { system: SYSTEM, user: instruction(req), maxTokens: 1024, timeoutMs: 20_000 });
}

/** Deterministic, offline-safe heuristics — ONLY for the truncation tasks.
 *  Model-requiring tasks never reach this (they throw AiUnavailableError). */
function fallback(req: AiRequest): string {
  const clean = req.input.replace(/\s+/g, " ").trim();
  const truncate = (s: string, n: number) => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const sp = cut.lastIndexOf(" ");
    return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trim()}…`;
  };
  switch (req.task) {
    case "meta_title": {
      const firstLine = clean.split(/[.!?\n]/)[0]?.trim() || clean;
      return truncate(firstLine, 60);
    }
    case "meta_description":
      return truncate(clean, 155);
    case "summarize": {
      const sentence = clean.match(/^.*?[.!?](\s|$)/)?.[0]?.trim();
      return sentence || truncate(clean, 160);
    }
    default:
      // Unreachable: aiAssist throws for model-requiring tasks before this.
      throw new AiUnavailableError();
  }
}

/** Normalize a `variants` response to a guaranteed JSON string array — models
 *  routinely wrap JSON in ```fences or add prose despite instructions. */
function normalizeVariants(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const tryParse = (s: string): string | null => {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string")) return JSON.stringify(arr);
    } catch { /* not JSON */ }
    return null;
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const embedded = text.match(/\[[\s\S]*\]/);
  if (embedded) {
    const fromEmbedded = tryParse(embedded[0]);
    if (fromEmbedded) return fromEmbedded;
  }
  return JSON.stringify([text]); // salvage: one variant, never raw fences
}

export async function aiAssist(req: AiRequest, cfg: AiConfig): Promise<AiResult> {
  // Alt text must be derived from the IMAGE, not text. /ai/assist + MCP ai_assist
  // only have the filename here; generating from it would be image-blind output
  // dressed up as a real result (rule #1). Route callers to the dedicated vision
  // endpoint regardless of whether a key is configured (L1).
  if (req.task === "alt_text") {
    throw new AiUnavailableError(
      "Alt text must come from the image itself — call POST /ai/alt-text (vision), which sends the image bytes. /ai/assist only sees the filename.",
    );
  }
  const needsModel = REQUIRES_MODEL.has(req.task);
  if (!cfg.apiKey) {
    if (needsModel) throw new AiUnavailableError();
    return { result: fallback(req), provider: "fallback" };
  }
  try {
    const result = await callModel(req, cfg);
    return {
      result: req.task === "variants" ? normalizeVariants(result) : req.task === "schema_fields" ? normalizeSchemaFields(result) : result,
      provider: providerOf(cfg),
    };
  } catch (err) {
    // Truncation tasks degrade gracefully; model-requiring tasks must surface
    // the failure — a "result" that is really the input would gaslight the
    // caller (human or agent) into believing the work happened.
    if (needsModel) {
      throw new AiUnavailableError(
        `AI provider call failed (${err instanceof Error ? err.message : "unknown error"}) — try again, or check the key/model in Settings → AI.`,
      );
    }
    return { result: fallback(req), provider: "fallback" };
  }
}

/* ------------------------------ vision alt text --------------------------- */

const ALT_SYSTEM =
  "You write alt text for images in a CMS. Describe what is IN the image for a person who cannot see it: subject, action, setting. Be specific and concise (max 120 characters). Do not start with 'Image of' or 'Photo of'. Return ONLY the alt text — no quotes, no preamble.";

export interface AiAltTextRequest {
  /** The image itself, base64-encoded (downscaled by the caller). */
  imageBase64: string;
  mediaType: string;
  /** Filename/context shown to the model as a hint, never as the source. */
  filename?: string;
}

/**
 * Alt text from the ACTUAL IMAGE via a vision content block. There is no
 * fallback: alt text derived from a filename is exactly the kind of fake
 * output rule #1 forbids, so without a key this throws AiUnavailableError.
 */
export async function aiImageAltText(req: AiAltTextRequest, cfg: AiConfig): Promise<AiResult> {
  if (!cfg.apiKey) throw new AiUnavailableError();
  try {
    const text = await chat(cfg, {
      system: ALT_SYSTEM,
      user: `Write alt text for this image.${req.filename ? ` (Filename, as a weak hint only: ${req.filename})` : ""}`,
      image: { base64: req.imageBase64, mediaType: req.mediaType },
      maxTokens: 256,
      timeoutMs: 30_000,
    });
    return { result: text.slice(0, 200), provider: providerOf(cfg) };
  } catch (err) {
    if (err instanceof AiUnavailableError) throw err;
    throw new AiUnavailableError(
      `AI provider call failed (${err instanceof Error ? err.message : "unknown error"}) — try again, or check the key/model in Settings → AI.`,
    );
  }
}

/* ----------------------------- batch translate ---------------------------- */

const TRANSLATE_SYSTEM =
  "You are a professional translator inside a headless CMS. Translate each input string into the requested language, preserving meaning, tone, and any Markdown/HTML formatting. Return ONLY a JSON array of the translated strings, in the same order and with the same length as the input — no preamble, no code fences.";

async function callModelTranslate(texts: string[], targetLocale: string, cfg: AiConfig): Promise<string[]> {
  const prompt = `Translate each string in this JSON array into ${targetLocale}. Return ONLY a JSON array of translations, same order and length.\n\n${JSON.stringify(texts)}`;
  let text = await chat(cfg, { system: TRANSLATE_SYSTEM, user: prompt, maxTokens: 8192, timeoutMs: 30_000 });
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) throw new Error("Bad translate response");
  return arr as string[];
}

/**
 * Translate many strings in ONE provider call (so a whole page is one request,
 * not one per field — which would trip the per-route rate limit). Offline or on
 * any error it returns the source strings unchanged (provider "fallback"), so the
 * caller still gets a complete, safe result to seed a draft from.
 */
export async function aiTranslateBatch(
  texts: string[],
  targetLocale: string,
  cfg: AiConfig,
): Promise<{ results: string[]; provider: AiResult["provider"] }> {
  if (!texts.length) return { results: [], provider: "fallback" };
  if (cfg.apiKey) {
    try {
      const results = await callModelTranslate(texts, targetLocale, cfg);
      if (results.length === texts.length) return { results, provider: providerOf(cfg) };
    } catch {
      // fall through to copy-source fallback
    }
  }
  return { results: [...texts], provider: "fallback" };
}
