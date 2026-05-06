import { defineRefPropertyUi } from '@/components/propertyEditors/refPropertyUi.ts'
import { srsNextReviewDateProp } from './schema.ts'

export const srsNextReviewDateUi = defineRefPropertyUi(srsNextReviewDateProp, {
  label: 'Next review date',
  category: 'SRS',
})
