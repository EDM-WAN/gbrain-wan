/**
 * `gbrain embed-cache` — manage the cross-source embedding cache.
 *
 *   gbrain embed-cache backfill [--batch <n>] [--dry-run]
 *   gbrain embed-cache prune [--days <n>] [--dry-run]
 *   gbrain embed-cache stats
 *
 * `backfill` is the one-shot step after the table lands: it copies every
 * vector already stored in content_chunks into the cache, so sources indexed
 * before this feature start benefiting without a full re-embed.
 *
 * `prune` drops entries nothing has read for a while. Growth is bounded by
 * distinct chunk bodies, not by page count — re-indexing the same tree does
 * not add rows — so a long default is safe.
 */
import type { BrainEngine } from '../core/engine.ts';
import { backfillEmbeddingCache, pruneEmbeddingCache } from '../core/embedding-cache.ts';
import { getEmbeddingDimensions } from '../core/embedding.ts';
import { getEmbeddingModel } from '../core/ai/gateway.ts';

const HELP = `gbrain embed-cache — cross-source embedding cache

Usage:
  gbrain embed-cache backfill [--batch <n>] [--dry-run] [--json]
  gbrain embed-cache prune [--days <n>] [--dry-run] [--json]
  gbrain embed-cache stats [--json]

Why: a chunk's vector depends only on the text sent to the provider, the
model and the dimensions — not on which source, page or chunker version
produced it. Two sources holding the same tree therefore share every vector,
and a CHUNKER_VERSION bump re-embeds only text that actually changed.

backfill  Copy vectors already in content_chunks into the cache.
prune     Delete entries unused for --days (default 90).
stats     Row count, size and hit totals.
`;

export async function runEmbedCache(engine: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (!engine) {
    console.error('gbrain embed-cache: no brain configured (set GBRAIN_HOME or run gbrain init)');
    process.exitCode = 1;
    return;
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const numFlag = (name: string): number | undefined => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return Number(eq.slice(name.length + 1));
    const i = args.indexOf(name);
    if (i >= 0) return Number(args[i + 1]);
    return undefined;
  };

  switch (sub) {
    case 'backfill': {
      const batch = numFlag('--batch');
      if (dryRun) {
        const table = await engine.executeRaw<{ chunks: number; cached: number }>(
          `SELECT (SELECT count(*)::int FROM content_chunks WHERE embedding IS NOT NULL) AS chunks,
                  (SELECT count(*)::int FROM embedding_cache) AS cached`,
        );
        const row = table[0] ?? { chunks: 0, cached: 0 };
        // Name the target brain and the CHECKSUM total alongside the count.
        // A bare "would scan 0" is indistinguishable from "wrong database" or
        // "counting succeeded but nothing is embedded"; on a 499k-chunk brain
        // that ambiguity costs a round trip to psql to rule out.
        const where = await engine.executeRaw<{ db: string; user: string; schema: string | null; total: number }>(
          `SELECT current_database() AS db, current_user AS "user",
                  current_schema() AS schema,
                  (SELECT count(*)::int FROM content_chunks) AS total`,
        ).catch(() => [] as Array<{ db: string; user: string; schema: string | null; total: number }>);
        const w = where[0];
        const target = w ? `${w.db}@${w.user}/${w.schema ?? '-'}` : 'unknown';
        const total = w?.total ?? 0;
        const report = { dryRun: true, database: target, total_chunks: total, ...row, would_scan: row.chunks };
        if (json) console.log(JSON.stringify(report));
        else console.log(
          `database=${target} total_chunks=${total} embedded=${row.chunks} ` +
          `(${total > 0 ? Math.round((row.chunks / total) * 100) : 0}%); cache currently holds ${row.cached} row(s)`,
        );
        return;
      }
      const model = resolveModel();
      const dimensions = resolveDimensions();
      if (!model || !dimensions) {
        console.error('gbrain embed-cache backfill: embedding model/dimensions unavailable — configure the embedding provider first');
        process.exitCode = 1;
        return;
      }
      const result = await backfillEmbeddingCache(engine, { ...(batch ? { batchSize: batch } : {}), model, dimensions });
      if (json) console.log(JSON.stringify(result));
      else console.log(`scanned ${result.scanned} chunk(s), cached ${result.inserted}`);
      return;
    }
    case 'prune': {
      const days = numFlag('--days') ?? 90;
      if (dryRun) {
        const rows = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM embedding_cache
            WHERE last_used_at < now() - ($1 || ' days')::interval`,
          [String(days)],
        );
        const n = rows[0]?.n ?? 0;
        if (json) console.log(JSON.stringify({ dryRun: true, days, would_delete: n }));
        else console.log(`would delete ${n} cache row(s) unused for ${days} day(s)`);
        return;
      }
      const removed = await pruneEmbeddingCache(engine, days);
      if (json) console.log(JSON.stringify({ days, removed }));
      else console.log(`pruned ${removed} cache row(s) unused for ${days} day(s)`);
      return;
    }
    case 'stats': {
      const rows = await engine.executeRaw<{ rows: number; hits: number; bytes: number }>(
        `SELECT count(*)::int AS rows,
                COALESCE(sum(hit_count), 0)::int AS hits,
                COALESCE(pg_total_relation_size('embedding_cache'), 0)::bigint AS bytes
           FROM embedding_cache`,
      );
      const row = rows[0] ?? { rows: 0, hits: 0, bytes: 0 };
      const report = { rows: row.rows, total_hits: row.hits, size_bytes: Number(row.bytes) };
      if (json) console.log(JSON.stringify(report));
      else console.log(`rows=${report.rows} total_hits=${report.total_hits} size=${Math.round(report.size_bytes / 1024 / 1024)}MB`);
      return;
    }
    default:
      console.error(`gbrain embed-cache: unknown subcommand "${sub}"`);
      process.stderr.write(HELP);
      process.exitCode = 2;
  }
}

/** The FULL model id (`provider:model`), matching what content_chunks.model
 *  stores. getEmbeddingModelName() strips the provider prefix, which made a
 *  backfill scan match zero rows against a brain labelled `openai:<model>`. */
function resolveModel(): string | null {
  try { return getEmbeddingModel(); } catch { return null; }
}

function resolveDimensions(): number | null {
  try {
    const d = getEmbeddingDimensions();
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}
