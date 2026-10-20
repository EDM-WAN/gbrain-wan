const LEADING_REQUEST_PATTERN = /^\s*(?:请(?:帮我|你)?\s*)?(?:总结(?:一下)?|概括(?:一下)?|介绍(?:一下)?|解释(?:一下)?|说明(?:一下)?|提取(?:一下)?(?:内容)?|查看(?:一下)?|查询|查找|找出|列出(?:所有)?)(?:\s*[:：，,]|\s*)/iu
const ENGLISH_REQUEST_PATTERN = /^\s*(?:please\s+)?(?:summarize|summary\s+of|explain|describe|extract|show\s+me|find)\s+/i

/**
 * Remove common answer-intent wrappers before lexical/title retrieval.
 * The original question is still sent to synthesis; this is only the search
 * key, so requests like “总结一下 E2E 测试修复总结” can hit the exact title.
 */
export function cleanThinkRetrievalQuery(question: string): string {
  let value = question.trim()
  // Web Chat keeps recent turns in the original question for synthesis. Strip
  // that wrapper only for retrieval so old turns cannot dilute the current title.
  const currentMarker = value.lastIndexOf('当前问题：')
  if (currentMarker >= 0) value = value.slice(currentMarker + '当前问题：'.length).trim()
  value = value.replace(LEADING_REQUEST_PATTERN, '').replace(ENGLISH_REQUEST_PATTERN, '')
  value = value.replace(/[\s，,：:]+(?:的)?(?:内容|全文|文档)?\s*$/iu, '').trim()
  // Deterministic subtree enumeration owns the retrieval key for directory
  // questions; strip the conversational wrapper so semantic fallback cannot
  // dilute the prefix if enumeration is unavailable on an older server.
  const directory = value.match(/[“"']?([a-z0-9][a-z0-9_./-]*)[”"']?\s*(?:这个\s*)?(?:文件夹|目录|folder|directory|dir)/iu)
  if (directory?.[1]) return directory[1]
  return value || question.trim()
}

export function normalizedRetrievalText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function isExactTitleMatch(title: string, query: string): boolean {
  const left = normalizedRetrievalText(title)
  const right = normalizedRetrievalText(query)
  return Boolean(left && right && left === right)
}
