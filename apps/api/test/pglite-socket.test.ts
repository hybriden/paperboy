import { type PgliteServer, createDb, isPgliteUrl, pgliteDataDir, startPglite } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PGlite mode's socket (#124). @electric-sql/pglite-socket 0.2.14 failed 45 API
 * tests: it interleaved two connections' extended-protocol messages outside a
 * transaction ("unnamed prepared statement does not exist") and stopped serving
 * after a failed query. Both are pinned here.
 */
describe("PGlite socket server", () => {
  let pg: PgliteServer;
  type Sql = ReturnType<typeof createDb>["sql"];
  let a: Sql;
  let b: Sql;

  beforeAll(async () => {
    pg = await startPglite(undefined);
    a = createDb(pg.url, { max: 4 }).sql;
    b = createDb(pg.url, { max: 4 }).sql;
    await a`create table t (id int primary key, v text)`;
  });
  afterAll(async () => {
    await Promise.all([a.end(), b.end()]);
    await pg.stop();
  });

  it("parses the URL forms", () => {
    expect(isPgliteUrl("pglite:///data/db")).toBe(true);
    expect(isPgliteUrl("postgresql://x")).toBe(false);
    expect(pgliteDataDir("pglite:///data/db")).toBe("/data/db");
    expect(pgliteDataDir("pglite://./db")).toBe("./db");
    expect(pgliteDataDir("pglite:memory")).toBeUndefined();
  });

  it("many concurrent parameterized queries from several connections never interleave", async () => {
    // unsafe() sends UNNAMED statements: Parse/Bind/Execute/Sync must reach Postgres as one unit.
    const rows = await Promise.all(Array.from({ length: 200 }, (_, i) => (i % 2 ? a : b).unsafe("select $1::int as n, $2::text as s", [i, `s${i}`])));
    rows.forEach((r, i) => expect(r[0]).toEqual({ n: i, s: `s${i}` }));
  });

  it("keeps serving every connection after a query fails", async () => {
    const failing = Promise.all([a`select * from missing_table`, b`select 1/0`].map((p) => p.then(() => "ok", (e: { code?: string }) => e.code)));
    expect(await failing).toEqual(["42P01", "22012"]);
    expect(await Promise.all([a`select 1 as x`, b`select 2 as x`])).toEqual([[{ x: 1 }], [{ x: 2 }]]);
  });

  it("isolates a transaction: another connection waits for its commit", async () => {
    const order: string[] = [];
    await a.begin(async (tx) => {
      await tx`insert into t values (1, 'in tx')`;
      const other = b`select count(*)::int as n from t`.then((r) => order.push(`read ${r[0]!.n}`));
      await new Promise((r) => setTimeout(r, 100));
      order.push("commit");
      void other;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["commit", "read 1"]);
  });

  it("rolls back and frees the database when a connection dies mid-transaction", async () => {
    const dying = createDb(pg.url, { max: 1 }).sql;
    const reserved = await dying.reserve();
    await reserved`begin`;
    await reserved`insert into t values (2, 'never committed')`;
    await dying.end({ timeout: 0 });
    expect(await b`select id from t order by id`).toEqual([{ id: 1 }]);
  });
});
