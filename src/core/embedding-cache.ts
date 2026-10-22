/**
 * Cross-source embedding cache.
 *
 * A chunk's vector is a pure function of what the provider is shown: the
 * embedding input text, the model, and the dimensions. Nothing about which
 * source, page, chunk index or chunker version produced that text changes the
 * answer. `content_chunks` stores one vector per (source, page, chunk), so the
 * same body is embedded again for every source that indexes it and again for
 * every CHUNKER_VERSION bump — even when the text is byte-identical.
 *
 * Measured on the real dsp trees: two sources held 2727 identical pages out of
 * ~2730, and one chunker bump re-embedded all of them. That is the cost this
 * table removes.
 *
 * Key design: `input_hash` digests (embedding input, model, dimensions) using
 * the same `embeddingInputHash` the per-page reuse gate already trusts. A hit
 * therefore cannot return a vector built from different text — the hash is of
 * the exact provider input, not of the chunk body or its header.
 *
 * Failure policy: every operation here is best-effort. A missing table, a
 * shape mismatch after a model swap, or a database error must degrade to "no
 * cache" and let the caller embed normally. Embedding is on the critical path
 * of an import; a cache must never be the reason one fails.
 */
import type { BrainEngine } from './engine.ts';
import { digest, sha256 } from './persistence/digest.ts';

/** The subset of a chunk row this module needs. */
export interface CacheableChunk {
  chunk_text: string;
  chunk_source?: string | null;
}

/** Provenance that must match for a cached vector to be valid. */
export interface EmbeddingCacheKey {
  model: string;
  dimensions: number;
  /** Embedding input actually sent to the provider (already wrapped). */
  input: string;
}

/** The per-chunk key: provenance plus the exact text. */
export function embeddingCacheKey(key: EmbeddingCacheKey, text: string): string {
  return digest(['embedding-cache-v1', key.model, key.dimensions, sha256(text)]);
}

/**
 * Hash of the provider input for a chunk under a given wrapping convention.
 *
 * `input` is what the caller is about to send; this module never rebuilds the
 * wrapper itself (the two call sites wrap differently, and a mismatch here
 * would silently poison every later read).
 */
export function inputsFor(chunks: readonly string[], wrap?: (text: string, index: number) => string): string[] {
  return wrap ? chunks.map((c, i) => wrap(c, i)) : [...chunks];
}

export interface CacheHit {
  index: number;
  embedding: Float32Array;
  token_count: number | null;
}

export interface CacheMiss {
  index: number;
  text: string;
}

export interface CacheLookupResult {
  hits: CacheHit[];
  misses: CacheMiss[];
}

/** Vector literal Postgres accepts for pgvector. */
function toVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

