import type { MarkdownExtension } from '@/markdown/extensions.ts'
import remarkGfm from 'remark-gfm'

export const gfmMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkGfm],
})
