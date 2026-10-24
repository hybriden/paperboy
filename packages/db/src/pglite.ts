import { createServer, type Socket } from "node:net";

/**
 * PGlite mode (#124): `DATABASE_URL=pglite:///data/db` runs Postgres in-process
 * (WASM, data in that folder) behind a loopback socket, so postgres.js, drizzle
 * and the embedded MCP child connect to it unchanged.
 *
 * PGlite is ONE Postgres session. A connection therefore owns it from its first
 * message until Postgres answers ReadyForQuery IDLE: an extended-protocol cycle
 * (Parse…Sync) or a whole transaction never interleaves with another
 * connection's messages. (@electric-sql/pglite-socket 0.2.14 interleaves outside
 * transactions and stalls its queue after an error, failing 45 API tests.)
 */

const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;

export function isPgliteUrl(url: string): boolean {
  return url.startsWith("pglite:");
}

/** `pglite:///data/db` → `/data/db`; `pglite://./db` → `./db`; `pglite:memory` → in-memory. */
export function pgliteDataDir(url: string): string | undefined {
  const rest = url.slice("pglite:".length).replace(/^\/\//, "");
  return rest === "memory" || rest === "" ? undefined : rest;
}

export interface PgliteServer {
  /** A postgres:// URL for postgres.js. */
  url: string;
  stop: () => Promise<void>;
}

export async function startPglite(dataDir: string | undefined, port = 0): Promise<PgliteServer> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(dataDir);
  const gate = new Gate();
  const sockets = new Set<Socket>();
  let nextId = 1;

  const server = createServer((socket) => {
    const id = nextId++;
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let chain = Promise.resolve();

    const run = async (message: Buffer) => {
      await gate.acquire(id);
      try {
        const out = await db.runExclusive(() => db.execProtocolRaw(new Uint8Array(message)));
        if (out.length && socket.writable) socket.write(out);
        if (endsIdle(out)) gate.release(id);
      } catch {
        socket.destroy(); // a WASM-level failure; Postgres errors come back in-band
      }
    };

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (let len = frameLength(buffer); len > 0 && buffer.length >= len; len = frameLength(buffer)) {
        const message = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        if (isUntyped(message, SSL_REQUEST)) socket.write("N");
        else if (!isUntyped(message, CANCEL_REQUEST)) chain = chain.then(() => run(message));
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      chain = chain.then(async () => {
        if (gate.owner !== id) return;
        if (db.isInTransaction()) await db.exec("ROLLBACK").catch(() => {});
        gate.release(id);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: bound } = server.address() as { port: number };
  return {
    url: `postgresql://postgres@127.0.0.1:${bound}/postgres`,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

/** Whole length of the first message in `buf`, or 0 when its header hasn't arrived. */
function frameLength(buf: Buffer): number {
  // Typed messages start with a letter; startup, SSL and cancel requests have no
  // type byte and start with their (small, so high-byte-zero) length.
  if (buf.length >= 5 && buf[0] !== 0) return 1 + buf.readInt32BE(1);
  return buf.length >= 4 && buf[0] === 0 ? buf.readInt32BE(0) : 0;
}

function isUntyped(message: Buffer, code: number): boolean {
  return message.length >= 8 && message.readInt32BE(4) === code;
}

/** Does Postgres's reply end with ReadyForQuery 'I' (idle, no transaction open)? */
function endsIdle(out: Uint8Array): boolean {
  const n = out.length;
  return n >= 6 && out[n - 6] === 0x5a && out[n - 2] === 5 && out[n - 1] === 0x49;
}

/** One owner at a time; the rest wait their turn. */
class Gate {
  owner: number | null = null;
  private waiters: Array<() => void> = [];

  async acquire(id: number): Promise<void> {
    while (this.owner !== null && this.owner !== id) await new Promise<void>((r) => this.waiters.push(r));
    this.owner = id;
  }

  release(id: number): void {
    if (this.owner !== id) return;
    this.owner = null;
    this.waiters.splice(0).forEach((wake) => wake());
  }
}
