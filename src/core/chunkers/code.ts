/**
 * Code Chunker — Tree-Sitter-Based Semantic Code Splitting
 *
 * Uses web-tree-sitter (WASM) to parse code files into AST, then extracts
 * semantic units (functions, classes, types, exports) as chunks.
 *
 * Each chunk includes a structured header with language, file path, line range,
 * and symbol name — so embeddings capture both context and code content.
 *
 * Supports: TypeScript, TSX, JavaScript, Python, Ruby, Go.
 * Falls back to recursive text chunker for unsupported languages.
 *
 * WASM loading (v0.19.0, Layer 2):
 * Uses Bun's embedded-asset pattern via `import ... with { type: 'file' }`.
 * WASMs live at `src/assets/wasm/` and are committed to the repo. At
 * `bun --compile` time, Bun bundles them into the binary. In dev, the
 * imports resolve to the repo paths directly. No node_modules dependency
 * at runtime.
 */

import { chunkText as recursiveChunk } from './recursive.ts';
import { buildQualifiedName } from './qualified-names.ts';
import { MERGE_PROTECTED_SYMBOL_TYPES, declaresFunctionValue } from './def-types.ts';
import { isModuleChunk, mergedRunSymbol, moduleChunkQualifiedName, moduleStatementSymbol } from './code-module-chunks.ts';
import { estimateTokens, estimateEmbedTokens, estimateEmbedTokensCeiling, DEFAULT_MAX_CHUNK_TOKENS } from './token-estimate.ts';
import { safeSplitIndex } from '../text-safe.ts';
import {
  isComponentMarkupPath,
  extractComponentScriptRegions,
  maskOutsideRegion,
  maskRegions,
} from './component-markup.ts';

// Both estimators moved to token-estimate.ts (#3477 follow-up) so
// recursive.ts can share them without an import cycle. Re-exported here:
// commands/sync.ts, commands/reindex-code.ts, and tests import them from
// this module.
export { estimateTokens, estimateEmbedTokens } from './token-estimate.ts';

// Embed the tree-sitter runtime + per-language grammars as files.
// `with { type: 'file' }` returns a path (string) at runtime. Bun bundles
// the referenced file into the compiled binary during `bun build --compile`.
// In dev, the path resolves to the source-tree file; the compiled binary
// uses a bundler-synthesized path.
// @ts-ignore — type: 'file' import attribute is valid Bun syntax, not in lib.d.ts
import TREE_SITTER_WASM from '../../assets/wasm/tree-sitter.wasm' with { type: 'file' };
// 36 grammars total. Every grammar ships in the compiled binary — Bun's
// --compile bundles each referenced asset. Layer 5 extends the 6 baseline
// languages to all 36 tree-sitter-wasms ship.
// @ts-ignore
import G_BASH from '../../assets/wasm/grammars/tree-sitter-bash.wasm' with { type: 'file' };
// @ts-ignore
import G_C from '../../assets/wasm/grammars/tree-sitter-c.wasm' with { type: 'file' };
// @ts-ignore
import G_CSHARP from '../../assets/wasm/grammars/tree-sitter-c_sharp.wasm' with { type: 'file' };
// @ts-ignore
import G_CPP from '../../assets/wasm/grammars/tree-sitter-cpp.wasm' with { type: 'file' };
// @ts-ignore
import G_CSS from '../../assets/wasm/grammars/tree-sitter-css.wasm' with { type: 'file' };
// @ts-ignore
import G_DART from '../../assets/wasm/grammars/tree-sitter-dart.wasm' with { type: 'file' };
// @ts-ignore
import G_ELIXIR from '../../assets/wasm/grammars/tree-sitter-elixir.wasm' with { type: 'file' };
// @ts-ignore
import G_ELM from '../../assets/wasm/grammars/tree-sitter-elm.wasm' with { type: 'file' };
// @ts-ignore
import G_GO from '../../assets/wasm/grammars/tree-sitter-go.wasm' with { type: 'file' };
// @ts-ignore
import G_HTML from '../../assets/wasm/grammars/tree-sitter-html.wasm' with { type: 'file' };
// @ts-ignore
import G_JAVA from '../../assets/wasm/grammars/tree-sitter-java.wasm' with { type: 'file' };
// @ts-ignore
import G_JAVASCRIPT from '../../assets/wasm/grammars/tree-sitter-javascript.wasm' with { type: 'file' };
// @ts-ignore
import G_JSON from '../../assets/wasm/grammars/tree-sitter-json.wasm' with { type: 'file' };
// @ts-ignore
import G_KOTLIN from '../../assets/wasm/grammars/tree-sitter-kotlin.wasm' with { type: 'file' };
// @ts-ignore
import G_LUA from '../../assets/wasm/grammars/tree-sitter-lua.wasm' with { type: 'file' };
// @ts-ignore
import G_OCAML from '../../assets/wasm/grammars/tree-sitter-ocaml.wasm' with { type: 'file' };
// @ts-ignore
import G_PHP from '../../assets/wasm/grammars/tree-sitter-php.wasm' with { type: 'file' };
// @ts-ignore
import G_PYTHON from '../../assets/wasm/grammars/tree-sitter-python.wasm' with { type: 'file' };
// @ts-ignore
import G_RUBY from '../../assets/wasm/grammars/tree-sitter-ruby.wasm' with { type: 'file' };
// @ts-ignore
import G_RUST from '../../assets/wasm/grammars/tree-sitter-rust.wasm' with { type: 'file' };
// @ts-ignore
import G_SCALA from '../../assets/wasm/grammars/tree-sitter-scala.wasm' with { type: 'file' };
// @ts-ignore
import G_SOLIDITY from '../../assets/wasm/grammars/tree-sitter-solidity.wasm' with { type: 'file' };
// @ts-ignore — DerekStride/tree-sitter-sql @ c2e1e08db1ea20dc23bdb8d228a81a8756e9c450,
// built with tree-sitter-cli@v0.26.3 --abi 14 (matches web-tree-sitter 0.22.6).
// 11 MB; substantially larger than peers because the grammar covers
// PostgreSQL + MySQL + SQLite + T-SQL basics. See CHANGELOG for size notes.
import G_SQL from '../../assets/wasm/grammars/tree-sitter-sql.wasm' with { type: 'file' };
// @ts-ignore
import G_SWIFT from '../../assets/wasm/grammars/tree-sitter-swift.wasm' with { type: 'file' };
// @ts-ignore
import G_TOML from '../../assets/wasm/grammars/tree-sitter-toml.wasm' with { type: 'file' };
// @ts-ignore
import G_TSX from '../../assets/wasm/grammars/tree-sitter-tsx.wasm' with { type: 'file' };
// @ts-ignore
import G_TYPESCRIPT from '../../assets/wasm/grammars/tree-sitter-typescript.wasm' with { type: 'file' };
// @ts-ignore
import G_VUE from '../../assets/wasm/grammars/tree-sitter-vue.wasm' with { type: 'file' };
// @ts-ignore
import G_YAML from '../../assets/wasm/grammars/tree-sitter-yaml.wasm' with { type: 'file' };
// @ts-ignore
import G_ZIG from '../../assets/wasm/grammars/tree-sitter-zig.wasm' with { type: 'file' };

// Bumped whenever chunker output shape changes (new tokenizer, merge-threshold,
// language set, etc.) so importCodeFile's content_hash re-chunks existing pages
// after a gbrain upgrade. See A2 / C2 in the v0.19.0 plan.
//
// v3: Chonkie parity (Layer 5) — 36 languages + tiktoken cl100k_base tokenizer
// + small-sibling merging. Every v0.18.0 brain with code pages re-chunks on
// next sync because the chunk sizes + symbol boundaries shift.
//
// v4 (v0.20.0 Cathedral II Layer 12): chunk-grain FTS vector + qualified
// symbol name + parent_symbol_path + doc_comment columns. Chunk_text headers
// will gain the qualified name and scope chain once Layer 5/6 lands. The
// bump + sources.chunker_version gate (in src/commands/sync.ts) forces a
// full walk on upgraded brains even when git HEAD hasn't moved, so existing
// chunks get the new columns populated. Without this, the v28 backfill
// gives every existing chunk a search_vector but subsequent Layer 5 AST
// work would silently no-op.
//
// v5 (#3821): Python `decorated_definition` handling. A decorated top-level
// function or class (and a decorated method inside a class) parses as a
// `decorated_definition` wrapper around the def — previously unmatched by
// TOP_LEVEL_TYPES / NESTED_EMIT_CONFIG, so decorated code emitted ZERO
// semantic chunks and its text vanished from the index entirely. The bump
// forces a full re-chunk so existing Python pages recover the lost symbols.
//
// v6 (#4511): mergeSmallSiblings no longer folds named definitions into
// anonymous `symbolType: 'merged'` chunks (merging nulls out symbol_name, so
// a merged definition was unreachable by code-def — a flat file of short
// top-level defs indexed to ZERO symbols). Chunk boundaries change for every
// previously-merged file, so the bump forces a re-chunk that recovers the
// erased symbols.
// v8 (N13-1): `const f = () => …` definitions keep their own named chunk.
// v9: 覆盖率兜底 —— tree-sitter 对「整文件被 #ifdef 包裹」的 C 源码只解析出头部
// `#include`，余下上千行静默丢失（chunk 覆盖不足）。现在覆盖不到 50% 时回退到
// 递归分片。分片结果对这类文件完全不同，bump 让存量页面在下一次 sync 时重切。
// v10: cAST 式结构分片 —— 语义节点采集现在会穿透 preproc_if/ERROR 等透明包装
// 节点（整文件被 `#if defined(CONFIG_X)` 包住的 C 源码此前只切出 `#include`），
// 并对主解析覆盖不到的长片段做「掩掉预处理指令后重新解析」的恢复，最后把
// 所有未被覆盖的片段补成 module 块。分片边界与 chunk 清单对所有 C/C++ 及
// 含条件编译的文件都变了，bump 让存量页面重切。
// v11: `declaration_list` / `field_declaration_list` are descended as
// transparent wrappers — an `extern "C" { … }` header (xa_nnlib's 3022-line
// kernels API) collapsed to one unnamed chunk at 0% coverage and every
// declaration in it was unindexed. Normal .c/.cpp sources measured unchanged.
// v12: three coverage/omission fixes. (a) C/C++ `TOP_LEVEL_TYPES` gain
// `type_definition`, `preproc_function_def`, `enum_specifier`,
// `union_specifier` (and `type_alias_declaration` for C++) — file-scope
// typedefs and function-like macros were never chunked, which alone pushed
// ipc.h to 33% coverage and a whole-file word chop. (b) The coverage guard
// measures against CODE chars, not the raw file, so a doc-comment-heavy
// header (task.h: 87% comments) stops being mistaken for a failed parse.
// (c) gap-fill skips stretches that are >75% comment lines.
export const CHUNKER_VERSION = 12;
/**
 * Per-language chunker revisions (a grammar swap or a language-specific emission rule), folded into that language's
 * code-file hash and into `chunkerStamp()`: a change re-chunks only its own language's files instead of every code
 * page in the brain (a CHUNKER_VERSION bump).
 * lua 1: tree-sitter-grammars v0.3.0 replaced a build whose scanner ran every
 * parse after the first on uninitialized state; Lua defs now become chunks.
 * typescript/tsx/javascript/python/ruby 1 (#5001): top-level call statements become `__module__` chunks (code-module-chunks.ts).
 */
