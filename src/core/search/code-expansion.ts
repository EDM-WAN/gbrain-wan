/**
 * Code-vocabulary query expansion.
 *
 * `expandQuery` (expansion.ts) runs the generic document-retrieval prompt:
 * "rewrite into 3-4 related queries". Measured on a real dsp question —
 * 「新增一个自定义 shell 命令来打印某个计数器」 — that prompt returns three
 * CHINESE restatements of the question, which is exactly what the semantic
 * arm already has. The gap it was meant to close is the opposite one: the
 * answer lives in C source, so retrieval needs ENGLISH CODE VOCABULARY
 * (`heapdump`, `COMMAND_TABLE`, `counter`) that the prose never contains.
 *
 * This variant asks for identifiers instead of restatements. It is opt-in per
 * call site and never replaces `expandQuery` for document brains.
 *
 * Security notes mirror expansion.ts: the prompt-injection sanitizer runs
 * before the LLM call and every line of output is passed through the same
 * `sanitizeExpansionOutput` validator, so an injected rewrite can never reach
 * the SQL layer unfiltered.
 */

import { chat as gatewayChat, isAvailable as gatewayIsAvailable } from '../ai/gateway.ts';
import { sanitizeExpansionOutput } from './expansion.ts';

/** Output shape: one line per rewrite, no JSON — a JSON contract on an
 *  openai-compatible endpoint is the exact failure mode gateway.expand()
 *  documents at length, and a plain list is trivially parsed. */
const CODE_EXPANSION_SYSTEM = [
  'You rewrite search queries for a CODE search engine.',
  'The engine searches indexed source files: C/C++/Rust/TypeScript functions,',
  'structs, macros, shell command tables and file paths.',
  '',
  'Given a question (possibly in Chinese), output 3 rewritten queries that would',
  'match the SOURCE CODE that answers it. Rules:',
  '- Use ENGLISH identifiers, keywords and type names as they typically appear',
  '  in code, not a translation of the question (e.g. 打印->print is useless;',
  '  guess the real API name, macro, struct or command instead).',
  '- Name plausible FILE names and DIRECTORY names (heap_test.c, shell_cmd.c).',
  '- Every line must be useful on its own; they should cover DIFFERENT guesses.',
  '- Output nothing but the 3 lines. No numbering, no quotes, no commentary.',
].join('\n');

const MAX_CODE_EXPANSIONS = 3;
const MAX_LINE_CHARS = 200;

/**
 * Expand a question into code-vocabulary rewrites. Always includes the
 * original query as entry 0 (hybridSearch's `expandFn` contract). Fails open
 * to `[query]` — a dead expansion provider must never break retrieval.
 */
export async function expandQueryForCode(query: string): Promise<string[]> {
  if (!query.trim()) return [query];
  if (!gatewayIsAvailable('expansion')) return [query];

  try {
    const result = await gatewayChat({
      system: CODE_EXPANSION_SYSTEM,
      messages: [{ role: 'user', content: query }],
      maxTokens: 300,
      temperature: 0,
    });
    const lines = result.text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*\d]+[.)]?\s*)/, '').trim())
      .filter((line) => line.length > 0 && line.length <= MAX_LINE_CHARS);
    return [query, ...sanitizeExpansionOutput(lines).slice(0, MAX_CODE_EXPANSIONS)];
  } catch {
    return [query];
  }
}
