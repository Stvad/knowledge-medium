import type { BlockContextType } from '@/types'

export type SpatialSurface = 'outline' | 'backlink' | 'breadcrumb' | 'embedded' | 'nested'

export const surfaceFromContext = (context: BlockContextType): SpatialSurface => {
  if (context.isBreadcrumb) return 'breadcrumb'
  if (context.isBacklink) return 'backlink'
  if (context.isEmbedded) return 'embedded'
  if (context.isNestedSurface) return 'nested'
  return 'outline'
}
