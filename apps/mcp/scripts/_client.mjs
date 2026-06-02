// Minimal MCP stdio client for driving the Paperboy MCP server from scripts.
// Spawns `tsx src/server.ts` against the live (docker) database on :5433.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.resolve(here, "..");

export async function connect() {
  const transport = new StdioClientTransport({
    command: path.join(mcpDir, "node_modules/.bin/tsx"),
    args: [path.join(mcpDir, "src/server.ts")],
    cwd: mcpDir,
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://paperboy:paperboy@localhost:5433/paperboy",
      MCP_EMAIL: process.env.MCP_EMAIL ?? "admin@paperboy.test",
      MCP_PASSWORD: process.env.MCP_PASSWORD ?? "Admin!Passw0rd",
    },
  });
  const client = new Client({ name: "paperboy-mcp-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/** Call a tool; parse the JSON text result; throw on isError. */
export async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  if (res.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** Build a TipTap richtext doc from an array of blocks describing simple content.
 *  block: {h: "heading text", level} | {p: "paragraph"} | {ul: ["item", ...]} | {p:"...", links:[{text,href}]} */
export function doc(blocks) {
  const content = [];
  for (const b of blocks) {
    if (b.h) content.push({ type: "heading", attrs: { level: b.level ?? 2 }, content: [{ type: "text", text: b.h }] });
    else if (b.ul) content.push({ type: "bulletList", content: b.ul.map((li) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: li }] }] })) });
    else if (b.p != null) content.push({ type: "paragraph", content: b.p === "" ? [] : [{ type: "text", text: b.p }] });
  }
  return { type: "doc", content };
}
