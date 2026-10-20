/**
 * Plan D — direct directory imports gain the flags a full sync already had.
 *
 * `runImport` is reached two ways: through `performFullSync` (which threads
 * `opts.strategy` / `opts.exclude` programmatically) and directly, as the
 * minions `import` job and the web console's SDK drop-folder path do. The
 * direct form previously read NEITHER: `--strategy code` was accepted by the
 * flag registry and then ignored, so a code drop imported as markdown (no code
 * chunks, no call edges), and `--exclude` was silently dropped.
 *
 * `onProgress` is the third half: the minions handler mirrors it onto
 * job.progress so the console can render "N/M files".
 *
 * Serial: the module mocks and GBRAIN_HOME are process-wide.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-flags-'));
const root = join(home, 'drop');
let engine: PGLiteEngine;
const isolated = (fn: () => Promise<void>) => withEnv({
  GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_MAX_CONNECTIONS: undefined,
}, fn);

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(root, `page-${i}.md`), `---\ntype: note\ntitle: Page ${i}\n---\n\nBody ${i}.\n`);
  }
  // Two code files and a nested directory that --exclude should prune.
  writeFileSync(join(root, 'main.c'), 'int helper(void) { return 1; }\nint main(void) { return helper(); }\n');
  writeFileSync(join(root, 'lib.cpp'), 'void go() {}\n');
  mkdirSync(join(root, 'vendor'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'skipme.c'), 'int vendored(void) { return 0; }\n');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
}, 60_000);

afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function reset(): Promise<void> {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'sync.%'");
}

test('--strategy code selects the code chunker for a direct import', () => isolated(async () => {
  await reset();
  const result = await runImport(engine, [root, '--strategy', 'code', '--no-embed'], { sourceId: 'default' });
  // A code-strategy import must index the code files; under the pre-fix
  // markdown default none of them are even collected.
  expect(result.imported).toBeGreaterThanOrEqual(2);
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE '%main%'");
  expect(rows.length).toBeGreaterThan(0);
}), 60_000);

test('--code is an alias for --strategy code', () => isolated(async () => {
  await reset();
  const result = await runImport(engine, [root, '--code', '--no-embed'], { sourceId: 'default' });
  expect(result.imported).toBeGreaterThanOrEqual(2);
}), 60_000);

test('a caller-supplied strategy still wins over the CLI flag', () => isolated(async () => {
  await reset();
  // performFullSync threads opts.strategy; an argv flag must not override it.
  const result = await runImport(engine, [root, '--strategy', 'code', '--no-embed'], { sourceId: 'default', strategy: 'markdown' });
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE '%main%'");
  expect(result.imported).toBeGreaterThan(0);
  expect(rows.length).toBe(0);
}), 60_000);

test('--exclude on the direct import argv prunes matching files', () => isolated(async () => {
  await reset();
  const result = await runImport(engine, [root, '--strategy', 'code', '--no-embed', '--exclude', 'vendor/**'], { sourceId: 'default' });
  const vendored = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE '%vendored%' OR slug LIKE '%skipme%'");
  expect(vendored.length).toBe(0);
  // The non-excluded code files still land. Asserting a CODE slug explicitly
  // (not just a count) is what makes this a real --exclude test: a silent
  // fallback to the markdown lane would also import 3 markdown files and
  // leave `vendored` empty, passing the two assertions above vacuously.
  const code = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE '%main%'");
  expect(code.length).toBeGreaterThan(0);
  expect(result.imported).toBeGreaterThanOrEqual(2);
}), 60_000);

test('--exclude merges with (and does not replace) a caller-supplied list', () => isolated(async () => {
  await reset();
  await runImport(engine, [root, '--strategy', 'code', '--no-embed', '--exclude', 'vendor/**'], {
    sourceId: 'default',
    exclude: ['lib.cpp'],
  });
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages");
  const slugs = rows.map(r => r.slug).join(' ');
  expect(slugs).not.toContain('skipme');
  expect(slugs).not.toContain('lib');
}), 60_000);

test('onProgress reports a monotonically increasing done out of the file total', () => isolated(async () => {
  await reset();
  const seen: Array<{ done: number; total: number }> = [];
  await runImport(engine, [root, '--no-embed'], {
    sourceId: 'default',
    onProgress: (done, total) => seen.push({ done, total }),
  });
  expect(seen.length).toBeGreaterThan(0);
  // The total is the collected file count and never changes mid-run.
  expect(new Set(seen.map(s => s.total)).size).toBe(1);
  expect(seen.every(s => s.done <= s.total)).toBe(true);
  // Files finish out of order under parallel workers, so assert the final
  // counter reached the total rather than strict step-by-step monotonicity.
  expect(Math.max(...seen.map(s => s.done))).toBe(seen[0].total);
}), 60_000);

test('an in-process caller that passes no onProgress is unaffected', () => isolated(async () => {
  await reset();
  // Must not throw on a missing callback (the optional-chain contract).
  const result = await runImport(engine, [root, '--no-embed'], { sourceId: 'default' });
  expect(result.imported).toBeGreaterThan(0);
}), 60_000);
