import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/core/ops/pages.ts', import.meta.url), 'utf8');

describe('purge_pages permanent deletion contract', () => {
  test('requires source-scoped confirmation and uses batch delete', () => {
    expect(source).toContain("name: 'purge_pages'");
    expect(source).toContain('confirm_destructive');
    expect(source).toContain('source_id');
    expect(source).toContain('ctx.engine.deletePages(found, { sourceId })');
  });

  test('has a bounded slug batch and dry-run path', () => {
    expect(source).toContain('slugs.length > 200');
    expect(source).toContain("status: 'dry_run'");
    expect(source).toContain("status: 'purged'");
  });
});
