/**
 * #4400 — source_inventory is the Memory Library's folder/file explorer for
 * large SDK sources. Two invariants it must not regress:
 *
 *  1. A single call must be scoped to exactly ONE concrete source — callers
 *     enumerate each visible source and merge client-side. `__all__` is
 *     rejected (the frontend derives per-source batches from its source list).
 *  2. The root `folder: ""` + `recursive: true` listing must enumerate the
 *     WHOLE source (no `NOT LIKE '%/%'` trap that hid imported SDK trees like
 *     `dsp/source/...`), while non-recursive child listings stay restricted to
 *     direct files below that folder.
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const source_inventory = operations.find(o => o.name === 'source_inventory')!;

function makeCtx(overrides: Partial<OperationContext> = {}): {
  ctx: OperationContext;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const ctx = {
    engine: {
      executeRaw: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('COUNT(*)::text AS count')) return [{ count: '12' }];
        if (sql.includes('FROM child_pages')) {
          return [
            { name: 'lib', path: 'source/lib', source_id: null, source_ids: ['dsp'], subtree_count: 12, source_count: 1, direct_count: 0, child_folder_count: 2 },
          ];
        }
        return [{ slug: 'source/lib/aivoice.h', source_id: 'dsp', type: 'code', title: 'source/lib/aivoice.h', updated_at: '2026-01-01', tags: [] }];
      },
    } as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
  return { ctx, calls };
}

describe('source_inventory — source identity + root recursion (#from Memory Library all-source regression)', () => {
  test('root recursive inventory enumerates the whole source (no NOT-LIKE root trap)', async () => {
    const { ctx, calls } = makeCtx();
    const result = await source_inventory.handler(ctx, {
      source_id: 'dsp', folder: '', recursive: true, include_source_id: true, limit: 48,
    }) as any;
    expect(result.source_id).toBe('dsp');
    expect(result.total).toBe(12);
    expect(Array.isArray(result.pages)).toBe(true);
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0].path).toBe('source/lib');
    expect(calls[0].sql).toContain('p.source_id = $1');
    expect(calls[0].sql).not.toContain("NOT LIKE '%/%'");
  });

  test('an explicit source_id is still scoped single-source', async () => {
    const { ctx, calls } = makeCtx();
    await source_inventory.handler(ctx, { source_id: 'dsp', folder: 'source', limit: 48 });
    expect(calls[0].sql).toContain('p.source_id = $1');
  });

  test('recursive all-source (`__all__` + empty folder) is rejected; callers enumerate one source per request', async () => {
    const { ctx } = makeCtx();
    await expect(
      source_inventory.handler(ctx, { source_id: '__all__', folder: '', recursive: true }),
    ).rejects.toThrow(/one concrete source at a time/);
  });

  test('non-recursive child listing is restricted to direct files below the folder', async () => {
    const { ctx, calls } = makeCtx();
    await source_inventory.handler(ctx, { source_id: 'dsp', folder: 'source/lib', limit: 48 });
    const sql = calls[0].sql;
    expect(sql).toContain("substring((CASE") // folder prefix + no deeper slash
    expect(sql).toContain("NOT LIKE '%/%'");
  });
});
