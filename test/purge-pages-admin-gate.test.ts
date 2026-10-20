/**
 * purge_pages authority gate (local port to the 0.60 line).
 *
 * Upstream 0.60 refuses a remote irreversible purge outright
 * (`assertPurgeParams` → permission_denied when `remote !== false`). The
 * Memory Library needs the op from a remote caller, so the port keeps it
 * callable but adds a server-side authority check: the local CLI, or a remote
 * client holding the `admin` scope. `confirm_destructive` is an intent flag a
 * caller can forge, so it is deliberately NOT the security boundary.
 *
 * These execute the real handler — the sibling `ops-permanent-page-delete`
 * test only greps the source text and would not catch a gate regression.
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const purge_pages = operations.find(o => o.name === 'purge_pages')!;

function makeCtx(overrides: Partial<OperationContext> = {}): {
  ctx: OperationContext;
  deleted: string[][];
} {
  const deleted: string[][] = [];
  const ctx = {
    engine: {
      executeRaw: async () => [{ slug: 'a' }, { slug: 'b' }],
      deletePages: async (slugs: string[]) => { deleted.push(slugs); return slugs; },
    } as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    auth: { scopes: ['read', 'write', 'admin'] },
    ...overrides,
  } as OperationContext;
  return { ctx, deleted };
}

const args = { slugs: ['a', 'b'], source_id: 'dsp', confirm_destructive: true };

describe('purge_pages — authority gate', () => {
  test('local CLI (remote=false) purges without needing an admin scope', async () => {
    const { ctx, deleted } = makeCtx({ remote: false, auth: { scopes: [] } as any });
    const result = await purge_pages.handler(ctx, args) as any;
    expect(result.status).toBe('purged');
    expect(result.count).toBe(2);
    expect(deleted).toHaveLength(1);
  });

  test('remote caller WITH the admin scope purges (gbrain-web OAuth client)', async () => {
    const { ctx, deleted } = makeCtx({ remote: true, auth: { scopes: ['read', 'write', 'admin'] } as any });
    const result = await purge_pages.handler(ctx, args) as any;
    expect(result.status).toBe('purged');
    expect(deleted).toHaveLength(1);
  });

  test('remote caller WITHOUT the admin scope is refused before any delete', async () => {
    const { ctx, deleted } = makeCtx({ remote: true, auth: { scopes: ['read', 'write'] } as any });
    await expect(purge_pages.handler(ctx, args)).rejects.toThrow(/admin-scoped client|local CLI/);
    expect(deleted).toHaveLength(0);
  });

  test('remote caller with no auth info at all is refused', async () => {
    const { ctx, deleted } = makeCtx({ remote: true, auth: undefined });
    await expect(purge_pages.handler(ctx, args)).rejects.toThrow(/permission_denied|admin-scoped/);
    expect(deleted).toHaveLength(0);
  });

  test('forged confirm_destructive alone is not enough for a remote non-admin', async () => {
    const { ctx, deleted } = makeCtx({ remote: true, auth: { scopes: ['read'] } as any });
    await expect(purge_pages.handler(ctx, args)).rejects.toThrow();
    expect(deleted).toHaveLength(0);
  });

  test('dry_run on an authorized caller reports impact without deleting', async () => {
    const { ctx, deleted } = makeCtx({ remote: true, dryRun: true });
    const result = await purge_pages.handler(ctx, { ...args, dry_run: true }) as any;
    expect(result.status).toBe('dry_run');
    expect(result.found).toBe(2);
    expect(deleted).toHaveLength(0);
  });
});
