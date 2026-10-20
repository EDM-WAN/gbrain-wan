/**
 * `auth register-client --global-access` (local port #4621).
 *
 * A global operator client carries NO write source and reads every active
 * source. The server recognizes it by the deliberate shape
 * `source_id IS NULL AND source_grant = 'none' AND scopes ⊇ admin`, and
 * resolves the LIVE active-source set at token-verification time — so a source
 * registered later is visible without an operator rescope. That last property
 * is the whole point: gbrain-web's source dropdown was showing only `default`
 * because a federated_read snapshot is frozen at registration.
 *
 * These tests exercise the REAL registration path against PGlite, because the
 * interesting failure is a persistence one: the grant validates in memory but
 * reads back as source_grant=NULL, which the next read rejects as
 * source_inactive.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant } from '../src/core/grants/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';
import { parseRegisterClientArgs, registerScopedClient } from '../src/commands/auth.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({
    sql: sqlQueryForEngine(engine),
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
  });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);

const sql = () => sqlQueryForEngine(engine);

async function addSource(id: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
}

describe('parseRegisterClientArgs — --global-access', () => {
  test('sets sourceId to null (no write source) and flags global access', () => {
    const parsed = parseRegisterClientArgs(['--global-access']);
    expect(parsed.globalAccess).toBe(true);
    expect(parsed.sourceId).toBeNull();
  });

  test('absent by default: a normal client keeps sourceId "default"', () => {
    const parsed = parseRegisterClientArgs([]);
    expect(parsed.globalAccess).toBeFalsy();
    expect(parsed.sourceId).toBe('default');
  });

  test('--global-access wins over an earlier --source', () => {
    // Order-independence matters: the operator may write --source first.
    const parsed = parseRegisterClientArgs(['--source', 'notes', '--global-access']);
    expect(parsed.sourceId).toBeNull();
  });
});

describe('registerScopedClient — global access grant', () => {
  test('persists source_id=NULL + source_grant=none and reads back as sourcesNone', async () => {
    const parsed = { ...parseRegisterClientArgs(['--global-access']), scopes: 'read write admin' };
    const created = await registerScopedClient(sql(), 'global-readback', parsed, {});

    // Result shape: no write source, and NOT [null] in the read set.
    expect(created.sourceId).toBeNull();
    expect(created.federatedRead).toEqual([]);

    // The persistence half this port exists to get right.
    const grant = await readClientGrant(engine, created.clientId);
    expect(grant.sourceId).toBeNull();
    expect(grant.sourcesNone).toBe(true);
    expect(grant.federatedRead).toEqual([]);
  });

  test('requires an admin scope — a global client without it is refused', async () => {
    const parsed = { ...parseRegisterClientArgs(['--global-access']), scopes: 'read write' };
    await expect(registerScopedClient(sql(), 'global-no-admin', parsed, {}))
      .rejects.toThrow(/requires an admin scope/);
  });

  test('a normal client is unaffected: source_id + read set stay populated', async () => {
    const parsed = parseRegisterClientArgs(['--source', 'default']);
    const created = await registerScopedClient(sql(), 'normal-client-still-fine', parsed, {});
    expect(created.sourceId).toBe('default');
    expect(created.federatedRead).toEqual(['default']);
    const grant = await readClientGrant(engine, created.clientId);
    expect(grant.sourcesNone).toBe(false);
    expect(grant.sourceId).toBe('default');
  });

  test('the client surface sees every ACTIVE source, and new sources appear without a rescope', async () => {
    await addSource('later-source');
    const parsed = { ...parseRegisterClientArgs(['--global-access']), scopes: 'read write admin' };
    const created = await registerScopedClient(sql(), 'global-live-sources', parsed, {});

    const tokens = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
    const auth = (await provider.verifyAccessToken(tokens.access_token)) as unknown as AuthInfo;

    // The live union must include a source that was NOT in any snapshot.
    expect(auth.allowedSources ?? []).toContain('later-source');
    // A global client has no scalar write source: sourceId carries the
    // NO_SOURCES sentinel, which makes every write path fail closed while the
    // federated read set above stays populated.
    expect(auth.sourceId).toBe(NO_SOURCES);
    expect(auth.allowedSources ?? []).not.toContain(NO_SOURCES);
  }, 30_000);
});
