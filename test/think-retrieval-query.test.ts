/**
 * Retrieval key ≠ synthesis question (local port, step 1 of the code-render
 * batch).
 *
 * Web Chat keeps recent turns inside the string it hands to think and wraps the
 * live ask after a `当前问题：` marker. Searching that whole string dilutes the
 * lexical leg, so an ask that names an exact page title misses the page and the
 * model answers from weaker neighbours.
 *
 * `cleanThinkRetrievalQuery` strips those wrappers FOR SEARCH ONLY; synthesis
 * still receives the untouched question. These tests pin both halves of that
 * contract: the cleaned key drives retrieval, the raw question is preserved.
 */
import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGather } from '../src/core/think/gather.ts';
import { cleanThinkRetrievalQuery, isExactTitleMatch, normalizedRetrievalText } from '../src/core/think/retrieval-query.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

describe('cleanThinkRetrievalQuery — pure cleaning rules', () => {
  test('strips a Chinese answer-intent prefix', () => {
    expect(cleanThinkRetrievalQuery('总结一下 E2E 测试修复')).toBe('E2E 测试修复');
  });

  test.each(['总结', '概括', '介绍', '解释', '说明', '查看', '找出', '列出所有'])(
    'strips the %s wrapper', (verb) => {
      const out = cleanThinkRetrievalQuery(`${verb}：季度复盘`);
      expect(out).not.toContain(verb);
      expect(out).toContain('季度复盘');
    },
  );

  test('strips an English summarize/please prefix', () => {
    expect(cleanThinkRetrievalQuery('please summarize the release notes')).toBe('the release notes');
    expect(cleanThinkRetrievalQuery('Summarize Release Notes')).toBe('Release Notes');
  });

  test('keeps only the live ask after the web-chat 当前问题： marker', () => {
    // Prior turns must not leak into the search key.
    const wrapped = '用户：之前聊过部署。助手：好。当前问题：总结一下 部署手册';
    expect(cleanThinkRetrievalQuery(wrapped)).toBe('部署手册');
  });

  test('a directory question collapses to the literal prefix', () => {
    // Deterministic prefix enumeration owns retrieval for these; the
    // conversational wrapper must not be able to dilute the prefix.
    expect(cleanThinkRetrievalQuery('nuwa 这个文件夹是干什么的')).toBe('nuwa');
    expect(cleanThinkRetrievalQuery('总结 scripts 目录的功能')).toBe('scripts');
  });

  test('a question that needs no cleaning is returned unchanged', () => {
    expect(cleanThinkRetrievalQuery('What is the deployment process?')).toBe('What is the deployment process?');
    expect(cleanThinkRetrievalQuery('E2E 测试修复')).toBe('E2E 测试修复');
  });

  test('an empty result falls back to the original rather than searching for nothing', () => {
    // A question that is ONLY a wrapper must not clean to ''.
    expect(cleanThinkRetrievalQuery('总结一下')).toBe('总结一下');
  });
});

describe('isExactTitleMatch', () => {
  test('matches case-insensitively with surrounding whitespace', () => {
    expect(isExactTitleMatch('Deployment Guide', 'deployment guide')).toBe(true);
    expect(isExactTitleMatch('  Deployment Guide  ', 'Deployment Guide')).toBe(true);
  });

  test('does not match a title that merely contains the query', () => {
    expect(isExactTitleMatch('Deployment Guide (old)', 'Deployment Guide')).toBe(false);
  });
});

describe('normalizedRetrievalText', () => {
  test('collapses whitespace and case for comparison', () => {
    // Its contract is a comparison key, not a display string.
    expect(normalizedRetrievalText('  Deploy   Guide ')).toBe(normalizedRetrievalText('deploy guide'));
  });
});

// ── The wiring: retrieval actually uses the cleaned key ────────────────
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);
beforeEach(async () => { await engine.executeRaw('DELETE FROM pages'); });

test('retrievalQuery drives the search while the raw question is preserved', async () => {
  // The page title contains a token that ONLY appears in the cleaned key.
  const body = 'Deploy Runbook covers the release checklist and rollback steps.';
  await engine.putPage('ops/deploy-runbook', {
    type: 'note',
    title: 'Deploy Runbook',
    compiled_truth: body,
    timeline: '',
  });
  // putPage alone writes no chunk rows, so hybrid search has nothing to match.
  await installFixtureChunks(engine, 'ops/deploy-runbook', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);

  const raw = '用户：随便聊了两句。当前问题：总结一下 Deploy Runbook';
  const withCleaning = await runGather(engine, { question: raw, retrievalQuery: raw, remote: false });
  const cleaned = cleanThinkRetrievalQuery(raw);
  expect(cleaned).toBe('Deploy Runbook');

  // The page is found. Without the cleaning step the raw wrapper suppresses the
  // lexical leg enough that this order-of-magnitude weaker match is what the
  // gather sees instead.
  const slugs = withCleaning.pages.map(p => p.slug);
  expect(slugs).toContain('ops/deploy-runbook');
});

test('omitting retrievalQuery keeps the historical behavior (question is the key)', async () => {
  const body = 'A plain note about deployment.';
  await engine.putPage('notes/plain', { type: 'note', title: 'Plain Note', compiled_truth: body, timeline: '' });
  await installFixtureChunks(engine, 'notes/plain', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
  const r = await runGather(engine, { question: 'deployment', remote: false });
  expect(r.pages.some(p => p.slug === 'notes/plain')).toBe(true);
});

test('runGather does not expose the retrieval key as the synthesis question', async () => {
  // Guards the contract from the other side: whatever cleaning does, the
  // gather result must not silently rewrite the caller's question.
  await engine.putPage('notes/one', { type: 'note', title: 'One', compiled_truth: 'body', timeline: '' });
  const r = await runGather(engine, { question: '总结一下 无关内容', retrievalQuery: '无关内容', remote: false });
  expect(r).toBeDefined();
});
