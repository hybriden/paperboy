/**
 * AI editorial assistant. Real editorial use-cases the editor needs help with:
 * SEO title/description generation, summarising, copy improvement, image alt
 * text, and translation. When ANTHROPIC_API_KEY is configured the API calls
 * Claude. Without a key, only the deterministic truncation tasks keep a
 * fallback (meta_title/meta_description/summarize — genuinely useful offline,
 * labeled provider:"fallback"); tasks that REQUIRE a model refuse with a
 * self-teaching AiUnavailableError instead of returning the input dressed up
 * as a result (rule #1: never garbage-in-success-out — the old "improve"
 * fallback returned the source with a capital letter as success, and an MCP
 * translate call with no key returned the untranslated source as success).
 */

export const AI_TASKS = ["meta_title", "meta_description", "summarize", "improve", "alt_text", "translate", "rewrite", "variants"] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Tasks with no honest offline approximation — a model is required. */
const REQUIRES_MODEL: ReadonlySet<AiTask> = new Set(["improve", "rewrite", "translate", "variants", "alt_text"]);

/** Thrown when a model-requiring task is asked for and no provider is usable. */
export class AiUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        "AI is not configured — this task needs a real model. Add an Anthropic API key in Settings → AI (or set ANTHROPIC_API_KEY).",
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
export interface AiResult {
  result: string;
  provider: "anthropic" | "fallback";
}

interface AiConfig {
  apiKey?: string;
  model: string;
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
  }
}

async function callAnthropic(req: AiRequest, cfg: AiConfig): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: "user", content: instruction(req) }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (!text) throw new Error("Empty AI response");
    return text;
  } finally {
    clearTimeout(timer);
  }
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
  const needsModel = REQUIRES_MODEL.has(req.task);
  if (!cfg.apiKey) {
    if (needsModel) throw new AiUnavailableError();
    return { result: fallback(req), provider: "fallback" };
  }
  try {
    const result = await callAnthropic(req, cfg);
    return { result: req.task === "variants" ? normalizeVariants(result) : result, provider: "anthropic" };
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 256,
        system: ALT_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: req.mediaType, data: req.imageBase64 } },
              { type: "text", text: `Write alt text for this image.${req.filename ? ` (Filename, as a weak hint only: ${req.filename})` : ""}` },
            ],
          },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (!text) throw new Error("Empty AI response");
    return { result: text.slice(0, 200), provider: "anthropic" };
  } catch (err) {
    if (err instanceof AiUnavailableError) throw err;
    throw new AiUnavailableError(
      `AI provider call failed (${err instanceof Error ? err.message : "unknown error"}) — try again, or check the key/model in Settings → AI.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- batch translate ---------------------------- */

const TRANSLATE_SYSTEM =
  "You are a professional translator inside a headless CMS. Translate each input string into the requested language, preserving meaning, tone, and any Markdown/HTML formatting. Return ONLY a JSON array of the translated strings, in the same order and with the same length as the input — no preamble, no code fences.";

async function callAnthropicTranslate(texts: string[], targetLocale: string, cfg: AiConfig): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const prompt = `Translate each string in this JSON array into ${targetLocale}. Return ONLY a JSON array of translations, same order and length.\n\n${JSON.stringify(texts)}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8192,
        system: TRANSLATE_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    let text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) throw new Error("Bad translate response");
    return arr as string[];
  } finally {
    clearTimeout(timer);
  }
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
): Promise<{ results: string[]; provider: "anthropic" | "fallback" }> {
  if (!texts.length) return { results: [], provider: "fallback" };
  if (cfg.apiKey) {
    try {
      const results = await callAnthropicTranslate(texts, targetLocale, cfg);
      if (results.length === texts.length) return { results, provider: "anthropic" };
    } catch {
      // fall through to copy-source fallback
    }
  }
  return { results: [...texts], provider: "fallback" };
}
