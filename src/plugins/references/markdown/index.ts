import {resolveMarkdownRenderConfig, type MarkdownExtension} from '@/markdown/extensions'
import {blockrefMarkdownExtension} from './blockrefs/index'
import {wikilinkMarkdownExtension} from './wikilinks/index'
import {remarkReferenceOccurrences} from './remark-reference-occurrences'

export const referencesMarkdownExtension: MarkdownExtension = context => {
  const config = resolveMarkdownRenderConfig([wikilinkMarkdownExtension, blockrefMarkdownExtension], context)
  return {...config, remarkPlugins: [...config.remarkPlugins, remarkReferenceOccurrences]}
}
