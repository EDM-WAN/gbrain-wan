/**
 * Plan D — per-call `source_id` on the diagnostic ops (get_stats / get_health)
 * and the think retrieval params.
 *
 * The diagnostic ops needed a third scope rung: before this, a caller could
 * only see its ctx-derived grant, so `get_stats` on a multi-source brain could
 * not be pointed at ONE source. The fix must not disturb the no-param path —
 * in particular a trusted local `gbrain stats` keeps reporting the whole
 * brain, which a naive `federatedSearchScope(ctx)` substitution silently
 * narrowed to the scalar source.
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const get_stats = operations.find(o => o.name === 'get_stats')!;
const get_health = operations.find(o => o.name === 'get_health')!;
const think = operations.find(o => o.name === 'think')!;

function makeCtx(overrides: Partial<OperationContext> = {}): { ctx: OperationContext; scopes: any[] } {
  const scopes: any[] = [];
  const ctx = {
    engine: {
      getStats: async (scope: any) => { scopes.push(scope); return {}; },
      getHealth: async (scope: any) => { scopes.push(scope); return {}; },
      executeRaw: async () => [{ ok: 1 }],
    } as any,
    config: {} as any,
    logger: { warn() {}, error() {}, info() {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
  return { ctx, scopes };
}

describe('get_stats / get_health — optional source_id', () => {
  test('the param exists on both ops', () => {
    expect(get_stats.params.source_id).toBeDefined();
    expect(get_health.params.source_id).toBeDefined();
  });

  test('a trusted local no-param call still reports the WHOLE brain ({} scope)', async () => {
    // The regression this guard exists for: `federatedSearchScope` would have
    // answered { sourceId: 'default' } here, silently narrowing `gbrain stats`.
    const { ctx, scopes } = makeCtx({ remote: false, sourceId: 'default' });
    await get_stats.handler(ctx, {});
    expect(scopes[0]).toEqual({});
  });

  test('a remote no-param call keeps the ctx-derived grant', async () => {
    const { ctx, scopes } = makeCtx({
      remote: true,
      sourceId: 'default',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default', 'src-a'] } as any,
    });
    await get_stats.handler(ctx, {});
    expect(scopes[0]).toMatchObject({ sourceIds: ['default', 'src-a'] });
  });

  test('an explicit in-grant source_id scopes to that one source', async () => {
    const { ctx, scopes } = makeCtx({
      remote: true,
      sourceId: 'default',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default', 'src-a'] } as any,
    });
    await get_stats.handler(ctx, { source_id: 'src-a' });
    expect(scopes[0]).toMatchObject({ sourceId: 'src-a' });
  });

  test('an out-of-grant source_id is denied for a remote caller', async () => {
    const { ctx, scopes } = makeCtx({
      remote: true,
      sourceId: 'default',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default'] } as any,
    });
    await expect(get_stats.handler(ctx, { source_id: 'secret' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(scopes).toHaveLength(0);
  });

  test('a malformed source_id is invalid_params before the engine is called', async () => {
    const { ctx, scopes } = makeCtx({ remote: false });
    await expect(get_stats.handler(ctx, { source_id: '   ' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(scopes).toHaveLength(0);
  });

  test('get_health threads the same scope (it goes to the memoized cache key)', async () => {
    const { ctx, scopes } = makeCtx({ remote: false, sourceId: 'default' });
    await get_health.handler(ctx, {});
    expect(scopes[0]).toEqual({});
  });
});

describe('think — retrieval params', () => {
  test('the retrieval params are declared', () => {
    for (const p of ['source_id', 'slug_prefix', 'retrieval_query', 'conversation_context']) {
      expect(think.params[p]).toBeDefined();
    }
  });
});
