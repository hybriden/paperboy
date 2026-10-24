import { type Logger, sql as sqlTag } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Query helpers take a Queryable so a caller inside a transaction passes `tx` and
 *  never borrows a second pool connection (a full pool then deadlocks the API). */
export type Queryable = Database | Transaction;

export function createDb(connectionString: string, opts: { max?: number; logger?: Logger } = {}) {
  const sql = postgres(connectionString, { max: opts.max ?? 10 });
  const db = drizzle(preparedByDefault(sql), { schema, logger: opts.logger });
  return { db, sql };
}

/**
 * Drizzle runs every query with `prepare: false`, and postgres.js then sends a
 * query with parameters as Parse/Describe, WAITS for the parameter types, and
 * only then Bind/Execute: two network round trips for every query (connection.js
 * `describeFirst`). A prepared statement is described once per connection and
 * then costs one. On a managed database that halves the wait of every query.
 * Only queries WITH parameters are prepared: a parameterless one may hold
 * several statements (migrations), which a prepared statement cannot. The
 * statement cache lives per connection, and postgres.js recycles connections
 * (max_lifetime), so it does not grow without bound.
 */
function preparedByDefault<T extends postgres.Sql | postgres.TransactionSql>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "unsafe") {
        return (query: string, params?: unknown[], options?: { prepare?: boolean }) =>
          target.unsafe(query, params as never, { ...options, prepare: (params?.length ?? 0) > 0 || options?.prepare === true });
      }
      if (prop === "begin" || prop === "savepoint") {
        return (...args: unknown[]) => {
          const fn = args.pop() as (tx: postgres.TransactionSql) => unknown;
          const method = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]!;
          return method.call(target, ...args, (tx: postgres.TransactionSql) => fn(preparedByDefault(tx)));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Lazily-created singleton for app code (tests create their own). */
let singleton: { db: Database; sql: postgres.Sql } | null = null;

export function getDb(): Database {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    singleton = createDb(url);
  }
  return singleton.db;
}

export function getSql(): postgres.Sql {
  getDb();
  return singleton!.sql;
}

/** Lightweight liveness probe for health checks. */
export async function ping(db: Database): Promise<void> {
  await db.execute(sqlTag`SELECT 1`);
}

export { schema };
