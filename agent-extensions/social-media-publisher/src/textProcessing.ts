import type {PostBlock, ProcessedBlock} from './types'

export const BLOCK_REF_REGEX = /\(\(([\w\d-]{6,64})\)\)/g
export const PAGE_REF_REGEX = /\[\[([^\]]+)\]\]/g
export const HASHTAG_PAGE_REF_REGEX = /#\[\[([^\]]+)\]\]/g
export const IMAGE_REGEX = /!\[[^\]]*\]\(([^\s)]*)\)/g
export const ALIAS_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g
export const BUTTON_REGEX = /\{\{[^}]*\}\}/g
export const BOLD_REGEX = /\*\*(.+?)\*\*/g
export const ITALIC_REGEX = /__(.+?)__/g
export const HIGHLIGHT_REGEX = /\^\^(.+?)\^\^/g
export const STRIKETHROUGH_REGEX = /~~(.+?)~~/g
export const INLINE_CODE_REGEX = /`([^`]+)`/g

export const replaceAsync = async (
  input: string,
  regex: RegExp,
  replacer: (...args: any[]) => Promise<string>,
): Promise<string> => {
  const matches = Array.from(input.matchAll(regex))
  if (matches.length === 0) return input
  const replacements = await Promise.all(matches.map(match => replacer(...match)))
  let offset = 0
  let result = input
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + offset
    const end = start + match[0].length
    result = `${result.slice(0, start)}${replacements[index]}${result.slice(end)}`
    offset += replacements[index].length - match[0].length
  })
  return result
}

export const resolveBlockReference = async (repo: any, id: string): Promise<string> => {
  try {
    const data = await repo.block(id).load()
    return data?.content ?? ''
  } catch {
    return ''
  }
}

export const processBlockText = async (
  raw: string,
  repo: any,
): Promise<Omit<ProcessedBlock, 'id' | 'raw'>> => {
  let text = raw
  const mediaUrls: string[] = []

  text = text.replace(IMAGE_REGEX, (_match, url) => {
    mediaUrls.push(url)
    return ''
  })

  text = await replaceAsync(text, BLOCK_REF_REGEX, async (_match, id) =>
    resolveBlockReference(repo, id))

  text = text.replace(ALIAS_REGEX, '$2')
  text = text.replace(HASHTAG_PAGE_REF_REGEX, (_match, pageName) =>
    `#${String(pageName).replace(/\s+/g, '')}`)
  text = text.replace(PAGE_REF_REGEX, (_match, pageName) =>
    `#${String(pageName).replace(/\s+/g, '')}`)
  text = text.replace(BOLD_REGEX, '$1')
  text = text.replace(ITALIC_REGEX, '$1')
  text = text.replace(HIGHLIGHT_REGEX, '$1')
  text = text.replace(STRIKETHROUGH_REGEX, '$1')
  text = text.replace(INLINE_CODE_REGEX, '$1')
  text = text.replace(BUTTON_REGEX, '')
  text = text.replace(/  +/g, ' ').trim()

  return {text, mediaUrls}
}

export const processBlocks = async (
  blocks: PostBlock[],
  repo: any,
): Promise<ProcessedBlock[]> =>
  Promise.all(blocks.map(async block => ({
    id: block.id,
    raw: block.content,
    ...(await processBlockText(block.content, repo)),
  })))

export const readChildBlocks = async (repo: any, blockId: string): Promise<PostBlock[]> => {
  const block = repo.block(blockId)
  await block.load()
  const children = await block.children.load()
  return children.map((child: {id: string; content: string}) => ({
    id: child.id,
    content: child.content ?? '',
  }))
}
