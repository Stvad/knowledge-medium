/**
 * The media-capture EFFECT seam (design §11).
 *
 * Capture has two phases: DECIDE (a paste/drop/file-picker yields a `media` outcome
 * via `pasteDecisionVerb`) and ACT (turn the files into content-addressed media
 * blocks). This verb is the ACT phase, factored out of the renderers so:
 *   - core declares the extension point here; the **attachments plugin** supplies the
 *     impl (see `src/plugins/attachments/pasteCapture.ts`), so the renderers no longer import
 *     attachments code, and disabling the plugin makes capture a no-op (`defaultImpl`);
 *   - it's trigger-agnostic — paste, drop, and the file-picker all run THIS verb, so
 *     the capture path lives in exactly one place;
 *   - plugins can `decorator`-wrap it (confirm-before-capture, throttle, swap the
 *     uploader), `impl`-replace it, or `before`/`after`-observe it (analytics).
 *
 * It is kept SEPARATE from `pasteDecisionVerb` on purpose: the decision verb is pure
 * and surface-agnostic (testable as a value), so folding the effect into it would
 * force editor/repo internals into the decision input and lose that property.
 *
 * Returns the REFERENCE TEXT (`((assetBlockId))`) for each captured file — capture
 * mints the content-addressed asset block (under the workspace ASSETS container) but
 * does NOT place the reference: the renderer inserts these via its normal text-paste
 * path, so a pasted attachment lands at the caret per the text policy (NOT as a forced
 * child). The verb is awaited (`run`), but the slow upload is still fire-and-forget
 * inside the impl, so the caller only waits for the fast asset-block write, not the
 * upload.
 */
import type { Repo } from '@/data/repo.js'
import { defineVerbFacet } from '@/facets/verbFacet.js'

export interface CaptureMediaInput {
  readonly repo: Repo
  readonly workspaceId: string
  readonly files: readonly File[]
}

export interface CaptureMediaOutcome {
  /** `((assetBlockId))` for each SUCCESSFULLY captured file, in file order. The
   *  renderer inserts these as text (at the caret, per the text policy). Empty when
   *  capture is off (the default no-op impl), there are no files, or all failed. */
  readonly references: readonly string[]
}

const NOTHING: CaptureMediaOutcome = { references: [] }

export const captureMediaVerb = defineVerbFacet<CaptureMediaInput, CaptureMediaOutcome | Promise<CaptureMediaOutcome>>({
  id: 'paste.capture-media',
  // No capture provider installed (attachments off) → capture nothing. In practice a
  // `media` outcome only arises when attachments contributed it, so this is defensive.
  defaultImpl: () => NOTHING,
  // Effectful: never re-run the default after a partial effect.
  onError: 'rethrow',
})
