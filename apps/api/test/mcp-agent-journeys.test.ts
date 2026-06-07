import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * Agent-journey deep suite. Every describe block replays a COMPLETE, REAL
 * tool-call sequence mined from production logs (harmonix automation_runs +
 * Paperboy audit_log, 2026-06-02 → 2026-06-07) against the real spawned MCP
 * server. The goal: when an agent workflow breaks in production, a test here
 * should already have been red.
 *
 * Sources, by journey:
 *  J1  the scheduled drafter flows ("Neoteric daily blog drafter" /
 *      "hardware news drafter"): delivery_list → create_content →
 *      set_field × N → publish, verified through delivery.
 *  J2  the 2026-06-06 chat task (the "Untitled" incident): create in en,
 *      write all fields into nb, publish nb.
 *  J3  the 2026-06-07 chat task: find the existing post, translate, write
 *      en fields with set_field, publish en — both locales live independently.
 *  J4  the 2026-06-05 stuck-loop run: long strings nested in `data` arrived
 *      client-mangled as {} — 9 identical retries. The error must steer to
 *      set_field (the shape that survives), and set_field must then succeed.
 *  J5  the 2026-06-04 error dance: the agent invented text-wrapper shapes
 *      ({type:'text',text}, {text}, {raw}) for a text field — 3 rejects in a
 *      row. These are meaning-preserving and must coerce (rule 3).
 *  J6  the 2026-06-07 chat task's get_content_type "blog-post" miss: the
 *      not-found error must list the real type names (one-step correction).
 *  J7  the 2026-06-04 publish-too-early loop: publish before required fields →
 *      self-teaching error → one corrective write → publish succeeds.
 */

// ~3k chars of realistic Norwegian markdown — code fences, headings, lists,
// special chars. The drafters write bodies of this size; byte-identical
// round-trip through MCP → DB → delivery is the contract.
const LONG_BODY = [
  "# Maskinvarenytt: GPU-prisene stiger igjen\n",
  "Prisene på skjermkort har økt **23 %** siden årsskiftet — drevet av DRAM-mangel og økt etterspørsel etter AI-akseleratorer.\n",
  "## Hva skjer i markedet?\n",
  "- HBM-kapasiteten er utsolgt til 2027\n- Hyperscalerne støvsuger markedet for `H200`-kort\n- Forbrukerkort nedprioriteres i produksjonen\n",
  "## Teknisk bakgrunn\n",
  "```python\n# Eksempel: måling av tokens/sekund\nimport time\nstart = time.time()\ntokens = run_inference(model, prompt)\nprint(f\"{len(tokens) / (time.time() - start):.1f} tok/s\")\n```\n",
  "> «Vi ser en strukturell underkapasitet i minnemarkedet», sier analytiker Kari Nordmann i Tek-analyse AS.\n",
  "## Hva betyr det for deg?\n",
  "1. Vent med oppgradering hvis du kan — prisene normaliseres trolig i Q3\n2. Brukte kort fra forrige generasjon er nå et reelt alternativ\n3. Skytjenester blir relativt billigere når egen maskinvare blir dyr\n",
  "Husk: æ, ø og å skal overleve hele veien — og det skal «smarte anførselstegn», em-dashes — og emoji 🚀 også.\n",
].join("\n").repeat(2);

