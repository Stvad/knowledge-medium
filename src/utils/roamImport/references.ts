import { parseReferences } from '@/utils/referenceParser'

interface ProtectedRange {
  start: number
  end: number
}

const collectCodeRanges = (content: string): ProtectedRange[] => {
  const ranges: ProtectedRange[] = []
  let i = 0
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3)
      const rangeEnd = end < 0 ? content.length : end + 3
      ranges.push({start: i, end: rangeEnd})
      i = rangeEnd
      continue
    }
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1)
      if (end < 0) break
      ranges.push({start: i, end: end + 1})
      i = end + 1
      continue
    }
    i += 1
  }
  return ranges
}

const inRange = (ranges: ReadonlyArray<ProtectedRange>, index: number): boolean =>
  ranges.some(range => index >= range.start && index < range.end)

export const parseRoamImportReferences = (content: string) => {
  const codeRanges = collectCodeRanges(content)
  if (codeRanges.length === 0) return parseReferences(content)
  return parseReferences(content).filter(ref => !inRange(codeRanges, ref.startIndex))
}
