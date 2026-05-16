import type { GroupedBacklinksGroupHeaderControl } from '@/plugins/grouped-backlinks/facet.ts'
import { SpreadSrsReviewsButton } from './SpreadSrsReviewsButton.tsx'

export const srsSpreadReviewsGroupHeaderControl: GroupedBacklinksGroupHeaderControl = {
  id: 'srs-rescheduling.spread-reviews',
  component: SpreadSrsReviewsButton,
}
