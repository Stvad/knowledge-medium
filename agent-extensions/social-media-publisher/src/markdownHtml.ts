import type {PostBlock} from './types'
import {
  BLOCK_REF_REGEX,
  BUTTON_REGEX,
  HASHTAG_PAGE_REF_REGEX,
  PAGE_REF_REGEX,
  replaceAsync,
  resolveBlockReference,
} from './textProcessing'

export const normalizeBlockMarkdownForHtml = async (
  raw: string,
  repo: any,
): Promise<string> => {
  let text = raw

  text = await replaceAsync(text, BLOCK_REF_REGEX, async (_match, id) =>
    resolveBlockReference(repo, id))
  text = text.replace(BUTTON_REGEX, '')
  text = text.replace(HASHTAG_PAGE_REF_REGEX, (_match, pageName) => String(pageName))
  text = text.replace(PAGE_REF_REGEX, (_match, pageName) => String(pageName))
  return text.trim()
}

export const blockToHtml = async (raw: string, repo: any): Promise<string> => {
  const markdown = await normalizeBlockMarkdownForHtml(raw, repo)
  if (!markdown) return ''
  const {renderMarkdownHtml} = await import('@/markdown/renderMarkdownHtml.js')
  return renderMarkdownHtml(markdown, {mode: 'external'})
}

export const blocksToHtml = async (blocks: PostBlock[], repo: any): Promise<string> => {
  const htmlBlocks = await Promise.all(blocks.map(async block => {
    return blockToHtml(block.content, repo)
  }))
  return htmlBlocks.filter(Boolean).join('\n')
}
