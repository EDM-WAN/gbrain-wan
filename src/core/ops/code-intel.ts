/**
 * Code-intelligence operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3): the v0.34 Cathedral III MCP wrappers (code_callers /
 * code_callees / code_def / code_refs), the W3 recursive code_blast +
 * code_flow, and the W3b code_traversal_cache_clear admin op. Op consts stay
 * module-private; `codeIntelOperations` below lists them in EXACTLY the
 * order they appear in the canonical `operations` array in ../operations.ts.
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { opError, type OperationError } from './contract.ts';
import { routeCodeIntelScope, readPolicyOpts } from './context.ts';
import { hostOnlyError } from './op-fix.ts';
import { isValidSourceId } from '../source-id.ts';
import type { WalkResult } from '../code-intel/recursive-walk.ts';
import {
  CODE_CALLERS_DESCRIPTION,
  CODE_CALLEES_DESCRIPTION,
  CODE_DEF_DESCRIPTION,
  CODE_REFS_DESCRIPTION,
} from '../operations-descriptions.ts';

// ──────────────────────────────────────────────────────────────────────────────
// v0.34 Cathedral III — code-intelligence ops (MCP-exposed).
//
// Pre-v0.34 code-callers / code-callees / code-def / code-refs lived only in
// the CLI_ONLY set at cli.ts:30 — agents calling gbrain via MCP couldn't reach
// them and fell through to text search. These wrappers expose the existing
// engine + library functions to the MCP surface with resolver-grade
// descriptions (operations-descriptions.ts) so agents route to them
// automatically during plan-mode.
//
// All four are scope:'read'. Source-scoped via ctx.sourceId when set.
// Both `source_id` and `all_sources` are params so per-call overrides work.
// ──────────────────────────────────────────────────────────────────────────────

const code_callers: Operation = {
  name: 'code_callers',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: CODE_CALLERS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callers of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources (equivalent to source_id=__all__): every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver + federated code-source re-route (see
    // routeCodeIntelScope): remote callers can't span sources outside their
    // grant, and `__all__` collapses to their grant (not the whole brain).
    const { allSources, sourceId } = await routeCodeIntelScope(ctx, sourceIdParam, p.all_sources === true, 'code_callers');
    const edges = await ctx.engine.getCallersOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
    // #4352: thread trust — the out_of_scope brain-wide rerun is local-only.
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources, remote: ctx.remote,
    });
    return {
      symbol, count: edges.length, status: readiness.status, ready: readiness.ready,
      // #3707: out_of_scope names the empty scope so a federated client can see
      // "grant problem", not "graph never built".
      ...(readiness.scoped_source_id ? { scoped_source_id: readiness.scoped_source_id } : {}),
      callers: edges,
    };
  },
  cliHints: { name: 'code_callers', hidden: true },
};

const code_callees: Operation = {
  name: 'code_callees',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: CODE_CALLEES_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callees of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources: every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver + federated re-route (see code_callers).
    const { allSources, sourceId } = await routeCodeIntelScope(ctx, sourceIdParam, p.all_sources === true, 'code_callees');
    const edges = await ctx.engine.getCalleesOf(symbol, {
      limit,
      allSources,
      sourceId,
      bareFallback: true, // #4670: honor the documented "bare or qualified" contract
    });
    const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
    // #4352: thread trust — see code_callers.
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources, remote: ctx.remote,
    });
    return {
      symbol, count: edges.length, status: readiness.status, ready: readiness.ready,
      // #3707: see code_callers.
      ...(readiness.scoped_source_id ? { scoped_source_id: readiness.scoped_source_id } : {}),
      callees: edges,
    };
  },
  cliHints: { name: 'code_callees', hidden: true },
};

const code_def: Operation = {
  name: 'code_def',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: CODE_DEF_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol name (bare token; e.g., parseMarkdown, BrainEngine).' },
    limit: { type: 'number', description: 'Max definition sites returned. Default 20.' },
    lang: { type: 'string', description: "Filter by content_chunks.language (e.g. 'typescript', 'python')." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeDef } = await import('../../commands/code-def.ts');
    const policy = await readPolicyOpts(ctx, ctx.remote === false ? {} : undefined);
    const defs = await findCodeDef(ctx.engine, p.symbol as string, {
      ...policy,
      limit: (p.limit as number) ?? 20,
      language: (p.lang as string) || undefined,
    });
    const { resolveCodeReadiness, readinessHint } = await import('../code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { ...policy, remote: ctx.remote, kind: 'symbol', count: defs.length });
    return { symbol: p.symbol as string, count: defs.length, status: readiness.status, ready: readiness.ready, hint: readinessHint(readiness), defs };
  },
  cliHints: { name: 'code_def', hidden: true },
};

// --- Local port: code call graph for the web Knowledge Graph page ---
// Upstream 0.60 has no `code_graph` op. Unlike the suspended `codeReadOperations`
// below, this one keeps the remote read path: it returns only structural
// metadata (symbol names, file paths, line numbers, edge type) and never raw
// code fragments, so it is safe for the same federated callers that serve the
// page's symbol list. It routes its scope through `routeCodeIntelScope` exactly
// like its siblings.
const code_graph: Operation = {
  name: 'code_graph',
  description: 'Build a bounded source-scoped code call graph from indexed symbols and edges. Nodes are functions/classes/types and edges are calls, imports, or references. Use source_id for one repository; unresolved symbol targets are included as unresolved nodes.',
  params: {
    limit: { type: 'number', description: 'Maximum edge rows. Default 300, max 500.' },
    source_id: { type: 'string', description: "Scope to one source. Defaults to the caller grant; '__all__' spans granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span all granted sources.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { allSources, sourceId } = await routeCodeIntelScope(
      ctx,
      typeof p.source_id === 'string' ? p.source_id : undefined,
      p.all_sources === true,
      'code_graph',
    );
    const rawLimit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.floor(p.limit) : 300;
    const limit = Math.max(1, Math.min(rawLimit, 500));
    const params: unknown[] = [];
    const sourcePredicate = allSources || !sourceId
      ? ''
      : (() => {
          params.push(sourceId);
          return `AND e.source_id = $${params.length}`;
        })();
    params.push(limit);
    const rows = await ctx.engine.executeRaw<{
      from_symbol: string; from_type: string | null; from_slug: string; from_title: string;
      from_file: string | null; from_start: number | null; from_end: number | null; from_source: string;
      to_symbol: string; to_type: string | null; to_slug: string | null; to_title: string | null;
      to_file: string | null; to_start: number | null; to_end: number | null; to_source: string | null;
      edge_type: string; resolved: boolean; resolution_kind: string | null;
    }>(
      `SELECT
         e.from_symbol_qualified AS from_symbol,
         fc.symbol_type AS from_type,
         fp.slug AS from_slug, fp.title AS from_title,
         fp.frontmatter->>'file' AS from_file,
         fc.start_line AS from_start, fc.end_line AS from_end,
         fp.source_id AS from_source,
         e.to_symbol_qualified AS to_symbol,
         tc.symbol_type AS to_type,
         tp.slug AS to_slug, tp.title AS to_title,
         tp.frontmatter->>'file' AS to_file,
         tc.start_line AS to_start, tc.end_line AS to_end,
         tp.source_id AS to_source,
         e.edge_type,
         COALESCE(e.to_chunk_id, (e.edge_metadata->>'resolved_chunk_id')::int) IS NOT NULL AS resolved,
         CASE
           WHEN e.to_chunk_id IS NOT NULL THEN 'resolved'
           WHEN e.edge_metadata->>'resolved_chunk_id' IS NOT NULL THEN 'resolved_metadata'
           WHEN e.edge_metadata->>'ambiguous' = 'true' THEN 'ambiguous'
           ELSE 'unresolved'
         END AS resolution_kind
       FROM (
         SELECT from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata
           FROM code_edges_chunk
         UNION ALL
         -- An unresolved edge may have been bound later by the edges-backfill
         -- pass through edge_metadata.resolved_chunk_id (its own to_chunk_id
         -- stays NULL, since code_edges_symbol has no such column). Carry that
         -- metadata through the LEFT JOIN below, or an edge that HAS resolved
         -- would still be reported as an unresolved node.
         SELECT from_chunk_id, NULL::int AS to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata
           FROM code_edges_symbol
       ) e
       JOIN content_chunks fc ON fc.id = e.from_chunk_id
       JOIN pages fp ON fp.id = fc.page_id AND fp.deleted_at IS NULL AND fp.page_kind = 'code'
       LEFT JOIN content_chunks tc ON tc.id = COALESCE(e.to_chunk_id, (e.edge_metadata->>'resolved_chunk_id')::int)
       LEFT JOIN pages tp ON tp.id = tc.page_id AND tp.deleted_at IS NULL AND tp.page_kind = 'code'
       WHERE 1=1 ${sourcePredicate}
       ORDER BY fp.source_id, fp.slug, fc.start_line NULLS LAST, e.to_symbol_qualified
       LIMIT $${params.length}`,
      params,
    );

    const nodes = new Map<string, Record<string, unknown>>();
    const edges: Record<string, unknown>[] = [];
    for (const row of rows) {
      const fromId = `${row.from_source}:${row.from_symbol}`;
      const targetSource = row.to_source ?? row.from_source;
      const toId = row.to_slug && row.to_type
        ? `${targetSource}:${row.to_slug}:${row.to_symbol}`
        : `${targetSource}:unresolved:${row.to_symbol}`;
      nodes.set(fromId, {
        id: fromId, slug: fromId, symbol: row.from_symbol,
        title: row.from_symbol, type: row.from_type ?? 'symbol',
        file: row.from_file, page_slug: row.from_slug,
        source_id: row.from_source, start_line: row.from_start, end_line: row.from_end, weight: 1,
      });
      nodes.set(toId, {
        id: toId, slug: toId, symbol: row.to_symbol,
        title: row.to_symbol, type: row.to_type ?? 'unresolved',
        file: row.to_file, page_slug: row.to_slug ?? undefined,
        source_id: targetSource, start_line: row.to_start, end_line: row.to_end, weight: 1,
        ...(row.resolution_kind ? { resolution_kind: row.resolution_kind } : {}),
      });
      edges.push({ source: fromId, target: toId, type: row.edge_type, weight: 1, resolved: row.resolved, resolution_kind: row.resolution_kind });
    }
    return { nodes: Array.from(nodes.values()), edges, edge_count: edges.length, node_count: nodes.size, source_id: allSources ? null : sourceId ?? null };
  },
  cliHints: { name: 'code_graph', hidden: true },
};

const code_refs: Operation = {
  name: 'code_refs',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: CODE_REFS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find references to.' },
    limit: { type: 'number', description: 'Max references returned. Default 50.' },
    lang: { type: 'string', description: "Filter by content_chunks.language." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeRefs } = await import('../../commands/code-refs.ts');
    const policy = await readPolicyOpts(ctx, ctx.remote === false ? {} : undefined);
    const refs = await findCodeRefs(ctx.engine, p.symbol as string, {
      ...policy,
      limit: (p.limit as number) ?? 50,
      language: (p.lang as string) || undefined,
    });
    const { resolveCodeReadiness, readinessHint } = await import('../code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { ...policy, remote: ctx.remote, kind: 'symbol', count: refs.length });
    return { symbol: p.symbol as string, count: refs.length, status: readiness.status, ready: readiness.ready, hint: readinessHint(readiness), refs };
  },
  cliHints: { name: 'code_refs', hidden: true },
};

// --- v0.34 W3: recursive code_blast + code_flow ---

/**
 * Stamp the same typed readiness contract code_callers/callees/def/refs carry
 * onto a recursive walk result. Without it a bare `{result:"not_found"}` (or an
 * `ok` walk with zero nodes) conflates a genuine miss with an unbuilt or
 * still-indexing graph, and agents read absence of evidence as "no blast
 * radius". Runs AFTER the traversal cache so readiness is never cached.
 * `unsupported_language` is left untouched — it says nothing about the graph.
 * `ambiguous` (2+ candidates) short-circuits to ready without a query.
 */
