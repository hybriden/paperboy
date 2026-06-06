#!/usr/bin/env node
// @ts-check
/**
 * MCP usability eval — a REAL model drives the Paperboy MCP server end-to-end.
 *
 * The parity suite (apps/api/test/mcp-parity.test.ts) locks the *contract*:
 * given exact arguments, the tools behave identically to the REST API. This
 * eval locks the *usability*: can a real model, reading only the tool
 * descriptions and schemas, accomplish a realistic editorial task? When a tool
 * description silently stops steering the model, the parity suite stays green
 * but this eval goes red — and the scorecard prints the tool errors the model
 * hit verbatim, so you can see exactly which description stopped working.
 *
 * Run from the repo root:  node evals/mcp-eval.mjs
 * Dry run (no model loop):  node evals/mcp-eval.mjs --dry-run
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

if (!DRY_RUN && !ANTHROPIC_API_KEY) {
  console.error("[eval] ANTHROPIC_API_KEY is required for the model loop (or pass --dry-run).");
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
 * MCP tool (JSON Schema) -> Anthropic tool-use format.
 *
 * The MCP SDK already converts each tool's Zod shape to JSON Schema and
 * returns it as `inputSchema`, which is exactly the shape Anthropic's
 * `tools[].input_schema` wants (type: "object", properties, required). So
 * conversion is mostly a passthrough; we only defensively normalize:
 *   - ensure top-level type is "object" (Anthropic requires it),
 *   - ensure `properties` exists (a no-arg tool's schema may omit it; the
 *     API rejects an object schema without properties),
 *   - strip the JSON Schema `$schema` / `additionalProperties` noise the SDK
 *     may emit, which the API tolerates but doesn't need.
 * ------------------------------------------------------------------ */
