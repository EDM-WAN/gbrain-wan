/**
 * `import` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * 容忍多少个「单文件被拒」后仍判定 import 成功。
 *
 * 背景：一个 SDK 目录里混进几个非 UTF-8 / 空文件 / 超大文件是常态，而
 * `runImport` 只要有一个文件失败就让 `errors > 0`。若据此判整个任务失败，
 * 会出现「2772 个文件成功入库、1 个被拒 → 任务 failed」的结果，进而
 * `source-scheduler` 每轮 +1 `consecutiveFailures`，累计到上限还会**自动停用**
 * 该 source 的定时同步 —— 为了几个无关紧要的文件，整条链路被拖垮。
 *
 * 因此给一个容忍额度：`errors <= 额度` 视为成功。
 *
 * 额度随规模放大：`max(FLOOR, ceil(totalFiles * RATIO))`。
 *   - 2 772 个文件 → 容忍 5 个（与原先的绝对值一致）
 *   - 36 883 个文件 → 容忍 37 个
 * 固定 5 对几万文件的 SDK 过于苛刻：实测 loong SDK 36 876 页成功入库、
 * 19 个超限文件被拒，就足以让整个 import 判失败。
 *
 * 「按比例必然误判」的顾虑在这里不成立：`totalFiles` 取自 walker 全集
 * （`allFiles.length`），不是 checkpoint 恢复后重试的子集。重试时
 * `files` 只剩上次失败的那几个，但分母仍是整棵树，比例不会被放大。
 * 已分类的跳过（generated_data / file_too_large）根本不进 `errors`，
 * 所以它们不占用这个额度。
 *
 * 失败详情仍会打进日志与 job 归档，超过额度时依旧是硬失败。
 */
const IMPORT_ERROR_TOLERANCE_FLOOR = 5;
/** 0.1 %: one bad file per thousand is tolerable for a bulk SDK import. */
const IMPORT_ERROR_TOLERANCE_RATIO = 0.001;

/** The allowed error count for a run over `totalFiles` files. */
function importErrorTolerance(totalFiles: number | undefined): number {
  if (!Number.isFinite(totalFiles ?? NaN) || (totalFiles ?? 0) <= 0) return IMPORT_ERROR_TOLERANCE_FLOOR;
  return Math.max(IMPORT_ERROR_TOLERANCE_FLOOR, Math.ceil(totalFiles! * IMPORT_ERROR_TOLERANCE_RATIO));
}

/** Statuses where an `embed` job can still make progress on a source. */
const LIVE_EMBED_STATUSES = ['active', 'waiting', 'delayed', 'waiting-children', 'paused'];

/**
 * The id of a live `embed` job already covering `sourceId`, or null.
 *
 * Null-source embeds (whole brain) count for every source: they scan all stale
 * chunks, so they cover a scoped backfill too.
 */
async function findInFlightEmbedJob(engine: BrainEngine, sourceId: string | undefined): Promise<number | null> {
  const rows = await engine.executeRaw<{ id: number; data: { sourceId?: string | null } | null }>(
    `SELECT id, data FROM minion_jobs
      WHERE name = 'embed' AND status = ANY($1::text[])
      ORDER BY id DESC LIMIT 50`,
    [LIVE_EMBED_STATUSES],
  );
  const hit = rows.find((row) => {
    const jobSourceId = row.data?.sourceId;
    return jobSourceId == null || jobSourceId === sourceId;
  });
  return hit ? Number(hit.id) : null;
}