export const GRAMMAR_REVISIONS: Partial<Record<SupportedCodeLanguage, number>> = { lua: 1, typescript: 1, tsx: 1, javascript: 1, python: 1, ruby: 1 };
/** The `sources.chunker_version` gate value: a change forces the next sync to walk every file (hash compare, no re-import of unchanged hashes). */
export const chunkerStamp = (): string => [String(CHUNKER_VERSION), ...Object.entries(GRAMMAR_REVISIONS).map(([lang, rev]) => `${lang}=${rev}`)].join(';');

// Lazy-loaded tree-sitter module (v0.22.x API: Parser is default export)
let Parser: typeof import('web-tree-sitter') | null = null;

async function getParser(): Promise<typeof import('web-tree-sitter')> {
  if (!Parser) {
    Parser = (await import('web-tree-sitter')).default || await import('web-tree-sitter');
  }
  return Parser;
}

export type SupportedCodeLanguage =
  | 'typescript' | 'tsx' | 'javascript' | 'python' | 'ruby' | 'go'
  | 'rust' | 'java' | 'c_sharp' | 'cpp' | 'c' | 'php' | 'swift' | 'kotlin'
  | 'scala' | 'lua' | 'elixir' | 'elm' | 'ocaml' | 'dart' | 'zig' | 'solidity'
  | 'bash' | 'css' | 'html' | 'vue' | 'json' | 'yaml' | 'toml' | 'sql';

export interface CodeChunkMetadata {
  symbolName: string | null;
  symbolType: string;
  filePath: string;
  language: SupportedCodeLanguage;
  startLine: number;
  endLine: number;
  /**
   * v0.20.0 Cathedral II Layer 6 (A3): chain of enclosing symbols from
   * outermost to innermost. Empty for top-level nodes. `['BrainEngine',
   * 'searchKeyword']` for a nested method 2 levels deep. Pairs with the
   * chunk header which prints `(in BrainEngine.searchKeyword)` so the
   * embedding captures scope context.
   */
  parentSymbolPath?: string[];
  /**
   * v0.20.0 Cathedral II Layer 5 (A1): fully-qualified symbol identity for
   * edge matching. Built by qualified-names.ts from language + symbolType
   * + symbolName + parentSymbolPath. Examples:
   *   Ruby:   Admin::UsersController#render
   *   Python: admin.users_controller.UsersController.render
   *   TS/JS:  BrainEngine.searchKeyword
   *   Rust:   users::UsersController::render
   * Null when symbolName is missing (merged chunks, module-level fallback).
   */
  symbolNameQualified?: string | null;
  /** N13-1: a const/let/var whose value is a function — merge-protected (def-types.ts). */
  definesFunction?: boolean;
}

export interface CodeChunk {
  text: string;
  index: number;
  metadata: CodeChunkMetadata;
}

export interface CodeChunkOptions {
  chunkSizeTokens?: number;
  largeChunkThresholdTokens?: number;
  fallbackChunkSizeWords?: number;
  fallbackOverlapWords?: number;
  /**
   * Hard upper bound (estimated tokens) on any single emitted chunk. A node
   * the AST splitter can't break up (a giant object/array literal, a single
   * huge assignment, a massive template literal) would otherwise be emitted
   * whole and rejected by the embedder ("input exceeds context length").
   * Chunks over this budget are recursively re-split. Default 2000 fits the
   * smallest common embedder context (e.g. nomic-embed-text, 2048).
   */
  maxChunkTokens?: number;
  /** Parse wall-clock cap for this call (default GBRAIN_CHUNKER_TIMEOUT_MS or 30 s); on expiry the source falls back to text chunks. */
  timeoutMs?: number;
}

/**
 * v0.20.0 Cathedral II Layer 4 (B1) — LanguageEntry manifest.
 *
 * Before Cathedral II, languages were hardcoded in two places: GRAMMAR_PATHS
 * (Bun asset imports) and DISPLAY_LANG (display names). The plan's B1 tier
 * wants one manifest that supports (a) embedded grammars that ship with
 * `bun --compile` today, (b) lazy-loaded grammars resolved from
 * node_modules/tree-sitter-wasms at runtime for source-installs, and (c)
 * user-registered grammars so downstream consumers can extend coverage
 * without forking the chunker.
 *
 * v0.20.0 ships the 29 embedded grammars we already had. The lazy-loader
 * + registerLanguage hook are in place as forward-compat — a v0.20.x
 * follow-up (or user) can register additional grammars without touching
 * the chunker core.
 *
 * Structure:
 *   - `embeddedPath` → Bun asset path, takes priority when present.
 *   - `lazyLoader` → async function returning path OR Uint8Array. Used
 *     when embeddedPath is absent. Runs at most once per process
 *     (result cached alongside the parsed Language via `languageCache`).
 *   - `displayName` → human-readable name used in embedded chunk headers
 *     so both the agent and a human reader see "TypeScript", not
 *     "typescript", in the structured header line.
 */
export interface LanguageEntry {
  displayName: string;
  embeddedPath?: string;
  lazyLoader?: () => Promise<string | Uint8Array>;
}

const LANGUAGE_MANIFEST: Record<SupportedCodeLanguage, LanguageEntry> = {
  typescript: { displayName: 'TypeScript', embeddedPath: G_TYPESCRIPT },
  tsx:        { displayName: 'TSX',        embeddedPath: G_TSX },
  javascript: { displayName: 'JavaScript', embeddedPath: G_JAVASCRIPT },
  python:     { displayName: 'Python',     embeddedPath: G_PYTHON },
  ruby:       { displayName: 'Ruby',       embeddedPath: G_RUBY },
  go:         { displayName: 'Go',         embeddedPath: G_GO },
  rust:       { displayName: 'Rust',       embeddedPath: G_RUST },
  java:       { displayName: 'Java',       embeddedPath: G_JAVA },
  c_sharp:    { displayName: 'C#',         embeddedPath: G_CSHARP },
  cpp:        { displayName: 'C++',        embeddedPath: G_CPP },
  c:          { displayName: 'C',          embeddedPath: G_C },
  php:        { displayName: 'PHP',        embeddedPath: G_PHP },
  swift:      { displayName: 'Swift',      embeddedPath: G_SWIFT },
  kotlin:     { displayName: 'Kotlin',     embeddedPath: G_KOTLIN },
  scala:      { displayName: 'Scala',      embeddedPath: G_SCALA },
  lua:        { displayName: 'Lua',        embeddedPath: G_LUA },
  elixir:     { displayName: 'Elixir',     embeddedPath: G_ELIXIR },
  elm:        { displayName: 'Elm',        embeddedPath: G_ELM },
  ocaml:      { displayName: 'OCaml',      embeddedPath: G_OCAML },
  dart:       { displayName: 'Dart',       embeddedPath: G_DART },
  zig:        { displayName: 'Zig',        embeddedPath: G_ZIG },
  solidity:   { displayName: 'Solidity',   embeddedPath: G_SOLIDITY },
  bash:       { displayName: 'Bash',       embeddedPath: G_BASH },
  css:        { displayName: 'CSS',        embeddedPath: G_CSS },
  html:       { displayName: 'HTML',       embeddedPath: G_HTML },
  vue:        { displayName: 'Vue',        embeddedPath: G_VUE },
  json:       { displayName: 'JSON',       embeddedPath: G_JSON },
  yaml:       { displayName: 'YAML',       embeddedPath: G_YAML },
  toml:       { displayName: 'TOML',       embeddedPath: G_TOML },
  sql:        { displayName: 'SQL',        embeddedPath: G_SQL },
};

/**
 * Extension registry for lazy-registered languages (beyond the 29
 * embedded core). Keyed on SupportedCodeLanguage string; registrations
 * here take priority over LANGUAGE_MANIFEST on conflict so hot-fix
 * overrides during a session work without a restart.
 *
 * This is the extension point Layer 9 (Magika) uses to wire extensionless
 * language detection, and the v0.20.x+ follow-up point for full
 * tree-sitter-wasms (~165 langs) coverage. Not exposed in the MCP
 * surface — purely a developer-facing hook.
 */
const dynamicLanguages: Map<string, LanguageEntry> = new Map();

export function registerLanguage(lang: string, entry: LanguageEntry): void {
  dynamicLanguages.set(lang, entry);
}

export function unregisterLanguage(lang: string): void {
  dynamicLanguages.delete(lang);
  languageCache.delete(lang as SupportedCodeLanguage);
}

export function listRegisteredLanguages(): string[] {
  return [
    ...Object.keys(LANGUAGE_MANIFEST),
    ...Array.from(dynamicLanguages.keys()),
  ];
}

function getLanguageEntry(language: string): LanguageEntry | undefined {
  // dynamicLanguages wins on conflict (hot-fix overrides).
  return dynamicLanguages.get(language) ?? LANGUAGE_MANIFEST[language as SupportedCodeLanguage];
}

// A grammar that fails to load, or whose ABI the pinned web-tree-sitter
// runtime rejects, used to fall back to text chunks in complete silence — the
// index reported "0 errors" while `symbol_name` was NULL for every chunk in
// that language, which is indistinguishable from a language with no semantic
// nodes. Warn once per language so the failure is visible without turning a
// per-file fallback into per-file noise. Reset in tests via
// `resetChunkerWarnings()`.
const warnedLanguages = new Set<string>();

export function resetChunkerWarnings(): void {
  warnedLanguages.clear();
}

