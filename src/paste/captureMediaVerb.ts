/**
 * The media-capture EFFECT seam (design §11).
 *
 * Capture has two phases: DECIDE (a paste/drop/file-picker yields a `media` outcome
 * via `pasteDecisionVerb`) and ACT (turn the files into content-addressed media
 * blocks). This verb is the ACT phase, factored out of the renderers so:
 *   - core declares the extension point here; the **attachments plugin** supplies the
 *     impl (see `src/attachments/pasteCapture.ts`), so the renderers no longer import
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
 * Effectful + passthrough: the impl returns `Promise<void>` the caller fire-and-
 * forgets (`void Promise.resolve(runSync(...)).catch(...)`). `onError: 'rethrow'` —
 * an effectful verb must never re-run its default after a partial effect.
 */
import type { Repo } from '@/data/repo.js'
import { defineVerbFacet } from '@/facets/verbFacet.js'

export interface CaptureMediaInput {
  readonly repo: Repo
  readonly workspaceId: string
  /** The block the captured media embeds are inserted under. */
  readonly parentBlockId: string
  readonly files: readonly File[]
}

export const captureMediaVerb = defineVerbFacet<CaptureMediaInput, void | Promise<void>>({
  id: 'paste.capture-media',
  // No capture provider installed (attachments off) → a no-op. In practice a `media`
  // outcome only arises when attachments contributed it, so this is defensive.
  defaultImpl: () => {},
  // The result is a fire-and-forget promise; the caller owns its rejection.
  syncResultMayBePromise: true,
  onError: 'rethrow',
})
