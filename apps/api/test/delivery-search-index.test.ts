import { readFile } from "node:fs/promises";
import { createDb } from "@paperboy/db";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_DB } from "./helpers.js";

/**
 * Delivery search must stay able to use its GIN index.
 *
 * The failure mode is silent and invisible in every functional test: search keeps
 * returning correct results while scanning and re-tokenizing the whole table.
 * 0007 indexed the EXPRESSION `to_tsvector('simple', name || ' ' || data::text)`,
 * which meant the query text had to stay byte-compatible with the index
 * definition forever — and the ranking step re-tokenized every candidate row's
 * `data` JSONB anyway (295.9ms vs 17.6ms on 40k versions / 92MB).
 *
 * 0017 moves the vector into a STORED generated column, so this pins the two
 * things that would quietly undo it: the column exists and is generated (not a
 * plain column something must remember to fill), and the planner can satisfy the
 * real query shape with the GIN index.
 *
 * `enable_seqscan = off` makes the assertion independent of table size — the seed
 * dataset is far too small for the planner to prefer an index on cost alone, so
 * without it this test would pass on a sequential scan and prove nothing.
 */
describe("delivery search index is usable by the query", () => {
  const raw = createDb(TEST_DB);
  afterAll(async () => {
    await raw.sql.end();
  });

  it("stores the tsvector in a column maintained by a trigger (nothing to sync by hand)", async () => {
    const cols = (await raw.sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'content_version' AND column_name = 'fts'
    `) as unknown as { data_type: string }[];
    expect(cols[0], "content_version.fts is missing — did migrations 0017/0018 run?").toBeTruthy();
    expect(cols[0]!.data_type).toBe("tsvector");

    // 0017 used a GENERATED column; 0018 had to move to a trigger because an
    // expression cannot catch to_tsvector's 1MB overflow, which made large
    // documents permanently unsavable. Pin the trigger, not the old mechanism.
    const trg = (await raw.sql`
      SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE tgrelid = 'content_version'::regclass AND NOT tgisinternal
        AND tgname = 'content_version_fts_trg'
    `) as unknown as { tgname: string; def: string }[];
    expect(trg[0], "the fts maintenance trigger is missing").toBeTruthy();
    expect(trg[0]!.def).toMatch(/BEFORE INSERT OR UPDATE OF name, data/i);
  });

  it("the trigger degrades instead of failing when a document overflows the vector", async () => {
    // The exact input that used to 500 and brick the document: many DISTINCT
    // words (repeated text collapses to one lexeme and proves nothing).
    const rows = (await raw.sql`
      WITH words AS (SELECT string_agg('zeta' || g, ' ') AS w FROM generate_series(1, 80000) g)
      INSERT INTO content_version (document_id, locale, status, is_current_published, version_number, name, data)
      SELECT 'fts-overflow-probe', 'en', 'draft', false, 1, 'Overflow probe', jsonb_build_object('seoNotes', w)
      FROM words
      RETURNING length(data::text) AS data_bytes, length(fts::text) AS fts_bytes
    `) as unknown as { data_bytes: number; fts_bytes: number }[];

    // Stored complete; only the indexed vector is bounded.
    expect(rows[0]!.data_bytes).toBeGreaterThan(600_000);
    expect(rows[0]!.fts_bytes).toBeGreaterThan(0);
    expect(rows[0]!.fts_bytes, "vector must stay under Postgres's cap").toBeLessThan(1_048_575);

    await raw.sql`DELETE FROM content_version WHERE document_id = 'fts-overflow-probe'`;
  });

  it("indexes that column with GIN", async () => {
    const rows = (await raw.sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'content_version' AND indexname = 'content_version_fts_v2_idx'
    `) as unknown as { indexdef: string }[];
    expect(rows[0]?.indexdef ?? "").toMatch(/USING gin \(fts\)/i);
  });

  it("the predicate deliverySearch issues is index-usable", async () => {
    // Deliberately MINIMAL: just the fts predicate. The full query shape also
    // matches `is_current_published`, and on a small table the planner prefers
    // that partial index and applies `fts @@ ...` as a Filter — so asserting the
    // whole shape tested table statistics, not index usability, and flipped
    // between runs. This asks the one question that matters: can this predicate
    // be answered by the GIN index at all?
    //
    // SET is session-scoped and postgres-js pools connections, so the SET and the
    // EXPLAIN must share one — an earlier version set it on a different
    // connection and the assertion was decided by luck.
    const plan = await raw.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return (await tx`
        EXPLAIN (FORMAT JSON)
        SELECT document_id FROM content_version
        WHERE fts @@ websearch_to_tsquery('simple', 'salmon')
      `) as unknown as { "QUERY PLAN": unknown }[];
    });
    expect(JSON.stringify(plan)).toContain("content_version_fts_v2_idx");
  });

  it("deliverySearch matches on the stored column, not an inlined to_tsvector", async () => {
    // A SOURCE-level pin, and honest about it: the plan test above proves the
    // index is usable, not that the shipped query uses it. Re-inlining
    // `to_tsvector(...)` in the query would keep every functional search test
    // green while silently reverting to a full re-tokenization per candidate row
    // (295.9ms vs 17.6ms measured on 40k versions), and no assertion here
    // observes the SQL the function actually sends.
    const src = await readFile(new URL("../../../packages/db/src/delivery.ts", import.meta.url), "utf8");
    const searchFn = src.slice(src.indexOf("export async function deliverySearch"));
    // Strip comments: the function's own docstring names `to_tsvector` precisely
    // to warn against re-inlining it, which would otherwise trip the check below.
    const body = searchFn
      .slice(0, searchFn.indexOf("\n}"))
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n");
    expect(body, "the search query should match on v.fts").toContain("v.fts @@ websearch_to_tsquery");
    expect(body, "ranking should read the stored column too").toContain("ts_rank(v.fts");
    expect(body, "an inlined to_tsvector cannot use the index").not.toContain("to_tsvector(");
  });

  it("the superseded expression index is gone (it doubled the write cost of a save)", async () => {
    const rows = (await raw.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'content_version' AND indexname = 'content_version_fts_idx'
    `) as unknown as { indexname: string }[];
    expect(rows).toHaveLength(0);
  });
});