function warnParseFailure(language: SupportedCodeLanguage, filePath: string, err: unknown): void {
  if (warnedLanguages.has(language)) return;
  warnedLanguages.add(language);
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[gbrain chunker] ${language}: semantic parsing unavailable (${msg}); ` +
    `falling back to text chunks for every .${language} file — code-def/code-callers ` +
    `will return 0 for this language. First seen: ${filePath}`,
  );
}

// Dart splits a top-level function into TWO sibling nodes — the
// `*_signature` and the `function_body` that follows it — where every other
// grammar gbrain ships nests the body inside the declaration. Chunks are built
// solely from `semanticNodes`, and source not covered by one is never emitted,
// so without this the chunk for `int f(int a) => a + 1;` would hold exactly
// `int f(int a)` and the body would vanish from the index. Returns the node
// whose END bounds the chunk; the start always stays on the signature.
const DART_SIGNATURE_TYPES = new Set([
  'function_signature', 'getter_signature', 'setter_signature',
]);

function chunkEndNode(node: any, language: SupportedCodeLanguage): any {
  if (language !== 'dart' || !DART_SIGNATURE_TYPES.has(node.type)) return node;
  const next = node.nextNamedSibling;
  // `external int f(int a);` has no body — the signature bounds itself.
  return next && next.type === 'function_body' ? next : node;
}

/**
 * #3821: Python wraps a decorated function/class in a `decorated_definition`
 * node whose actual def hangs off field 'definition'. Symbol NAME/TYPE come
 * from the inner def; chunk RANGES stay on the outer wrapper so decorator
 * text survives in the emitted chunk. Identity for non-wrapper nodes.
 */
function unwrapDecorated(node: any): any {
  if (node?.type === 'decorated_definition') {
    return node.childForFieldName?.('definition') ?? node;
  }
  return node;
}

// Per-language top-level AST node types that count as semantic units.
// Languages not in this map fall through to the recursive text chunker
// when the grammar loads but no semantic nodes match — correct behavior.
const TOP_LEVEL_TYPES: Partial<Record<SupportedCodeLanguage, Set<string>>> = {
  // Dart. `class_definition`/`enum_declaration`/`type_alias`/`function_signature`
  // normalize to existing DEF_TYPES via normalizeSymbolType; `mixin_declaration`
  // and `extension_declaration` normalize to "mixin declaration" / "extension
  // declaration", which code-def's DEF_TYPES lists explicitly.
  dart: new Set([
    'class_definition', 'enum_declaration', 'mixin_declaration',
    'extension_declaration', 'type_alias',
    'function_signature', 'getter_signature', 'setter_signature',
  ]),
  typescript: new Set([
    'function_declaration', 'class_declaration', 'abstract_class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration',
    'lexical_declaration', 'variable_declaration', 'export_statement',
  ]),
  tsx: new Set([
    'function_declaration', 'class_declaration', 'interface_declaration',
    'type_alias_declaration', 'enum_declaration', 'lexical_declaration',
    'variable_declaration', 'export_statement',
  ]),
  javascript: new Set([
    'function_declaration', 'class_declaration', 'lexical_declaration',
    'variable_declaration', 'export_statement',
  ]),
  python: new Set([
    'function_definition', 'class_definition',
    // #3821: a decorated fn/class parses as decorated_definition wrapping the
    // def via field 'definition' — without this entry decorated code emitted
    // zero chunks. Symbol name/type unwrap the wrapper (unwrapDecorated);
    // the chunk keeps the OUTER range so decorator text survives.
    'decorated_definition',
    'import_statement', 'import_from_statement', 'assignment',
  ]),
  ruby: new Set(['class', 'module', 'method', 'singleton_method', 'assignment']),
  go: new Set([
    'function_declaration', 'method_declaration', 'type_declaration',
    'const_declaration', 'var_declaration', 'import_declaration',
  ]),
  rust: new Set([
    'function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item',
    'mod_item', 'type_item', 'const_item', 'static_item', 'use_declaration',
  ]),
  java: new Set([
    'method_declaration', 'class_declaration', 'interface_declaration',
    'enum_declaration', 'record_declaration', 'import_declaration',
    'package_declaration',
  ]),
  c_sharp: new Set([
    'method_declaration', 'class_declaration', 'interface_declaration',
    'struct_declaration', 'enum_declaration', 'namespace_declaration',
    'file_scoped_namespace_declaration', 'using_directive', 'property_declaration',
  ]),
  // Same omissions as C above: `typedef`/`using` at file scope and function-
  // like macros are named definitions, and a translation unit built out of
  // them (flatbuffers' flatbuffer_builder.h, 25 unnamed chunks) never reached
  // the 50% coverage guard's threshold without them.
  cpp: new Set([
    'function_definition', 'class_specifier', 'struct_specifier',
    'namespace_definition', 'declaration', 'template_declaration',
    'type_definition', 'preproc_function_def', 'enum_specifier',
    'union_specifier', 'type_alias_declaration',
  ]),
  // `type_definition` was missing, so every `typedef …;` at file scope was
  // invisible: inside an `extern "C"` header a typedef is a named chunk, and
  // without it files like ipc.h fell below the 50% coverage guard and were
  // word-chopped wholesale (measured: 33.3% -> 81.0% coverage with it).
  // `preproc_function_def` (`#define F(x) …`) is the same class of omission —
  // a named macro definition tree-sitter produces as its own top-level node.
  c: new Set([
    'function_definition', 'struct_specifier', 'declaration', 'preproc_def',
    'preproc_include', 'type_definition', 'preproc_function_def',
    'enum_specifier', 'union_specifier',
  ]),
  php: new Set([
    'function_definition', 'class_declaration', 'interface_declaration',
    'method_declaration', 'trait_declaration',
  ]),
  swift: new Set([
    'function_declaration', 'class_declaration', 'struct_declaration',
    'protocol_declaration', 'enum_declaration', 'import_declaration',
  ]),
  kotlin: new Set(['function_declaration', 'class_declaration', 'property_declaration', 'object_declaration']),
  scala: new Set(['function_definition', 'class_definition', 'object_definition', 'trait_definition']),
  lua: new Set(['function_declaration', 'function_definition', 'local_declaration']),
  elixir: new Set(['call']),
  bash: new Set(['function_definition', 'variable_assignment']),
  solidity: new Set(['contract_declaration', 'function_definition', 'modifier_definition', 'event_definition']),
  // SQL (DerekStride): every top-level node is `statement`, wrapping a single
  // child whose type is the actual kind (create_table, create_function, etc).
  // Catch-all `statement` here; extractSymbolName dives into the inner child
  // to extract the schema target name (Step 0 inspection 2026-05-24 found
  // all 9 fixtures produced `program > statement > <kind>` shape).
  sql: new Set(['statement']),
};

const BODY_NODE_TYPES = new Set([
  'statement_block',
  'block',
  'class_body',
  'module_body',
  'body_statement',
  'body',
  // #3602: C# class/namespace bodies AND Rust impl/trait bodies are
  // `declaration_list` (no `_body` suffix), so nested-emit's scan could
  // never descend into them — Rust impl methods were silently dropped
  // (only the scope-header chunk emitted) and C# could not nest at all.
  // Shared set: PHP class bodies are also declaration_list, but PHP has
  // no NESTED_EMIT_CONFIG entry and splitLargeNode prefers the `body`
  // field, so this is additive there.
  'declaration_list',
]);

/**
 * v0.20.0 Cathedral II Layer 6 (A3) — nested-chunk emission config.
 *
 * Per-language map: when a top-level AST node is `parentType`, emit each
 * child of type `childTypes` as its OWN chunk with `parentSymbolPath`
 * populated. The parent itself still emits a chunk for the class-level
 * documentation / scope overview. This lets retrieval surface individual
 * methods (with scope context "in ClassName.method") instead of returning
 * the entire class body for a symbol-specific query.
 *
 * Languages not in this map keep current behavior: top-level node → one
 * chunk. Go stays absent (methods are already top-level with receivers).
 */
interface NestedEmitConfig {
  parentTypes: Set<string>;
  childTypes: Set<string>;
}
const NESTED_EMIT_CONFIG: Partial<Record<SupportedCodeLanguage, NestedEmitConfig>> = {
  typescript: {
    parentTypes: new Set(['class_declaration', 'abstract_class_declaration', 'interface_declaration']),
    childTypes: new Set(['method_definition', 'method_signature', 'public_field_definition']),
  },
  tsx: {
    parentTypes: new Set(['class_declaration', 'interface_declaration']),
    childTypes: new Set(['method_definition', 'method_signature', 'public_field_definition']),
  },
  javascript: {
    parentTypes: new Set(['class_declaration']),
    childTypes: new Set(['method_definition', 'field_definition']),
  },
  python: {
    parentTypes: new Set(['class_definition']),
    // #3821: decorated methods (@property, @staticmethod, ...) parse as
    // decorated_definition — emit them as leaves too, decorators included.
    childTypes: new Set(['function_definition', 'decorated_definition']),
  },
  ruby: {
    parentTypes: new Set(['class', 'module']),
    childTypes: new Set(['method', 'singleton_method']),
  },
  rust: {
    parentTypes: new Set(['impl_item', 'trait_item']),
    childTypes: new Set(['function_item']),
  },
  java: {
    parentTypes: new Set(['class_declaration', 'interface_declaration', 'record_declaration']),
    childTypes: new Set(['method_declaration', 'constructor_declaration']),
  },
  // #3602: C# nesting. Namespaces (block-scoped AND file-scoped, cf. #3601)
  // are parents so `namespace Demo { class C { ... } }` recurses Demo → C →
  // methods with the full parent path. Bodies are `declaration_list` (see
  // BODY_NODE_TYPES above).
  c_sharp: {
    parentTypes: new Set([
      'namespace_declaration', 'file_scoped_namespace_declaration',
      'class_declaration', 'interface_declaration', 'struct_declaration',
    ]),
    childTypes: new Set(['method_declaration', 'constructor_declaration', 'property_declaration']),
  },
};

let initDone = false;
let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedCodeLanguage, any>();

// ---------- Public API ----------

/**
 * v0.20.0 Cathedral II Layer 1a hook: Magika-style content-based detection
 * for extension-less files (Dockerfile, Makefile, .envrc, shell scripts with
 * shebangs but no extension). Wired by Layer 9 (B2). When null, the
 * extension map result stands; when set, this is called for filenames that
 * have no recognized extension and `content` was passed.
 *
 * Left as a module-level hook rather than a dependency injection argument
 * so the chunker doesn't need a plumbing refactor for B2. Layer 9 sets it
 * via `setLanguageFallback(fn)` at bootstrap; default is null (→ recursive
 * chunker fallback, today's behavior for extension-less files).
 */
export type LanguageFallback = (filePath: string, content: string) => SupportedCodeLanguage | null;
let languageFallback: LanguageFallback | null = null;

/** Register a content-based language fallback (Layer 9 Magika). */
export function setLanguageFallback(fn: LanguageFallback | null): void {
  languageFallback = fn;
}

