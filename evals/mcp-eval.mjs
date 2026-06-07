#!/usr/bin/env node
// @ts-check
/**
 * MCP outcome-invariant eval — a REAL model drives the Paperboy MCP server
 * through several realistic editorial SCENARIOS, and after each one the harness
 * asserts OUTCOME INVARIANTS on every document the model produced: the things a
 * human would otherwise have to eyeball in production.
 *
 *   reachable          — the page resolves to a URL (computePath ≠ null)
 *   real name          — not the "Untitled" placeholder
 *   published          — a published variant exists (delivery perspective)
 *   visible where meant — under a list page, the child's type === listedType
 *                          (else it publishes but never appears on the list)
 *   complete           — at least one non-empty content field (no empty body)
 *   right branch        — a published variant exists in the locale the scenario
 *                          intended (catches "Norwegian on the English blog")
 *
 * Each incident this project hit in production maps to one of these. The net
 * runs the universal checks on EVERY produced doc, so it also catches failures
 * nobody wrote a specific assertion for — that is the point of a net.
 *
 * The parity suite (apps/api/test/mcp-parity.test.ts) locks the contract; this
 * locks whether a real model, reading only tool descriptions + schemas, lands a
 * GOOD OUTCOME. The two are complementary: parity can stay green while this
 * goes red (a tool description silently stopped steering the model).
 *
 * Run from the repo root:  node evals/mcp-eval.mjs
 * Dry run (no model loop):  node evals/mcp-eval.mjs --dry-run
 * One scenario:             node evals/mcp-eval.mjs --only=projects
 *
 * Env:
 *   DATABASE_URL       (required) — the DB the MCP server (and this eval) mutate.
 *   ANTHROPIC_API_KEY  (required unless --dry-run) — drives the model loop.
 *   EVAL_MODEL         (default claude-haiku-4-5-20251001)
 *   MCP_EMAIL          (default admin@paperboy.test)
 *   MCP_PASSWORD       (default Admin!Passw0rd)
 *
 * Dependency-free beyond Node built-ins + global fetch. No SDK installs.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run");
// Mock mode: replace the paid Anthropic loop with a DETERMINISTIC scripted
// driver per scenario (real MCP tool calls, no model). The outcome-invariant
// net is identical, so this catches every SYSTEM regression for free — it is
// what runs on every push. The real-model loop stays for weekly drift checks.
const MOCK = process.argv.includes("--mock");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length) || null;
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_DIR = join(REPO, "apps", "mcp");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[eval] DATABASE_URL is required (it is the DB this eval mutates).");
  process.exit(2);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVAL_MODEL = process.env.EVAL_MODEL ?? "claude-haiku-4-5-20251001";
const MCP_EMAIL = process.env.MCP_EMAIL ?? "admin@paperboy.test";
const MCP_PASSWORD = process.env.MCP_PASSWORD ?? "Admin!Passw0rd";

if (!DRY_RUN && !MOCK && !ANTHROPIC_API_KEY) {
  console.error("[eval] ANTHROPIC_API_KEY is required for the model loop (or pass --mock / --dry-run).");
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * Minimal newline-delimited JSON-RPC client for the stdio MCP server.
 * Adapted from apps/api/test/mcp-parity.test.ts (the proven pattern).
 * ------------------------------------------------------------------ */
