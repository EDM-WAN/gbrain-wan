/**
 * /think/stream scope rule (local port from the 0.48 line, #4621).
 *
 * The bug this guards: the stream route forwarded BOTH the chat dropdown's
 * explicit `source_id` AND the caller's federated `allowedSources` grant. A
 * global-access OAuth client resolves that array to EVERY active source at
 * verify-time, and gather's array-wins ladder then searched the whole brain —
 * so a user who picked one source got an answer drawn from all of them.
 *
 * The fix has two halves and this file pins both:
 *   1. gather's `resolveThinkSourceScope` — scalar wins over the array.
 *   2. the route — an explicit pick does not forward the broad grant at all.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveThinkSourceScope } from '../src/core/think/gather.ts';

describe('resolveThinkSourceScope — scalar wins (#4621)', () => {
  test('an explicit sourceId beats a federated sourceIds array', () => {
    expect(resolveThinkSourceScope({ sourceId: 'wam', sourceIds: ['default', 'wam', 'nuwa'] }))
      .toEqual({ sourceId: 'wam' });
  });

  test('a federated array applies only when no explicit pick exists', () => {
    expect(resolveThinkSourceScope({ sourceIds: ['default', 'wam'] }))
      .toEqual({ sourceIds: ['default', 'wam'] });
  });

  test('an empty array is not a scope (never widens to all sources)', () => {
    expect(resolveThinkSourceScope({ sourceIds: [] })).toEqual({});
  });

  test('neither set yields no scope fragment', () => {
    expect(resolveThinkSourceScope({})).toEqual({});
  });

  test('an explicit pick alone is preserved', () => {
    expect(resolveThinkSourceScope({ sourceId: 'wegent' })).toEqual({ sourceId: 'wegent' });
  });
});

describe('the stream route does not forward a broad grant beside an explicit pick', () => {
  const src = readFileSync(new URL('../src/commands/serve-http-think-stream.ts', import.meta.url), 'utf8');

  test('allowedSources is dropped when source_id is present', () => {
    expect(src).toContain('const allowedSources = sourceId === undefined ? authInfo?.allowedSources : undefined;');
  });

  test('the route passes both sourceId and allowedSources into runThink', () => {
    expect(src).toContain('sourceId,');
    expect(src).toContain('allowedSources,');
  });
});
