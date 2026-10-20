/**
 * `X-Gbrain-Source-Scope` — per-request, NARROW-ONLY read-scope narrowing.
 *
 * Motivation: an OAuth client's read authority (`federated_read` →
 * `AuthInfo.allowedSources`) is fixed at registration time. A deployment that
 * fronts one brain with a SINGLE shared client for every end user — gbrain-web
 * does this — otherwise has no way to say "this request is for a user who may
 * see only these sources", so unqualified reads span the whole client grant and
 * leak content across users.
 *
 * The header is attacker-controlled (any HTTP client can send it), so the
 * contract these tests pin is: it may only ever REDUCE authority. Widening,
 * naming a source outside the grant, and malformed input must all fail closed —
 * and the deny-all sentinel must never degrade into "no filter".
 */
import { describe, test, expect } from 'bun:test';
import {
  GBRAIN_SOURCE_SCOPE_HEADER,
  narrowAllowedSources,
  parseSourceScopeHeader,
} from '../src/mcp/request-scope.ts';
import { ALL_SOURCES, NO_SOURCES } from '../src/core/source-id.ts';

describe('parseSourceScopeHeader', () => {
  test('splits, trims and dedupes', () => {
    expect(parseSourceScopeHeader(' a , b ,a,  c ')).toEqual(['a', 'b', 'c']);
  });

  test('absent or empty header is null (no opinion)', () => {
    expect(parseSourceScopeHeader(null)).toBeNull();
    expect(parseSourceScopeHeader(undefined)).toBeNull();
    expect(parseSourceScopeHeader('')).toBeNull();
    expect(parseSourceScopeHeader('  ,  , ')).toBeNull();
  });

  test('sentinels are accepted alongside real ids', () => {
    expect(parseSourceScopeHeader(NO_SOURCES)).toEqual([NO_SOURCES]);
    expect(parseSourceScopeHeader(ALL_SOURCES)).toEqual([ALL_SOURCES]);
  });

  test('malformed ids are rejected wholesale, not dropped', () => {
    // Dropping the bad one would silently turn a narrowing request into a
    // broader one — the opposite of fail-closed.
    expect(parseSourceScopeHeader('good,../etc/passwd')).toBeNull();
    expect(parseSourceScopeHeader('good,UPPER')).toBeNull();
    expect(parseSourceScopeHeader('good,has space')).toBeNull();
  });

  test('header name is the documented one', () => {
    expect(GBRAIN_SOURCE_SCOPE_HEADER).toBe('X-Gbrain-Source-Scope');
  });
});

describe('narrowAllowedSources — never widens', () => {
  const granted = ['alpha', 'beta', 'gamma'];

  test('no grant to narrow (undefined) ⇒ unchanged', () => {
    expect(narrowAllowedSources(undefined, 'alpha')).toBeUndefined();
  });

  test('absent header ⇒ unchanged', () => {
    expect(narrowAllowedSources(granted, null)).toBeUndefined();
    expect(narrowAllowedSources(granted, '')).toBeUndefined();
  });

  test('requesting MORE than the grant ⇒ unchanged (never widens)', () => {
    expect(narrowAllowedSources(granted, 'alpha,beta,gamma,delta')).toBeUndefined();
  });

  test('requesting exactly the whole grant ⇒ unchanged (no-op)', () => {
    expect(narrowAllowedSources(granted, 'alpha,beta,gamma')).toBeUndefined();
  });

  test('`__all__` ⇒ unchanged (it is the unqualified baseline)', () => {
    expect(narrowAllowedSources(granted, ALL_SOURCES)).toBeUndefined();
    expect(narrowAllowedSources(granted, `alpha,${ALL_SOURCES}`)).toBeUndefined();
  });

  test('malformed header ⇒ unchanged (falls back to the grant)', () => {
    expect(narrowAllowedSources(granted, 'alpha,NOT VALID')).toBeUndefined();
  });
});

describe('narrowAllowedSources — narrows and fails closed', () => {
  const granted = ['alpha', 'beta', 'gamma'];

  test('subset ⇒ intersection, in the GRANT order', () => {
    expect(narrowAllowedSources(granted, 'gamma,alpha')).toEqual(['alpha', 'gamma']);
  });

  test('single id ⇒ that id', () => {
    expect(narrowAllowedSources(granted, 'beta')).toEqual(['beta']);
  });

  test('ids wholly outside the grant ⇒ deny-all, NOT unfiltered', () => {
    // The critical case: an attacker asking for sources it cannot read must end
    // up able to read nothing, never everything.
    expect(narrowAllowedSources(granted, 'delta,epsilon')).toEqual([NO_SOURCES]);
  });

  test('mix of outside + inside ⇒ keeps only the granted one', () => {
    expect(narrowAllowedSources(granted, 'delta,beta')).toEqual(['beta']);
  });

  test('explicit deny-all sentinel ⇒ deny-all', () => {
    expect(narrowAllowedSources(granted, NO_SOURCES)).toEqual([NO_SOURCES]);
    expect(narrowAllowedSources(granted, `alpha,${NO_SOURCES}`)).toEqual([NO_SOURCES]);
  });

  test('empty grant ⇒ cannot be widened by any header', () => {
    expect(narrowAllowedSources([], 'alpha')).toEqual([NO_SOURCES]);
    expect(narrowAllowedSources([], ALL_SOURCES)).toBeUndefined();
    expect(narrowAllowedSources([], NO_SOURCES)).toEqual([NO_SOURCES]);
  });

  test('write authority is not part of the contract (read axis only)', () => {
    // The function only ever returns a read-scope array; callers keep
    // AuthInfo.sourceId (write authority) from the client row untouched.
    const narrowed = narrowAllowedSources(granted, 'alpha');
    expect(Array.isArray(narrowed)).toBe(true);
    expect(narrowed).not.toContain('__write__');
  });
});
