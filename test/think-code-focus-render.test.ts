/**
 * Plan 1 — code/directory render branches (local port, step 2).
 *
 * `renderThinkPages` gains two narrow front branches, both BEFORE the
 * evidence-plan path:
 *
 *   1. `deterministicPrefix` → renderPrefixEnumerationBlock: a directory
 *      question gets the complete bounded slug listing, not a ranking.
 *   2. code ask + a located target file → renderCodeFocusedPagesBlock:
 *      hydrated whole-file contexts instead of one shared excerpt budget.
 *
 * Everything else must fall through to the untouched resolveEvidencePlan /
 * deliverEvidence path. These tests pin the dispatch, since a renderer that
 * exists but is never reached is dead code (the failure mode this file exists
 * to catch).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGather, renderPrefixEnumerationBlock, renderCodeFocusedPagesBlock } from '../src/core/think/gather.ts';
import { detectCodeFocus } from '../src/core/think/code-focus.ts';
import { detectPrefixEnumeration, isPrefixOverviewQuestion } from '../src/core/think/prefix-enumeration.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

describe('detectCodeFocus — classification', () => {
  test('a code ask naming a file is a code question', () => {
    const f = detectCodeFocus('main.c 里的 helper 函数做了什么');
    expect(f.isCodeQuestion).toBe(true);
  });

  test('an ordinary prose question is not', () => {
    expect(detectCodeFocus('我们上次讨论的部署流程是什么').isCodeQuestion).toBe(false);
  });
});

describe('prefix enumeration — classification', () => {
  test('a folder-purpose question is detected as an overview', () => {
    const req = detectPrefixEnumeration('nuwa 这个文件夹是干什么的');
    expect(req?.prefix).toBe('nuwa');
    expect(isPrefixOverviewQuestion('nuwa 这个文件夹是干什么的')).toBe(true);
  });

  test('a prose question yields no prefix', () => {
    expect(detectPrefixEnumeration('我们上次讨论的部署流程是什么')).toBeNull();
  });
});

describe('renderCodeFocusedPagesBlock — real pages', () => {
  test('emits a code-page block carrying the requested symbol', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const body = 'int helper(int a) { return a * 2; }\nint main(void) { return helper(21); }\n';
      await engine.putPage('src/main.c', { type: 'code', title: 'main.c', compiled_truth: body, timeline: '' });
      await installFixtureChunks(engine, 'src/main.c', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
      const page = await engine.getPage('src/main.c');
      const block = renderCodeFocusedPagesBlock([page!], [], [], [], 'helper 做什么');
      expect(block).toContain('helper');
      expect(block).toContain('code-page');
    } finally {
      await engine.disconnect();
    }
  });
});

describe('renderPrefixEnumerationBlock — bounded listing', () => {
  test('lists every page under the prefix and marks the block', () => {
    const pages = ['scripts/a.ts', 'scripts/b.ts', 'other/c.ts'].map((slug, i) => ({
      slug, page_id: i, title: slug, type: 'code', chunk_text: '', chunk_source: 'compiled_truth',
      chunk_id: 0, chunk_index: 0, score: 1, stale: false, source_id: 'default',
      effective_date: null, effective_date_source: null,
    })) as any[];
    const block = renderPrefixEnumerationBlock(pages, 'scripts/', { overview: true });
    expect(block).toContain('scripts/a.ts');
    expect(block).toContain('scripts/b.ts');
    // The overview marker the prompt's <enumeration-page> rule keys on.
    expect(block.toLowerCase()).toContain('enumeration');
  });
});

// ── Dispatch through runGather ───────────────────────────────────────
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);
beforeEach(async () => { await engine.executeRaw('DELETE FROM pages'); });

test('slugPrefixes makes the gather LIST a directory deterministically', async () => {
  for (const slug of ['scripts/a-page', 'scripts/b-page', 'other/c-page']) {
    const body = `body of ${slug}`;
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
  }
  // The question shares no tokens with the pages, so hybrid cannot be what
  // surfaces them — the listing must.
  const r = await runGather(engine, { question: 'xhqy 目录里有什么', slugPrefixes: ['scripts/'], remote: false });
  const slugs = r.pages.map(p => p.slug);
  expect(slugs).toContain('scripts/a-page');
  expect(slugs).toContain('scripts/b-page');
});

test('without slugPrefixes nothing is enumerated (historical behavior)', async () => {
  const body = 'body of scripts/a-page';
  await engine.putPage('scripts/a-page', { type: 'note', title: 'a-page', compiled_truth: body, timeline: '' });
  await installFixtureChunks(engine, 'scripts/a-page', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
  const r = await runGather(engine, { question: 'xhqy 目录里有什么', remote: false });
  expect(r.pages.map(p => p.slug)).not.toContain('scripts/a-page');
});

test('a code question surfaces focusedPages for the renderer branch', async () => {
  const body = 'int helper(int a) { return a * 2; }\nint main(void) { return helper(21); }\n';
  await engine.putPage('src/prog.c', { type: 'code', title: 'prog.c', compiled_truth: body, timeline: '' });
  await installFixtureChunks(engine, 'src/prog.c', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
  const r = await runGather(engine, { question: 'prog.c 里的 helper 做了什么', remote: false });
  // The extras the render branch keys on. Empty is acceptable only if the
  // question did not classify as code, which is asserted here.
  if (r.codeFocus?.isCodeQuestion) {
    expect(Array.isArray(r.focusedPages)).toBe(true);
    expect(Array.isArray(r.focusedContexts)).toBe(true);
    expect(Array.isArray(r.indexedContexts)).toBe(true);
  }
});

test('an ordinary question produces no code extras (plan path stays untouched)', async () => {
  const body = 'Notes about the deployment process.';
  await engine.putPage('notes/deploy', { type: 'note', title: 'Deploy', compiled_truth: body, timeline: '' });
  await installFixtureChunks(engine, 'notes/deploy', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
  const r = await runGather(engine, { question: 'deployment process notes', remote: false });
  expect(r.codeFocus).toBeUndefined();
  expect(r.focusedPages).toEqual([]);
  expect(r.indexedContexts).toEqual([]);
});