async function attachWalkReadiness(ctx: OperationContext, walk: WalkResult, sourceId: string | undefined) {
  if (walk.result === 'unsupported_language') return walk;
  const count = walk.result === 'ok'
    ? walk.depth_groups.reduce((total, group) => total + group.nodes.length, 0)
    : walk.result === 'ambiguous' ? walk.candidates.length : 0;
  const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
  // not_found = the seed symbol never resolved → symbol grain; anything else
  // is about edge resolution → edge grain. Trust threaded like the siblings.
  const readiness = await resolveCodeReadiness(ctx.engine, {
    kind: walk.result === 'not_found' ? 'symbol' : 'edge', count, sourceId, remote: ctx.remote,
  });
  return {
    ...walk,
    status: readiness.status,
    ready: readiness.ready,
    ...(readiness.scoped_source_id ? { scoped_source_id: readiness.scoped_source_id } : {}),
  };
}

const code_blast: Operation = {
  name: 'code_blast',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'BEFORE editing any function, run code_blast with the symbol name to surface every transitive caller grouped by depth (direct → 2-hop → 3-hop). Use this during plan-mode to size the change. Returns up to 200 nodes. Trust an empty/not_found result only when ready=true; ready=false means impact is unknown and requires a safe fallback. Returns: {result, status, ready, depth_groups?, truncation?, cycles_detected?, did_you_mean?, candidates?}. Example ok: {result:"ok", status:"ready", ready:true, depth_groups:[{depth:1, nodes:[{symbol,chunk_id}], confidence:0.77}], truncation:"none"}.',
  params: {
    symbol: { type: 'string', required: true, description: 'Bare or qualified symbol name (e.g. "performSync" or "src/foo::performSync")' },
    depth: { type: 'number', description: 'Hop cap (default 5, max 8)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation; treat symbol as exact qualified name' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('../code-intel/recursive-walk.ts');
    const symbol = p.symbol as string;
    const depth = Math.min((p.depth as number) ?? 5, 8);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver: a remote federated client can't traverse a
    // source outside its grant (pre-fix this scoped by bare ctx.sourceId only).
    // Falls back to ctx.sourceId (a required string) for the trusted-local case,
    // exactly preserving pre-fix local behavior.
    const { sourceId: scopedSourceId } = await routeCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined, false, 'code_blast');
    const sourceId = scopedSourceId ?? ctx.sourceId;
    const walk = await runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callers',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      });
    return attachWalkReadiness(ctx, walk, sourceId);
  },
  cliHints: { name: 'code_blast', hidden: true },
};

