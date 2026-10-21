import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyBaseLogger } from "fastify";

/** apps/mcp — beside this app in the monorepo and in the image. */
const MCP_DIR = fileURLToPath(new URL("../../mcp/", import.meta.url));

export interface EmbeddedMcp {
  /** The running child, if any (between a crash and its restart there is none). */
  current(): ChildProcess | undefined;
  stop(): void;
}

/**
 * Run the MCP server (apps/mcp, Streamable HTTP) as a child of this process, so
 * a one-container host (App Service, Cloud Run, …) serves {PUBLIC_URL}/mcp with
 * no second service: MCP_EMBEDDED=true points MCP_UPSTREAM_URL here (loadEnv)
 * and the /mcp forward does the rest.
 *
 * A child, not an import: the MCP entry reads its env and exits on
 * misconfiguration at module load, and its stdio mode owns stdout. It inherits
 * this process's env — the same DATABASE_URL, the secrets that decrypt stored
 * AI/stock keys, UPLOADS_DIR — and is restarted if it dies.
 */
export function startEmbeddedMcp(opts: {
  port: number;
  /** OAuth issuer the MCP server advertises; clients sign in against the API. */
  publicUrl: string;
  log: FastifyBaseLogger;
  env?: NodeJS.ProcessEnv;
  restartDelayMs?: number;
}): EmbeddedMcp {
  const tsxLoader = pathToFileURL(createRequire(`${MCP_DIR}package.json`).resolve("tsx")).href;
  const restartDelayMs = opts.restartDelayMs ?? 5_000;
  let child: ChildProcess | undefined;
  let stopped = false;
  let restartTimer: NodeJS.Timeout | undefined;

  const start = (): void => {
    // tsx as a loader, not the tsx CLI: the CLI runs the server as a grandchild,
    // which a SIGKILLed (crashed) CLI orphans, still holding the port.
    const proc = spawn(process.execPath, ["--import", tsxLoader, "src/server.ts"], {
      cwd: MCP_DIR,
      env: { ...(opts.env ?? process.env), MCP_HTTP_PORT: String(opts.port), PUBLIC_URL: opts.publicUrl },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child = proc;
    proc.on("error", (err) => opts.log.error({ err }, "embedded MCP server failed to start"));
    proc.on("exit", (code, signal) => {
      child = undefined;
      if (stopped) return;
      opts.log.error({ code, signal }, `embedded MCP server exited — restarting in ${restartDelayMs} ms`);
      restartTimer = setTimeout(start, restartDelayMs);
    });
  };
  start();

  return {
    current: () => child,
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      child?.kill("SIGTERM");
    },
  };
}
