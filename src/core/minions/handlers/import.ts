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
 * 因此这里按**绝对失败数**给一个小的容忍额度：`errors <= 此值` 视为成功。
 * 注意不能用「失败率」：import 失败后会写 checkpoint，重试时只重新处理上次
 * 失败的那几个文件，届时看到的永远是 100% 失败率，按比例判断必然误判。
 *
 * 失败详情仍会打进日志与 job 归档，超过额度时依旧是硬失败。
 */
const IMPORT_ERROR_TOLERANCE = 5;

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
    if (result.errors > IMPORT_ERROR_TOLERANCE) {
      throw new Error(
        `Import failed for ${result.errors} file(s) (> tolerance ${IMPORT_ERROR_TOLERANCE}); ` +
        'fix rejected documents and retry the job.',
      );
    }
    if (result.errors > 0) {
      // 少量文件被拒不影响整体可用性：页面已入库，这里只记录，不判失败。
      const detail = result.failures.slice(0, 5).map((f) => `  - ${f.path}: ${f.error}`).join('\n');
      console.error(
        `[import] ${result.errors} file(s) rejected within tolerance (${IMPORT_ERROR_TOLERANCE}); ` +
        `imported ${result.imported}. First failures:\n${detail}`,
      );
    }

    // Local port (0.48 plan C): a --no-embed import writes text pages with no
    // vectors, so search never finds them. On the minions path nobody ran the
    // promised `embed --stale` follow-up, leaving pages that exist but cannot
    // be retrieved. Submit the backfill here so every entry that imports with
    // noEmbed=true gets its vectors, idempotently (embed --stale scans only
    // chunks with no embedding, and coalescing avoids duplicate jobs).
    if (job.data.noEmbed) {
      try {
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
      } catch {
        // Best-effort: a failed embed submission must not undo a successful
        // import; the next sync or a manual embed still fills the gap.
      }
    }

    return { imported: true };
  };
}
