/**
 * `references` for a block whose whole content is an id-carrying reference,
 * handed to `tx.create` so `parseReferences` finds the row already correct.
 *
 * Core mints property machinery rows — a field row addressing its definition,
 * a ref value child addressing its target — by writing the id into the content
 * itself, and then has to pay for the parser to read that id back out: the
 * plan differs from the empty `references` a fresh row carries, so the
 * processor opens a transaction and writes every row a second time — one extra
 * write, row event and upload per machinery row, and a migration mints one of
 * those per property per block. Prefilled, every plan in the batch comes out
 * idempotent and the processor returns without opening a transaction at all.
 *
 * It lives HERE, not in core, for two reasons that are really one. The
 * contract is agreement with {@link parseReferencesProcessor} — a prefill it
 * would not reproduce is one it retracts, turning the optimization into its
 * opposite — so the prediction and the parse have to be able to move together;
 * core holding a second reading of the grammar is exactly how they would drift
 * apart. And core holding it would mean turning References off stopped the
 * parse while leaving the extraction, so a machinery row born and then edited
 * with the toggle off keeps a backlink with nothing left to retract it.
 */

import { normalizeReferences, type BlockReference } from '@/data/api'
import type { ContentReferencePrefill } from '@/data/facets'
import {
  isIdCarryingReference,
  parseExactReferenceBlockContent,
} from '@/data/referenceBlock'
import { isBlockRefId } from './referenceParser.ts'

/** `undefined` for everything but a bare `((uuid))`, and that direction is the
 *  safe one: content holding prose, a `[[wikilink]]`, or a non-uuid id needs
 *  the alias lookup and seat probe only the full parse does. */
const derive = (content: string): BlockReference[] | undefined => {
  const parsed = parseExactReferenceBlockContent(content)
  if (!isIdCarryingReference(parsed) || parsed.kind !== 'blockRef') return undefined
  // The INLINE scanner's own id test, not a second copy of it: the whole-block
  // grammar accepts a broader id than the scanner does (a ref property will
  // happily hold `((target-xyz))`), and prefilling from the broader reading
  // writes the reference the parse then strips back out.
  if (!isBlockRefId(parsed.id)) return undefined
  // The parse aliases a bare `((id))` by the id itself, which is the whole of
  // the mapping for this shape.
  return normalizeReferences([{id: parsed.id, alias: parsed.id}])
}

export const exactBlockRefPrefill: ContentReferencePrefill = {
  id: 'references.exactBlockRef',
  derive,
}
