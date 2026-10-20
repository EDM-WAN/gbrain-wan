import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/core/ops/sources.ts', import.meta.url), 'utf8');

describe('source lifecycle operation contract', () => {
  test('exposes path/archive/restore operations', () => {
    expect(source).toContain('sources_set_path');
    expect(source).toContain('sources_archive');
    expect(source).toContain('sources_restore');
  });
});
