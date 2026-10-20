/**
 * C/C++ call extraction (local port from the 0.48 line, Layer 5 / A1).
 *
 * Before the port, `CALL_CONFIG` had no `c` / `cpp` entry, so an embedded C
 * project produced no call edges at all — `code-callers` came back empty and
 * the call graph for a whole source was blank. These tests run the real
 * chunker end to end (chunkCodeTextFull), not a string grep.
 */
import { describe, test, expect } from 'bun:test';
import { chunkCodeTextFull } from '../src/core/chunkers/code.ts';

describe('Layer 5 (A1) — C/C++ call extraction', () => {
  test('captures direct and member calls in C++', async () => {
    const src = `
void LoadSDK() {}
void main() {
  LoadSDK();
  console.StartConsole();
  RealtekWiFi::Initialize();
}
`.trim();
    const result = await chunkCodeTextFull(src, 'src/main.cpp');
    const names = result.edges.map((edge) => edge.toSymbol);
    expect(names).toContain('LoadSDK');
    expect(names).toContain('StartConsole');
    expect(names).toContain('Initialize');
  });

  test('captures direct calls in C', async () => {
    const result = await chunkCodeTextFull('void helper() {}\nvoid main() { helper(); }', 'src/main.c');
    expect(result.edges.map((edge) => edge.toSymbol)).toContain('helper');
  });

  test('a C function_definition yields a named symbol', async () => {
    const result = await chunkCodeTextFull('int compute(int a) { return a * 2; }', 'src/calc.c');
    const names = result.chunks.map((chunk) => chunk.metadata.symbolName).filter(Boolean);
    expect(names).toContain('compute');
  });

  test('.xc and .c++ files are classified as C/C++', async () => {
    const xc = await chunkCodeTextFull('void f(void) { g(); }', 'src/thing.xc');
    expect(xc.edges.map((e) => e.toSymbol)).toContain('g');
    const cxx = await chunkCodeTextFull('void f() { g(); }', 'src/thing.c++');
    expect(cxx.edges.map((e) => e.toSymbol)).toContain('g');
  });
});