/** Parse a pgvector literal into a Float32Array; null on any surprise. */
function parseVector(raw: unknown): Float32Array | null {
  if (raw == null) return null;
  if (raw instanceof Float32Array) return raw;
  const text = typeof raw === 'string' ? raw : String(raw);
  const body = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (!body.trim()) return null;
  const parts = body.split(',');
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

/**
 * Split `texts` into cached hits and texts that still need a provider call.
 *
 * Empty input short-circuits before touching the database. Any error (missing
 * table on a brain that predates the migration, a dimension mismatch after a
 * model change) returns everything as a miss — the caller then embeds exactly
 * as it would have without this module.
 */
export async function lookupEmbeddings(
  engine: BrainEngine,
  key: EmbeddingCacheKey,
  texts: readonly string[],
): Promise<CacheLookupResult> {
  const indexed = texts.map((text, index) => ({ index, text, hash: embeddingCacheKey(key, text) }));
  if (indexed.length === 0) return { hits: [], misses: [] };
  const hashes = indexed.map((e) => e.hash);

  let rows: Array<{ input_hash: string; embedding: unknown; token_count: number | null }> = [];
  try {
    rows = await engine.executeRaw<{ input_hash: string; embedding: unknown; token_count: number | null }>(
      `SELECT input_hash, embedding, token_count
         FROM embedding_cache
        WHERE input_hash = ANY($1::text[])
          AND model = $2
          AND dimensions = $3
          AND embedding IS NOT NULL`,
      [hashes, key.model, key.dimensions],
    );
  } catch {
    return { hits: [], misses: indexed.map(({ index, text }) => ({ index, text })) };
  }

  const found = new Map(rows.map((row) => [row.input_hash, row]));
  const hits: CacheHit[] = [];
  const misses: CacheMiss[] = [];
  const hitHashes: string[] = [];
  for (const entry of indexed) {
    const embedding = parseVector(found.get(entry.hash)?.embedding);
    // A stored literal that will not parse is a miss, not an error: the row is
    // one bad value away from a permanently broken page.
    if (!embedding) {
      misses.push({ index: entry.index, text: entry.text });
      continue;
    }
    hits.push({ index: entry.index, embedding, token_count: found.get(entry.hash)?.token_count ?? null });
    hitHashes.push(entry.hash);
  }

  if (hitHashes.length > 0) {
    // Best-effort usage stamp; the caller already has its vectors.
    try {
      await engine.executeRaw(
        `UPDATE embedding_cache SET last_used_at = now(), hit_count = hit_count + 1
          WHERE input_hash = ANY($1::text[])`,
        [hitHashes],
      );
    } catch { /* usage accounting only */ }
  }
  return { hits, misses };
}

/** Cache an embedding. Best-effort; a failure never fails the caller. */
export async function storeEmbedding(
  engine: BrainEngine,
  key: EmbeddingCacheKey,
  text: string,
  embedding: Float32Array,
  tokenCount: number | null,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO embedding_cache (input_hash, model, dimensions, embedding, token_count)
       VALUES ($1, $2, $3, $4::vector, $5)
       ON CONFLICT (input_hash) DO UPDATE
         SET last_used_at = now()`,
      [embeddingCacheKey(key, text), key.model, key.dimensions, toVectorLiteral(embedding), tokenCount],
    );
  } catch { /* cache writes never fail an import */ }
}

/** Cache a batch of embeddings. Best-effort, one statement. */
export async function storeEmbeddings(
  engine: BrainEngine,
  key: EmbeddingCacheKey,
  entries: Array<{ text: string; embedding: Float32Array; token_count: number | null }>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    // VALUES rows rather than a multi-array unnest: PGLite's parser handles
    // the former and not the latter, and the cache must work on both engines.
    const params: unknown[] = [];
    const shaped = entries.map((e) => {
      params.push(embeddingCacheKey(key, e.text), key.model, key.dimensions,
        toVectorLiteral(e.embedding), e.token_count);
      const b = params.length - 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::vector, $${b + 5})`;
    });
    await engine.executeRaw(
      `INSERT INTO embedding_cache (input_hash, model, dimensions, embedding, token_count)
       VALUES ${shaped.join(', ')}
       ON CONFLICT (input_hash) DO UPDATE SET last_used_at = now()`,
      params,
    );
  } catch { /* cache writes never fail an import */ }
}

/** Backfill every stored vector that is not in the cache yet.
 *
 * Run once after the table lands so existing sources start benefiting
 * immediately instead of only after their next full re-embed. Batched so a
 * large brain cannot hold the whole table in memory.
 */
export async function backfillEmbeddingCache(
  engine: BrainEngine,
  opts: { batchSize?: number; model: string; dimensions: number } = { model: '', dimensions: 0 },
): Promise<{ scanned: number; inserted: number }> {
  const batchSize = Math.max(100, Math.min(opts.batchSize ?? 2000, 20_000));
  let scanned = 0;
  let inserted = 0;
  let lastId = 0;
  for (;;) {
    let rows: Array<{ id: number; chunk_text: string; embedding: unknown; token_count: number | null }>;
    try {
      rows = await engine.executeRaw(
        `SELECT id, chunk_text, embedding, token_count
           FROM content_chunks
          WHERE id > $1 AND embedding IS NOT NULL
            AND (model = $2 OR $2 = '')
          ORDER BY id
          LIMIT ${batchSize}`,
        [lastId, opts.model],
      );
    } catch {
      return { scanned, inserted };
    }
    if (rows.length === 0) break;
    scanned += rows.length;
    lastId = rows[rows.length - 1]!.id;
    const entries: Array<{ text: string; embedding: Float32Array; token_count: number | null }> = [];
    for (const row of rows) {
      const vector = parseVector(row.embedding);
      if (vector) entries.push({ text: row.chunk_text, embedding: vector, token_count: row.token_count });
    }
    if (entries.length > 0) {
      await storeEmbeddings(engine, { model: opts.model, dimensions: opts.dimensions, input: '' }, entries);
      inserted += entries.length;
    }
  }
  return { scanned, inserted };
}

/** Drop cache rows idle past `retentionDays`. Returns how many were removed. */
export async function pruneEmbeddingCache(engine: BrainEngine, retentionDays = 90): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ input_hash: string }>(
      `DELETE FROM embedding_cache
        WHERE last_used_at < now() - ($1 || ' days')::interval
        RETURNING input_hash`,
      [String(Math.max(1, Math.floor(retentionDays)))],
    );
    return rows.length;
  } catch {
    return 0;
  }
}
