/**
 * v0.51.x — `list_pages` folder enumeration + batched list metadata.
 *
 * Three opt-in params, ported from the Wegent-informed patch the web Memory
 * Library was written against:
 *
 *   - `slug_prefix`  — literal folder/prefix enumeration (LIKE-escaped, so a
 *                      caller-supplied `%`/`_` can never widen the match).
 *   - `include_tags` — project tags on the listing itself (one batched query)
 *                      instead of one `get_page` per row.
 *   - `include_total` — return `{ total, limit, offset, has_more, pages }`
 *                      instead of a bare array, so a paginated consumer can
 *                      fetch the remaining pages concurrently.
 *
 * Contract asserted here: all three are strictly opt-in. The default path
 * stays a bare array and issues NO count query, which is what keeps legacy
 * consumers (the CLI's tab-separated output) byte-identical.
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const list_pages = operations.find(o => o.name === 'list_pages')!;

interface FakeCtx {
  ctx: OperationContext;
  calls: any[];
  countCalls: any[];
}

function makeCtx(rows: any[] = [], total = 0, overrides: Partial<OperationContext> = {}): FakeCtx {
  const calls: any[] = [];
  const countCalls: any[] = [];
  const ctx = {
    engine: {
      listPages: async (opts: any) => {
        calls.push(opts);
        return rows;
      },
      listPagesCount: async (opts: any) => {
        countCalls.push(opts);
        return total;
      },
      executeRaw: async () => [{ ok: 1 }],
    } as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
  return { ctx, calls, countCalls };
}

const page = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  source_id: 'default',
  type: 'note',
  title: slug,
  updated_at: new Date('2026-01-01T00:00:00Z'),
  updated_at_iso: '2026-01-01T00:00:00.000000Z',
  ...extra,
});

describe('list_pages — slug_prefix', () => {
  test('threads slugPrefix into the engine filter', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { slug_prefix: 'wiki/error-' });
    expect(calls[0]).toMatchObject({ slugPrefix: 'wiki/error-' });
  });

  test('trims surrounding whitespace', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { slug_prefix: '  wiki/  ' });
    expect(calls[0].slugPrefix).toBe('wiki/');
  });

  test('an absent slug_prefix leaves the filter unset (no accidental prefix match)', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, {});
    expect(calls[0].slugPrefix).toBeUndefined();
  });

  test('a prefix over 200 chars is rejected before the engine is called', async () => {
    const { ctx, calls } = makeCtx();
    await expect(list_pages.handler(ctx, { slug_prefix: 'x'.repeat(201) })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('list_pages — include_tags', () => {
  test('off by default: no tags key in the emitted rows', async () => {
    const { ctx } = makeCtx([page('a', { tags: ['x'] })]);
    const out = await list_pages.handler(ctx, {});
    expect(out[0]).not.toHaveProperty('tags');
  });

  test('off by default: the engine is not asked to project tags', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, {});
    expect(calls[0].includeTags).toBe(false);
  });

  test('on: requests the projection and emits tags (empty array when the page has none)', async () => {
    const { ctx, calls } = makeCtx([page('a', { tags: ['x', 'y'] }), page('b')]);
    const out: any = await list_pages.handler(ctx, { include_tags: true });
    expect(calls[0].includeTags).toBe(true);
    expect(out[0].tags).toEqual(['x', 'y']);
    // A page row that carried no tags column still emits [] — the consumer
    // renders chips unconditionally, so a missing key would crash it.
    expect(out[1].tags).toEqual([]);
  });
});

describe('list_pages — include_total', () => {
  test('off by default: returns the legacy bare array and issues NO count query', async () => {
    const { ctx, countCalls } = makeCtx([page('a')], 5);
    const out = await list_pages.handler(ctx, {});
    expect(Array.isArray(out)).toBe(true);
    expect(countCalls).toHaveLength(0);
  });

  test('on: returns { total, limit, offset, has_more, pages }', async () => {
    const { ctx, countCalls } = makeCtx([page('a', { tags: [] })], 3);
    const out: any = await list_pages.handler(ctx, { include_total: true, limit: 2, offset: 0 });
    expect(out.total).toBe(3);
    expect(out.limit).toBe(2);
    expect(out.offset).toBe(0);
    expect(out.pages).toHaveLength(1);
    // offset 0 + 1 returned row < total 3 → more rows remain.
    expect(out.has_more).toBe(true);
    expect(countCalls).toHaveLength(1);
  });

  test('has_more is false when the returned window reaches the total', async () => {
    // The walk-terminates case: a caller at offset 2 that gets the last row
    // back must stop, not request offset 3 forever.
    const { ctx } = makeCtx([page('c')], 3);
    const out: any = await list_pages.handler(ctx, { include_total: true, limit: 2, offset: 2 });
    expect(out.offset).toBe(2);
    expect(out.has_more).toBe(false);
  });

  test('has_more is false once the returned rows reach the total', async () => {
    const { ctx } = makeCtx([page('a'), page('b')], 2);
    const out: any = await list_pages.handler(ctx, { include_total: true });
    expect(out.has_more).toBe(false);
  });

  test('the count is issued with the SAME predicates as the listing (no drift)', async () => {
    const { ctx, calls, countCalls } = makeCtx([], 0);
    await list_pages.handler(ctx, {
      include_total: true,
      type: 'note',
      tag: 't1',
      slug_prefix: 'wiki/',
      include_deleted: true,
      source_id: 'default',
    });
    // compare the filter surface both sides were given, minus limit/offset
    // (the listing probes limit+1; a count has no page window).
    const strip = (o: any) => {
      const { limit, offset, listColumnsOnly, includeTags, ...rest } = o;
      return rest;
    };
    expect(strip(countCalls[0])).toEqual(strip(calls[0]));
  });

  test('include_total composes with include_tags', async () => {
    const { ctx } = makeCtx([page('a', { tags: ['x'] })], 1);
    const out: any = await list_pages.handler(ctx, { include_total: true, include_tags: true });
    expect(out.pages[0].tags).toEqual(['x']);
    expect(out.total).toBe(1);
  });
});