function toAnthropicTool(mcpTool) {
  const schema = mcpTool.inputSchema ?? { type: "object", properties: {} };
  const input_schema = {
    type: "object",
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) && schema.required.length ? { required: schema.required } : {}),
  };
  return {
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    input_schema,
  };
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
 * Run the model loop. Returns telemetry: { toolCalls: Map<name,count>,
 * toolErrors: [{name,args,text}], iterations, stopReason }.
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
  const MAX_ITERS = 15;
  let i = 0;
  for (; i < MAX_ITERS; i++) {
    const resp = await callAnthropic({
      model: EVAL_MODEL,
      max_tokens: 2048,
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
 * Programmatic outcome verification — never trust the model's word.
 * Uses the MCP client directly (delivery tools need no key over MCP).
 * ------------------------------------------------------------------ */
/**
 * @param {McpClient} mcp
 * @param {string|null} blogId
 * @param {string} title
 */
async function verifyOutcomes(mcp, blogId, title) {
  /** @type {{label:string,pass:boolean,detail:string}[]} */
  const checks = [];
  const add = (label, pass, detail = "") => checks.push({ label, pass, detail });

  if (!blogId) {
    add("Blog parent page found via tree", false, "no top-level page named 'Blog'");
    add("post exists under Blog parent", false, "skipped: no Blog parent");
    add("post is PUBLISHED (delivery, preview=false)", false, "skipped: no Blog parent");
    add("post has a non-empty markdown body", false, "skipped");
    add("post has a non-empty summary", false, "skipped");
    return checks;
  }
  add("Blog parent page found via tree", true, blogId);

  // Children of the Blog page (page tree) — proves parent placement without
  // relying on delivery output (DeliveryContent omits parentId).
  const children = await mcp.call("tree", { parentId: blogId });
  const childList = Array.isArray(children.json) ? children.json : [];
  const match = childList.find(
    (c) => typeof c?.name === "string" && c.name.trim() === title.trim(),
  );
  add(
    "post exists under Blog parent",
    Boolean(match),
    match ? `documentId=${match.documentId}` : `no child named "${title}" among ${childList.length} children`,
  );

  if (!match) {
    add("post is PUBLISHED (delivery, preview=false)", false, "skipped: post not found under Blog");
    add("post has a non-empty markdown body", false, "skipped");
    add("post has a non-empty summary", false, "skipped");
    return checks;
  }

  // Published perspective: delivery_get_by_id with preview=false returns the
  // item ONLY if a published variant exists — so a non-null result IS the
  // published assertion.
  const delivered = await mcp.call("delivery_get_by_id", { documentId: match.documentId, preview: false });
  const doc = delivered.json;
  const isPublished = Boolean(doc && doc.documentId);
  add(
    "post is PUBLISHED (delivery, preview=false)",
    isPublished,
    isPublished ? "delivered on the published perspective" : "not returned on published perspective (still draft?)",
  );

  const data = (doc && doc.data) || {};
  const body = typeof data.body === "string" ? data.body : "";
  const summary = typeof data.summary === "string" ? data.summary : "";
  add("post has a non-empty markdown body", body.trim().length > 0, body ? `${body.length} chars` : "empty/missing 'body'");
  add("post has a non-empty summary", summary.trim().length > 0, summary ? `${summary.length} chars` : "empty/missing 'summary'");
  return checks;
}

/* ------------------------------------------------------------------ *
 * Scorecard
 * ------------------------------------------------------------------ */
function printScorecard({ checks, toolCalls, toolErrors, iterations, stopReason, dryRun }) {
  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log("  MCP EVAL SCORECARD" + (dryRun ? "  (DRY RUN — model loop skipped)" : ""));
  console.log(line);

  console.log("\n  Assertions:");
  for (const c of checks) {
    console.log(`    ${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
  }

  if (!dryRun) {
    console.log(`\n  Model loop: stop_reason=${stopReason}, iterations=${iterations}`);
    console.log("\n  Tool calls made:");
    if (toolCalls.size === 0) console.log("    (none)");
    for (const [name, count] of [...toolCalls.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(3)}x  ${name}`);
    }

    console.log("\n  Tool errors the model hit (THE SIGNAL — which description stopped working):");
    if (toolErrors.length === 0) {
      console.log("    (none — every tool call the model made succeeded)");
    } else {
      for (const e of toolErrors) {
        const args = JSON.stringify(e.args)?.slice(0, 300) ?? "";
        console.log(`    [${e.name}]  args=${args}`);
        console.log(`        ${e.text.replace(/\n/g, "\n        ")}`);
      }
    }
  }

  const allPass = checks.every((c) => c.pass);
  console.log(`\n  RESULT: ${allPass ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length} assertions)`);
  console.log(`${line}\n`);
  return allPass;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  const timestamp = new Date().toISOString();
  const title = `Eval: ${timestamp}`;
  const task = [
    `Create a new blog post under the Blog list page titled "${title}".`,
    "Use the tree tool to find the Blog page first (it is the page named \"Blog\"),",
    "then create the post as its child. Write a short markdown body (a couple of",
    "paragraphs, with at least one markdown heading) about running AI models locally.",
    "Set the post's summary to a one-sentence description. Finally, publish the post.",
  ].join(" ");

  const mcp = new McpClient({
    DATABASE_URL,
    MCP_EMAIL,
    MCP_PASSWORD,
    MCP_HTTP_PORT: "",
    MCP_TOKEN: "",
  });

  let blogId = null;
  let agentTelemetry = { toolCalls: new Map(), toolErrors: [], iterations: 0, stopReason: "n/a" };

  try {
    await mcp.initialize();
    const mcpTools = await mcp.listTools();
    const tools = mcpTools.map(toAnthropicTool);

    // Resolve the Blog page documentId dynamically — never hardcode seed ids.
    const treeRes = await mcp.call("tree");
    const topLevel = Array.isArray(treeRes.json) ? treeRes.json : [];
    const blog = topLevel.find((n) => typeof n?.name === "string" && n.name.trim().toLowerCase() === "blog");
    blogId = blog?.documentId ?? null;

    if (DRY_RUN) {
      console.log(`[eval] DRY RUN — spawned MCP, ${tools.length} tools listed.`);
      console.log(`[eval] Resolved Blog page documentId via tree: ${blogId ?? "(not found)"}`);
      console.log("\n[eval] Converted Anthropic tool schemas:");
      console.log(JSON.stringify(tools, null, 2));
      // Run the assertions against a title that does not exist so they fail
      // cleanly (proves the verification path works without a model).
      const checks = await verifyOutcomes(mcp, blogId, `__nonexistent_${timestamp}__`);
      const allPass = printScorecard({ checks, ...agentTelemetry, dryRun: true });
      mcp.kill();
      process.exit(allPass ? 0 : 1);
    }

    console.log(`[eval] model=${EVAL_MODEL}`);
    console.log(`[eval] Blog page documentId: ${blogId ?? "(not found — the model must still try)"}`);
    console.log(`[eval] Task: ${task}\n`);

    agentTelemetry = await runAgent(mcp, tools, task);

    const checks = await verifyOutcomes(mcp, blogId, title);
    const allPass = printScorecard({ checks, ...agentTelemetry, dryRun: false });
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
