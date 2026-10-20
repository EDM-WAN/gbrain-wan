export interface PrefixEnumeration {
  prefix: string
  source: 'question' | 'context' | 'subtree'
}

/**
 * Directory-level questions need breadth, not a few very large file excerpts.
 * Keep this classifier deliberately narrow so explicit "extract this file"
 * requests retain the deeper single-file context path.
 */
export function isPrefixOverviewQuestion(question: string): boolean {
  const hasDirectoryWord = /(?:文件夹|目录|folder|directory|dir)/iu.test(question)
  const asksForPurpose = /(?:功能|作用|用途|实现什么|做什么|干什么|包括哪些|包含哪些|purpose|what does|what is .* for|capabilit)/iu.test(question)
  return hasDirectoryWord && asksForPurpose
}

/** Bounded enumeration budget: breadth mode distributes context across the
 * directory; detail mode preserves the original larger per-page window. */
// Keep the overview under the normal think context budget: directory questions
// need breadth, but sending 30K+ chars makes the synthesis noticeably slower.
// 450 chars × ~36 scripts pages is enough for representative excerpts plus the
// complete file list while staying close to the normal think evidence budget.
export const PREFIX_OVERVIEW_TOTAL_BUDGET_CHARS = 16_000
export const PREFIX_OVERVIEW_PAGE_MAX_CHARS = 450