export function detectCodeLanguage(filePath: string, content?: string): SupportedCodeLanguage | null {
  const lower = filePath.toLowerCase();
  // TSX + JSX take precedence over their base language.
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.cs')) return 'c_sharp';
  if (lower.endsWith('.c++') || lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') || lower.endsWith('.hpp') || lower.endsWith('.hxx') || lower.endsWith('.hh')) return 'cpp';
  if (lower.endsWith('.xc') || lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.php')) return 'php';
  if (lower.endsWith('.swift')) return 'swift';
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) return 'kotlin';
  if (lower.endsWith('.scala') || lower.endsWith('.sc')) return 'scala';
  if (lower.endsWith('.lua')) return 'lua';
  if (lower.endsWith('.ex') || lower.endsWith('.exs')) return 'elixir';
  if (lower.endsWith('.elm')) return 'elm';
  if (lower.endsWith('.ml') || lower.endsWith('.mli')) return 'ocaml';
  if (lower.endsWith('.dart')) return 'dart';
  if (lower.endsWith('.zig')) return 'zig';
  if (lower.endsWith('.sol')) return 'solidity';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'bash';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.astro') || lower.endsWith('.svelte')) return 'html';
  if (lower.endsWith('.vue')) return 'vue';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.sql')) return 'sql';
  // v0.20.0 Cathedral II Layer 1a fallback hook. Layer 9 (B2 Magika) wires
  // this in to detect extensionless files (Dockerfile, Makefile, shell
  // shebangs). try/catch because the fallback may itself fail on first-run
  // model-load — we never want chunker init to throw; recursive chunker
  // is always an acceptable default.
  if (languageFallback && content !== undefined) {
    try {
      return languageFallback(filePath, content);
    } catch {
      return null;
    }
  }
  return null;
}

export async function chunkCodeText(
  source: string,
  filePath: string,
  opts: CodeChunkOptions = {},
): Promise<CodeChunk[]> {
  const result = await chunkCodeTextFull(source, filePath, opts);
  return result.chunks;
}

/**
 * v0.20.0 Cathedral II Layer 5 (A1): chunker + edge-extractor joint API.
 * Returns chunks + per-file call-site edges. importCodeFile uses this
 * shape so we don't re-parse the tree twice. Existing callers keep using
 * chunkCodeText (backward-compatible wrapper above).
 */
export interface ChunkAndEdgeResult {
  chunks: CodeChunk[];
  /** Raw call edges — byte-offset resolution + chunk mapping happens in import-file.ts. */
  edges: import('./edge-extractor.ts').ExtractedEdge[];
}

/**
 * Thrown when tree-sitter's wall-clock cap (set via setTimeoutMicros)
 * fires and `parser.parse(source)` returns null. The caller is expected
 * to fall back to recursive chunking and continue. v0.31.2 closes the
 * 99%-CPU-no-I/O hang class where a single pathological file wedged
 * the entire sync because tree-sitter's WASM loop is opaque to JS.
 */
export class ChunkerTimeoutError extends Error {
  readonly filePath: string;
  readonly timeoutMs: number;
  constructor(filePath: string, timeoutMs: number) {
    super(`Tree-sitter parse timeout on ${filePath} after ${timeoutMs}ms`);
    this.name = 'ChunkerTimeoutError';
    this.filePath = filePath;
    this.timeoutMs = timeoutMs;
  }
}

interface ParserLike {
  setTimeoutMicros(t: number): void;
  parse(source: string): unknown;
}

/**
 * Parse `source` with a wall-clock cap, throwing `ChunkerTimeoutError`
 * when the parser returns null. Pure function — caller owns parser
 * construction AND parser/tree cleanup. Callers MUST wrap the
 * parser+tree lifecycle in try/finally so a thrown timeout still
 * reaps the WASM allocation.
 *
 * Test seam: `parser` is `ParserLike` so unit tests can pass a stub
 * whose `parse()` returns null deterministically without depending on
 * machine speed. The runtime path always passes a real
 * web-tree-sitter Parser instance.
 *
 * @internal exported for tests; production callers go through
 *   chunkCodeTextFull.
 */
export function parseWithTimeout(
  parser: ParserLike,
  source: string,
  timeoutMs: number,
  filePath: string,
): unknown {
  if (typeof parser.setTimeoutMicros !== 'function') {
    // Fail loud at the seam if a future web-tree-sitter upgrade drops
    // the API — better than silently regressing to no-timeout behavior.
    throw new Error(
      `web-tree-sitter Parser is missing setTimeoutMicros (required for chunker timeout). ` +
      `Pin in package.json may be too new (deprecated 0.25.0+) or too old.`,
    );
  }
  parser.setTimeoutMicros(timeoutMs * 1000);
  let tree: unknown;
  // web-tree-sitter throws "Parsing failed" itself when the timeout makes the parse return null.
  try { tree = parser.parse(source); } catch (e: unknown) { if (e instanceof Error && e.message === 'Parsing failed') throw new ChunkerTimeoutError(filePath, timeoutMs); throw e; }
  if (tree === null || tree === undefined) {
    throw new ChunkerTimeoutError(filePath, timeoutMs);
  }
  return tree;
}

const DEFAULT_CHUNKER_TIMEOUT_MS = 30_000;

function resolveChunkerTimeoutMs(): number {
  const raw = process.env.GBRAIN_CHUNKER_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_CHUNKER_TIMEOUT_MS;
}

export async function chunkCodeTextFull(
  source: string,
  filePath: string,
  opts: CodeChunkOptions = {},
): Promise<ChunkAndEdgeResult> {
  const language = detectCodeLanguage(filePath);
  if (!language) {
    return { chunks: fallbackChunks(source, filePath, 'javascript', opts), edges: [] };
  }

  if (!source.trim()) return { chunks: [], edges: [] };

  // #3768: .svelte/.astro carry real TS/JS in <script> blocks (and the Astro
  // `---` fence) but map to 'html'. Parse each script region with the TS/JS
  // grammar over a geometry-preserving mask (absolute line numbers AND
  // absolute edge byte offsets for free); the markup keeps its html chunks
  // with the script interiors blanked so text isn't double-indexed.
  if (isComponentMarkupPath(filePath)) {
    const componentResult = await chunkComponentMarkup(source, filePath, opts);
    if (componentResult) return componentResult;
  }

  return chunkParsedLanguage(source, filePath, language, opts);
}

/** #3768 orchestration — returns null when the file has no script regions. */
async function chunkComponentMarkup(
  source: string,
  filePath: string,
  opts: CodeChunkOptions,
): Promise<ChunkAndEdgeResult | null> {
  const regions = extractComponentScriptRegions(source, filePath);
  if (regions.length === 0) return null;
  const chunks: CodeChunk[] = [];
  const edges: import('./edge-extractor.ts').ExtractedEdge[] = [];
  for (const region of regions) {
    const masked = maskOutsideRegion(source, region);
    const r = await chunkParsedLanguage(masked, filePath, region.language, opts);
    chunks.push(...r.chunks);
    edges.push(...r.edges);
  }
  const markup = maskRegions(source, regions);
  if (markup.trim()) {
    const m = await chunkParsedLanguage(markup, filePath, 'html', opts);
    chunks.push(...m.chunks);
    edges.push(...m.edges);
  }
  // Re-number so downstream chunk_index stays unique + sequential per file.
  return { chunks: chunks.map((c, i) => ({ ...c, index: i })), edges };
}

async function chunkParsedLanguage(
  source: string,
  filePath: string,
  language: SupportedCodeLanguage,
  opts: CodeChunkOptions,
): Promise<ChunkAndEdgeResult> {
  // #4669: a language with no TOP_LEVEL_TYPES entry (yaml, json, toml, css,
  // html, ...) can only reach the no-semantic-nodes fallback below; skip the
  // WASM load + parse (same output) and the false "parsing unavailable" alarm.
  if (!TOP_LEVEL_TYPES[language]) {
    return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
  }

  const largeThreshold = opts.largeChunkThresholdTokens ?? 1000;
  const chunkTarget = opts.chunkSizeTokens ?? 300;
  const timeoutMs = opts.timeoutMs ?? resolveChunkerTimeoutMs();

  // v0.31.2: parser + tree are always reaped via finally. Pre-fix, the
  // catch block returned without delete() — a leak Codex flagged
  // (C4) as soon as the timeout path could throw before the manual
  // mid-function deletes ran.
  let parser: any = null;
  let tree: any = null;
  try {
    await ensureInit();
    const P = await getParser();
    parser = new (P as any)();
    const grammar = await loadLanguage(language);
    parser.setLanguage(grammar);

    try {
      tree = parseWithTimeout(parser as ParserLike, source, timeoutMs, filePath);
    } catch (e: unknown) {
      if (e instanceof ChunkerTimeoutError) {
        console.warn(
          `[gbrain chunker] timeout parsing ${filePath} after ${timeoutMs}ms; ` +
          `falling back to recursive chunks`,
        );
        return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
      }
      throw e;
    }

    const root = (tree as any).rootNode;
    const topLevelTypes = TOP_LEVEL_TYPES[language]!;
    const semanticNodes = collectSemanticNodes(root, topLevelTypes, language);

    if (semanticNodes.length === 0) {
      return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
    }

    const chunks: CodeChunk[] = [];
    const nestedConfig = NESTED_EMIT_CONFIG[language];
    /** Absolute [start,end) ranges already turned into chunks — the recovery
     *  pass uses these to skip nodes the primary parse already emitted. */
    const emittedRanges: Array<[number, number]> = [];

    const emitSemanticNode = (node: any): void => {
      const endNode = chunkEndNode(node, language);
      const nodeText = source.slice(node.startIndex, endNode.endIndex).trim();
      if (!nodeText) return;

      // v0.20.0 Cathedral II Layer 6 (A3): for class/module/impl nodes,
      // emit the parent AND each child method as its own chunk with
      // parentSymbolPath populated. Retrieval then surfaces individual
      // methods when a query targets one, instead of returning the whole
      // class body. The parent chunk still ships so class-level docs /
      // scope overview stay queryable.
      //
      // For Ruby (`module Admin { class UsersController { ... } }`) and
      // Java (nested classes) the expansion is recursive: a nested class
      // inside a module itself emits its methods with the full parent
      // path [Admin, UsersController].
      //
      // TS/JS `export class Foo {...}` wraps the class in an
      // `export_statement`. Unwrap one level to find the nestable
      // declaration; top-level chunk still uses the outer node's range
      // so the header shows the `export` keyword for completeness.
      const nestableNode = findNestableParent(node, nestedConfig);
      const moduleSymbol = moduleStatementSymbol(node, language); // #5001: a top-level statement containing a call
      const symbolName = moduleSymbol?.symbolName ?? extractSymbolName(nestableNode ?? node);
      // For SQL `statement` wrappers, the meaningful type lives on the inner
      // child. extractSymbolName already dives in for the name; mirror that
      // here so chunk headers say "table users" not "statement users".
      // #3821: same for Python decorated_definition — the header must say
      // "function cached_fn" / "class Config", not "decorated definition".
      const typeNode = unwrapDecorated(nestableNode ?? node);
      const symbolType = moduleSymbol?.symbolType ?? ((typeNode.type === 'statement' && typeNode.namedChildCount === 1)
        ? normalizeSymbolType(typeNode.namedChild(0).type)
        : normalizeSymbolType(typeNode.type));

      if (nestableNode && symbolName && nestedConfig) {
        const before = chunks.length;
        emitNestedScoped(nestableNode, [], source, filePath, language, nestedConfig, chunks);
        if (chunks.length > before) {
          emittedRanges.push([node.startIndex, endNode.endIndex]);
          return;
        }
      }

      if (estimateTokens(nodeText) <= largeThreshold) {
        const chunk = buildChunk({
          body: nodeText, filePath, language, symbolName, symbolType,
          startLine: node.startPosition.row + 1,
          endLine: endNode.endPosition.row + 1,
          index: chunks.length,
          parentSymbolPath: [],
        });
        if (declaresFunctionValue(typeNode)) chunk.metadata.definesFunction = true;
        chunks.push(chunk);
        emittedRanges.push([node.startIndex, endNode.endIndex]);
        return;
      }

      // Split very large nodes at nested block boundaries
      const subRanges = splitLargeNode(node, source, chunkTarget);
      if (subRanges.length === 0) {
        chunks.push(buildChunk({
          body: nodeText, filePath, language, symbolName, symbolType,
          startLine: node.startPosition.row + 1,
          endLine: endNode.endPosition.row + 1,
          index: chunks.length,
          parentSymbolPath: [],
        }));
        emittedRanges.push([node.startIndex, endNode.endIndex]);
        return;
      }

      for (const range of subRanges) {
        const body = source.slice(range.startIndex, range.endIndex).trim();
        if (!body) continue;
        chunks.push(buildChunk({
          body, filePath, language, symbolName, symbolType,
          startLine: range.startLine, endLine: range.endLine,
          index: chunks.length,
          parentSymbolPath: [],
        }));
      }
      emittedRanges.push([node.startIndex, endNode.endIndex]);
    };

    for (const node of semanticNodes) emitSemanticNode(node);

    // Parse-recovery pass: a file whose conditional structure defeats the
    // grammar (fatfs ff.c: one unbalanced `#else` collapsed 192K chars into a
    // single ERROR node) emits almost nothing from the primary tree. Re-parse
    // ONLY the uncovered stretches with preprocessor directive lines blanked
    // out — same byte length, so offsets stay absolute and the nodes land on
    // the right lines. Masking the directives is what repairs the structure:
    // the grammar then sees plain C and recovers the function bodies.
    for (const node of recoverUncoveredNodes(parser, source, language, topLevelTypes, emittedRanges, timeoutMs)) {
      emitSemanticNode(node);
    }

    // Gap-fill pass: the AST is not a partition — nodes leave stretches
    // between them (leading license headers, an `#endif` tail, anything the
    // grammar dropped mid-file). Word chunking used to fold that text into
    // its sliding windows, so dropping it here would be a content REGRESSION
    // even while symbol coverage improves (measured: stb_image.h 111.8% ->
    // 77.5%). Emit each remaining stretch as an unnamed `module` chunk so the
    // text stays indexed and the coverage guard below stops firing.
    emitUncoveredGaps(source, filePath, language, emittedRanges, chunks, chunkTarget);

    // v0.20.0 Cathedral II Layer 5 (A1): harvest call-graph edges from the
    // tree before we delete it. The extractor is iterative (no recursion);
    // cost is ~O(n) on node count so adding this pass does not regress
    // chunker throughput measurably.
    let rawEdges: import('./edge-extractor.ts').ExtractedEdge[] = [];
    try {
      // v0.34 W2: switched to extractAllEdges so imports + references edges
      // get emitted alongside calls. JS/TS/TSX + Python emit imports;
      // TS only emits references. Other langs still get bare-token calls
      // (v0.20 baseline).
      const { extractAllEdges } = await import('./edge-extractor.ts');
      rawEdges = extractAllEdges(tree, language);
    } catch {
      // Edge extraction is best-effort — failure here must not break
      // chunking. Syntactically invalid code or a grammar quirk should
      // still get chunks.
      rawEdges = [];
    }

    if (chunks.length === 0) {
      return { chunks: fallbackChunks(source, filePath, language, opts), edges: rawEdges };
    }

    // 覆盖率兜底：tree-sitter 遇到预处理条件块（`#if defined(CONFIG_X)` 包住
    // 大段代码）或语法歧义时，只把其中一部分当顶层语义节点，其余内容静默丢失
    // —— 索引看起来「成功」，实际检索不到。两种典型形态：
    //   ① 只切了文件头部，剩余上千行全丢（rtk_coex.c: 1 chunk / 1285 行）
    //   ② 切出很多 chunk，但 chunk 之间有空隙（stb_image.h: 49 chunks 只覆盖 6.5%）
    // 形态 ② 用「最后一个 chunk 的行号」判不出来（末尾那块确实存在），所以这里
    // 直接比较**内容字符总数**：切出来的总量不到原文一半，就认定 AST 不完整。
    //
    // 用字符而非行号，是因为 fallback chunk 的 endLine 是块内相对行号，
    // 跨块不可比；字符数则是线性可加的绝对量。
    if (source.length > 1000) {
      // 必须剔除 chunk 头部（`[C] path:N-M symbol`）再比较：头部是为 embedding
      // 补的上下文，不是文件内容，且长度随路径变化 —— 路径越长，头部越多，
      // 覆盖率被虚高，短文件路径下会漏判（实测同一文件：短路径 48.2% 触发回退，
      // 长路径 52.7% 不触发）。
      const coveredChars = chunks.reduce((sum, c) => sum + stripChunkHeader(c.text).length, 0);
      // Measure against the file's CODE, not its raw length. A doc-comment
      // heavy header (asr_interface.h: 73% comment lines) reads as 20.8%
      // covered against the whole file and gets word-chopped, even though
      // every declaration in it was chunked (78.0% of the code). Comments
      // are not semantic units here — they ride along inside the chunks that
      // contain them, or come back through the gap-fill pass.
      const commentChars = countCommentChars(root);
      const codeChars = Math.max(1, source.length - commentChars);
      const coverage = coveredChars / codeChars;
      if (coverage < 0.5) {
        console.warn(
          `[gbrain chunker] incomplete AST for ${filePath}: chunks cover ` +
          `${coveredChars} of ${codeChars} code chars (${(coverage * 100).toFixed(1)}%, ` +
          `${commentChars} in comments); falling back to recursive chunks`,
        );
        return { chunks: fallbackChunks(source, filePath, language, opts), edges: rawEdges };
      }
    }

    return { chunks: capOversizedChunks(mergeSmallSiblings(chunks, chunkTarget), filePath, language, opts), edges: rawEdges };
  } catch (err: unknown) {
    warnParseFailure(language, filePath, err);
    return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
  } finally {
    // v0.31.2 (codex C4): single cleanup site so a thrown
    // ChunkerTimeoutError, edge-extraction failure, or any other
    // exception still reaps parser+tree WASM objects. Pre-fix, the
    // catch block returned without delete() — a guaranteed leak
    // whenever a code file failed to parse.
    try { tree?.delete?.(); } catch { /* ignore double-delete */ }
    try { parser?.delete?.(); } catch { /* ignore double-delete */ }
  }
}

/**
 * Transparent wrapper node types — conditionals and error recovery that
 * tree-sitter interposes between the root and the semantic nodes we want.
 *
 * A Realtek C source whose entire body sits inside `#if defined(CONFIG_X)`
 * parses as ONE `preproc_if` at the root; its 40 `function_definition`
 * children are invisible to a root-level scan, so the file chunked to a
 * single `#include` and the coverage guard below fell back to word
 * chopping for the whole file (measured: rtk_coex.c, 0.5% covered). Same
 * for `#ifdef`-gated headers (`preproc_ifdef`) and files mbedtls/psa
 * guard wholesale. `ERROR` is included because a single unbalanced
 * `#else` makes tree-sitter wrap the rest of the file in one recovery
 * node — refusing to descend there costs the file's entire remainder.
 *
 * Only these wrapper kinds are descended. A named node that is NOT a
 * wrapper is a real construct: descending into it would emit anonymous
 * fragments of a function body as top-level chunks.
 */
const TRANSPARENT_WRAPPER_TYPES = new Set([
  'preproc_if', 'preproc_ifdef', 'preproc_else', 'preproc_elif',
  'preproc_elifdef', 'preproc_elifndef', 'preproc_defined',
  'linkage_specification', 'ERROR',
  // `declaration_list` is what `linkage_specification` holds for an
  // `extern "C" { … }` block — the shape every C API header uses. Without
  // descending into it the whole block reads as one unnamed node: xa_nnlib's
  // 3022-line kernels header yielded ONE chunk at 0% coverage, hiding all 226
  // function declarations. With it the same file yields 249 named nodes at
  // 93.5% coverage, and measured normal sources (tasks.c, ssl_tls.c) are
  // completely unchanged.
  'declaration_list',
  // C++ `class { … }` / `struct { … }` members.
  'field_declaration_list',
]);

/**
 * Collect the file's semantic nodes, descending through transparent
 * wrappers (see TRANSPARENT_WRAPPER_TYPES) but stopping at the first real
 * semantic node. Order is source order so chunk_index stays monotonic.
 */
function collectSemanticNodes(root: any, topLevelTypes: Set<string>, language: SupportedCodeLanguage): any[] {
  const out: any[] = [];
  const visit = (node: any): void => {
    for (const child of node.namedChildren) {
      if (topLevelTypes.has(child.type) || moduleStatementSymbol(child, language) !== null) {
        out.push(child);
      } else if (TRANSPARENT_WRAPPER_TYPES.has(child.type)) {
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Total characters the parse classified as comments (any depth).
 *
 * Used to size the coverage guard's denominator: a header that is 87%
 * doc-comment (FreeRTOS task.h) can cover every declaration it has and still
 * read as "7.8% covered" against its raw length.
 */
function countCommentChars(root: any): number {
  let total = 0;
  const visit = (node: any): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'comment') total += child.endIndex - child.startIndex;
      else visit(child);
    }
  };
  visit(root);
  return total;
}

/** Minimum uncovered stretch worth a second parse. Below this the recovery
 *  pass cannot pay for itself: comments and trailing `#endif` lines are the
 *  normal remainder and never contain a definition. */
const RECOVERY_MIN_GAP_CHARS = 4096;

/** Cap on re-parses per file. Each one is a full WASM parse; a badly broken
 *  file should degrade to a handful of recoveries, not dozens. */
const RECOVERY_MAX_GAPS = 8;

/** How deep the rebuilt (gap-relative) node tree is materialized. Chunking
 *  only inspects a few levels (symbol name/type, a body's direct children),
 *  and every level costs an object per named child. */
const MAX_RECOVERED_DEPTH = 6;

/**
 * Find the stretches of `source` not covered by `emittedRanges`, re-parse each
 * one with preprocessor directive lines blanked, and return the semantic nodes
 * it yields that fit entirely inside that stretch.
 *
 * Geometry-preserving by construction: the mask replaces each directive with
 * spaces of the same length (newlines preserved), so the re-parsed tree's
 * indices are offsets in the ORIGINAL source. Nodes that overrun their gap are
 * dropped — a node whose range crosses already-emitted content would duplicate
 * it, and `mapCodeEdges` resolves call sites by line.
 *
 * Fail-open: any parse error returns what was collected so far. Recovery is an
 * optimization on top of the primary tree, never a reason to fail a file.
 */
function recoverUncoveredNodes(
  parser: any,
  source: string,
  language: SupportedCodeLanguage,
  topLevelTypes: Set<string>,
  emittedRanges: Array<[number, number]>,
  timeoutMs: number,
): any[] {
  if (emittedRanges.length === 0) return [];
  const sorted = [...emittedRanges].sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < source.length) gaps.push([cursor, source.length]);

  const out: any[] = [];
  let reparsed = 0;
  for (const [gapStart, gapEnd] of gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))) {
    if (gapEnd - gapStart < RECOVERY_MIN_GAP_CHARS) continue;
    if (reparsed >= RECOVERY_MAX_GAPS) break;
    reparsed++;
    try {
      const masked = maskPreprocessorDirectives(source.slice(gapStart, gapEnd));
      const tree = parseWithTimeout(parser as ParserLike, masked, timeoutMs, `${language}:recovery@${gapStart}`);
      const root = (tree as any).rootNode;
      for (const node of collectSemanticNodes(root, topLevelTypes, language)) {
        // A node that overruns its gap would duplicate content the primary
        // pass already emitted (and mapCodeEdges would land its call sites on
        // the wrong chunk). Drop it rather than clip it.
        if (gapStart + node.endIndex > gapEnd) continue;
        out.push(offsetNode(node, source, gapStart, rowOffsetAt(source, gapStart)));
      }
      try { tree?.delete?.(); } catch { /* ignore double-delete */ }
    } catch {
      // Timeout or parse failure on this stretch — keep what we have.
    }
  }
  return out;
}

