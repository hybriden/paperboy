import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--filter", "@paperboy/mcp", "start"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: "postgresql://paperboy:paperboy@localhost:5433/paperboy",
    MCP_EMAIL: "admin@paperboy.test",
    MCP_PASSWORD: "Admin!Passw0rd",
  },
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOL COUNT:", tools.tools.length);
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const tree = await client.callTool({ name: "tree", arguments: {} });
console.log("\ntree →", tree.content[0].text.slice(0, 200));

const types = await client.callTool({ name: "list_content_types", arguments: {} });
const parsed = JSON.parse(types.content[0].text);
console.log("\ncontent types →", parsed.map((t) => t.name).join(", "));

const start = await client.callTool({ name: "delivery_start", arguments: { locale: "en" } });
console.log("\ndelivery_start →", JSON.parse(start.content[0].text).name);

await client.close();
console.log("\nSMOKE OK");
process.exit(0);