class McpClient {
  /** @param {Record<string,string>} env */
  constructor(env) {
    this.buf = "";
    this.nextId = 1;
    /** @type {Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>} */
    this.pending = new Map();
    this.stderr = "";

    const requireFromMcp = createRequire(join(MCP_DIR, "package.json"));
    const tsxCli = requireFromMcp.resolve("tsx/cli");
    this.proc = spawn(process.execPath, [tsxCli, "src/server.ts"], {
      cwd: MCP_DIR,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let nl;
      // eslint-disable-next-line no-cond-assign
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {
          /* non-JSON stdout noise — ignore */
        }
      }
    });
    this.proc.stderr.on("data", (c) => {
      this.stderr += c.toString();
    });
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {boolean} [expectReply]
   * @returns {Promise<any>}
   */
  send(method, params, expectReply = true) {
    const id = expectReply ? this.nextId++ : undefined;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      ...(id != null ? { id } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.proc.stdin.write(`${payload}\n`);
    if (id == null) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id))
          reject(new Error(`MCP request ${method} timed out\nstderr: ${this.stderr.slice(-2000)}`));
      }, 30_000);
    });
  }

  async initialize() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-eval", version: "0.0.0" },
    });
    await this.send("notifications/initialized", undefined, false);
  }

  /** Raw tools/list result: [{ name, description, inputSchema }]. */
  async listTools() {
    const res = await this.send("tools/list", {});
    return res.tools;
  }

  /**
   * Call a tool; returns { text, json, isError }.
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   */
  async call(name, args = {}) {
    const res = await this.send("tools/call", { name, arguments: args });
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error strings are not JSON */
    }
    return { text, json, isError: Boolean(res.isError) };
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ *
 * MCP tool (JSON Schema) -> Anthropic tool-use format. Mostly a
 * passthrough; we only normalize what the Messages API strictly needs.
 * ------------------------------------------------------------------ */
function toAnthropicTool(mcpTool) {
  const schema = mcpTool.inputSchema ?? { type: "object", properties: {} };
  const input_schema = {
    type: "object",
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) && schema.required.length ? { required: schema.required } : {}),
  };
  return { name: mcpTool.name, description: mcpTool.description ?? "", input_schema };
}

/* ------------------------------------------------------------------ *
 * Anthropic Messages API agent loop (raw fetch, no SDK).
 * ------------------------------------------------------------------ */