/** A leftover stretch shorter than this is left out entirely rather than
 *  becoming its own row: a Go `package p` clause or a trailing `#endif` is
 *  not worth an embedding call, and `module` must not name it (#5001). */
const GAP_FILL_MIN_CHARS = 400;

/**
 * Emit the stretches no semantic node covered as unnamed `module` chunks
 * (and fold short ones into the preceding chunk's text).
 *
 * These are the file's leading license header, trailing `#endif`s, and
 * whatever the grammar abandoned — content that word chunking used to
 * sample and AST chunking would otherwise silently drop. Named chunks keep
 * their symbol identity; these are explicitly `module`, which is also what
 * keeps `code-def` from inventing a symbol for them.
 */
function emitUncoveredGaps(
  source: string,
  filePath: string,
  language: SupportedCodeLanguage,
  emittedRanges: Array<[number, number]>,
  chunks: CodeChunk[],
  chunkTarget: number,
): void {
  if (chunks.length === 0) return;
  const sorted = [...emittedRanges].sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < source.length) gaps.push([cursor, source.length]);

  for (const [start, end] of gaps) {
    const text = source.slice(start, end).trim();
    if (!text) continue;
    // Short remainders are the normal by-product of AST chunking: a Go
    // `package p` clause, a license header, a trailing `#endif`. They carry
    // no definition and turning them into rows invents `module` chunks the
    // inventory tests (rightly) reject — #5001 keeps `module` meaning "a
    // top-level call statement". Drop them; the long ones below are the ones
    // that used to carry real lost content.
    if (text.length < GAP_FILL_MIN_CHARS) continue;
    // A gap that is almost entirely comment is a license header, a doc block
    // the grammar left outside any declaration, or the prose between API
    // entries. Emitting it as a `module` chunk costs an embedding and returns
    // nothing a code query can use — measured on dsp's doc-heavy headers, 64
    // of the 72 remaining unnamed module chunks were this shape. Keep a gap
    // only when it carries enough code to be worth a row.
    if (commentLineRatio(text) > 0.75) continue;
    const startLine = rowOffsetAt(source, start) + 1;
    for (const piece of recursiveChunk(text, { chunkSize: chunkTarget, chunkOverlap: 0 })) {
      chunks.push(buildChunk({
        body: piece.text, filePath, language,
        symbolName: null, symbolType: 'module',
        startLine, endLine: startLine + countLines(piece.text) - 1,
        index: chunks.length,
      }));
    }
  }
}

