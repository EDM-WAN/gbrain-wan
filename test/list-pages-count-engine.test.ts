/**
 * v0.51.x — `listPagesCount` executes the SAME predicate chain as `listPages`
 * (both are built by `buildListPagesConditions`), against a real PGlite
 * database. The op-level test proves the handler wires `include_total` to the
 * engine; this file proves the SQL actually agrees with the listing, which is
 * the failure this seam exists to prevent: a count that says 12 while the
 * listing walks 7 rows (or vice versa) makes a paginated consumer stop early
 * and silently drop pages.
 *
 * Also covers `includeTags`, whose projection is a correlated subquery on
 * `tags` and therefore cannot be verified with a mocked engine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

const body = (title: string) => ({
  type: 'concept' as const,
  title,
  compiled_truth: `${title} body`,
  timeline: '',
});

describe('listPagesCount — agrees with listPages on a real database', () => {
  beforeEach(truncateAll);

  test('counts every page when no filter is given', async () => {
    for (const slug of ['a/one', 'a/two', 'b/three']) await engine.putPage(slug, body(slug));
    expect(await engine.listPagesCount()).toBe(3);
    expect(await engine.listPages()).toHaveLength(3);
  });

  test('excludes soft-deleted pages by default, same as the listing', async () => {
    await engine.putPage('a/live', body('live'));
    await engine.putPage('a/gone', body('gone'));
    await engine.softDeletePage('a/gone');

    const listed = await engine.listPages();
    const counted = await engine.listPagesCount();
    expect(counted).toBe(listed.length);
    expect(counted).toBe(1);

    // Both must widen together under includeDeleted — a count that stayed at
    // 1 while the listing returned 2 would truncate the caller's walk.
    const listedAll = await engine.listPages({ includeDeleted: true });
    expect(await engine.listPagesCount({ includeDeleted: true })).toBe(listedAll.length);
    expect(listedAll).toHaveLength(2);
  });

  test('a tag filter counts DISTINCT pages even when a page carries several tags', async () => {
    // The tag JOIN fans out one row per matching tag; a naive COUNT would
    // report 3 here (2 tags on one page + 1 on the other) instead of 2.
    await engine.putPage('a/multi', body('multi'));
    await engine.putPage('a/single', body('single'));
    await engine.addTag('a/multi', 'shared');
    await engine.addTag('a/multi', 'extra');
    await engine.addTag('a/single', 'shared');

    const listed = await engine.listPages({ tag: 'shared' });
    expect(listed).toHaveLength(2);
    expect(await engine.listPagesCount({ tag: 'shared' })).toBe(2);
  });

  test('type and slugPrefix narrow both sides identically', async () => {
    await engine.putPage('wiki/error-404', { ...body('404'), type: 'note' });
    await engine.putPage('wiki/error-500', { ...body('500'), type: 'note' });
    await engine.putPage('wiki/guide', body('guide'));

    expect(await engine.listPagesCount({ slugPrefix: 'wiki/error-' })).toBe(2);
    expect(await engine.listPages({ slugPrefix: 'wiki/error-' })).toHaveLength(2);
    expect(await engine.listPagesCount({ type: 'note' })).toBe(2);
    expect(await engine.listPagesCount({ type: 'person' })).toBe(0);
  });

  test('slugPrefix treats LIKE metacharacters as literals', async () => {
    // A caller-supplied `%` must not widen the match: 'a%' must match the
    // literal slug 'a%x' and NOT 'abc'.
    await engine.putPage('a%x', body('literal percent'));
    await engine.putPage('abc', body('abc'));
    expect(await engine.listPagesCount({ slugPrefix: 'a%' })).toBe(1);
    expect(await engine.listPages({ slugPrefix: 'a%' })).toHaveLength(1);
  });

  test('the count ignores limit/offset (it is a total, not a window)', async () => {
    for (const slug of ['a/1', 'a/2', 'a/3', 'a/4']) await engine.putPage(slug, body(slug));
    expect(await engine.listPagesCount({ limit: 2, offset: 2 })).toBe(4);
    expect(await engine.listPages({ limit: 2, offset: 2 })).toHaveLength(2);
  });

  test('sourceId scopes the count the same way it scopes the listing', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('src-b', 'B') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('a/one', body('one'));
    await engine.putPage('a/two', body('two'), { sourceId: 'src-b' } as any);

    const listed = await engine.listPages({ sourceId: 'src-b' });
    expect(await engine.listPagesCount({ sourceId: 'src-b' })).toBe(listed.length);
    expect(listed).toHaveLength(1);
    expect(await engine.listPagesCount({ sourceId: 'default' })).toBe(1);
  });
});

describe('listPages includeTags — real projection', () => {
  beforeEach(truncateAll);

  test('projects tags when asked, and omits them when not', async () => {
    await engine.putPage('a/tagged', body('tagged'));
    await engine.addTag('a/tagged', 'alpha');
    await engine.addTag('a/tagged', 'beta');

    const withTags = await engine.listPages({ includeTags: true });
    expect(withTags[0].tags).toEqual(['alpha', 'beta']);

    const without = await engine.listPages({});
    expect(without[0].tags).toBeUndefined();
  });

  test('a page with no tags projects an empty array, not NULL', async () => {
    // COALESCE(..., ARRAY[]::text[]) in the projection — a NULL here would
    // reach the op layer's `pg.tags ?? []` the same way, but the engine
    // contract is what the SQL-text golden pins.
    await engine.putPage('a/bare', body('bare'));
    const rows = await engine.listPages({ includeTags: true });
    expect(rows[0].tags).toEqual([]);
  });

  test('includeTags composes with listColumnsOnly (the list_pages path)', async () => {
    await engine.putPage('a/tagged', body('tagged'));
    await engine.addTag('a/tagged', 'alpha');
    const rows = await engine.listPages({ includeTags: true, listColumnsOnly: true });
    expect(rows[0].tags).toEqual(['alpha']);
    // listColumnsOnly still blanks the body columns.
    expect(rows[0].compiled_truth).toBe('');
  });
});
