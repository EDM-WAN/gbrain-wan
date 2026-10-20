import type { Page, SearchResult } from '../types.ts';

/** Targets extracted from a question that can be resolved against code pages. */
export interface CodeFocus {
  isCodeQuestion: boolean;
  files: string[];
  symbols: string[];
  configKeys: string[];
}

export interface CodeContext {
  pageKey?: string;
  symbol: string | null;
  rootSymbol?: string | null;
  relation?: 'requested' | 'direct-helper' | 'indexed-helper';
  depth?: number;
  kind: 'function' | 'file';
  text: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

const CODE_TERMS = /\b(?:sdk|source\s*code|sourcecode|code|源码|代码|函数|方法|类|接口|头文件|配置文件|初始化|编译|dll|api|宏|枚举|cpp|c\+\+|typescript|javascript|python|rust)\b/i;
/**
 * v0.51.x — questions that NAME a code-ish path without using an explicit
 * CODE_TERM ("script 文件夹"/"scripts 目录"). With only CODE_TERMS, a query
 * like "script 文件夹是实现什么功能的" failed isCodeQuestion (no 代码/函数…)
 * → code pages took the generic 600-char excerpt → implementations truncated.
 *
 * These are deliberately NARROW: a literal script(s)/src/include/… directory
 * word in the question. We do NOT add vague words like "file/目录/文件夹"
 * alone — that would misclassify non-code questions; instead the DIRECTORY
 * must be a known code-container name. `folder|目录` only counts when paired
 * with a script-ish container (see CODE_PATH_TERMS below), which keeps the
 * blast radius to genuine code-path questions.
 */
const CODE_DIR_NAMES = /\b(?:script|scripts|src|include|lib|bin|sdk|api|backend|frontend|plugin|module|mod)\b/i;
const CODE_DIR_TERMS = /(?:文件夹|目录|folder|dir|directory)/i;
const FILE_PATTERN = /(?:[\w./\\-]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|json|yaml|yml|ts|tsx|js|jsx|py|rs|java|go|sh|bash|mjs|cjs|rb|php|swift|kt|scala|cs|zig|lua|ps1|bat|cmd|Makefile|dockerfile))\b/gi;
const SYMBOL_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*(?:::\s*[A-Za-z_][A-Za-z0-9_]*)?\s*\(/g;
const CONFIG_PATTERN = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stripCallSuffix(value: string): string {
  return value.replace(/\s*\($/, '').replace(/\s+/g, '');
}

/**
 * Classify a question without an LLM. This is deliberately conservative: the
 * focus path only changes evidence packing and never changes source grants.
 */
export function detectCodeFocus(question: string): CodeFocus {
  const files = unique(Array.from(question.matchAll(FILE_PATTERN), (match) => match[0]));
  const symbols = unique(Array.from(question.matchAll(SYMBOL_PATTERN), (match) => stripCallSuffix(match[0])));
  const configKeys = unique(Array.from(question.matchAll(CONFIG_PATTERN), (match) => match[0]))
    .filter((value) => !files.some((file) => file.includes(value)));
  // Directory-named code paths ("script 文件夹", "scripts 目录"): only when a
  // code-container dir name appears AND a folder/dir noun is present. An
  // explicit FILE_PATTERN hit alone already makes isCodeQuestion true.
  const dirScoped = CODE_DIR_TERMS.test(question) && CODE_DIR_NAMES.test(question);
  const isCodeQuestion = files.length > 0 || symbols.length > 0 || configKeys.length > 0 || CODE_TERMS.test(question) || dirScoped;
  return { isCodeQuestion, files, symbols, configKeys };
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
}

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() ?? value;
}

function targetMatches(target: string, candidate: string): boolean {
  const targetKey = normalized(target);
  const candidateKey = normalized(candidate);
  return targetKey.length > 0 && (candidateKey === targetKey || candidateKey.includes(targetKey));
}

/** Score a search hit against explicit file/symbol/config targets. */
export function codeFocusScore(result: SearchResult, focus: CodeFocus): number {
  if (!focus.isCodeQuestion) return 0;
  const slug = String(result.slug ?? '');
  const title = String(result.title ?? '');
  const text = String(result.chunk_text ?? '');
  let score = 0;

  for (const file of focus.files) {
    if (targetMatches(file, slug) || targetMatches(file, title) || targetMatches(basename(file), slug)) score += 12;
  }
  for (const symbol of focus.symbols) {
    const shortSymbol = symbol.split('::').pop() ?? symbol;
    if (targetMatches(symbol, slug) || targetMatches(symbol, title)) score += 8;
    if (new RegExp(`\\b${shortSymbol.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(text)) score += 6;
  }
  for (const key of focus.configKeys) {
    if (text.includes(key) || targetMatches(key, slug) || targetMatches(key, title)) score += 4;
  }
  if (result.type === 'code') score += 2;
  return score;
}

/** Return at most the requested number of explicit-target search hits. */
export function selectCodeFocusHits(results: SearchResult[], focus: CodeFocus, limit = 2): SearchResult[] {
  if (!focus.isCodeQuestion) return [];
  return results
    .map((result, index) => ({ result, score: codeFocusScore(result, focus), index }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.result);
}

export function codeFocusLabel(focus: CodeFocus): string {
  const targets = [...focus.files, ...focus.symbols, ...focus.configKeys];
  return targets.length > 0 ? targets.join(', ') : 'code pages';
}

export function codeFocusKey(page: Pick<Page, 'slug' | 'source_id'>): string {
  return `${page.source_id}:${page.slug}`;
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (content[i] === '\n') line += 1;
  return line;
}

function matchingBraceEnd(content: string, openBrace: number): number | null {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = openBrace; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  return null;
}

/**
 * Extract a bounded function body from a page. This is intentionally a
 * lexical brace matcher, not a C++ parser: it handles the SDK's ordinary
 * source files while preserving a safe fallback for macros/strings.
 */
export function extractCodeContext(content: string, symbol: string, maxChars = 12_000): CodeContext | null {
  const shortSymbol = symbol.split('::').pop() ?? symbol;
  const escaped = shortSymbol.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const declaration = new RegExp(`(?:^|[\\n;{}])[^\\n{};]{0,240}\\b${escaped}\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?\\{`, 'm');
  const match = declaration.exec(content);
  if (!match || match.index === undefined) return null;
  const openBrace = content.indexOf('{', match.index);
  if (openBrace < 0) return null;
  const end = matchingBraceEnd(content, openBrace);
  if (end === null) return null;
  const start = match.index + (content[match.index] === '\n' ? 1 : 0);
  const fullText = content.slice(start, end);
  const text = fullText.length <= maxChars ? fullText : fullText.slice(0, maxChars);
  return {
    symbol,
    kind: 'function',
    text,
    startLine: lineNumberAt(content, start),
    endLine: lineNumberAt(content, Math.min(end, start + text.length)),
    truncated: text.length < fullText.length,
  };
}

/** Extract the requested symbol contexts, falling back to full page context. */
export function extractCodeContexts(content: string, symbols: string[], maxChars = 12_000): CodeContext[] {
  const contexts = symbols
    .map((symbol) => extractCodeContext(content, symbol, maxChars))
    .filter((context): context is CodeContext => context !== null)
    .map((context) => ({ ...context, rootSymbol: context.symbol, relation: 'requested' as const }));
  return contexts.length > 0
    ? contexts
    : [{ symbol: null, rootSymbol: null, relation: 'requested', kind: 'file', text: content.slice(0, maxChars), startLine: 1, endLine: content.slice(0, maxChars).split('\n').length, truncated: content.length > maxChars }];
}

const CONTROL_FLOW_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'decltype',
  'static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast',
]);

/** Find simple callable names in a function body, in source order. */
export function extractCalledSymbols(context: CodeContext): string[] {
  if (context.kind !== 'function') return [];
  const names: string[] = [];
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*(?:::\s*[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/g;
  for (const match of context.text.matchAll(callPattern)) {
    const value = (match[1] ?? '').replace(/\s+/g, '');
    const shortName = value.split('::').pop() ?? value;
    if (!value || value === context.symbol || CONTROL_FLOW_CALLS.has(shortName) || names.includes(value)) continue;
    names.push(value);
  }
  return names;
}

/**
 * Expand requested contexts by one local helper-definition hop. Resolution is
 * deliberately limited to the already hydrated page; it never broadens reads.
 */
export function expandDirectHelperContexts(
  content: string,
  roots: CodeContext[],
  maxHelpersPerRoot = 6,
  maxChars = 12_000,
): CodeContext[] {
  const expanded: CodeContext[] = [];
  for (const root of roots) {
    if (root.kind !== 'function' || !root.symbol) continue;
    const called = extractCalledSymbols(root).slice(0, maxHelpersPerRoot);
    for (const symbol of called) {
      const helper = extractCodeContext(content, symbol, maxChars);
      if (!helper || helper.symbol === root.symbol) continue;
      expanded.push({
        ...helper,
        rootSymbol: root.rootSymbol ?? root.symbol,
        relation: 'direct-helper',
        depth: (root.depth ?? 0) + 1,
      });
    }
  }
  return expanded;
}

/**
 * Expand a local call graph by a small, deterministic number of hops. All
 * definitions are resolved from the already hydrated page; unresolved names
 * are intentionally left for the indexed cross-file resolver.
 */
export function expandLocalHelperContexts(
  content: string,
  roots: CodeContext[],
  maxDepth = 2,
  maxHelpersPerContext = 6,
  maxTotal = 12,
  maxChars = 12_000,
): CodeContext[] {
  const output: CodeContext[] = [];
  const seen = new Set(roots.map((root) => root.symbol).filter((symbol): symbol is string => Boolean(symbol)));
  let frontier = roots.filter((root) => root.kind === 'function' && root.symbol);

  for (let depth = 1; depth <= maxDepth && output.length < maxTotal && frontier.length > 0; depth += 1) {
    const next: CodeContext[] = [];
    for (const root of frontier) {
      const called = extractCalledSymbols(root).slice(0, maxHelpersPerContext);
      for (const symbol of called) {
        if (seen.has(symbol)) continue;
        const helper = extractCodeContext(content, symbol, maxChars);
        if (!helper || !helper.symbol || seen.has(helper.symbol)) continue;
        seen.add(helper.symbol);
        const expanded: CodeContext = {
          ...helper,
          rootSymbol: root.rootSymbol ?? root.symbol,
          relation: 'direct-helper',
          depth,
        };
        output.push(expanded);
        next.push(expanded);
        if (output.length >= maxTotal) break;
      }
      if (output.length >= maxTotal) break;
    }
    frontier = next;
  }
  return output;
}