/** Fraction of non-blank lines that open or continue a `//`, `/*` or `*`
 *  comment. Line-based on purpose: the gap text has no AST to consult. */
function commentLineRatio(text: string): number {
  let comment = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    total++;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) comment++;
  }
  return total === 0 ? 0 : comment / total;
}

/** Replace `#...` directive runs with spaces, preserving length and newlines. */
function maskPreprocessorDirectives(text: string): string {
  return text.replace(/^[ \t]*#[^\r\n]*/gm, (m) => ' '.repeat(m.length));
}

function rowOffsetAt(source: string, index: number): number {
  let rows = 0;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) rows++;
  return rows;
}

/**
 * Re-anchor a node from a gap-relative parse onto the original source.
 *
 * Indices shift by `gapStart`; rows shift by the gap's row offset (columns do
 * not — the gap starts at a line boundary). Child nodes are rebuilt lazily
 * from a bounded list so `namedChildren` keeps working for `chunkEndNode`
 * (Dart signatures), `splitLargeNode`, and the child-type scans, but the
 * tree-sitter handle itself is never retained: the tree is deleted after the
 * loop and a live handle would dangle into WASM memory.
 */
function offsetNode(node: any, source: string, gapStart: number, rowDelta: number, depth: number = 0): any {
  const fetchChild = (c: any): any => offsetNode(c, source, gapStart, rowDelta, depth + 1);
  const children = depth < MAX_RECOVERED_DEPTH
    ? Array.from(node.namedChildren ?? [], fetchChild)
    : [];
  const relocated: any = {
    type: node.type,
    startIndex: gapStart + node.startIndex,
    endIndex: gapStart + node.endIndex,
    startPosition: { row: node.startPosition.row + rowDelta, column: node.startPosition.column },
    endPosition: { row: node.endPosition.row + rowDelta, column: node.endPosition.column },
    namedChildren: children,
    namedChildCount: children.length,
    isExtra: node.isExtra,
    // extractSymbolName reads `.text` off the name node; the source slice is
    // the only thing that survives after the tree is deleted.
    get text(): string { return source.slice(this.startIndex, this.endIndex); },
  };
  // `childForFieldName` drives extractSymbolName (name/declaration/declarator/
  // definition) and splitLargeNode (body). Resolve every field EAGERLY, here,
  // while the tree is still alive: the caller deletes it as soon as the gap
  // loop finishes, and a lazy closure would then call into freed WASM memory
  // ("Out of bounds memory access", measured on zephyr's fff.h).
  const fields = new Map<string, any>();
  const byOriginal = new Map<any, any>();
  if (depth < MAX_RECOVERED_DEPTH) {
    const originals: any[] = Array.from(node.namedChildren ?? []);
    children.forEach((c: any, i: number) => { if (originals[i]) byOriginal.set(originals[i], c); });
  }
  for (const fieldName of RECOVERED_FIELD_NAMES) {
    const original = typeof node.childForFieldName === 'function' ? node.childForFieldName(fieldName) : null;
    if (!original) continue;
    fields.set(fieldName, byOriginal.get(original) ?? fetchChild(original));
  }
  relocated.childForFieldName = (name: string): any => fields.get(name) ?? null;
  return relocated;
}

/** The field names `extractSymbolName`, `unwrapDecorated` and `splitLargeNode`
 *  read off a node. Eager resolution in `offsetNode` needs the full list. */
const RECOVERED_FIELD_NAMES = ['name', 'declaration', 'declarator', 'definition', 'body'] as const;

/**
 * Post-pass that merges adjacent small chunks into larger chunks up to
 * `chunkTarget` tokens. Mirrors Chonkie's bisect_left approach: scan
 * chunks left-to-right, extend the current merge group with the next
 * chunk if doing so stays under the budget, otherwise close the group.
 *
 * Why: tree-sitter emits one chunk per top-level node. For languages
 * with many tiny declarations (Go imports, Python from-imports, JS
 * top-level consts), each chunk ends up 5-20 tokens and the embedding
 * cost dominates without any retrieval quality benefit. Merging lets
 * the chunker respect the user's chunkSizeTokens budget instead of
 * letting the file's AST dictate it.
 *
 * Merged chunks lose their individual symbolName (set to null) and get symbolType='merged', except a run holding a
 * #5001 `__module__` statement, which keeps that identity (code-module-chunks.ts). The header shows the line range
 * of the merged group. Single-chunk groups pass through unchanged.
 */
function mergeSmallSiblings(chunks: CodeChunk[], chunkTarget: number): CodeChunk[] {
  if (chunks.length <= 1) return chunks;
  // 15% of chunk target is "tiny". The intent is to catch runs of single-
  // line declarations (imports, const exports, typedefs) without collapsing
  // substantive classes/functions. A 3-method class body is typically
  // 80-200 tokens, well above 15% of 300 = 45 tokens → stays independent.
  const mergeThreshold = Math.floor(chunkTarget * 0.15);
  // v0.20.0 Cathedral II Layer 6 (A3): never merge chunks that carry
  // parent-scope metadata. They were emitted for a reason — retrieval
  // wants to surface them individually, not roll them up into a single
  // anonymous "merged" chunk. Skip applies both to the parent scope
  // header (empty parent path, but holds the class declaration) and to
  // nested leaves (non-empty parent path).
  const hasScopedChunks = chunks.some(c => (c.metadata.parentSymbolPath ?? []).length > 0);
  // #4511: merging nulls out symbolName, and code-def resolves names against
  // chunk rows, so a merged definition is unreachable — a flat file of short
  // top-level defs indexed to ZERO symbols (protection previously happened
  // only as a side effect of hasScopedChunks, which flat files never set).
  // Upstream intent is to merge import/const RUNS, not definitions — enforce
  // exactly that: a named definition never starts a merge group and is never
  // accumulated into one. The set is a derived view of code-def's DEF_TYPES
  // (def-types.ts), so the lookup allowlist and this guard cannot drift.
  const isDefChunk = (c: CodeChunk): boolean =>
    c.metadata.symbolName != null && !isModuleChunk(c) &&
    (MERGE_PROTECTED_SYMBOL_TYPES.has(c.metadata.symbolType) || c.metadata.definesFunction === true);
  const merged: CodeChunk[] = [];
  let i = 0;
  while (i < chunks.length) {
    const current = chunks[i]!;
    const currentTokens = estimateTokens(current.text);
    const currentIsScoped = (current.metadata.parentSymbolPath ?? []).length > 0;
    // If ANY chunk in this file participates in parent-scope emission, the
    // scope chunks + their siblings all pass through verbatim. A Python
    // class body's 3 × 10-token methods are each their own chunk on
    // purpose — merging would erase the (in ClassName) scope header
    // Layer 6 just added.
    if (currentTokens >= mergeThreshold || hasScopedChunks || currentIsScoped || isDefChunk(current)) {
      merged.push({ ...current, index: merged.length });
      i++;
      continue;
    }
    // Accumulate adjacent small chunks
    const group: CodeChunk[] = [current];
    let groupTokens = currentTokens;
    let j = i + 1;
    while (j < chunks.length) {
      const next = chunks[j]!;
      if (isDefChunk(next)) break; // #4511: never fold a definition into a run
      const nextTokens = estimateTokens(next.text);
      if (groupTokens + nextTokens > chunkTarget) break;
      group.push(next);
      groupTokens += nextTokens;
      j++;
    }
    if (group.length === 1) {
      merged.push({ ...current, index: merged.length });
    } else {
      merged.push(buildMergedChunk(group, merged.length));
    }
    i = j;
  }
  return merged;
}

/**
 * The structured header `buildChunk` prepends: "[Lang] path:N-M symbol\n\n".
 * It carries line numbers, so it is volatile across edits above a symbol —
 * `src/core/embed-reuse.ts` keys the embedding-reuse cache on the stripped body.
 */
export const CHUNK_HEADER_RE = /^\[[^\]]+\] [^\n]+\n\n/;

/** Chunk text minus its header, or unchanged when there is no header. */
export function stripChunkHeader(text: string): string {
  return text.replace(CHUNK_HEADER_RE, '');
}

function buildMergedChunk(group: CodeChunk[], index: number): CodeChunk {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  // Strip each chunk's structured header line when merging so the combined
  // body reads like the original source. Header is always "[Lang] path:N-M symbol".
  const bodies = group.map((c) => stripChunkHeader(c.text));
  const mergedBody = bodies.join('\n\n');
  const header = `[${displayLang(first.metadata.language)}] ${first.metadata.filePath}:${first.metadata.startLine}-${last.metadata.endLine} merged (${group.length} siblings)`;
  return {
    index,
    text: `${header}\n\n${mergedBody}`,
    metadata: {
      ...mergedRunSymbol(group),
      filePath: first.metadata.filePath,
      language: first.metadata.language,
      startLine: first.metadata.startLine,
      endLine: last.metadata.endLine,
      parentSymbolPath: [],
    },
  };
}

/**
 * Final safety net: guarantee no emitted chunk exceeds the embedder's context
 * budget. tree-sitter splitting (splitLargeNode) can only break up a node that
 * exposes a `body` with >= 2 named children. A node without one — a giant
 * object/array literal, a single huge assignment, a massive template literal —
 * is emitted whole, producing a chunk far larger than the embedder accepts.
 * The embedder then rejects it ("input exceeds context length") and the chunk
 * is never embedded. Recursively re-split any over-budget chunk; fall back to a
 * hard character split for pathological no-whitespace content (e.g. a minified
 * one-liner) where word/line splitting can't get under budget.
 */