describe("MCP agent journeys (real production sequences)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let mcp: McpClient;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    const adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    const minted = await s.app.inject({ method: "POST", url: "/api/v1/manage/mcp-tokens", headers: authHeaders(admin), payload: { name: "journey-suite", userId: adminId } });
    const token = minted.json().token as string;
    mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: token, MCP_HTTP_PORT: "" });
    await mcp.initialize();
  }, 90_000);

  afterAll(async () => {
    mcp?.kill();
    await s.app.close();
  });

  /** Delivery read through the API with the public (published-only) key. */
  async function deliveryBySlug(slug: string, locale: string) {
    return s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/by-slug?slug=${encodeURIComponent(slug)}&locale=${locale}`,
      headers: { "x-api-key": PUBLIC_KEY },
    });
  }

  // ------------------------------------------------------------------
  // J1 — the scheduled drafter: fetch existing → create → fill → publish
  // ------------------------------------------------------------------
  describe("J1: scheduled drafter publish loop", () => {
    let docId: string;

    it("delivery_list returns the published blog posts (the 'fetch published posts' node)", async () => {
      const r = await mcp.call("delivery_list", { parentId: s.ids.blogId, type: "BlogPost" });
      expect(r.isError).toBe(false);
      const items = (r.json as { items: Array<{ documentId: string }> }).items;
      expect(items.length).toBeGreaterThanOrEqual(1); // the seeded posts
    });

    it("create_content under the blog parent auto-slugs and lands in the tree", async () => {
      const r = await mcp.call("create_content", {
        type: "BlogPost",
        locale: "en",
        name: "GPU prices climb again — what it means",
        parentId: s.ids.blogId,
      });
      expect(r.isError).toBe(false);
      const created = r.json as { documentId: string; slug: string; parentId: string };
      docId = created.documentId;
      expect(created.parentId).toBe(s.ids.blogId);
      expect(created.slug).toBe("gpu-prices-climb-again-what-it-means");
    });

    it("set_field fills every field the drafters write — including the long markdown body", async () => {
      const fields: Array<[string, string]> = [
        ["title", "GPU prices climb again — what it means"],
        ["summary", "DRAM shortage pushes GPU prices up 23% — here is what to do about it."],
        ["body", LONG_BODY],
        ["metaDescription", "GPU price analysis: DRAM shortage, HBM allocation and what buyers should do."],
        ["ogType", "article"],
        ["publishDate", "2026-06-07T08:00:00.000Z"],
      ];
      for (const [field, value] of fields) {
        const r = await mcp.call("set_field", { documentId: docId, locale: "en", field, value });
        expect(r.isError, `set_field ${field}: ${r.text.slice(0, 200)}`).toBe(false);
      }
    });

    it("publish succeeds and the delivery output is byte-identical (no flattening, no mangling)", async () => {
      const pub = await mcp.call("publish", { documentId: docId, locale: "en" });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);

      const res = await deliveryBySlug("gpu-prices-climb-again-what-it-means", "en");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { name: string; data: Record<string, unknown> };
      expect(body.name).toBe("GPU prices climb again — what it means");
      // The contract that broke in the original TipTap-flattening incident:
      // what the agent sent is EXACTLY what delivery serves.
      expect(body.data.body).toBe(LONG_BODY);
      expect(body.data.ogType).toBe("article");
    });

    it("the new post appears in the next delivery_list poll (what tomorrow's run sees)", async () => {
      const r = await mcp.call("delivery_list", { parentId: s.ids.blogId, type: "BlogPost" });
      const items = (r.json as { items: Array<{ documentId: string }> }).items;
      expect(items.map((i) => i.documentId)).toContain(docId);
    });
  });

  // ------------------------------------------------------------------
  // J2 — the Untitled incident, end to end through the MCP surface
  // ------------------------------------------------------------------
  describe("J2: create in en, write nb, publish nb (the 2026-06-06 incident)", () => {
    let docId: string;

    it("replays the exact sequence: orientation reads → create(en) → set_field×N(nb) → publish(nb)", async () => {
      // Orientation phase, as the real agent did it.
      expect((await mcp.call("list_content_types")).isError).toBe(false);
      expect((await mcp.call("tree", {})).isError).toBe(false);
      expect((await mcp.call("list_locales")).isError).toBe(false);

      const created = await mcp.call("create_content", {
        type: "BlogPost",
        locale: "en",
        name: "Japansk interiør: en historie",
        parentId: s.ids.blogId,
      });
      expect(created.isError).toBe(false);
      docId = (created.json as { documentId: string }).documentId;

      for (const [field, value] of [
        ["title", "Japansk interiør: en historie"],
        ["summary", "Fra tatamistuer og wabi-sabi til dagens Japandi-trend."],
        ["body", "# Japansk interiør\n\nWabi-sabi, zen og Japandi — hele historien."],
      ] as const) {
        const r = await mcp.call("set_field", { documentId: docId, locale: "nb", field, value });
        expect(r.isError, r.text.slice(0, 200)).toBe(false);
      }

      const pub = await mcp.call("publish", { documentId: docId, locale: "nb" });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);
      const published = pub.json as { name: string; slug: string };
      // THE incident assertions: never "Untitled", never /untitled.
      expect(published.name).toBe("Japansk interiør: en historie");
      expect(published.slug).toBe("japansk-interior-en-historie");
    });

    it("the nb post is live at the inherited slug through delivery", async () => {
      const res = await deliveryBySlug("japansk-interior-en-historie", "nb");
      expect(res.statusCode).toBe(200);
      expect((res.json() as { locale: string }).locale).toBe("nb");
    });

    // J3 — the 2026-06-07 follow-up: translate and publish the OTHER locale.
    it("J3: set_field en translations on the same doc, publish en — locales stay independent", async () => {
      for (const [field, value] of [
        ["title", "Japanese Interior: A History"],
        ["summary", "From tatami rooms and wabi-sabi to today's Japandi trend."],
        ["body", "# Japanese Interior\n\nWabi-sabi, zen and Japandi — the whole story."],
      ] as const) {
        const r = await mcp.call("set_field", { documentId: docId, locale: "en", field, value });
        expect(r.isError, r.text.slice(0, 200)).toBe(false);
      }
      const pub = await mcp.call("publish", { documentId: docId, locale: "en" });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);

      const en = await deliveryBySlug("japansk-interior-en-historie", "en");
      expect(en.statusCode).toBe(200);
      expect((en.json() as { data: { title: string } }).data.title).toBe("Japanese Interior: A History");
      // nb must be untouched by the en publish.
      const nb = await deliveryBySlug("japansk-interior-en-historie", "nb");
      expect((nb.json() as { data: { title: string } }).data.title).toBe("Japansk interiør: en historie");
    });
  });

  // ------------------------------------------------------------------
  // J4 — client-mangled long strings: data:{body:{},...} (2026-06-05 run)
  // ------------------------------------------------------------------
  describe("J4: long strings mangled to {} in `data` — the stuck-loop class", () => {
    let docId: string;

    beforeAll(async () => {
      const created = await mcp.call("create_content", { type: "BlogPost", locale: "en", name: "Mangled args victim", parentId: s.ids.blogId });
      docId = (created.json as { documentId: string }).documentId;
    });

    it("rejects the mangled write with an error that steers to set_field (rule 4)", async () => {
      // Verbatim shape from the production run that looped 9 times:
      const r = await mcp.call("update_content", {
        documentId: docId,
        locale: "en",
        data: { body: {}, metaDescription: {}, summary: {} },
        merge: false,
      });
      expect(r.isError).toBe(true);
      // Names each field with its expected shape (already true)…
      expect(r.text).toContain("'summary' is a text field");
      expect(r.text).toContain("'body' is a markdown field");
      // …and steers to the transport-safe tool (this is what was missing:
      // the agent had no way to learn its long strings were being destroyed
      // client-side, so it retried the same garbage 9 times).
      expect(r.text).toContain("set_field");
    });

    it("the steered follow-up (set_field) then succeeds in one step", async () => {
      const r = await mcp.call("set_field", { documentId: docId, locale: "en", field: "body", value: LONG_BODY });
      expect(r.isError, r.text.slice(0, 200)).toBe(false);
      expect((r.json as { data: { body: string } }).data.body).toBe(LONG_BODY);
    });
  });

  // ------------------------------------------------------------------
  // J5 — invented text-wrapper shapes (2026-06-04 run, 3 rejects in a row)
  // ------------------------------------------------------------------
  describe("J5: meaning-preserving text wrappers coerce instead of erroring", () => {
    let docId: string;

    beforeAll(async () => {
      const created = await mcp.call("create_content", { type: "ArticlePage", locale: "en", name: "Wrapper dance page" });
      docId = (created.json as { documentId: string }).documentId;
    });

    // The three exact shapes the production agent tried, in order:
    const WRAPPERS: Array<[string, Record<string, unknown>]> = [
      ["{type:'text', text}", { type: "text", text: "Open-source tools and after-hours AI experiments." }],
      ["{text}", { text: "Open-source tools and after-hours AI experiments." }],
      ["{raw}", { raw: "Open-source tools and after-hours AI experiments." }],
    ];

    for (const [label, wrapper] of WRAPPERS) {
      it(`text field given ${label} → unwrapped to the inner string (rule 3)`, async () => {
        const r = await mcp.call("update_content", {
          documentId: docId,
          locale: "en",
          data: { heading: wrapper },
          merge: true,
        });
        expect(r.isError, r.text.slice(0, 300)).toBe(false);
        expect((r.json as { data: { heading: string } }).data.heading).toBe(
          "Open-source tools and after-hours AI experiments.",
        );
      });
    }

    it("genuinely ambiguous objects still error helpfully (no garbage-in-success-out)", async () => {
      const r = await mcp.call("update_content", {
        documentId: docId,
        locale: "en",
        data: { heading: { foo: 1, bar: 2 } },
        merge: true,
      });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("'heading' is a text field");
    });
  });

  // ------------------------------------------------------------------
  // J6 — get_content_type with a guessed name (2026-06-07 run)
  // ------------------------------------------------------------------
  describe("J6: unknown content-type name errors list the real names", () => {
    it("get_content_type 'blog-post' names the available types for one-step correction", async () => {
      const r = await mcp.call("get_content_type", { name: "blog-post" });
      expect(r.isError).toBe(true);
      // The agent guessed kebab-case; the error must hand it the real names.
      expect(r.text).toContain("BlogPost");
      expect(r.text).toContain("ArticlePage");
    });
  });

  // ------------------------------------------------------------------
  // J8 — the locale-omission trap (2026-06-07 article run)
  // ------------------------------------------------------------------
  describe("J8: set_field without locale on a single-locale document targets THAT locale", () => {
    it("never silently forks a phantom variant in the static default locale", async () => {
      // The exact incident: the agent created the article in nb, then wrote
      // tags/publishDate WITHOUT a locale (they're localized:false — "not
      // language-specific" was a perfectly reasonable read). The MCP defaulted
      // to 'en' and silently forked a near-empty en draft; the nb article
      // shipped without tags or date.
      const created = await mcp.call("create_content", {
        type: "BlogPost",
        locale: "nb",
        name: "Norsk-eneste dokument",
        parentId: s.ids.blogId,
      });
      expect(created.isError).toBe(false);
      const docId = (created.json as { documentId: string }).documentId;

      const r = await mcp.call("set_field", { documentId: docId, field: "tags", value: "Interiør, Japan" });
      expect(r.isError, r.text.slice(0, 300)).toBe(false);

      // The write must land in nb (the document's only locale)…
      const nb = await mcp.call("get_content", { documentId: docId, locale: "nb" });
      expect((nb.json as { data: { tags?: string } }).data.tags).toBe("Interiør, Japan");

      // …and NO en variant may exist: reading en explicitly returns the
      // non-persisted scaffold (versionNumber 0, empty data), not a fork.
      const en = await mcp.call("get_content", { documentId: docId, locale: "en" });
      const enBody = en.json as { versionNumber: number; data: Record<string, unknown> };
      expect(enBody.versionNumber).toBe(0);
      expect(enBody.data).toEqual({});
    });
  });

  // ------------------------------------------------------------------
  // J7 — publish before required fields (2026-06-04 run)
  // ------------------------------------------------------------------
  describe("J7: premature publish self-teaches and recovers in one step", () => {
    it("publish → required-field error → one set_field → publish OK", async () => {
      const created = await mcp.call("create_content", { type: "BlogPost", locale: "en", name: "Premature publish", parentId: s.ids.blogId });
      const docId = (created.json as { documentId: string }).documentId;

      const early = await mcp.call("publish", { documentId: docId, locale: "en" });
      expect(early.isError).toBe(true);
      expect(early.text).toContain("title"); // names the missing field
      expect(early.text).toContain("merge:true"); // and the recovery path

      const fix = await mcp.call("set_field", { documentId: docId, locale: "en", field: "title", value: "Premature publish" });
      expect(fix.isError).toBe(false);
      const pub = await mcp.call("publish", { documentId: docId, locale: "en" });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);
    });
  });
});
