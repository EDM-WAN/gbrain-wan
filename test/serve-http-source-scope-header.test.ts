/**
 * `X-Gbrain-Source-Scope` over the REAL HTTP transport (`serve --http`).
 *
 * The unit suite (test/request-source-scope.test.ts) pins the narrowing
 * function's contract. This suite pins that the function is actually WIRED —
 * that a request header changes what `sources_list` returns over /mcp, which is
 * the whole point of the feature and the thing a refactor would silently drop.
 *
 * Why it exists: gbrain fixes read authority per OAuth client
 * (`federated_read`), so a front end that serves many end users through ONE
 * shared client has no other way to express per-user visibility. Without this
 * header wired end to end, such a deployment leaks every source in the grant to
 * every user (gbrain-web shipped with exactly that bug).
 *
 * Safety properties asserted here, not just the happy path:
 *  - a subset request narrows;
 *  - a request naming a source OUTSIDE the grant does not gain it;
 *  - the header can never widen beyond the client's grant.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { GBRAIN_SOURCE_SCOPE_HEADER } from '../src/mcp/request-scope.ts';

type Row = Record<string, unknown>;

let engine: PGLiteEngine;
let server: Server;
let base: string;
let token: string;

const GRANTED = ['alpha-src', 'beta-src'];
const OUTSIDE = 'gamma-src';

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(line ? line.slice('data:'.length) : text) as T;
}

/** Raw MCP POST with optional header; returns the tool-result payload. */
async function sourceIds(header?: string): Promise<string[]> {
  const rpc = await json<{ result: { content: Array<{ text: string }> } }>(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(header === undefined ? {} : { [GBRAIN_SOURCE_SCOPE_HEADER]: header }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sources_list', arguments: {} },
    }),
  }));
  const payload = JSON.parse(rpc.result.content[0].text) as { sources?: Row[] };
  return (payload.sources ?? []).map(s => String(s.id)).sort();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Three real sources: two inside the client grant, one outside it.
  for (const id of [...GRANTED, OUTSIDE]) {
    await addSource(engine, { id, name: id, force: true } as never);
  }

  const app = express();
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const built = await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: base });

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: built.bootstrapToken }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  // The grant the header may narrow, but never widen: exactly GRANTED.
  const reg = await json<{ clientId: string; clientSecret: string }>(await fetch(`${base}/admin/api/register-client`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'scope-header-client', scopes: 'read write', grantTypes: ['client_credentials'],
      federatedRead: GRANTED, sourceId: GRANTED[0], hasSourceGrant: true,
    }),
  }));
  token = (await json<{ access_token: string }>(await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: reg.clientId, client_secret: reg.clientSecret, scope: 'read write',
    }),
  }))).access_token;
}, 120_000);

afterAll(async () => {
  await new Promise<void>(resolve => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
  await engine?.disconnect();
});

describe('X-Gbrain-Source-Scope over /mcp', () => {
  test('no header ⇒ the full grant (baseline unchanged)', async () => {
    expect(await sourceIds()).toEqual([...GRANTED].sort());
  });

  test('subset ⇒ narrowed to exactly that subset', async () => {
    expect(await sourceIds('beta-src')).toEqual(['beta-src']);
    expect(await sourceIds('alpha-src,beta-src')).toEqual([...GRANTED].sort());
  });

  test('naming a source OUTSIDE the grant does not gain it', async () => {
    // half in, half out: only the granted half survives
    expect(await sourceIds(`${OUTSIDE},alpha-src`)).toEqual(['alpha-src']);
    // wholly outside: fail closed to nothing, never to everything
    expect(await sourceIds(OUTSIDE)).toEqual([]);
  });

  test('the header cannot widen beyond the grant', async () => {
    expect(await sourceIds(`${OUTSIDE},alpha-src,beta-src`)).toEqual([...GRANTED].sort());
  });

  test('__all__ is a no-op (it is the unqualified baseline)', async () => {
    expect(await sourceIds('__all__')).toEqual([...GRANTED].sort());
  });

  test('malformed header falls back to the grant, never to something wider', async () => {
    expect(await sourceIds('alpha-src,NOT VALID')).toEqual([...GRANTED].sort());
  });
});
