/**
 * The attachments-owned paste rule: a paste carrying file(s) is a media paste.
 *
 * This lives HERE (contributed by the attachments plugin), not in core
 * `defaultPasteDecision`, so the rule is gated on the plugin's toggle: disable
 * attachments and a file paste falls through to the text default instead of minting
 * media blocks + uploading bytes that nothing can render. It's a `decorator` (not an
 * `impl`) so it composes with other paste contributions — files → `media`, otherwise
 * defer to `next` (the rest of the chain / the text default). The renderer handles
 * the text half of a files+text paste by re-running the verb with files stripped,
 * which this decorator then passes straight through to `next`.
 */
import { pasteDecisionVerb } from '@/paste/decision.js'

export const mediaPasteDecisionContribution = pasteDecisionVerb.decorator(
  next => request => (request.files && request.files.length > 0 ? { kind: 'media' } : next(request)),
  { source: 'attachments' },
)
