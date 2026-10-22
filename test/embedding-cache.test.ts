/**
 * Cross-source embedding cache.
 *
 * The cache exists because a chunk's vector depends only on the text sent to
 * the provider plus the model and dimensions — two sources holding the same
 * tree were paying twice, and a CHUNKER_VERSION bump re-embedded every source
 * even when the text was byte-identical (measured: 2727 of 2732 pages shared).
 *
 * Every case here runs against a real schema; the failure modes that matter
 * are "a hit returns a wrong vector" and "a cache problem breaks an import",
 * and neither is visible from a mock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  backfillEmbeddingCache,
  embeddingCacheKey,
  lookupEmbeddings,
  pruneEmbeddingCache,
  storeEmbedding,
  storeEmbeddings,
} from '../src/core/embedding-cache.ts';

// The test brain's pgvector column is the pinned 1536-d test shape.
const DIMS = 1536;
const KEY = { model: 'test-model', dimensions: DIMS, input: '' };

/** A DIMS-wide vector with `values` at the head and zeros after. */
function vec(...values: number[]): Float32Array {
  const out = new Float32Array(DIMS);
  for (let i = 0; i < values.length; i++) out[i] = values[i]!;
  return out;
}

describe('embedding cache', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  test('stores and reads back a vector', async () => {
    await storeEmbedding(engine, KEY, 'body alpha', vec(1, 2, 3, 4), 7);
    const { hits, misses } = await lookupEmbeddings(engine, KEY, ['body alpha']);
    expect(misses).toEqual([]);
    expect(hits).toHaveLength(1);
    expect(Array.from(hits[0]!.embedding.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(hits[0]!.token_count).toBe(7);
  });

  test('a text never stored is a miss, and the other texts still hit', async () => {
    await storeEmbedding(engine, KEY, 'body beta', vec(5, 6, 7, 8), null);
    const { hits, misses } = await lookupEmbeddings(engine, KEY, ['body beta', 'body unknown']);
    expect(hits.map((h) => h.index)).toEqual([0]);
    expect(misses).toEqual([{ index: 1, text: 'body unknown' }]);
  });

  test('the same text under another model is NOT reused', async () => {
    await storeEmbedding(engine, KEY, 'body gamma', vec(9, 9, 9, 9), null);
    const { hits, misses } = await lookupEmbeddings(
      engine,
      { ...KEY, model: 'other-model' },
      ['body gamma'],
    );
    // A different model produces a different vector for identical text; serving
    // the old one would silently poison retrieval.
    expect(hits).toEqual([]);
    expect(misses).toHaveLength(1);
  });

  test('the same text at another dimension count is NOT reused', async () => {
    const { hits, misses } = await lookupEmbeddings(engine, { ...KEY, dimensions: 768 }, ['body gamma']);
    expect(hits).toEqual([]);
    expect(misses).toHaveLength(1);
  });

  test('the cache key separates texts, models and dimensions', () => {
    const base = embeddingCacheKey(KEY, 'same text');
    expect(embeddingCacheKey(KEY, 'same text')).toBe(base);
    expect(embeddingCacheKey(KEY, 'other text')).not.toBe(base);
    expect(embeddingCacheKey({ ...KEY, model: 'm2' }, 'same text')).not.toBe(base);
    expect(embeddingCacheKey({ ...KEY, dimensions: 768 }, 'same text')).not.toBe(base);
  });

  test('a batch write hits on every row', async () => {
    await storeEmbeddings(engine, KEY, [
      { text: 'batch one', embedding: vec(1, 0, 0, 0), token_count: 1 },
      { text: 'batch two', embedding: vec(0, 1, 0, 0), token_count: 2 },
    ]);
    const { hits, misses } = await lookupEmbeddings(engine, KEY, ['batch one', 'batch two']);
    expect(misses).toEqual([]);
    expect(hits.map((h) => h.index).sort()).toEqual([0, 1]);
  });

  test('writing the same text twice keeps one row and does not fail', async () => {
    await storeEmbedding(engine, KEY, 'dup body', vec(1, 1, 1, 1), null);
    await storeEmbedding(engine, KEY, 'dup body', vec(2, 2, 2, 2), null);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM embedding_cache WHERE input_hash = $1`,
      [embeddingCacheKey(KEY, 'dup body')],
    );
    expect(rows[0]!.n).toBe(1);
  });

  test('a lookup against a missing table misses instead of throwing', async () => {
    // Simulates a brain whose schema predates the migration: the call must
    // degrade to "embed everything", never to a failed import.
    const broken = {
      executeRaw: async () => { throw new Error('relation "embedding_cache" does not exist'); },
    } as unknown as PGLiteEngine;
    const { hits, misses } = await lookupEmbeddings(broken, KEY, ['a', 'b']);
    expect(hits).toEqual([]);
    expect(misses.map((m) => m.text)).toEqual(['a', 'b']);
  });

  test('a store against a missing table does not throw', async () => {
    const broken = {
      executeRaw: async () => { throw new Error('relation "embedding_cache" does not exist'); },
    } as unknown as PGLiteEngine;
    await expect(storeEmbedding(broken, KEY, 'x', vec(1, 2, 3, 4), null)).resolves.toBeUndefined();
  });

  test('an unparseable stored literal is a miss, not a crash', async () => {
    // The row exists but its vector text is garbage — a page must not become
    // permanently broken because one cache value went bad.
    await engine.executeRaw(
      `INSERT INTO embedding_cache (input_hash, model, dimensions, embedding)
       VALUES ($1, $2, $3, NULL)`,
      [embeddingCacheKey(KEY, 'bad literal'), KEY.model, KEY.dimensions],
    );
    const { hits, misses } = await lookupEmbeddings(engine, KEY, ['bad literal']);
    expect(hits).toEqual([]);
    expect(misses).toHaveLength(1);
  });

  test('backfill copies stored chunk vectors into the cache', async () => {
    await engine.executeRaw(`
      INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth)
      VALUES ('default', 'backfill-demo', 'code', 'code', 'demo', 'int f(void) { return 1; }')`);
    const page = (await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'backfill-demo'`))[0]!;
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding, model)
       VALUES ($1, 0, $2, $3::vector, $4)`,
      [page.id, 'int f(void) { return 1; }', `[${'0.1,'.repeat(DIMS - 1)}0.1]`, KEY.model],
    );
    const result = await backfillEmbeddingCache(engine, { model: KEY.model, dimensions: DIMS });
    expect(result.inserted).toBeGreaterThan(0);
    const { hits } = await lookupEmbeddings(engine, KEY, ['int f(void) { return 1; }']);
    expect(hits.length).toBe(1);
  });

  test('prune removes only entries older than the window', async () => {
    await storeEmbedding(engine, KEY, 'old entry', vec(3, 3, 3, 3), null);
    await engine.executeRaw(
      `UPDATE embedding_cache SET last_used_at = now() - interval '400 days' WHERE input_hash = $1`,
      [embeddingCacheKey(KEY, 'old entry')],
    );
    const removed = await pruneEmbeddingCache(engine, 90);
    expect(removed).toBeGreaterThan(0);
    const { hits } = await lookupEmbeddings(engine, KEY, ['old entry']);
    expect(hits).toEqual([]);
  });
});

describe('embedding cache under --no-embed', () => {
  // The web's import path always passes noEmbed and queues an embed backfill.
  // Filling vectors from the cache during that import means the backfill finds
  // nothing stale — the whole point of caching for a second source.
  test('a primed cache fills chunk vectors without a provider call', async () => {
    const { importCodeFile } = await import('../src/core/import-file.ts');
    const { configureGateway } = await import('../src/core/ai/gateway.ts');
    const { LEGACY_EMBEDDING_CONFIG } = await import('./helpers/legacy-embedding-config.ts');

    // No network: this test asserts the cache path never reaches the provider.
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'unset-for-test' } } as never);

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('cache-a','A','/a'),('cache-b','B','/b') ON CONFLICT DO NOTHING`,
    );
    // Small inline C file: two functions, distinct bodies, enough to prove the
    // cache fills every chunk without a provider call.
    const src = [
      '#include <stdint.h>',
      '',
      'static int counter(void) { return 1; }',
      'static int helper(int x) { return x + counter(); }',
      'int run(int n) { return helper(n) * 2; }',
      '',
    ].join('\n');
    const rel = 'example/cache_demo.c';

    await importCodeFile(engine, rel, src, { sourceId: 'cache-a', noEmbed: true });
    const chunks = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.source_id = 'cache-a'`,
    );
    const key = { model: 'openai:text-embedding-3-large', dimensions: DIMS, input: '' };
    await storeEmbeddings(engine, key, chunks.map((c, i) => ({ text: c.chunk_text, embedding: vec(i + 1), token_count: c.chunk_text.length })));

    await importCodeFile(engine, rel, src, { sourceId: 'cache-b', noEmbed: true });
    const rows = await engine.executeRaw<{ n: number; e: number }>(
      `SELECT count(*)::int AS n, count(embedding)::int AS e
         FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.source_id = 'cache-b'`,
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(rows[0]!.e).toBe(rows[0]!.n);
    await engine.disconnect();
  }, 60_000);
});

describe('cache key dimensions follow the provider, not the column placeholder', () => {
  // normalizeEngineColumn returns a hardcoded 1536 for the default `embedding`
  // column ("placeholder — not used by the $1::vector cast"). A brain running
  // 2560-d vectors keyed every import lookup at 1536 and never matched a row
  // that `embed-cache backfill` wrote with getEmbeddingDimensions() = 2560.
  // Measured on the production brain: 36861 chunks re-imported, 2173 embedded,
  // zero cache hits.
  test('embeddingWriteTarget reports the column placeholder, not the provider width', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const { embeddingWriteTarget } = await import('../src/core/page-state/projections.ts');
    const target = await embeddingWriteTarget(engine);
    // Documents WHY the cache key cannot use target.column.dimensions.
    expect(target.column.name).toBe('embedding');
    expect(target.column.dimensions).toBe(1536);
    await engine.disconnect();
  }, 60_000);
});
