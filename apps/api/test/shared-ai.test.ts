import { afterEach, describe, expect, it, vi } from "vitest";
import { AiUnavailableError, aiAssist, aiImageAltText, aiTranslateBatch, listAiModels } from "@paperboy/shared";

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

describe("OpenAI-compatible provider (dialect mapping)", () => {
  const CFG = { provider: "openai" as const, apiKey: "sk-oai-test", model: "gpt-test", baseUrl: "https://llm.example/v1/" };
  const okText = (text: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });

  it("maps to {baseUrl}/chat/completions with Bearer auth + a system message, labels the result 'openai'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okText("Better text."));
    vi.stubGlobal("fetch", fetchMock);
    const r = await aiAssist({ task: "improve", input: "some text" }, CFG);
    expect(r).toEqual({ result: "Better text.", provider: "openai" });
    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://llm.example/v1/chat/completions"); // trailing slash stripped
    expect(init.headers.authorization).toBe("Bearer sk-oai-test");
    const body = JSON.parse(init.body) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("gpt-test");
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[1]!.role).toBe("user");
    expect(body.messages[1]!.content).toContain("some text");
  });

  it("defaults the base URL to api.openai.com when none is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okText("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await aiAssist({ task: "improve", input: "x" }, { provider: "openai", apiKey: "k", model: "m" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("retries once with max_completion_tokens when the endpoint rejects max_tokens (newer OpenAI models)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"Unsupported parameter: max_tokens. Use max_completion_tokens instead."}}',
      })
      .mockResolvedValueOnce(okText("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await aiAssist({ task: "improve", input: "x" }, CFG);
    expect(r.result).toBe("ok");
    const first = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body) as Record<string, unknown>;
    expect(first.max_tokens).toBeDefined();
    expect(second.max_tokens).toBeUndefined();
    expect(second.max_completion_tokens).toBe(first.max_tokens);
  });

  it("surfaces the endpoint's own error body in the failure (self-teaching for misconfig)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'model "gpt-nope" does not exist' }));
    await expect(aiAssist({ task: "improve", input: "x" }, CFG)).rejects.toThrow(/gpt-nope/);
  });

  it("sends vision input as an image_url data URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okText("A cat on a sofa"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await aiImageAltText({ imageBase64: "aGk=", mediaType: "image/jpeg" }, CFG);
    expect(r).toEqual({ result: "A cat on a sofa", provider: "openai" });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userContent = body.messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>;
    const image = userContent.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toBe("data:image/jpeg;base64,aGk=");
  });

  it("reads content-part array replies (some compatible servers return parts, not a string)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: [{ type: "text", text: "part reply" }] } }] }) }),
    );
    const r = await aiAssist({ task: "improve", input: "x" }, CFG);
    expect(r.result).toBe("part reply");
  });

  it("translate batch goes through the same dialect and keeps its contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okText('["hei","verden"]')));
    const r = await aiTranslateBatch(["hi", "world"], "nb", CFG);
    expect(r).toEqual({ results: ["hei", "verden"], provider: "openai" });
  });
});

describe("listAiModels — endpoint model catalog probe", () => {
  it("openai dialect: GET {baseUrl}/models with Bearer auth; ids sorted and deduped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }, { id: 42 }, {}] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const models = await listAiModels({ provider: "openai", apiKey: "sk-o", model: "m", baseUrl: "https://openrouter.ai/api/v1/" });
    expect(models).toEqual(["a-model", "z-model"]); // sorted, deduped, non-strings dropped
    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init.headers.authorization).toBe("Bearer sk-o");
  });

  it("anthropic dialect: GET /v1/models with the x-api-key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "claude-x" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const models = await listAiModels({ apiKey: "sk-ant", model: "m" });
    expect(models).toEqual(["claude-x"]);
    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
    expect(url).toContain("api.anthropic.com/v1/models");
    expect(init.headers["x-api-key"]).toBe("sk-ant");
  });

  it("surfaces the endpoint's error (proxies without /models are common)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "no such route" }));
    await expect(listAiModels({ provider: "openai", apiKey: "k", model: "m" })).rejects.toThrow(/404.*no such route/);
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