async function callAnthropic(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${txt.slice(0, 2000)}`);
  }
  return res.json();
}

const SYSTEM_PROMPT = [
  "You operate a headless CMS (Paperboy) via the provided tools.",
  "You are an editor: you create, edit and publish content. Read each tool's",
  "description and input schema carefully — they tell you the exact value shape",
  "each field expects. When you are unsure of a content type's fields, call",
  "get_content_type. When you are unsure where a page belongs in the site, call",
  "the tree tool. Work step by step and verify your work. When the task is fully",
  "done, stop and briefly state what you did.",
].join(" ");

/**
 * Run the model loop for one task. Returns telemetry.
 * @param {McpClient} mcp
 * @param {{name:string,description:string,input_schema:object}[]} tools
 * @param {string} task
 */
async function runAgent(mcp, tools, task) {
  /** @type {any[]} */
  const messages = [{ role: "user", content: task }];
  const toolCalls = new Map();
  /** @type {{name:string,args:unknown,text:string}[]} */
  const toolErrors = [];
  let stopReason = "max_iterations";
  const MAX_ITERS = 24;
  let i = 0;
  for (; i < MAX_ITERS; i++) {
    const resp = await callAnthropic({
      model: EVAL_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    const toolUses = (resp.content ?? []).filter((b) => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
      stopReason = resp.stop_reason ?? "end_turn";
      break;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      toolCalls.set(tu.name, (toolCalls.get(tu.name) ?? 0) + 1);
      let resultText;
      let isError = false;
      try {
        const r = await mcp.call(tu.name, tu.input ?? {});
        resultText = r.text;
        isError = r.isError;
        if (r.isError) toolErrors.push({ name: tu.name, args: tu.input, text: r.text });
      } catch (err) {
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        toolErrors.push({ name: tu.name, args: tu.input, text: resultText });
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: resultText,
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { toolCalls, toolErrors, iterations: i + (stopReason === "max_iterations" ? 0 : 1), stopReason };
}

/* ------------------------------------------------------------------ *
 * Mock driver — a deterministic scripted "agent" (real MCP tool calls, no
 * model). Records the same telemetry shape as runAgent, so the scorecard and
 * the invariant net treat mock and real runs identically. This is what gates
 * every push: free, deterministic, and it exercises the same write paths a
 * real agent does — so the outcome invariants catch the same regressions.
 * ------------------------------------------------------------------ */
function recorder(mcp) {
  const toolCalls = new Map();
  /** @type {{name:string,args:unknown,text:string}[]} */
  const toolErrors = [];
  const call = async (name, args = {}) => {
    toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
    const r = await mcp.call(name, args);
    if (r.isError) toolErrors.push({ name, args, text: r.text });
    return r;
  };
  const telemetry = () => ({
    toolCalls,
    toolErrors,
    iterations: [...toolCalls.values()].reduce((a, b) => a + b, 0),
    stopReason: "mock",
  });
  return { call, telemetry };
}

/** Find a top-level page's documentId by name (Blog, Projects are top-level). */
async function findTopLevel(mcp, name) {
  const res = await mcp.call("tree");
  const top = Array.isArray(res.json) ? res.json : [];
  const node = top.find((n) => typeof n?.name === "string" && n.name.trim().toLowerCase() === name.toLowerCase());
  return node?.documentId ?? null;
}

/* ------------------------------------------------------------------ *
 * CMS reads used by setup + invariants (via the MCP client directly).
 * ------------------------------------------------------------------ */
/** Flat set of every page documentId currently in scope. */
async function pageIdSet(mcp) {
  const res = await mcp.call("list_pages");
  const pages = Array.isArray(res.json) ? res.json : [];
  return new Set(pages.map((p) => p.documentId).filter(Boolean));
}

/** Enabled locale codes + the default code. */
async function localeInfo(mcp) {
  const res = await mcp.call("list_locales");
  const list = Array.isArray(res.json) ? res.json : [];
  const enabled = list.filter((l) => l.enabled !== false).map((l) => l.code);
  const def = (list.find((l) => l.isDefault) ?? list[0])?.code ?? "en";
  return { enabled: enabled.length ? enabled : ["en"], def };
}

/**
 * Inspect a document across locales: type, parentId, and per-locale
 * {status,name,urlPath,data}. Uses management get_content (returns the working
 * version with urlPath + type), one call per locale.
 * @returns {Promise<{type:string|null,parentId:string|null,variants:Record<string,any>}>}
 */
async function inspectDoc(mcp, documentId, localeCodes) {
  let type = null;
  let parentId = null;
  /** @type {Record<string, any>} */
  const variants = {};
  for (const code of localeCodes) {
    const r = await mcp.call("get_content", { documentId, locale: code });
    const d = r.json;
    if (!d || typeof d !== "object") continue;
    if (typeof d.type === "string") type = d.type;
    if (d.parentId !== undefined) parentId = d.parentId;
    if ((d.versionNumber ?? 0) > 0) variants[code] = d;
  }
  return { type, parentId, variants };
}

/** find-or-create a list page (by name) that lists `listedType`. Setup only. */
async function findOrCreateListPage(mcp, name, listedType, locale) {
  const pages = await mcp.call("list_pages");
  const existing = (Array.isArray(pages.json) ? pages.json : []).find(
    (p) => typeof p?.name === "string" && p.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing) return existing.documentId;
  const created = await mcp.call("create_content", { type: "ListPage", locale, name });
  if (created.isError) throw new Error(`setup: could not create '${name}' list page: ${created.text}`);
  const id = created.json.documentId;
  await mcp.call("set_field", { documentId: id, locale, field: "heading", value: name });
  await mcp.call("update_content", { documentId: id, locale, data: { listedType }, merge: true });
  await mcp.call("publish", { documentId: id, locale });
  return id;
}

/* ------------------------------------------------------------------ *
 * Universal outcome invariants — run on EVERY produced document.
 * `parents` caches inspected list-page parents (documentId -> info).
 * ------------------------------------------------------------------ */
async function universalInvariants(mcp, info, parents) {
  /** @type {{label:string,pass:boolean,detail:string}[]} */
  const checks = [];
  const add = (label, pass, detail = "") => checks.push({ label, pass, detail });

  const present = Object.values(info.variants);
  const publishedVariants = present.filter((v) => v.status === "published");
  const anyVariant = publishedVariants[0] ?? present[0];

  // real name — not the "Untitled" placeholder, not empty.
  const name = anyVariant?.name ?? "";
  add("real name (not 'Untitled')", !!name && !/^Untitled\b/i.test(name), name || "(empty)");

  // published — a published variant exists.
  add(
    "published",
    publishedVariants.length > 0,
    publishedVariants.length ? `locales: ${publishedVariants.map((v) => v.locale).join(",")}` : "no published variant",
  );

  // reachable — the published page resolves to a URL.
  const urlPath = publishedVariants.map((v) => v.urlPath).find((u) => typeof u === "string" && u.length > 0);
  add("reachable (urlPath ≠ null)", Boolean(urlPath), urlPath || "no urlPath on any published variant");

  // complete — at least one non-empty content field.
  const data = anyVariant?.data ?? {};
  const hasContent = Object.values(data).some((v) =>
    typeof v === "string" ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : v != null && typeof v === "object",
  );
  add("complete (has content)", hasContent, hasContent ? `${Object.keys(data).length} fields` : "all fields empty");

  // visible where intended — under a list page, type must equal listedType.
  if (info.parentId) {
    if (!parents.has(info.parentId)) {
      const p = await inspectDoc(mcp, info.parentId, [anyVariant?.locale ?? "en"]);
      const pv = Object.values(p.variants)[0];
      parents.set(info.parentId, { listedType: pv?.data?.listedType ?? null });
    }
    const parent = parents.get(info.parentId);
    if (parent?.listedType) {
      add(
        "visible on parent list (type === listedType)",
        info.type === parent.listedType,
        info.type === parent.listedType ? `${info.type}` : `is ${info.type}, list shows ${parent.listedType}`,
      );
    }
  }
  return checks;
}

/* ------------------------------------------------------------------ *
 * Scenarios — each maps to a real workflow this project has run.
 * `expect` adds scenario-specific assertions on top of the universal net.
 * ------------------------------------------------------------------ */
function scenarios(stamp) {
  return [
    {
      id: "blog-post",
      title: `Eval blog ${stamp}`,
      setup: async () => ({}),
      task: (title) =>
        [
          `Create a new blog post under the Blog list page titled "${title}".`,
          'Find the Blog page with the tree tool (it is named "Blog"), then create the',
          "post as its child. Write a short markdown body (a couple of paragraphs with at",
          "least one heading) about running AI models locally, set a one-sentence summary,",
          "and publish it.",
        ].join(" "),
      // Deterministic transcript: the well-behaved path a correct agent takes.
      script: async (mcp, _loc, title) => {
        const rec = recorder(mcp);
        const blog = await findTopLevel(mcp, "Blog");
        const c = await rec.call("create_content", { type: "BlogPost", parentId: blog, locale: "en", name: title });
        const id = c.json?.documentId;
        if (id) {
          await rec.call("set_field", { documentId: id, locale: "en", field: "title", value: title });
          await rec.call("set_field", { documentId: id, locale: "en", field: "body", value: "# Local AI\n\nRunning models locally is increasingly practical. This post covers the trade-offs of on-device inference." });
          await rec.call("set_field", { documentId: id, locale: "en", field: "summary", value: "A short note on running AI models locally." });
          await rec.call("publish", { documentId: id, locale: "en" });
        }
        return rec.telemetry();
      },
      expect: { parentName: "Blog", locale: "en", minDocs: 1 },
    },
    {
      id: "projects",
      title: `Eval project ${stamp}`,
      // The 2026-06-07 incident: "an article per repo under Projects". Projects
      // lists ArticlePage; the agent must NOT leave BlogPosts that never appear.
      setup: async (mcp, loc) => ({ projectsId: await findOrCreateListPage(mcp, "Projects", "ArticlePage", loc.def) }),
      task: (title) =>
        [
          `Create an article under the Projects list page titled "${title}", describing a`,
          "small open-source project. Find the Projects page with the tree tool, create the",
          "article as its child with a markdown body and a one-sentence summary, and publish it.",
        ].join(" "),
      // OMIT the type → it must inherit the parent's listedType (ArticlePage).
      // If that inheritance regresses, create errors → no doc → scenario fails.
      // If the mismatch guard regresses, an explicit BlogPost would slip through
      // → the "visible where meant" invariant fails. Either way: caught.
      script: async (mcp, _loc, title) => {
        const rec = recorder(mcp);
        const projects = await findTopLevel(mcp, "Projects");
        const c = await rec.call("create_content", { parentId: projects, locale: "en", name: title });
        const id = c.json?.documentId;
        if (id) {
          await rec.call("set_field", { documentId: id, locale: "en", field: "heading", value: title });
          await rec.call("set_field", { documentId: id, locale: "en", field: "intro", value: "A small open-source project." });
          await rec.call("publish", { documentId: id, locale: "en" });
        }
        return rec.telemetry();
      },
      expect: { parentName: "Projects", locale: "en", minDocs: 1 },
    },
    {
      id: "norwegian",
      title: `Eval norsk ${stamp}`,
      // The 2026-06-07 incident: Norwegian content must land on the nb branch,
      // not the English (default) one.
      setup: async () => ({}),
      task: (title) =>
        [
          `Lag en artikkel under Blog-listesiden med tittelen "${title}".`,
          "Skriv HELE innholdet på NORSK (bokmål): en markdown-body på et par avsnitt med",
          "minst én overskrift, om japansk interiørdesign, og en sammendrags-setning.",
          "Finn Blog-siden med tree-verktøyet, opprett artikkelen under den, og publiser den.",
        ].join(" "),
      // Norwegian content created and published on the nb branch — the right
      // branch. (Note: the seeded Blog lists BlogPost, so the title here is the
      // listed type; we create a BlogPost in nb.)
      script: async (mcp, _loc, title) => {
        const rec = recorder(mcp);
        const blog = await findTopLevel(mcp, "Blog");
        const c = await rec.call("create_content", { type: "BlogPost", parentId: blog, locale: "nb", name: title });
        const id = c.json?.documentId;
        if (id) {
          await rec.call("set_field", { documentId: id, locale: "nb", field: "title", value: title });
          await rec.call("set_field", { documentId: id, locale: "nb", field: "body", value: "# Japansk interiør\n\nJapansk interiørdesign bygger på enkelhet, naturmaterialer og harmoni. Wabi-sabi feirer det ufullkomne og det forgjengelige." });
          await rec.call("set_field", { documentId: id, locale: "nb", field: "summary", value: "En kort introduksjon til japansk interiørdesign og wabi-sabi." });
          await rec.call("publish", { documentId: id, locale: "nb" });
        }
        return rec.telemetry();
      },
      expect: { parentName: "Blog", locale: "nb", minDocs: 1 },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Run one scenario: snapshot → setup → agent → discover → invariants.
 * ------------------------------------------------------------------ */
async function runScenario(mcp, tools, scenario, loc) {
  await scenario.setup(mcp, loc);
  // setup may have created the parent list page — snapshot AFTER setup so it
  // is excluded from "produced by the model".
  const afterSetup = await pageIdSet(mcp);

  const telemetry = MOCK
    ? await scenario.script(mcp, loc, scenario.title)
    : await runAgent(mcp, tools, scenario.task(scenario.title));

  const after = await pageIdSet(mcp);
  const produced = [...after].filter((id) => !afterSetup.has(id));

  /** @type {{documentId:string,checks:any[]}[]} */
  const docResults = [];
  const parents = new Map();
  for (const id of produced) {
    const info = await inspectDoc(mcp, id, loc.enabled);
    const checks = await universalInvariants(mcp, info, parents);

    // Scenario-specific assertions.
    if (scenario.expect?.parentName) {
      const p = info.parentId ? await inspectDoc(mcp, info.parentId, [loc.def]) : { variants: {} };
      const pName = Object.values(p.variants)[0]?.name ?? "";
      checks.push({
        label: `under '${scenario.expect.parentName}'`,
        pass: pName.trim().toLowerCase() === scenario.expect.parentName.toLowerCase(),
        detail: pName || "(no parent)",
      });
    }
    if (scenario.expect?.locale) {
      const v = info.variants[scenario.expect.locale];
      checks.push({
        label: `published on the '${scenario.expect.locale}' branch`,
        pass: Boolean(v && v.status === "published"),
        detail: v ? v.status : "no variant in that locale",
      });
    }
    docResults.push({ documentId: id, checks });
  }

  const producedEnough = produced.length >= (scenario.expect?.minDocs ?? 1);
  return { scenario, telemetry, docResults, produced, producedEnough };
}

/* ------------------------------------------------------------------ *
 * Scorecard
 * ------------------------------------------------------------------ */
function printScenario(result, dryRun) {
  const { scenario, telemetry, docResults, produced, producedEnough } = result;
  const line = "─".repeat(70);
  console.log(`\n${line}`);
  console.log(`  SCENARIO: ${scenario.id}`);
  console.log(line);

  if (!dryRun) {
    console.log(`  driver: stop_reason=${telemetry.stopReason}, tool calls=${telemetry.iterations}`);
    console.log(`  produced ${produced.length} document(s)${producedEnough ? "" : "  ✗ EXPECTED ≥ " + (scenario.expect?.minDocs ?? 1)}`);
    if (telemetry.toolErrors.length) {
      console.log("  tool errors hit (the steering signal):");
      for (const e of telemetry.toolErrors) {
        console.log(`    [${e.name}] ${JSON.stringify(e.args)?.slice(0, 200)}`);
        console.log(`        ${e.text.replace(/\n/g, "\n        ").slice(0, 600)}`);
      }
    }
  }

  let pass = producedEnough;
  for (const d of docResults) {
    console.log(`\n  doc ${d.documentId}:`);
    for (const c of d.checks) {
      if (!c.pass) pass = false;
      console.log(`    ${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
    }
  }
  if (docResults.length === 0) console.log("  (no documents produced to check)");
  console.log(`\n  → scenario ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  const stamp = new Date().toISOString().slice(0, 19);
  const mcp = new McpClient({ DATABASE_URL, MCP_EMAIL, MCP_PASSWORD, MCP_HTTP_PORT: "", MCP_TOKEN: "" });

  try {
    await mcp.initialize();
    const tools = (await mcp.listTools()).map(toAnthropicTool);
    const loc = await localeInfo(mcp);
    let all = scenarios(stamp);
    if (ONLY) all = all.filter((s) => s.id === ONLY);
    if (!all.length) {
      console.error(`[eval] no scenario matches --only=${ONLY}`);
      mcp.kill();
      process.exit(2);
    }

    if (DRY_RUN) {
      console.log(`[eval] DRY RUN — ${tools.length} tools, locales=${loc.enabled.join(",")} (default ${loc.def}).`);
      console.log(`[eval] scenarios: ${all.map((s) => s.id).join(", ")}`);
      // Prove setup + plumbing without the model.
      for (const s of all) {
        const ctx = (await s.setup(mcp, loc)) ?? {};
        console.log(`  setup[${s.id}] -> ${JSON.stringify(ctx)}`);
      }
      mcp.kill();
      process.exit(0);
    }

    console.log(
      MOCK
        ? `[eval] MOCK mode (deterministic scripted driver — no model)  locales=${loc.enabled.join(",")} (default ${loc.def})`
        : `[eval] model=${EVAL_MODEL}  locales=${loc.enabled.join(",")} (default ${loc.def})`,
    );
    const results = [];
    for (const s of all) {
      console.log(`\n[eval] running scenario: ${s.id}`);
      results.push(await runScenario(mcp, tools, s, loc));
    }

    let allPass = true;
    for (const r of results) if (!printScenario(r, false)) allPass = false;

    const line = "═".repeat(70);
    console.log(`\n${line}`);
    console.log(`  OVERALL: ${allPass ? "PASS" : "FAIL"} — ${results.length} scenario(s)`);
    console.log(line + "\n");
    mcp.kill();
    process.exit(allPass ? 0 : 1);
  } catch (err) {
    console.error("\n[eval] FATAL:", err instanceof Error ? err.stack : String(err));
    if (mcp.stderr) console.error("[eval] MCP stderr tail:\n" + mcp.stderr.slice(-2000));
    mcp.kill();
    process.exit(2);
  }
}

main();
