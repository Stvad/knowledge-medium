import type { BlockContextType } from '@/types'

export const surfaceFromContext = (context: BlockContextType): string => {
  if (context.isBreadcrumb) return 'breadcrumb'
  if (context.surfaceName) return context.surfaceName
  if (context.isBacklink) return 'backlink'
  if (context.isEmbedded) return 'embedded'
  if (context.isNestedSurface) return 'nested'
  return 'outline'
}
