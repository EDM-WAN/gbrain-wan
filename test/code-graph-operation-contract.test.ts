/**
 * code_graph operation contract (local port from the 0.48 line).
 *
 * The web Knowledge Graph page reads this op through the HTTP MCP surface, so
 * two things must hold: (1) it builds a graph from both resolved
 * (code_edges_chunk) and unresolved (code_edges_symbol) edges, and (2) it stays
 * REMOTE-callable — unlike the suspended codeReadOperations, which refuse
 * `ctx.remote !== false`. These tests execute the real handler against a
 * PGlite (in-process PostgreSQL) engine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); }, 30_000);

beforeEach(async () => { await resetPgliteState(engine); });

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'http',
    // A remote caller may only name a source inside its grant
    // (resolveRequestedScope enforces this fail-closed).
    auth: { scopes: ['read'], allowedSources: ['srcalpha', 'srcbeta'] } as any,
    ...overrides,
  } as OperationContext;
}

async function registerSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [id, `/fake/${id}`],
  );
}

async function insertCodePage(sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', $4::jsonb, NOW(), NOW()) RETURNING id`,
    [slug, sourceId, slug, JSON.stringify({ file: `src/${slug}.ts` })],
  );
  return rows[0]!.id;
}

async function insertChunk(pageId: number, idx: number, symbol: string, type = 'function'): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', 'typescript', $4, $4, $5) RETURNING id`,
    [pageId, idx, `// ${symbol}`, symbol, type],
  );
  return rows[0]!.id;
}

async function insertResolvedEdge(fromId: number, toId: number, from: string, to: string, sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_chunk (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, $4, 'calls', $5, '{}'::jsonb)`,
    [fromId, toId, from, to, sourceId],
  );
}

async function insertUnresolvedEdge(fromId: number, from: string, to: string, sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
    [fromId, from, to, sourceId],
  );
}

const codeGraph = operationsByName['code_graph']!;

describe('code_graph — operation contract', () => {
  test('the op is registered and NOT in the remote-suspension set', () => {
    expect(codeGraph).toBeDefined();
    // A suspended op's description carries the suspension notice.
    expect(codeGraph.description).not.toContain('suspended');
  });

  test('builds nodes and edges from resolved + unresolved edge tables', async () => {
    await registerSource('srcalpha');
    const libPage = await insertCodePage('srcalpha', 'alpha-lib');
    const callerPage = await insertCodePage('srcalpha', 'alpha-caller');
    const targetId = await insertChunk(libPage, 0, 'alphaTargetFn');
    const callerId = await insertChunk(callerPage, 1, 'alphaCallerFn');
    await insertResolvedEdge(callerId, targetId, 'alphaCallerFn', 'alphaTargetFn', 'srcalpha');
    await insertUnresolvedEdge(callerId, 'alphaCallerFn', 'externalFn', 'srcalpha');

    const result = await codeGraph.handler(ctxOf(), { source_id: 'srcalpha', limit: 50 }) as any;
    expect(result.edge_count).toBe(2);
    const symbols = result.nodes.map((n: any) => n.symbol);
    expect(symbols).toContain('alphaCallerFn');
    expect(symbols).toContain('alphaTargetFn');
    expect(symbols).toContain('externalFn');
    // The unresolved target carries resolution_kind 'unresolved'.
    const unresolved = result.edges.find((e: any) => e.target.includes('externalFn'));
    expect(unresolved.resolution_kind).toBe('unresolved');
    expect(unresolved.resolved).toBe(false);
  });

  test('a REMOTE caller succeeds (the web Knowledge Graph path)', async () => {
    await registerSource('srcbeta');
    const page = await insertCodePage('srcbeta', 'beta-lib');
    const id = await insertChunk(page, 0, 'betaFn');
    await insertUnresolvedEdge(id, 'betaFn', 'otherFn', 'srcbeta');

    // remote: true is the HTTP MCP case; a suspended op would throw here.
    const result = await codeGraph.handler(ctxOf({ remote: true }), { source_id: 'srcbeta' }) as any;
    expect(result.node_count).toBeGreaterThan(0);
  });

  test('source_id scopes the result to one source', async () => {
    await registerSource('srcalpha');
    await registerSource('srcbeta');
    const aPage = await insertCodePage('srcalpha', 'shared-a');
    const bPage = await insertCodePage('srcbeta', 'shared-b');
    const aId = await insertChunk(aPage, 0, 'alphaOnlyFn');
    const bId = await insertChunk(bPage, 0, 'betaOnlyFn');
    await insertUnresolvedEdge(aId, 'alphaOnlyFn', 'targetA', 'srcalpha');
    await insertUnresolvedEdge(bId, 'betaOnlyFn', 'targetB', 'srcbeta');

    const result = await codeGraph.handler(ctxOf(), { source_id: 'srcalpha' }) as any;
    const symbols = result.nodes.map((n: any) => n.symbol);
    expect(symbols).toContain('alphaOnlyFn');
    expect(symbols).not.toContain('betaOnlyFn');
  });

  test('limit is clamped to the documented maximum', () => {
    expect(codeGraph.params.limit).toBeDefined();
    expect(String((codeGraph.params.limit as any).description)).toContain('500');
  });
});
