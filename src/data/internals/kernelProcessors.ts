import type { AnyPostCommitProcessor } from '@/data/api'
import { ALIAS_CLAIM_REDERIVE_PROCESSOR } from './aliasClaimRederiveProcessor'

export const KERNEL_PROCESSORS: ReadonlyArray<AnyPostCommitProcessor> = [
  ALIAS_CLAIM_REDERIVE_PROCESSOR,
]
