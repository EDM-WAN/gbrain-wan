/**
 * sources_remove — OAuth-client revoke gate (local port to the 0.60 line).
 *
 * `oauth_clients.source_id` carries an ON DELETE RESTRICT FK, so a source
 * referenced by a client cannot be deleted until those clients are dealt
 * with. The ported behaviour: refuse by default with a message naming the
 * clients; delete them only when the caller passes `revoke_oauth_clients`.
 *
 * Self-contained: drives `removeSource` directly against a stub engine, so it
 * does not depend on the 0.48 test scaffolding (withEnv / fakePath / ctxRemote).
 */
import { describe, test, expect } from 'bun:test';
import { removeSource } from '../src/core/sources-ops.ts';

interface Stub {
  engine: any;
  state: { clients: string[]; sourceDeleted: boolean; bindsDeleted: boolean };
}

function makeEngine(opts: { clients: string[]; pageCount?: number }): Stub {
  const state = { clients: [...opts.clients], sourceDeleted: false, bindsDeleted: false };
  const engine = {
    executeRaw: async (sql: string, params: unknown[] = []) => {
      if (/SELECT client_id FROM oauth_clients WHERE source_id/.test(sql)) {
        return state.clients.map((client_id) => ({ client_id }));
      }
      if (/DELETE FROM oauth_clients WHERE source_id/.test(sql)) {
        const gone = state.clients.map((client_id) => ({ client_id }));
        state.clients = [];
        return gone;
      }
      // 0.60 routes every source mutation through a managed-mode read: exactly
      // one well-formed persistence_brain row, or the op refuses. `enabled:
      // false` selects the unmanaged path these tests exercise.
      if (/persistence_brain/.test(sql)) return [{ enabled: false }];
      if (/COUNT\(\*\)/.test(sql)) return [{ count: String(opts.pageCount ?? 0) }];
      // deleteSourceRow issues one CTE that deletes the source row and its
      // persistence bindings together.
      if (/WITH gone AS \(DELETE FROM sources/.test(sql)) {
        state.sourceDeleted = true;
        state.bindsDeleted = true;
        return [{ id: params[0] }];
      }
      if (/DELETE FROM persistence_source_bindings/.test(sql)) { state.bindsDeleted = true; return []; }
      if (/DELETE FROM sources WHERE id/.test(sql)) { state.sourceDeleted = true; return [{ id: params[0] }]; }
      // fetchSourceRow: the full column projection, matched before the bare
      // `FROM sources` shape below.
      if (/SELECT id, name, local_path, last_commit/.test(sql)) {
        return [{ id: params[0], name: params[0], local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date(0) }];
      }
      if (/FROM sources WHERE id = \$1/.test(sql)) {
        return [{ id: params[0], local_path: null, archived: false, incarnation: 'inc-1' }];
      }
      return [];
    },
  };
  return { engine, state };
}

describe('sources_remove — OAuth client revoke gate', () => {
  test('refuses while a client still references the source, and deletes nothing', async () => {
    const { engine, state } = makeEngine({ clients: ['gbrain_cl_bound'] });
    await expect(
      removeSource(engine, { id: 'team-src', yes: true, confirmDestructive: true }),
    ).rejects.toThrow(/OAuth client/i);
    expect(state.sourceDeleted).toBe(false);
    expect(state.clients).toHaveLength(1);
  });

  test('revoke_oauth_clients deletes the clients, then the source', async () => {
    const { engine, state } = makeEngine({ clients: ['gbrain_cl_a', 'gbrain_cl_b'] });
    const result = await removeSource(engine, {
      id: 'team-src',
      yes: true,
      confirmDestructive: true,
      revokeOAuthClients: true,
    }) as any;
    expect(result.oauth_clients_revoked).toBe(2);
    expect(state.clients).toHaveLength(0);
    expect(state.sourceDeleted).toBe(true);
  });

  test('a source with no bound clients removes without the flag', async () => {
    const { engine, state } = makeEngine({ clients: [] });
    const result = await removeSource(engine, { id: 'plain-src', yes: true, confirmDestructive: true }) as any;
    expect(result.oauth_clients_revoked).toBe(0);
    expect(state.sourceDeleted).toBe(true);
  });
});
