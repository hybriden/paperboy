import { createDb, createContent, getAccessContext, listContentTypes } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, login, setupApi } from "./helpers.js";

/**
 * `createContent` must not need a SECOND pooled connection while its transaction
 * holds the first.
 *
 * It called `autoSlug(db, …)` from inside `db.transaction(...)`. `db` is the pool
 * handle, so that asked for another connection — and with `postgres(url, { max: 10 })`
 * (packages/db/src/client.ts), ten concurrent creates each held one connection and
 * waited for an eleventh that could never arrive. postgres.js QUEUES rather than
 * erroring, so nothing timed out and nothing recovered: the entire API — delivery,
 * login, /health — hung until the process was restarted. Ten simultaneous editors, a
 * bulk import, or one agent doing `Promise.all` over ten pages was enough.
 *
 * This test drives MORE concurrent creates than the pool has connections, and then
 * proves an UNRELATED read still completes — which is the part that made the original
 * bug a full outage rather than a slow write.
 */
const POOL_MAX = 10; // must match createDb's postgres({ max })
const CONCURRENT = POOL_MAX + 4;

describe("concurrent createContent does not exhaust the connection pool", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
    await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it(`survives ${CONCURRENT} concurrent creates and still serves unrelated reads`, async () => {
    const users = (await raw.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test'`) as unknown as {
      id: string;
    }[];
    const ctx = await getAccessContext(raw.db, users[0]!.id);

    // All pages, so every one of them takes the autoSlug path.
    const creates = Array.from({ length: CONCURRENT }, (_, i) =>
      createContent(raw.db, ctx, {
        type: "ArticlePage",
        parentId: null,
        locale: "en",
        name: `Pool Exhaustion ${i}`,
      }),
    );

    // An unrelated read issued while the creates are in flight. Before the fix this
    // never resolved, because every pooled connection was parked inside a
    // transaction waiting for one more.
    const unrelatedRead = new Promise<number>((resolve, reject) => {
      setTimeout(() => {
        listContentTypes(raw.db).then((t) => resolve(t.length)).catch(reject);
      }, 300);
    });

    // A hard deadline: the original bug hung forever, so "slow" and "deadlocked" must
    // be distinguishable. 25s is far above the ~150ms this takes when healthy.
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("createContent deadlocked the pool (no progress in 25s)")), 25_000),
    );

    const created = (await Promise.race([Promise.all(creates), deadline])) as Awaited<
      ReturnType<typeof createContent>
    >[];
    expect(created).toHaveLength(CONCURRENT);

    const typeCount = await Promise.race([unrelatedRead, deadline]);
    expect(typeCount, "an unrelated read must still complete during concurrent creates").toBeGreaterThan(0);
  }, 40_000);

  it("every concurrent create still got a UNIQUE sibling slug", async () => {
    // The advisory lock that serialises slug allocation is what made autoSlug need a
    // connection in the first place — so prove the fix didn't trade a deadlock for a
    // duplicate-slug race.
    const rows = (await raw.sql`
      SELECT v.slug
      FROM content_version v
      JOIN content_item i ON i.document_id = v.document_id
      WHERE i.parent_id IS NULL AND v.locale = 'en' AND v.slug LIKE 'pool-exhaustion%'
    `) as unknown as { slug: string }[];
    const slugs = rows.map((r) => r.slug);
    expect(slugs.length).toBeGreaterThanOrEqual(CONCURRENT);
    expect(new Set(slugs).size, `duplicate slugs: ${slugs.join(", ")}`).toBe(slugs.length);
  });
});
