// Serial: the real import command reads a temporary GBRAIN_HOME per test.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-job-import-errors-'));
const root = join(home, 'source');
let engine: PGLiteEngine;
let handler: (job: MinionJobContext) => Promise<unknown>;
const isolated = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined }, fn);

beforeAll(async () => isolated(async () => {
  mkdirSync(root);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const registered = (worker as unknown as { handlers: Map<string, typeof handler> }).handlers.get('import');
  if (!registered) throw new Error('import handler not registered');
  handler = registered;
}), 60_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
});

function makeJob(id: number, data: Record<string, unknown>): MinionJobContext {
  return {
    id,
    name: 'import',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: null,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

test('queued import tolerates a few rejected files but still imports the good ones', () => isolated(async () => {
  writeFileSync(join(root, 'valid.md'), '---\ntype: note\ntitle: Valid fixture\n---\n\nA valid fixture body.\n');
  writeFileSync(join(root, 'rejected.md'), '---\ntitle: [\n---\n\nA rejected fixture body.\n');
  const job = makeJob(1, { dir: root, sourceId: 'default', noEmbed: true });

  // 少量被拒文件落在容忍额度内 → 任务成功，而不是把整次导入判死。
  // （否则 source-scheduler 每轮 +1 consecutiveFailures，累计到上限会
  //   自动停用该 source 的定时同步。）
  await expect(handler(job)).resolves.toEqual({ imported: true });
  expect(await engine.getPage('valid', { sourceId: 'default' })).not.toBeNull();
  expect(await engine.getPage('rejected', { sourceId: 'default' })).toBeNull();

  // 检查点仍记录成功的路径、排除失败的，重试才会只重跑失败项。
  const checkpoint = JSON.parse(readFileSync(join(home, '.gbrain', 'import-checkpoint.json'), 'utf8'));
  expect(checkpoint.completedPaths).toContain('valid.md');
  expect(checkpoint.completedPaths).not.toContain('rejected.md');
}));

test('queued import still hard-fails when rejections exceed the tolerance', () => isolated(async () => {
  const badDir = join(home, 'too-many-bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'ok.md'), '---\ntype: note\ntitle: Ok\n---\n\nBody.\n');
  // 超过容忍额度（5）的坏文件 → 仍是硬失败，避免把「大面积解析不了」
  // 误当成正常。
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(join(badDir, `bad-${i}.md`), '---\ntitle: [\n---\n\nBad body.\n');
  }
  const job = makeJob(2, { dir: badDir, sourceId: 'default', noEmbed: true });
  await expect(handler(job)).rejects.toThrow(/Import failed for 6 file\(s\)/);
}));

test('a second import does not derive a duplicate embed job while one is in flight', () => isolated(async () => {
  const srcDir = join(home, 'single-flight');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'a.md'), '---\ntype: note\ntitle: Single flight A\n---\n\nBody A.\n');

  // Earlier tests in this file derived their own embed jobs; start clean.
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'embed'`);
  // An embed job for this source that can still do work.
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, status, data)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'embed', 'active', $1::jsonb)`,
    [JSON.stringify({ sourceId: 'default', stale: true })],
  );
  await expect(handler(makeJob(20, { dir: srcDir, sourceId: 'default', noEmbed: true }))).resolves.toEqual({ imported: true });

  const embedRows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'embed' AND status = 'waiting'`,
  );
  // The in-flight job already covers these chunks — no second one is queued.
  expect(embedRows[0]!.n).toBe(0);
}));

test('a live embed for another source does not suppress this source backfill', () => isolated(async () => {
  const otherDir = join(home, 'other-source');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'b.md'), '---\ntype: note\ntitle: Other B\n---\n\nBody B.\n');

  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'embed'`);
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, status, data)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'embed', 'active', $1::jsonb)`,
    [JSON.stringify({ sourceId: 'someone-else', stale: true })],
  );
  await expect(handler(makeJob(21, { dir: otherDir, sourceId: 'default', noEmbed: true }))).resolves.toEqual({ imported: true });

  // Scoped embeds are per-source: another source's job must not stand in.
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs
      WHERE name = 'embed' AND status = 'waiting' AND data->>'sourceId' = 'default'`,
  );
  expect(rows[0]!.n).toBe(1);
}));

test('repaired file imports cleanly on a fresh run', () => isolated(async () => {
  const repairDir = join(home, 'repair');
  mkdirSync(repairDir, { recursive: true });
  writeFileSync(join(repairDir, 'repaired.md'), '---\ntype: note\ntitle: Repaired fixture\n---\n\nA repaired fixture body.\n');
  const job = makeJob(3, { dir: repairDir, sourceId: 'default', noEmbed: true });
  await expect(handler(job)).resolves.toEqual({ imported: true });
  expect(await engine.getPage('repaired', { sourceId: 'default' })).not.toBeNull();
}));
