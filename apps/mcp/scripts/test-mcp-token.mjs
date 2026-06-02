// Verifies the MCP-token feature end to end: create (as admin) → verify →
// authenticate the MCP with MCP_TOKEN → call a tool → revoke → verify dead.
import { createDb, verifyLogin, getAccessContext, createMcpToken, verifyMcpToken, listMcpTokens, revokeMcpToken } from "@paperboy/db";
import { connect, call } from "./_client.mjs";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://paperboy:paperboy@localhost:5433/paperboy";
const ADMIN_PW = process.env.MCP_PASSWORD; // never hardcode a real password
if (!ADMIN_PW) { console.error("Set MCP_PASSWORD to the admin password."); process.exit(1); }

const { db } = createDb(DATABASE_URL);
const adminId = await verifyLogin(db, "admin@paperboy.test", ADMIN_PW);
const ctx = await getAccessContext(db, adminId);
console.log("admin permissions:", ctx.permissions.length);

const { token } = await createMcpToken(db, ctx, { name: "Test token", userId: adminId });
console.log("created token:", token.slice(0, 16) + "…");
console.log("verify token -> userId matches admin:", (await verifyMcpToken(db, token)) === adminId);
const list = await listMcpTokens(db, ctx);
console.log("token appears in list (acts-as email):", list.find((t) => t.name === "Test token")?.email);

// Authenticate the MCP with the token (no password) and call a tool.
process.env.MCP_TOKEN = token;
delete process.env.MCP_PASSWORD; // prove the token alone works
const { client, transport } = await connect();
try {
  const tree = await call(client, "tree", {});
  console.log("MCP authed via TOKEN; tree returned", Array.isArray(tree) ? tree.length : "?", "top-level items");
} finally {
  await transport.close();
}

// Revoke → token must stop working.
const created = list.find((t) => t.name === "Test token");
await revokeMcpToken(db, ctx, created.id);
console.log("after revoke, verify token -> null:", (await verifyMcpToken(db, token)) === null);
process.exit(0);
