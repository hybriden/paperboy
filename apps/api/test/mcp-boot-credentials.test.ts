import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_DB } from "./helpers.js";
import { MCP_DIR } from "./mcp-stdio-client.js";

/**
 * With no MCP_TOKEN and no MCP_EMAIL/MCP_PASSWORD, the server fell back to the
 * PUBLISHED demo login (admin@paperboy.test / Admin!Passw0rd) — public constants
 * in this repo — and booted with full admin rights. Like DATABASE_URL, a missing
 * credential must be a refusal that names the options, never a silent default.
 */
describe("MCP server boot without credentials", () => {
  it("exits non-zero and names MCP_TOKEN and MCP_EMAIL/MCP_PASSWORD (never the demo login)", async () => {
    const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: TEST_DB, MCP_TOKEN: "", MCP_HTTP_PORT: "" };
    delete env.MCP_EMAIL;
    delete env.MCP_PASSWORD;
    const tsxCli = createRequire(join(MCP_DIR, "package.json")).resolve("tsx/cli");
    const proc = spawn(process.execPath, [tsxCli, "src/server.ts"], { cwd: MCP_DIR, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const code = await Promise.race([
      new Promise<number | null>((resolve) => proc.once("exit", (c) => resolve(c))),
      new Promise<"booted">((resolve) => setTimeout(() => resolve("booted"), 30_000)),
    ]);
    if (code === "booted") proc.kill();
    expect(code, `the server must refuse to boot; stderr: ${stderr.slice(-800)}`).not.toBe("booted");
    expect(code).not.toBe(0);
    expect(stderr).toContain("MCP_TOKEN");
    expect(stderr).toContain("MCP_EMAIL");
    expect(stderr).not.toContain("authenticated (");
  }, 60_000);
});
