import type { AnyPostCommitProcessor } from '@/data/api'
import { ALIAS_CLAIM_REDERIVE_PROCESSOR } from './aliasClaimRederiveProcessor'
import { REPORT_UNCONVERTIBLE_VALUES } from './propertyDefinitionChangeProcessor'

export const KERNEL_PROCESSORS: ReadonlyArray<AnyPostCommitProcessor> = [
  ALIAS_CLAIM_REDERIVE_PROCESSOR,
  REPORT_UNCONVERTIBLE_VALUES,
]
