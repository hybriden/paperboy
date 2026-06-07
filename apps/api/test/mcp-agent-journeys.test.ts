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

// ~3k chars of realistic markdown — code fences, headings, lists, special
// chars (æøå, «smart quotes», emoji). The drafters write bodies of this size
// into the ENGLISH blog; byte-identical round-trip through MCP → DB →
// delivery is the contract. (English prose on purpose: the J9 language guard
// would — correctly — refuse a Norwegian body published into 'en'.)
const LONG_BODY = [
  "# Hardware news: GPU prices are climbing again\n",
  "Graphics card prices are up **23%** since New Year — driven by the DRAM shortage and surging demand for AI accelerators.\n",
  "## What is happening in the market?\n",
  "- HBM capacity is sold out through 2027\n- Hyperscalers are vacuuming up the market for `H200` cards\n- Consumer cards are deprioritised in production\n",
  "## Technical background\n",
  "```python\n# Eksempel: måling av tokens/sekund (æøå survives code fences)\nimport time\nstart = time.time()\ntokens = run_inference(model, prompt)\nprint(f\"{len(tokens) / (time.time() - start):.1f} tok/s\")\n```\n",
  "> «We are seeing structural under-capacity in the memory market», says analyst Kari Nordmann of Tek-analyse AS.\n",
  "## What does it mean for you?\n",
  "1. Hold off upgrading if you can — prices likely normalise in Q3\n2. Used previous-generation cards are now a real alternative\n3. Cloud compute gets relatively cheaper as owning hardware gets expensive\n",
  "Remember: special characters like æ, ø and å must survive end to end — as must «smart quotes», em-dashes — and emoji 🚀 too.\n",
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
  // J9 — the Norwegian-article-on-the-English-blog incident (2026-06-07)
  // ------------------------------------------------------------------
  describe("J9: language/branch mismatch guard at agent publish", () => {
    let docId: string;
    const NORSK_BODY = [
      "# Japansk interiør – En reise gjennom tid og estetikk\n",
      "Japansk interiørdesign har fascinert verden i generasjoner. Med sin dypt rotfestede",
      "filosofi om enkelhet, naturlighet og harmoni representerer japansk design noe unikt –",
      "ikke bare estetiske valg, men en hel livsfilosofi manifestert i rom og gjenstander.\n",
      "## Røttene\n",
      "For å forstå japansk interiør må vi først forstå wabi-sabi – en japansk verdensoppfatning",
      "som anerkjenner skjønnhet i det ufullkomne, det midlertidige og det enkle. Den oppstod",
      "fra zen-buddhismen og lærte at skjønnhet finnes i naturmaterialenes råhet, i en skjevt",
      "brent keramikkbolle og i patinaen som tiden legger på alt vi omgir oss med hjemme.\n",
    ].join("\n");

    it("publishing clearly-Norwegian content into the 'en' branch is refused self-teachingly", async () => {
      // The exact incident: agent omitted locale on create (new doc → 'en'),
      // wrote a Norwegian article, published — and the Norwegian post went
      // live on the ENGLISH blog.
      const created = await mcp.call("create_content", {
        type: "BlogPost",
        locale: "en",
        name: "Japansk interiør – tidsreisen",
        parentId: s.ids.blogId,
      });
      docId = (created.json as { documentId: string }).documentId;
      for (const [field, value] of [
        ["title", "Japansk interiør – tidsreisen"],
        ["body", NORSK_BODY],
      ] as const) {
        const r = await mcp.call("set_field", { documentId: docId, locale: "en", field, value });
        expect(r.isError).toBe(false);
      }

      const pub = await mcp.call("publish", { documentId: docId, locale: "en" });
      expect(pub.isError).toBe(true);
      // Names the detected language, the branch, AND the atomic recovery path.
      expect(pub.text).toContain("nb");
      expect(pub.text).toContain("copy_variant");
      expect(pub.text).toContain("allowLanguageMismatch");
    });

    it("the explicit override publishes when the mismatch is intended", async () => {
      const pub = await mcp.call("publish", { documentId: docId, locale: "en", allowLanguageMismatch: true });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);
    });

    it("the recovery is ONE atomic call: copy_variant moves the whole draft to the right branch", async () => {
      // The 12:46 retry run proved the failure mode of "re-send the data
      // yourself": the agent moved only 4 of 9 fields to nb and published an
      // article WITHOUT its body. Moving a draft between branches must not
      // require re-transmitting 10 kB through the LLM.
      const created = await mcp.call("create_content", {
        type: "BlogPost",
        locale: "en",
        name: "Atomisk flytting",
        parentId: s.ids.blogId,
      });
      const id = (created.json as { documentId: string }).documentId;
      await mcp.call("set_field", { documentId: id, locale: "en", field: "title", value: "Atomisk flytting" });
      await mcp.call("set_field", { documentId: id, locale: "en", field: "body", value: NORSK_BODY });
      await mcp.call("set_field", { documentId: id, locale: "en", field: "tags", value: "Interiør, Japan" });

      const refused = await mcp.call("publish", { documentId: id, locale: "en" });
      expect(refused.isError).toBe(true);
      // The error steers to the atomic move.
      expect(refused.text).toContain("copy_variant");

      const moved = await mcp.call("copy_variant", { documentId: id, fromLocale: "en", toLocale: "nb" });
      expect(moved.isError, moved.text.slice(0, 300)).toBe(false);
      const nb = moved.json as { name: string; data: Record<string, unknown> };
      expect(nb.name).toBe("Atomisk flytting");
      expect(nb.data.body).toBe(NORSK_BODY); // byte-identical, EVERY field came along
      expect(nb.data.title).toBe("Atomisk flytting");
      expect(nb.data.tags).toBe("Interiør, Japan");

      const pub = await mcp.call("publish", { documentId: id, locale: "nb" });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);

      // …and the mistaken en draft can be dropped, leaving nb as the only branch.
      const drop = await mcp.call("discard_draft", { documentId: id, locale: "en" });
      expect(drop.isError).toBe(false);
      const en = await mcp.call("get_content", { documentId: id, locale: "en" });
      expect((en.json as { versionNumber: number }).versionNumber).toBe(0);
    });

    it("English content in the en branch is untouched by the guard", async () => {
      const created = await mcp.call("create_content", {
        type: "BlogPost",
        locale: "en",
        name: "English post stays english",
        parentId: s.ids.blogId,
      });
      const id = (created.json as { documentId: string }).documentId;
      await mcp.call("set_field", { documentId: id, locale: "en", field: "title", value: "English post stays english" });
      await mcp.call("set_field", {
        documentId: id,
        locale: "en",
        field: "body",
        value:
          "# English post\n\nThis is a perfectly ordinary English article about hardware prices and the things we have seen in the market this year. It should publish without any language guard getting in the way of the agent doing its job.",
      });
      const pub = await mcp.call("publish", { documentId: id, locale: "en" });
      expect(pub.isError, pub.text.slice(0, 300)).toBe(false);
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