const code_flow: Operation = {
  name: 'code_flow',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'When tracing how a request flows through the codebase from entry point to side effect (DB write, HTTP call, file I/O), run code_flow from the entry point. Returns ordered execution chain with terminal-node tags. Returns: same envelope as code_blast plus terminal_nodes: [{symbol, sink_kind}] where sink_kind ∈ "db_call"|"http_call"|"file_io"|"process_exec"|"unknown".',
  params: {
    entry_point: { type: 'string', required: true, description: 'Entry-point symbol name (bare or qualified)' },
    depth: { type: 'number', description: 'Hop cap (default 8, max 12)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('../code-intel/recursive-walk.ts');
    const symbol = p.entry_point as string;
    const depth = Math.min((p.depth as number) ?? 8, 12);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver (see code_blast).
    const { sourceId: scopedSourceId } = await routeCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined, false, 'code_flow');
    const sourceId = scopedSourceId ?? ctx.sourceId;
    const walk = await runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callees',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      });
    return attachWalkReadiness(ctx, walk, sourceId);
  },
  cliHints: { name: 'code_flow', hidden: true },
};

// --- v0.34 W3b: code_traversal_cache admin op ---

const code_traversal_cache_clear: Operation = {
  name: 'code_traversal_cache_clear',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Clear cached code_blast / code_flow traversal results. Source-scoped by default; pass all_sources=true to wipe everything (destructive: it is guarded).',
  params: {
    source_id: { type: 'string', description: 'Source to clear. Required unless all_sources=true.' },
    all_sources: { type: 'boolean', description: 'Wipe cache across every source. Explicit opt-out of source-scoping.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    // INTENTIONAL exemption from resolveRequestedScope: this is a localOnly
    // admin/destructive op with its own D8 all_sources guard. The read-side
    // trust+grant resolver does not apply here (no remote caller reaches it).
    const { clearTraversalCache } = await import('../code-intel/traversal-cache.ts');
    const sourceId = (p.source_id as string | undefined) ?? ctx.sourceId;
    const allSources = (p.all_sources as boolean) ?? false;
    if (ctx.dryRun) {
      return { dry_run: true, action: 'code_traversal_cache_clear', source_id: sourceId, all_sources: allSources };
    }
    const deleted = await clearTraversalCache(ctx.engine, {
      sourceId: allSources ? undefined : sourceId,
      allSources,
    });
    return { deleted, source_id: allSources ? null : sourceId, all_sources: allSources };
  },
  cliHints: { name: 'code_traversal_cache_clear', hidden: true },
};

const SYMBOL_ARG = /^[A-Za-z_$][\w$.:/-]{0,199}$/;

/**
 * B6: remote code reads are suspended; the same read runs through the
 * trusted local `gbrain call` lane on the brain host. The symbol and source
 * are interpolated only when they match strict id shapes.
 */
const CODE_READ_FOLLOW_UP = 'garrytan/gbrain#5052';

function codeReadRefusal(ctx: OperationContext, op: Operation, params: Record<string, unknown>): OperationError {
  const message = `${op.name} is temporarily unavailable to agent callers: remote code reads stay suspended until they support the remote read policy (follow-up: ${CODE_READ_FOLLOW_UP}). `
    + 'Code search (search, query) still works here.';
  const key = 'entry_point' in op.params ? 'entry_point' : 'symbol';
  const symbol = params[key];
  if (typeof symbol !== 'string' || !SYMBOL_ARG.test(symbol)) {
    return opError('permission_denied', message,
      `Use search or query for code text now, or ask the user to run ${op.name} with the trusted local CLI on the brain host (gbrain call ${op.name} '<params_json>').`);
  }
  const source = typeof params.source_id === 'string' && isValidSourceId(params.source_id) ? ['--source', params.source_id] : [];
  return hostOnlyError(ctx, 'permission_denied', message,
    ['gbrain', 'call', ...source, op.name, JSON.stringify({ [key]: symbol })],
    `Symbol definitions, references, callers, callees, blast radius and flow run only through the trusted local CLI on the brain host until remote code reads return (${CODE_READ_FOLLOW_UP}).`);
}

const codeReadOperations: Operation[] = [
  code_callers, code_callees, code_def, code_refs,
  code_blast, code_flow,
];

// Raw code fragments and cached traversals do not yet support the complete
// remote read policy. Suspend this optional surface before touching storage.
export const codeIntelOperations: Operation[] = [
  ...codeReadOperations.map((op): Operation => ({
    ...op,
    description: `${op.description} Temporarily available only to trusted local CLI callers; agent-facing code reads are suspended.`,
    handler: async (ctx, params) => {
      if (ctx.remote !== false) throw codeReadRefusal(ctx, op, params);
      return op.handler(ctx, params);
    },
  })),
  code_traversal_cache_clear,
  // Local port: registered OUTSIDE the suspension map — the web Knowledge
  // Graph reads it through the HTTP MCP surface. It exposes structural
  // metadata only (symbol, file, line, edge type), never code text, and its
  // scope routes through routeCodeIntelScope like the suspended siblings.
  code_graph,
];
