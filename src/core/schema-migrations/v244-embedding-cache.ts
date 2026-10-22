import type { Migration } from './types.ts';

/*
 * Cross-source embedding cache.
 *
 * A chunk's vector is a pure function of (model, dimensions, embedding input
 * text) — nothing about which source, page or chunker version produced it.
 * `content_chunks` stores one copy per (source, page, chunk), so the same file
 * imported under two sources is embedded twice, and a CHUNKER_VERSION bump
 * re-embeds every source even when the text is byte-identical.
 *
 * This migration is the ONLY place an ALREADY-INITIALISED brain gets the
 * table. src/schema.sql also carries the DDL, but that file is replayed by
 * initSchema() on fresh installs — a brain already at v243 never re-runs it,
 * so without this migration `lookupEmbeddings`'s SELECT throws, is caught, and
 * silently degrades to "0 hits, everything misses" (fail-open by design, which
 * makes the degradation invisible in the logs).
 *
 * Dimensions are read from config here, NOT left as vector(1536):
 * getPostgresSchema() rewrites every `vector(1536)` in SCHEMA_SQL to the
 * configured size, but a migration's SQL does not pass through that rewrite.
 * On a 2560-dim brain a hard-coded 1536 column would reject every insert.
 */
export const v244: Migration = {
  version: 244,
  name: 'embedding_cache',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    const dimRows = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
    );
    const configured = Number.parseInt(dimRows[0]?.value ?? '', 10);
    const embeddingDim =
      Number.isInteger(configured) && configured > 0 && configured <= 16000 ? configured : 1536;

    await engine.executeRaw(
      `CREATE TABLE IF NOT EXISTS embedding_cache (
         input_hash   TEXT        PRIMARY KEY,
         model        TEXT        NOT NULL,
         dimensions   INTEGER     NOT NULL,
         embedding    vector(${embeddingDim}),
         token_count  INTEGER,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         hit_count    INTEGER     NOT NULL DEFAULT 0
       )`,
    );
    await engine.executeRaw(
      `CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used ON embedding_cache(last_used_at)`,
    );
  },
};