function capOversizedChunks(
  chunks: CodeChunk[],
  filePath: string,
  language: SupportedCodeLanguage,
  opts: CodeChunkOptions,
): CodeChunk[] {
  const cap = opts.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;
  if (!chunks.some((c) => estimateEmbedTokens(c.text) > cap)) return chunks;
  const out: CodeChunk[] = [];
  for (const c of chunks) {
    if (estimateEmbedTokens(c.text) <= cap) {
      out.push({ ...c, index: out.length });
      continue;
    }
    // Strip the structured header ("[Lang] path:N-M symbol\n\n") so the splitter
    // works on the raw body; buildChunk re-adds a header to each piece. The
    // re-added header costs tokens too — budget for it, or every piece split
    // to exactly `cap` re-emerges a header's-worth over it (measured: a 2,000
    // cap emitted 2,011-token fence chunks when the body alone was capped).
    // The reservation must be an UPPER bound on the header's contribution:
    // estimateEmbedTokens is super-additive across a mixed-script join, so the
    // header's standalone cl100k figure under-counts ~2.5x once the body
    // contains CJK and the weighted branch takes over (see
    // estimateEmbedTokensCeiling).
    const headerMatch = c.text.match(CHUNK_HEADER_RE);
    const body = headerMatch ? c.text.slice(headerMatch[0].length) : c.text;
    const bodyCap = Math.max(1, cap - (headerMatch ? estimateEmbedTokensCeiling(headerMatch[0]) : 0));
    for (const piece of splitToTokenBudget(body, bodyCap, opts)) {
      if (!piece.trim()) continue;
      out.push(buildChunk({
        body: piece,
        filePath,
        language,
        symbolName: c.metadata.symbolName,
        symbolType: c.metadata.symbolType,
        startLine: c.metadata.startLine,
        endLine: c.metadata.endLine,
        index: out.length,
        parentSymbolPath: c.metadata.parentSymbolPath,
      }));
    }
  }
  return out;
}

/** Split `text` into pieces each estimated <= cap tokens. Word/line-aware
 *  (recursiveChunk) first; a hard character split is the last resort for
 *  content with no whitespace to break on. */
function splitToTokenBudget(text: string, cap: number, opts: CodeChunkOptions): string[] {
  const out: string[] = [];
  const pieces = recursiveChunk(text, {
    chunkSize: opts.fallbackChunkSizeWords ?? 300,
    chunkOverlap: opts.fallbackOverlapWords ?? 50,
  }).map((p) => p.text);
  // Hard-split budget is derived from each piece's own measured density
  // (chars per estimated token) scaled to the cap, not a fixed chars-per-
  // token guess: the previous 3.5 chars/token ASCII assumption undercuts
  // URL-dense JSON (~2.6 chars/token measured), leaving 2,070–2,095-token
  // slices past a 2,000 cap. Slices are re-measured and re-derived (density
  // varies within a piece), so the cap holds by construction.
  const hardSplit = (p: string): void => {
    const est = estimateEmbedTokens(p);
    if (est <= cap) {
      out.push(p);
      return;
    }
    const charBudget = Math.max(1, Math.floor((p.length * cap) / est));
    if (charBudget >= p.length) {
      out.push(p); // 1-char floor on a tiny cap — nothing left to split
      return;
    }
    // Even out the slice width instead of striding by charBudget and shedding
    // `p.length mod charBudget` as a standalone piece at EVERY recursion
    // level: buildChunk re-headers each remainder into its own embedding row,
    // so a 14.4K fence emitted 5 chunks of 50-86 chars (and, deeper in the
    // recursion, 3-char slivers) alongside its real content. Evening is free —
    // the piece count is ceil(length / charBudget) either way, so the same
    // content is spread over the same number of chunks — and width <=
    // charBudget by construction, so the token budget still holds.
    //
    // The width is re-derived from what REMAINS on every step rather than
    // fixed up front, because safeSplitIndex can back a cut off by up to two
    // units and a fixed width lets that drift accumulate into a tail runt
    // (measured on an all-astral blob: 4-unit chunks trailing 724-unit ones).
    let i = 0;
    while (i < p.length) {
      const remaining = p.length - i;
      const partsLeft = Math.ceil(remaining / charBudget);
      // `i === 0` cannot recurse on the whole piece — charBudget < p.length is
      // checked above, so partsLeft >= 2 on the first step. The guard keeps a
      // degenerate budget from looping instead of terminating.
      if (partsLeft <= 1) {
        if (i === 0) out.push(p);
        else hardSplit(p.slice(i));
        return;
      }
      // The budget is derived from measured density, so it has arbitrary
      // parity: a raw slice at `i + width` orphans a UTF-16 surrogate half.
      // safeSplitIndex backs the cut off a pair (#2011 — a lone surrogate is
      // rejected by Postgres inside a ::jsonb cast and aborts the whole batch).
      const end = safeSplitIndex(p, i + Math.ceil(remaining / partsLeft));
      if (end <= i) {
        // Degenerate width (a 1-char budget backing off a surrogate pair) —
        // emit rather than drop, and never re-enter on the same string.
        if (i === 0) out.push(p);
        else hardSplit(p.slice(i));
        return;
      }
      hardSplit(p.slice(i, end));
      i = end;
    }
  };
  for (const piece of pieces) hardSplit(piece);
  return out;
}

// ---------- Internals ----------

function fallbackChunks(
  source: string,
  filePath: string,
  language: SupportedCodeLanguage,
  opts: CodeChunkOptions,
): CodeChunk[] {
  const size = opts.fallbackChunkSizeWords ?? 300;
  const overlap = opts.fallbackOverlapWords ?? 50;
  const chunks = recursiveChunk(source, { chunkSize: size, chunkOverlap: overlap }).map((chunk, index) =>
    buildChunk({
      body: chunk.text, filePath, language,
      symbolName: null, symbolType: 'module',
      startLine: 1, endLine: countLines(chunk.text),
      index,
    }),
  );
  // Route every fallback emission through the oversize net. Previously only
  // the empty-AST branch wrapped its fallback in capOversizedChunks — the
  // no-language, parse-timeout, no-semantic-nodes (every JSON/YAML fence:
  // their node types aren't in TOP_LEVEL_TYPES) and parse-throw branches
  // shipped word-counted chunks unchecked, and the word pipeline undercounts
  // exactly the dense content (JSON, minified, CJK-mixed) that overflows
  // embedders. Hoisting the cap here covers all five paths at once.
  return capOversizedChunks(chunks, filePath, language, opts);
}

function buildChunk(input: {
  body: string;
  filePath: string;
  language: SupportedCodeLanguage;
  symbolName: string | null;
  symbolType: string;
  startLine: number;
  endLine: number;
  index: number;
  /** v0.20.0 Cathedral II Layer 6: non-empty when nested inside a parent. */
  parentSymbolPath?: string[];
}): CodeChunk {
  const symbol = input.symbolName ? `${input.symbolType} ${input.symbolName}` : input.symbolType;
  const parentPath = input.parentSymbolPath && input.parentSymbolPath.length > 0
    ? ` (in ${input.parentSymbolPath.join('.')})`
    : '';
  const header = `[${displayLang(input.language)}] ${input.filePath}:${input.startLine}-${input.endLine} ${symbol}${parentPath}`;
  // v0.20.0 Cathedral II Layer 5 (A1): fold the qualified name into
  // metadata so edge extraction has a stable identity key.
  const qualified = moduleChunkQualifiedName(input) ?? buildQualifiedName({
    language: input.language,
    symbolName: input.symbolName,
    symbolType: input.symbolType,
    parentSymbolPath: input.parentSymbolPath ?? [],
  });
  return {
    index: input.index,
    text: `${header}\n\n${input.body}`,
    metadata: {
      symbolName: input.symbolName,
      symbolType: input.symbolType,
      filePath: input.filePath,
      language: input.language,
      startLine: input.startLine,
      endLine: input.endLine,
      parentSymbolPath: input.parentSymbolPath ?? [],
      symbolNameQualified: qualified,
    },
  };
}

/**
 * v0.20.0 Cathedral II Layer 6 (A3) helper: find the nestable-parent
 * node to expand. Returns `node` itself when it matches config.parentTypes,
 * or its first descendant that does — unwraps TS/JS `export_statement`,
 * `export_default_declaration`, etc. Returns null when nothing nestable
 * found.
 */
function findNestableParent(node: any, config: NestedEmitConfig | undefined): any | null {
  if (!config) return null;
  if (config.parentTypes.has(node.type)) return node;
  // #3821: a decorated Python class (`@dataclass class Config`) wraps the
  // class_definition in decorated_definition. Return the OUTER node so the
  // scope-header chunk's range keeps the decorator text; emitNestedScoped
  // unwraps for name/type/children.
  if (config.parentTypes.has(unwrapDecorated(node).type)) return node;
  // One-level unwrap — TS export_statement wraps a class_declaration.
  // We don't go deeper because that would accidentally treat a method
  // inside a class as a top-level parent.
  for (const child of node.namedChildren) {
    if (config.parentTypes.has(child.type)) return child;
  }
  return null;
}

/**
 * v0.20.0 Cathedral II Layer 6 (A3) helper: collect immediate nested
 * children matching the language's nested-emit config. Descends only
 * through body-style wrappers (class_body, module_body, etc.) which are
 * grammar-level container nodes, not symbols themselves.
 */
function collectImmediateNestedChildren(node: any, config: NestedEmitConfig): {
  parents: any[]; // children that are themselves parentTypes (recurse)
  leaves: any[];  // children that are childTypes (methods)
} {
  const parents: any[] = [];
  const leaves: any[] = [];
  const scan = (n: any) => {
    for (const child of n.namedChildren) {
      if (config.parentTypes.has(child.type)) parents.push(child);
      else if (config.childTypes.has(child.type)) leaves.push(child);
      if (BODY_NODE_TYPES.has(child.type) || child.type.endsWith('_body')) {
        scan(child);
      }
    }
  };
  scan(node);
  return { parents, leaves };
}

/**
 * v0.20.0 Cathedral II Layer 6 (A3): recursively emit a nested parent
 * node and its children. Walks the parent chain, pushing chunks onto
 * `chunks` as it goes. Call with parentPath=[] at the top level.
 *
 * Each parent gets a slim "scope header" chunk (declaration line +
 * member list). Each leaf (method) gets its own chunk with the full
 * parentPath populated. Nested parents recurse with the parent chain
 * extended by the enclosing parent's name.
 */
