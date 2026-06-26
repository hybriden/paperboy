import { afterEach, describe, expect, it, vi } from "vitest";
import { AiUnavailableError, aiAssist, aiImageAltText, aiTranslateBatch } from "@paperboy/shared";

/**
 * The AI provider's honesty contract (pure unit — no DB, no network).
 *
 * Rule #1 (never garbage-in-success-out) applies to the provider itself: with
 * no API key, tasks that REQUIRE a model (improve/rewrite/translate/variants/
 * alt_text) must REFUSE with a self-teaching error — not return the input
 * dressed up as a result. The old behavior returned "improved" text that was
 * just the source with a capital letter, and an MCP translate call returned
 * the untranslated source as success.
 *
 * Deterministic truncation stays for the SEO-ish tasks (meta_title/
 * meta_description/summarize) — genuinely useful offline, and labeled
 * provider:"fallback" so the UI can say "basic". aiTranslateBatch keeps its
 * copy-source fallback by design: callers use it to SEED drafts and label the
 * result ("Draft seeded from source"), which is honest at the workflow level.
 */

const NO_KEY = { model: "claude-test" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aiAssist — no API key", () => {
  it("keeps the deterministic fallback for the truncation tasks, labeled as fallback", async () => {
    const meta = await aiAssist({ task: "meta_title", input: "Hello world. This is a long page about things." }, NO_KEY);
    expect(meta.provider).toBe("fallback");
    expect(meta.result).toBe("Hello world");

    const desc = await aiAssist({ task: "meta_description", input: "x".repeat(400) }, NO_KEY);
    expect(desc.provider).toBe("fallback");
    expect(desc.result.length).toBeLessThanOrEqual(156);

    const sum = await aiAssist({ task: "summarize", input: "First sentence. Second sentence." }, NO_KEY);
    expect(sum.provider).toBe("fallback");
    expect(sum.result).toBe("First sentence.");
  });

  // alt_text is refused on a DEDICATED path (points to the vision route) — see the
  // "with a key" describe; the loop covers the other model-requiring tasks.
  for (const task of ["improve", "rewrite", "translate", "variants", "write"] as const) {
    it(`refuses '${task}' with a self-teaching error instead of fake success`, async () => {
      await expect(aiAssist({ task, input: "some text", targetLocale: "nb" }, NO_KEY)).rejects.toThrow(AiUnavailableError);
      await expect(aiAssist({ task, input: "some text", targetLocale: "nb" }, NO_KEY)).rejects.toThrow(/Settings → AI/);
    });
  }
});

describe("aiAssist — provider failure with a key", () => {
  it("model-requiring tasks rethrow (no silent downgrade to the source text)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(aiAssist({ task: "improve", input: "text" }, { apiKey: "k", model: "m" })).rejects.toThrow(AiUnavailableError);
  });

  it("truncation tasks degrade to the deterministic fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const r = await aiAssist({ task: "meta_title", input: "Resilient title. More." }, { apiKey: "k", model: "m" });
    expect(r).toEqual({ result: "Resilient title", provider: "fallback" });
  });

  it("refuses alt_text (text-only) and points to the vision route, even with a key (L1)", async () => {
    await expect(aiAssist({ task: "alt_text", input: "photo.jpg" }, { apiKey: "k", model: "m" })).rejects.toThrow(/\/ai\/alt-text|vision/i);
  });
});

describe("aiAssist — write (draft prose about a topic)", () => {
  it("asks for plain prose paragraphs and returns the model text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "First paragraph.\n\nSecond paragraph." }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await aiAssist({ task: "write", input: "The history of the printing press" }, { apiKey: "k", model: "m" });
    expect(r).toEqual({ result: "First paragraph.\n\nSecond paragraph.", provider: "anthropic" });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain("The history of the printing press");
    expect(body.messages[0]!.content).toMatch(/plain prose/i); // no markdown — TipTap inserts paragraphs
  });
});

describe("aiTranslateBatch — seed semantics preserved", () => {
  it("no key → returns the source strings unchanged, labeled fallback", async () => {
    const r = await aiTranslateBatch(["a", "b"], "nb", NO_KEY);
    expect(r).toEqual({ results: ["a", "b"], provider: "fallback" });
  });
});

describe("aiImageAltText — vision alt text", () => {
  it("refuses without a key (no filename heuristics dressed up as AI)", async () => {
    await expect(
      aiImageAltText({ imageBase64: "aGk=", mediaType: "image/jpeg", filename: "IMG_1234.jpg" }, NO_KEY),
    ).rejects.toThrow(AiUnavailableError);
  });

  it("sends the IMAGE to the model (vision content block), not just the filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "A red bicycle leaning against a brick wall" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await aiImageAltText({ imageBase64: "aGk=", mediaType: "image/jpeg", filename: "IMG_1234.jpg" }, { apiKey: "k", model: "m" });
    expect(r.result).toBe("A red bicycle leaning against a brick wall");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      messages: { content: { type: string; source?: { data?: string; media_type?: string } }[] }[];
    };
    const blocks = body.messages[0]!.content;
    const image = blocks.find((b) => b.type === "image");
    expect(image?.source?.data).toBe("aGk=");
    expect(image?.source?.media_type).toBe("image/jpeg");
  });
});
