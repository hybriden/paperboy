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

  it("stores the tsvector as a GENERATED column (nothing to keep in sync by hand)", async () => {
    const rows = (await raw.sql`
      SELECT is_generated, generation_expression
      FROM information_schema.columns
      WHERE table_name = 'content_version' AND column_name = 'fts'
    `) as unknown as { is_generated: string; generation_expression: string | null }[];
    expect(rows[0], "content_version.fts is missing — did migration 0017 run?").toBeTruthy();
    expect(rows[0]!.is_generated).toBe("ALWAYS");
    expect(rows[0]!.generation_expression).toContain("simple");
  });

  it("indexes that column with GIN", async () => {
    const rows = (await raw.sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'content_version' AND indexname = 'content_version_fts_v2_idx'
    `) as unknown as { indexdef: string }[];
    expect(rows[0]?.indexdef ?? "").toMatch(/USING gin \(fts\)/i);
  });

  it("the planner uses the GIN index for the real search query shape", async () => {
    await raw.sql`SET enable_seqscan = off`;
    try {
      // The same predicate deliverySearch issues (see packages/db/src/delivery.ts).
      const plan = (await raw.sql`
        EXPLAIN (FORMAT JSON)
        SELECT DISTINCT v.document_id AS id,
               MAX(ts_rank(v.fts, websearch_to_tsquery('simple', 'salmon'))) AS rank
        FROM content_version v
        JOIN content_item i ON i.document_id = v.document_id AND i.deleted_at IS NULL AND i.site_id = 'site_default'
        WHERE v.fts @@ websearch_to_tsquery('simple', 'salmon')
          AND v.locale IN ('en')
          AND v.is_current_published
        GROUP BY v.document_id
        ORDER BY rank DESC
        LIMIT 100
      `) as unknown as { "QUERY PLAN": unknown }[];
      expect(JSON.stringify(plan)).toContain("content_version_fts_v2_idx");
    } finally {
      await raw.sql`SET enable_seqscan = on`;
    }
  });

  it("the superseded expression index is gone (it doubled the write cost of a save)", async () => {
    const rows = (await raw.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'content_version' AND indexname = 'content_version_fts_idx'
    `) as unknown as { indexname: string }[];
    expect(rows).toHaveLength(0);
  });
});