function emitNestedScoped(
  node: any,
  parentPath: string[],
  source: string,
  filePath: string,
  language: SupportedCodeLanguage,
  config: NestedEmitConfig,
  chunks: CodeChunk[],
): void {
  const name = extractSymbolName(node);
  if (!name) return;
  // #3821: unwrap decorated_definition for type + child collection (the
  // class body hangs off the inner def); ranges below stay on `node` so a
  // decorated class's scope header keeps its decorator line.
  const def = unwrapDecorated(node);
  const symbolType = normalizeSymbolType(def.type);
  const { parents, leaves } = collectImmediateNestedChildren(def, config);

  // Parent scope-header chunk: declaration + member digest.
  const digestNames = [
    ...parents.map(p => extractSymbolName(p)).filter((n): n is string => Boolean(n)),
    ...leaves.map(l => extractSymbolName(l)).filter((n): n is string => Boolean(n)),
  ];
  chunks.push(buildChunk({
    body: buildScopeHeaderBody(node, source, digestNames, def),
    filePath, language, symbolName: name, symbolType,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    index: chunks.length,
    parentSymbolPath: [...parentPath],
  }));

  const newParentPath = [...parentPath, name];

  // Recursively expand nested parents (e.g. module Admin → class Users).
  for (const p of parents) {
    emitNestedScoped(p, newParentPath, source, filePath, language, config, chunks);
  }

  // Leaf children: methods / functions / fields. #3821: a decorated method
  // is a decorated_definition leaf — type from the inner def, range from the
  // outer node so the decorator line ships in the chunk.
  for (const leaf of leaves) {
    const leafName = extractSymbolName(leaf);
    const leafType = normalizeSymbolType(unwrapDecorated(leaf).type);
    const leafText = source.slice(leaf.startIndex, leaf.endIndex).trim();
    if (!leafText) continue;
    chunks.push(buildChunk({
      body: leafText, filePath, language,
      symbolName: leafName, symbolType: leafType,
      startLine: leaf.startPosition.row + 1,
      endLine: leaf.endPosition.row + 1,
      index: chunks.length,
      parentSymbolPath: newParentPath,
    }));
  }
}

/**
 * Build a slim scope-header body for a parent chunk. The full method
 * bodies land in their own nested chunks, so the parent just needs the
 * declaration line + a digest of member names so class-level queries
 * still hit something.
 */
function buildScopeHeaderBody(node: any, source: string, memberNames: string[], declNode: any = node): string {
  const full = source.slice(node.startIndex, node.endIndex);
  // #3821: when `node` is a decorated_definition wrapper, `declNode` is the
  // inner def — the declaration must run THROUGH the def's first line so a
  // decorated class header reads "@dataclass\nclass Config:" instead of
  // stopping at the bare decorator line.
  const declOffset = Math.max(0, (declNode?.startIndex ?? node.startIndex) - node.startIndex);
  const firstLineBreak = full.indexOf('\n', declOffset);
  const declaration = firstLineBreak > 0 ? full.slice(0, firstLineBreak) : full.slice(0, declOffset + 120);
  if (memberNames.length === 0) return declaration;
  return `${declaration}\n\n// Members: ${memberNames.slice(0, 20).join(', ')}`;
}

interface SplitRange {
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

function splitLargeNode(node: any, source: string, chunkTarget: number): SplitRange[] {
  // #3821: a large decorated def's body hangs off the INNER definition —
  // dive through the wrapper or the splitter finds no body and emits whole.
  const inner = unwrapDecorated(node);
  const body =
    inner.childForFieldName('body') ||
    inner.namedChildren.find((c: any) => BODY_NODE_TYPES.has(c.type)) ||
    null;

  if (!body || body.namedChildren.length < 2) return [];

  const children = body.namedChildren.filter((c: any) => !c.isExtra);
  if (children.length < 2) return [];

  const ranges: SplitRange[] = [];
  let curStart = children[0].startIndex;
  let curStartLine = children[0].startPosition.row + 1;
  let curEnd = children[0].endIndex;
  let curEndLine = children[0].endPosition.row + 1;
  let curTokens = estimateTokens(source.slice(curStart, curEnd));

  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    const childTokens = estimateTokens(source.slice(child.startIndex, child.endIndex));

    if (curTokens + childTokens > Math.ceil(chunkTarget * 1.5)) {
      ranges.push({ startIndex: curStart, endIndex: curEnd, startLine: curStartLine, endLine: curEndLine });
      curStart = child.startIndex;
      curStartLine = child.startPosition.row + 1;
      curEnd = child.endIndex;
      curEndLine = child.endPosition.row + 1;
      curTokens = childTokens;
    } else {
      curEnd = child.endIndex;
      curEndLine = child.endPosition.row + 1;
      curTokens += childTokens;
    }
  }
  ranges.push({ startIndex: curStart, endIndex: curEnd, startLine: curStartLine, endLine: curEndLine });
  return ranges;
}

function extractSymbolName(node: any): string | null {
  // SQL (DerekStride): the chunk node is `statement` wrapping a single inner
  // child whose type is the actual statement kind. Dive in to find the target
  // identifier. DML statements (select/insert/update/delete) deliberately
  // return null so their chunks emit unnamed — code-def is a DDL signal.
  // The `statement` wrapper is unique to SQL among gbrain's 37 grammars
  // (Step 0 inspection 2026-05-24); checking by node.type is safe.
  if (node.type === 'statement' && node.namedChildCount === 1) {
    const sqlName = extractSqlSymbolName(node.namedChild(0));
    if (sqlName !== undefined) return sqlName;
  }

  const directName = node.childForFieldName('name');
  if (directName?.text?.trim()) return sanitize(directName.text);

  const declaration = node.childForFieldName('declaration');
  if (declaration) {
    const nested = extractSymbolName(declaration);
    if (nested) return nested;
  }

  // #3821: Python decorated_definition exposes the wrapped def via field
  // 'definition' (mirrors the TS export_statement 'declaration' dive above).
  const definition = node.childForFieldName('definition');
  if (definition) {
    const nested = extractSymbolName(definition);
    if (nested) return nested;
  }

  // Local port: C/C++ function_definition stores the function name below the
  // `declarator` field (function_declarator -> declarator -> identifier),
  // rather than exposing a direct `name` field. Resolve only declarator
  // wrappers here so a type/declaration node cannot donate an unrelated
  // identifier as the symbol name.
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    const nested = extractSymbolName(declarator);
    if (nested) return nested;
  }

  for (const child of node.namedChildren) {
    if (child.type.endsWith('identifier') || child.type === 'constant') {
      const v = sanitize(child.text);
      if (v) return v;
    }
  }

  // #3789: declaration wrappers hold the identifier one level down —
  // Kotlin  `property_declaration > variable_declaration > simple_identifier`,
  // TS/JS   `lexical_declaration > variable_declarator` (field: name),
  // Go      `type_declaration > type_spec` / `const_declaration > const_spec`
  //         / `var_declaration > var_spec` (field: name),
  // C/C++   `declaration > init_declarator` (identifier child).
  // Without this dive those chunks carry symbol_name NULL, so code-def can
  // never surface them even with their symbol_type in DEF_TYPES. Dive is
  // restricted to these wrapper kinds only — an arbitrary expression child
  // must never donate a false name.
  for (const child of node.namedChildren) {
    if (NAME_WRAPPER_TYPES.has(child.type)) {
      const nested = extractSymbolName(child);
      if (nested) return nested;
    }
  }
  return null;
}

// See the wrapper dive in extractSymbolName (#3789).
const NAME_WRAPPER_TYPES = new Set([
  'variable_declaration', 'variable_declarator', 'init_declarator',
  'type_spec', 'const_spec', 'var_spec',
]);

// SQL-specific symbol extractor. Returns:
//   string — DDL statement: extracted target name (table/function/view/index/etc).
//   null   — DDL statement type, but name extraction failed (edge fixture).
//   undefined — fall through to generic extractor (not a recognized SQL kind).
//
// DerekStride/tree-sitter-sql exposes the target identifier via the `name`
// field on most create_* nodes; `alter_table` puts it in a separate field.
// DML kinds (select/insert/update/delete) deliberately return null —
// gbrain's code-def is a DDL retrieval signal, not a DML one.
function extractSqlSymbolName(inner: any): string | null | undefined {
  const t = inner.type;
  // DDL: extract identifier name. Tried `name` field first (most common shape),
  // then any `object_reference` / `identifier` child.
  const DDL_KINDS = new Set([
    'create_table', 'create_view', 'create_index', 'create_function',
    'create_procedure', 'create_type', 'create_schema', 'create_database',
    'create_trigger', 'alter_table', 'alter_view',
  ]);
  if (DDL_KINDS.has(t)) {
    const nameField = inner.childForFieldName?.('name');
    if (nameField?.text?.trim()) return sanitize(nameField.text);
    // Fallback: first identifier-like named child.
    for (let i = 0; i < (inner.namedChildCount || 0); i++) {
      const c = inner.namedChild(i);
      if (c.type === 'object_reference' || c.type === 'identifier' || c.type.endsWith('_identifier')) {
        const v = sanitize(c.text);
        if (v) return v;
      }
    }
    return null;
  }
  // DML: explicitly null (chunk emits unnamed; code-def doesn't fire).
  if (t === 'select' || t === 'insert' || t === 'update' || t === 'delete' ||
      t === 'merge' || t === 'with') {
    return null;
  }
  return undefined;
}

function normalizeSymbolType(type: string): string {
  if (type.includes('function') || type === 'method' || type === 'singleton_method') return 'function';
  if (type.includes('class')) return 'class';
  if (type.includes('interface')) return 'interface';
  if (type.includes('type_alias')) return 'type';
  if (type.includes('enum')) return 'enum';
  if (type.includes('module')) return 'module';
  if (type.includes('import')) return 'import';
  if (type === 'create_table' || type === 'alter_table') return 'table';
  if (type === 'create_view' || type === 'alter_view') return 'view';
  if (type === 'create_index') return 'index';
  if (type === 'create_procedure') return 'procedure';
  if (type === 'create_type') return 'type';
  if (type === 'create_schema') return 'schema';
  if (type === 'create_database') return 'database';
  if (type === 'create_trigger') return 'trigger';
  return type.replace(/_/g, ' ');
}

function sanitize(name: string): string {
  return name.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// v0.20.0 Cathedral II Layer 4: display name derived from the language
// manifest. Single source of truth — adding a new language via
// registerLanguage() automatically exposes its displayName to chunk
// headers without a parallel DISPLAY_LANG edit.
function displayLang(lang: SupportedCodeLanguage): string {
  const entry = getLanguageEntry(lang);
  return entry?.displayName ?? lang;
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

// ---------- Tree-sitter init ----------

async function ensureInit(): Promise<void> {
  if (initDone) return;
  if (!initPromise) {
    initPromise = (async () => {
      const P = await getParser();
      // v0.22.x: init takes locateFile for the WASM module.
      // TREE_SITTER_WASM is a path resolved by Bun's embedded-file loader — it
      // points at the real file in dev, and the bundler-synthesized path in
      // the compiled binary. Either way tree-sitter can read it.
      await (P as any).init({ locateFile: () => TREE_SITTER_WASM });
      initDone = true;
    })();
  }
  await initPromise;
}

async function loadLanguage(language: SupportedCodeLanguage): Promise<any> {
  if (languageCache.has(language)) return languageCache.get(language);
  const entry = getLanguageEntry(language);
  if (!entry) {
    throw new Error(`No grammar entry for language: ${language}`);
  }
  const P = await getParser();
  // Resolve grammar source: embedded path wins if set (zero-cost path for
  // the 29 core grammars that ship in every bun --compile binary). Lazy
  // loader fallback for registered-at-runtime languages (tree-sitter-wasms
  // npm resolution, user extensions via registerLanguage).
  let grammarSource: string | Uint8Array;
  if (entry.embeddedPath) {
    grammarSource = entry.embeddedPath;
  } else if (entry.lazyLoader) {
    grammarSource = await entry.lazyLoader();
  } else {
    throw new Error(`Language entry for ${language} has neither embeddedPath nor lazyLoader`);
  }
  const lang = await (P as any).Language.load(grammarSource);
  languageCache.set(language, lang);
  return lang;
}