const PREFIX_PATTERN = /(?:以|按)\s*[“"']?([a-z0-9][a-z0-9_./-]*)[”"']?\s*开头(?:的(?:文件|页面|内容|条目|文档)?|文件|页面|内容|条目|文档)?/iu
const ENGLISH_PREFIX_PATTERN = /(?:files?|pages?|slugs?|documents?)\s+(?:starting\s+with|prefixed\s+by)\s*[“"']?([a-z0-9][a-z0-9_./-]*)/i
const SUBTREE_PATTERN = /(?:source|来源|仓库|repo(?:sitory)?)?\s*[“"']?[a-z0-9][a-z0-9_-]*[”"']?\s*(?:source|来源|仓库|repo(?:sitory)?)?\s*(?:下|下面|中的|里(?:面)?|目录中|directory|under)\s*[“"']?([a-z0-9][a-z0-9_./-]*)[”"']?/iu
const COMPACT_SUBTREE_PATTERN = /[a-z0-9][a-z0-9_-]*这个(?:source|来源|仓库|repo(?:sitory)?)下(?:的)?[“”']?([a-z0-9][a-z0-9_./-]*)[“”']?/iu
// The Web selector supplies source_id separately, so users naturally say
// “当前 source 下的 scripts”. This wording has no source id token for the
// older generic pattern to anchor on; keep it deterministic rather than
// sending a known folder request through semantic vector retrieval.
const CURRENT_SOURCE_SUBTREE_PATTERN = /(?:当前|这个|所选(?:择)?|选中(?:的)?)\s*(?:source|来源|仓库|repo(?:sitory)?)\s*(?:下|下面|中的|里(?:面)?|目录中|directory|under)\s*(?:的)?\s*[“”']?([a-z0-9][a-z0-9_./-]*)[“”']?/iu
// A selected source is already supplied out-of-band by the Web selector, so
// follow-up questions commonly omit the source name: “总结一下 sdk 这个
// 文件夹内的内容”. Treat the named directory as a deterministic prefix;
// otherwise this natural-language wrapper has no useful vector token.
const DIRECTORY_CONTENT_PATTERN = /[“"']?([a-z0-9][a-z0-9_./-]*)[”"']?\s*(?:这个\s*)?(?:文件夹|目录|folder|directory|dir)\s*(?:内|中|下面|里(?:面)?|的)?/iu
const ENGLISH_SUBTREE_PATTERN = /(?:in|under|within)\s+(?:the\s+)?(?:source|repository|repo)\s*(?:directory\s*)?(?:path\s*)?[“"']?([a-z0-9][a-z0-9_./-]*)[”"']?/i
const ENGLISH_DIRECTORY_SUBTREE_PATTERN = /(?:the\s+)?([a-z0-9][a-z0-9_./-]*)\s+directory\s+(?:in|under|within)\s+(?:the\s+)?(?:source|repository|repo)/i

function normalizePrefix(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^['"“”]+|['"“”]+$/g, '')
}

const STRUCTURE_WORD_RE = /(?:source|来源|仓库|repo(?:sitory)?)/iu

/** 从"X 文件夹中的 Y 文件夹"这类问法里提取最具体的一级目录名。
 *
 * 用户问嵌套目录时通常关心最深/最具体的那个（"source 文件夹中的 example
 * 文件夹是干啥的" → example）。结构词（source/来源/仓库/repo）只是指向当前
 * 检索范围，不应当作目录名来枚举。在没有 文件夹/目录/folder 标记时返回 null，
 * 交回给语义检索，避免把任意名词误判成前缀。
 *
 * 两种形态都需要覆盖：
 *   1. "X 文件夹中的 Y 文件夹" —— 两个都带标记，取最后（最具体）的 Y。
 *   2. "X 目录/文件夹 下/里 (的) Y" —— 目标 Y 往往是裸名词（不带 文件夹 标记），
 *      此时取介词（下/里/内/中）后面的 Y，而不是带标记的 X。
 */
function extractDirectoryName(question: string): string | null {
  const markers = /(?:文件夹|目录|folder|directory|dir)/iu
  if (!markers.test(question)) return null

  // 形态 2：X <文件夹/目录> <下|里|内|中|里面> (的) Y —— Y 才是目标目录。
  // 匹配"Y"前允许以 source/来源 等结构词作范围前缀；Y 是文件名安全的裸名词。
  const nested = question.match(
    // 前缀(可选结构词) + X(任意文件夹标记) + 介词 + (的)? + Y
    /(?:[“”"']?[a-z0-9][a-z0-9_./-]*[””"']?\s*(?:这个\s*)?(?:文件夹|目录|folder|directory|dir)\s*(?:中|里(?:面)?|内|下|下面|之中|的| inside| under| within)\s*(?:的)?\s*)([a-z0-9][a-z0-9_./-]*)/iu,
  )
  if (nested?.[1] && !STRUCTURE_WORD_RE.test(normalizePrefix(nested[1]))) {
    return normalizePrefix(nested[1])
  }

  // 形态 1：收集所有 "XXXX文件夹" / "XXXX 文件夹" 形式的候选名，取最后一个非结构词。
  const candidates: string[] = []
  const re = /[“"']?([a-z0-9][a-z0-9_./-]*)[”"']?\s*(?:这个\s*)?(?:文件夹|目录|folder|directory|dir)/giu
  let m: RegExpExecArray | null
  while ((m = re.exec(question)) !== null) {
    const name = normalizePrefix(m[1])
    // 结构词跳过：source/来源/仓库/repo 表示"当前范围"，不是具体目录。
    if (!STRUCTURE_WORD_RE.test(name)) candidates.push(name)
  }
  // 取最后一个（最具体）。若全部是结构词，回退到 DIRECTOR 语义（现有行为由调用方决定）。
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null
}

/**
 * Detect deterministic slug-prefix enumeration requests. This intentionally
 * accepts only a small filename-safe alphabet; arbitrary prose must continue
 * through semantic retrieval rather than becoming a broad SQL prefix query.
 */
export function detectPrefixEnumeration(question: string, context = ''): PrefixEnumeration | null {
  const direct = question.match(PREFIX_PATTERN) ?? question.match(ENGLISH_PREFIX_PATTERN)
  if (direct?.[1]) return { prefix: normalizePrefix(direct[1]), source: 'question' }
  // 嵌套目录问法优先：取最具体的目录名（排除 source/来源/仓库 这类结构词）。
  const nestedDir = extractDirectoryName(question)
  if (nestedDir) return { prefix: nestedDir, source: 'subtree' }
  const subtree = question.match(CURRENT_SOURCE_SUBTREE_PATTERN) ?? question.match(DIRECTORY_CONTENT_PATTERN) ?? question.match(ENGLISH_DIRECTORY_SUBTREE_PATTERN) ?? question.match(SUBTREE_PATTERN) ?? question.match(ENGLISH_SUBTREE_PATTERN)
  if (subtree?.[1]) return { prefix: normalizePrefix(subtree[1]), source: 'subtree' }

  // A short follow-up such as “以 error 开头的呢” may be phrased without the
  // noun after the prefix. Reuse only a prefix-shaped expression from the
  // current conversation context; the latest question still controls intent.
  if (context && /^(?:\s*(?:以|按)\s*)/u.test(question)) {
    const inherited = context.match(PREFIX_PATTERN) ?? context.match(ENGLISH_PREFIX_PATTERN)
    if (inherited?.[1]) return { prefix: normalizePrefix(inherited[1]), source: 'context' }
  }
  return null
}

/** Page slugs in the imported wiki source are rooted under wiki/. */
export function prefixCandidates(prefix: string, opts: { preferExact?: boolean } = {}): string[] {
  const normalized = normalizePrefix(prefix)
  if (!normalized) return []
  if (normalized.includes('/')) return [normalized]
  if (opts.preferExact) {
    // subtree/目录问法:优先精确目录名,同时携带 source- 前缀变体 ——
    // 代码源(如 dsp)的 slug 形如 source-example-example_gdma-...,必须以
    // source- 为前缀才能枚举到;无 source- 变体时纯 `example` 枚举不到任何页。
    return Array.from(new Set([`source-${normalized}`, `wiki/${normalized}`, normalized]))
  }
  const candidates = [`wiki/${normalized}`, `source-${normalized}`, `source/${normalized}`, normalized]
  // Common three-r spelling in “Errror” is handled as a bounded fallback only;
  // exact user prefixes remain first and arbitrary fuzzy matching is avoided.
  if (normalized === 'errror') candidates.push('wiki/error', 'error')
  return Array.from(new Set(candidates))
}
