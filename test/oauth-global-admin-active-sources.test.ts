/**
 * Global-admin OAuth clients read every ACTIVE source (#4621, local port).
 *
 * The bug: `--global-access` stores a federated_read SNAPSHOT. A source added
 * later is absent from that snapshot, so `sources_list` (which row-filters by
 * the caller's grant) never lists it and gbrain-web's source dropdown shows
 * only the sources that existed when the client was registered — exactly how
 * it ended up showing `default` alone after several sources were added.
 *
 * The port resolves the active source set at token-verification time for a
 * client whose `source_id IS NULL` and whose scopes include `admin`. The
 * `active_read_sources` snapshot filter must NOT then strip those sources back
 * out, which is why the admin branch skips it and reads the sources table.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { pgliteOAuthTransaction } from './helpers/oauth.ts';
import { pgArray } from '../src/core/grants/encoding.ts';
import { hashToken } from '../src/core/utils.ts';

let db: PGlite;
let provider: GBrainOAuthProvider;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  provider = new GBrainOAuthProvider({ transaction: pgliteOAuthTransaction(db), sql, tokenTtl: 3600, refreshTtl: 3600 });

  for (const id of ['default', 'wam', 'nuwa']) {
    await sql`INSERT INTO sources (id, name, config) VALUES (${id}, ${id}, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`;
  }
  await sql`INSERT INTO sources (id, name, config, archived) VALUES ('gone-src', 'gone', '{}'::jsonb, true) ON CONFLICT (id) DO NOTHING`;
}, 30_000);

afterAll(async () => { if (db) await db.close(); }, 15_000);

/** Insert a client row directly — registerClientManual cannot express source_id NULL. */
async function insertClient(id: string, scope: string, sourceId: string | null, federated: string[]): Promise<string> {
  const secret = `secret-${id}`;
  await sql`INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, scope, source_id, federated_read, grant_types, token_endpoint_auth_method)
            VALUES (${id}, ${id}, ${hashToken(secret)}, ${scope}, ${sourceId}, ${pgArray(federated)}, ${pgArray(['client_credentials'])}, 'client_secret_post')`;
  return secret;
}

/** Mint a client_credentials token, then verify it and return the resolved grant. */
async function grantsFor(clientId: string, secret: string): Promise<{ allowedSources?: string[]; sourceId?: string }> {
  const res = await provider.exchangeClientCredentials(clientId, secret, undefined as any);
  const info = await provider.verifyAccessToken((res as any).access_token);
  return (info as any).extra ?? (info as any);
}

describe('global-admin OAuth client reads every active source', () => {
  test('a source added AFTER registration becomes readable', async () => {
    // Snapshot taken when only 'default' existed — 'wam'/'nuwa' came later.
    const snapSecret = await insertClient('cl_admin_snap', 'read write admin', null, ['default']);
    const extra = await grantsFor('cl_admin_snap', snapSecret);
    const sources = extra.allowedSources ?? [];
    expect(sources).toContain('default');
    expect(sources).toContain('wam');
    expect(sources).toContain('nuwa');
  });

  test('an ARCHIVED source never becomes readable through the union', async () => {
    const archSecret = await insertClient('cl_admin_arch', 'read write admin', null, ['default']);
    const extra = await grantsFor('cl_admin_arch', archSecret);
    expect(extra.allowedSources ?? []).not.toContain('gone-src');
  });

  test('a source-bound admin client is NOT widened to the whole brain', async () => {
    const scopedSecret = await insertClient('cl_scoped', 'read write admin', 'default', ['default']);
    const extra = await grantsFor('cl_scoped', scopedSecret);
    const sources = extra.allowedSources ?? [];
    expect(sources).toContain('default');
    expect(sources).not.toContain('nuwa');
  });

  test('a non-admin global client is not widened', async () => {
    const readerSecret = await insertClient('cl_reader', 'read', null, ['default']);
    const extra = await grantsFor('cl_reader', readerSecret);
    expect(extra.allowedSources ?? []).not.toContain('nuwa');
  });
});