export function makeImportHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    // import.ts Core extraction deferred (import has parallel workers +
    // checkpointing; the typed-API split lands in W7 of the fix-wave).
    // W0 (Tier-1 #5): runImport no longer contains ANY process.exit — all
    // five preflight sites throw typed ImportAbortError, which this
    // handler's catch converts to a normal failJob. No worker-kill risk.
    const { runImport } = await import('../../../commands/import.ts');
    const importArgs: string[] = [];

    // Local port (0.48 plan B): register a missing source on the trusted
    // worker side when the console imports a local directory. gbrain-web used
    // to spawn the local CLI (`sources add --path`), which this process
    // (remote=false) allows; after the minions cutover that path was gone and
    // HTTP MCP's sources_add refuses `path` by design, so the console could
    // not self-register a directory source. `force: true` mirrors the old CLI
    // (which passed --force), otherwise a non-git directory (nuwa etc.) is
    // refused with not_a_git_repo.
    const jobSourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (jobSourceId && job.data.dir) {
      try {
        const existing = await engine.executeRaw<{ id: string }>(
          `SELECT id FROM sources WHERE id = $1`,
          [jobSourceId],
        );
        if (existing.length === 0) {
          const { addSource } = await import('../../sources-ops.ts');
          await addSource(engine, {
            id: jobSourceId,
            name: jobSourceId,
            localPath: String(job.data.dir),
            federated: false,
            force: true,
          });
        }
      } catch (err) {
        console.error(`[import] could not auto-register source ${jobSourceId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (job.data.dir) importArgs.push(String(job.data.dir));
    if (job.data.noEmbed) importArgs.push('--no-embed');
    // Plan D: forward the console's parameters so a queued SDK import does not
    // fall back to the markdown default and silently drop code pages.
    if (job.data.fresh === true) importArgs.push('--fresh');
    if (job.data.allowNoncanonicalRoot === true) importArgs.push('--allow-noncanonical-root');
    const strategyArg =
      typeof job.data.strategy === 'string' && ['markdown', 'code', 'auto'].includes(job.data.strategy)
        ? job.data.strategy
        : undefined;
    if (strategyArg) importArgs.push('--strategy', strategyArg);
    if (jobSourceId) importArgs.push('--source-id', jobSourceId);
    if (Array.isArray(job.data.exclude)) {
      for (const pattern of job.data.exclude) {
        if (typeof pattern === 'string' && pattern) importArgs.push('--exclude', pattern);
      }
    } else if (typeof job.data.exclude === 'string' && job.data.exclude) {
      importArgs.push('--exclude', job.data.exclude);
    }
    if (typeof job.data.workers === 'number' && Number.isInteger(job.data.workers) && job.data.workers >= 1) {
      importArgs.push('--workers', String(job.data.workers));
    }
    const result = await runImport(engine, importArgs, {
      signal: job.signal,
      sourceId: jobSourceId,
      // Plan D: mirror the file counters onto job.progress so the web console
      // renders "N/M files" while the import runs, instead of a bare spinner.
      onProgress: (done, total) => {
        job.updateProgress({ done, total, phase: 'import.files' }).catch(() => {});
      },
    });
    const tolerance = importErrorTolerance(result.totalFiles);
    if (result.errors > tolerance) {
      throw new Error(
        `Import failed for ${result.errors} file(s) (> tolerance ${tolerance} of ${result.totalFiles ?? '?'} files); ` +
        'fix rejected documents and retry the job.',
      );
    }
    if (result.errors > 0) {
      // 少量文件被拒不影响整体可用性：页面已入库，这里只记录，不判失败。
      const detail = result.failures.slice(0, 5).map((f) => `  - ${f.path}: ${f.error}`).join('\n');
      console.error(
        `[import] ${result.errors} file(s) rejected within tolerance (${tolerance} of ${result.totalFiles ?? '?'} files); ` +
        `imported ${result.imported}. First failures:\n${detail}`,
      );
    }

    // Local port (0.48 plan C): a --no-embed import writes text pages with no
    // vectors, so search never finds them. On the minions path nobody ran the
    // promised `embed --stale` follow-up, leaving pages that exist but cannot
    // be retrieved. Submit the backfill here so every entry that imports with
    // noEmbed=true gets its vectors.
    //
    // Single-flight per source: two imports of the same source (a double click
    // on "sync now", or the scheduler firing while a manual run is in flight)
    // used to derive TWO active `embed` jobs over the same `embedding IS NULL`
    // rows — duplicate provider calls, duplicate DB scans, and both ran slower.
    // An idempotency_key cannot express this: the keyed row coalesces even when
    // it is COMPLETED, so the first backfill would swallow every later one. The
    // in-flight check below is scoped to jobs that can still do work.
    if (job.data.noEmbed) {
      try {
        const inFlight = await findInFlightEmbedJob(engine, jobSourceId);
        // A live embed for this source already covers these chunks.
        if (inFlight === null) {
          const pending = jobSourceId
            ? await engine.countStaleChunks({ sourceId: jobSourceId })
            : await engine.countStaleChunks();
          if (pending > 0) {
            const { MinionQueue } = await import('../../minions/queue.ts');
            const queue = new MinionQueue(engine);
            await queue.add(
              'embed',
              { sourceId: jobSourceId ?? null, stale: true, catchUp: true, auto_after_import: job.id },
              // Same explicit budget as sync/import: the 300 s default wall
              // clock would kill a large-source backfill.
              { timeout_ms: 6 * 60 * 60 * 1000, lock_duration_ms: 10 * 60 * 1000 },
            );
          }
        }
      } catch {
        // Best-effort: a failed embed submission must not undo a successful
        // import; the next sync or a manual embed still fills the gap.
      }
    }

    return { imported: true };
  };
}
