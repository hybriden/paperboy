import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal newline-delimited JSON-RPC client for the stdio MCP transport.
 * Spawns the REAL apps/mcp server (tsx src/server.ts) against whatever env is
 * passed in. Shared by the parity suite and the agent-journey suite.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
export const MCP_DIR = join(REPO, "apps", "mcp");

export class McpClient {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  stderr = "";

  constructor(env: Record<string, string>) {
    const requireFromMcp = createRequire(join(MCP_DIR, "package.json"));
    const tsxCli = requireFromMcp.resolve("tsx/cli");
    this.proc = spawn(process.execPath, [tsxCli, "src/server.ts"], {
      cwd: MCP_DIR,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      let nl: number;
      // biome-ignore lint: intentional assignment in condition
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
          if (msg.id != null && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {
          /* non-JSON stdout noise — ignore */
        }
      }
    });
    this.proc.stderr!.on("data", (c: Buffer) => {
      this.stderr += c.toString();
    });
  }

  private send(method: string, params?: unknown, expectReply = true): Promise<unknown> {
    const id = expectReply ? this.nextId++ : undefined;
    const payload = JSON.stringify({ jsonrpc: "2.0", ...(id != null ? { id } : {}), method, ...(params !== undefined ? { params } : {}) });
    this.proc.stdin!.write(`${payload}\n`);
    if (id == null) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request ${method} timed out\nstderr: ${this.stderr.slice(-2000)}`));
      }, 30_000);
    });
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-suite", version: "0.0.0" },
    });
    await this.send("notifications/initialized", undefined, false);
  }

  async listToolNames(): Promise<string[]> {
    const res = (await this.send("tools/list", {})) as { tools: { name: string }[] };
    return res.tools.map((t) => t.name).sort();
  }

  /** Call a tool; returns the parsed JSON payload (or raw text) + isError. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; json: unknown; isError: boolean }> {
    const res = (await this.send("tools/call", { name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error strings are not JSON */
    }
    return { text, json, isError: Boolean(res.isError) };
  }

  /** Resolves with the exit code (for boot-failure assertions). */
  exited(): Promise<number | null> {
    return new Promise((resolve) => this.proc.once("exit", (code) => resolve(code)));
  }

  kill(): void {
    this.proc.kill();
  }
}
