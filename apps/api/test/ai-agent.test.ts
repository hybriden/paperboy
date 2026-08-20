import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The content agent (POST /ai/agent): a server-side tool-use loop that creates
 * DRAFTS as the signed-in user. Anthropic is stubbed with a scripted
 * conversation so the loop, the tool execution and the SSE stream are tested
 * end-to-end against the real data layer — no network, no key.
 */
describe("AI content agent (build from brief)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let viewer: Awaited<ReturnType<typeof login>>;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    s.app.aiEnv.ANTHROPIC_API_KEY = undefined;
    s.app.aiEnv.OPENAI_API_KEY = undefined;
    s.app.aiEnv.OPENAI_BASE_URL = undefined;
    s.app.aiEnv.AI_PROVIDER = undefined;
  });

  const sse = (payload: string) =>
    payload
      .split("\n\n")
      .filter((c) => c.startsWith("data: "))
      .map((c) => JSON.parse(c.slice(6)) as { type: string; name?: string; ok?: boolean; created?: Array<{ documentId: string }>; text?: string });

  it("refuses without content.create (RBAC before any model call)", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/agent",
      headers: authHeaders(viewer),
      payload: { brief: "Make me a page about spring", locale: "en" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409s cleanly when no AI key is configured", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/agent",
      headers: authHeaders(ed),
      payload: { brief: "Make me a page about spring", locale: "en" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("not configured");
  });

  it("runs a scripted loop: creates a draft via the real tools and streams events", async () => {
    s.app.aiEnv.ANTHROPIC_API_KEY = "sk-test";
    // Scripted Anthropic: ① inspect types ② create a page ③ fill it ④ done.
    const turns = [
      { content: [{ type: "tool_use", id: "t1", name: "list_content_types", input: {} }], stop_reason: "tool_use" },
      {
        content: [
          { type: "text", text: "Creating the article." },
          { type: "tool_use", id: "t2", name: "create_content", input: { type: "ArticlePage", parentId: null, locale: "en", name: "Agent Article" } },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "t3", name: "update_content", input: { documentId: "__CREATED__", locale: "en", slug: "agent-article", data: { heading: "Agent Article" } } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "All set — one ArticlePage draft." }], stop_reason: "end_turn" },
    ];
    let call = 0;
    let createdId = "";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!(url instanceof Request ? url.url : String(url)).includes("api.anthropic.com")) return realFetch(url as never, init as never);
      // The scripted 3rd turn needs the real documentId from the 2nd turn's
      // tool_result (it's in the request body we receive).
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { messages: Array<{ content: unknown }> };
      const last = JSON.stringify(body.messages.at(-1)?.content ?? "");
      const m = /"documentId\\?":\\?"([A-Za-z0-9_-]{10,})/.exec(last);
      if (m) createdId = m[1]!;
      const turn = structuredClone(turns[Math.min(call++, turns.length - 1)]!);
      for (const b of turn.content) {
        if ("input" in b && b.input && (b.input as Record<string, unknown>).documentId === "__CREATED__") {
          (b.input as Record<string, unknown>).documentId = createdId;
        }
      }
      return new Response(JSON.stringify(turn), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/agent",
      headers: authHeaders(ed),
      payload: { brief: "Create one article page called Agent Article.", locale: "en" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = sse(res.payload);
    const toolsRun = events.filter((e) => e.type === "tool").map((e) => e.name);
    expect(toolsRun).toEqual(["list_content_types", "create_content", "update_content"]);
    expect(events.filter((e) => e.type === "tool_done").every((e) => e.ok)).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done?.created).toHaveLength(1);

    // The draft REALLY exists, with the agent's data, attributed to the editor.
    const docId = done!.created![0]!.documentId;
    const got = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${docId}?locale=en`, headers: authHeaders(ed) });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe("draft");
    expect(got.json().data.heading).toBe("Agent Article");
  });

  it("speaks the OpenAI tool_calls dialect: same loop, same tools, real drafts", async () => {
    s.app.aiEnv.AI_PROVIDER = "openai";
    s.app.aiEnv.OPENAI_API_KEY = "sk-oai-agent";
    s.app.aiEnv.OPENAI_BASE_URL = "https://llm.agent-test/v1";
    // Scripted OpenAI: ① create a page ② a tool call with BROKEN JSON arguments
    // (self-teaching error result, loop continues) ③ done.
    const turns = [
      {
        choices: [{ message: { content: "Creating the article.", tool_calls: [{ id: "c1", type: "function", function: { name: "create_content", arguments: JSON.stringify({ type: "ArticlePage", parentId: null, locale: "en", name: "OpenAI Article" }) } }] } }],
      },
      {
        choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "update_content", arguments: "{ this is not json" } }] } }],
      },
      { choices: [{ message: { content: "Done — one draft (the field update needs a retry)." } }] },
    ];
    let call = 0;
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!(url instanceof Request ? url.url : String(url)).includes("llm.agent-test")) return realFetch(url as never, init as never);
      requests.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
      return new Response(JSON.stringify(turns[Math.min(call++, turns.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/agent",
      headers: authHeaders(ed),
      payload: { brief: "Create one article page called OpenAI Article.", locale: "en" },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.payload);

    // Dialect on the wire: function-typed tools, a system message, and — after
    // the first tool ran — role:"tool" results tied to the call id.
    const first = requests[0]! as { tools: Array<{ type: string; function?: { name: string } }>; messages: Array<{ role: string }> };
    expect(first.tools.every((t) => t.type === "function")).toBe(true);
    expect(first.tools.some((t) => t.function?.name === "create_content")).toBe(true);
    expect(first.messages[0]!.role).toBe("system");
    const second = requests[1]! as { messages: Array<{ role: string; tool_call_id?: string }> };
    expect(second.messages.some((m) => m.role === "tool" && m.tool_call_id === "c1")).toBe(true);

    // Loop behavior: the create succeeded, the broken-JSON call failed HONESTLY
    // with a self-teaching message, and the run still completed.
    const doneEvents = events.filter((e) => e.type === "tool_done");
    expect(doneEvents.find((e) => e.name === "create_content")?.ok).toBe(true);
    const broken = doneEvents.find((e) => e.name === "update_content");
    expect(broken?.ok).toBe(false);
    expect(broken?.text).toMatch(/not valid JSON/i);
    const done = events.find((e) => e.type === "done");
    expect(done?.created).toHaveLength(1);

    const got = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${done!.created![0]!.documentId}?locale=en`, headers: authHeaders(ed) });
    expect(got.statusCode).toBe(200);
    expect(got.json().name).toBe("OpenAI Article");
  });

  it("sanitizes an unexpected (non-AppError) stream failure instead of leaking it (L2)", async () => {
    s.app.aiEnv.ANTHROPIC_API_KEY = "sk-test";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!(url instanceof Request ? url.url : String(url)).includes("api.anthropic.com")) return realFetch(url as never, init as never);
      throw new Error("SENSITIVE-INTERNAL-DETAIL postgres://secret@host");
    }) as typeof fetch;

    const res = await s.app.inject({ method: "POST", url: "/api/v1/ai/agent", headers: authHeaders(ed), payload: { brief: "Make me a page about spring", locale: "en" } });
    const err = sse(res.payload).find((e) => e.type === "error");
    expect(err?.text).toBe("Agent failed");
    expect(res.payload).not.toContain("SENSITIVE-INTERNAL-DETAIL");
  });

  it("has no publish tool: a scripted publish attempt fails without touching content", async () => {
    s.app.aiEnv.ANTHROPIC_API_KEY = "sk-test";
    const turns = [
      { content: [{ type: "tool_use", id: "p1", name: "publish", input: { documentId: "whatever", locale: "en" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Understood, cannot publish." }], stop_reason: "end_turn" },
    ];
    let call = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!(url instanceof Request ? url.url : String(url)).includes("api.anthropic.com")) return realFetch(url as never, init as never);
      return new Response(JSON.stringify(turns[Math.min(call++, turns.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/agent",
      headers: authHeaders(ed),
      payload: { brief: "Publish the start page right now please.", locale: "en" },
    });
    const events = sse(res.payload);
    const failed = events.find((e) => e.type === "tool_done" && e.name === "publish");
    expect(failed?.ok).toBe(false); // structural guardrail: tool not in the registry
  });
});
