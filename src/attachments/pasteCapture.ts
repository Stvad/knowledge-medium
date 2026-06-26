/**
 * The attachments↔paste seam: the plugin's two contributions for capturing files.
 *
 *  1. DECISION ({@link mediaPasteDecisionContribution}) — a `pasteDecisionVerb`
 *     decorator: "a paste carrying file(s) is a media paste." Lives here (not in core
 *     `defaultPasteDecision`) so it's gated on the plugin toggle — disable attachments
 *     and a file paste falls through to the text default instead of minting media
 *     blocks nothing can render. A `decorator` (not `impl`) so it composes: files →
 *     `media`, else defer to `next`. (The renderer handles the text half of a
 *     files+text paste by re-running the verb with files stripped, which this passes
 *     straight through to `next`.)
 *
 *  2. EFFECT ({@link captureMediaContribution}) — the {@link captureMediaVerb} impl:
 *     turn the files into content-addressed media blocks (the up-lane handles upload)
 *     and surface any failures. Lives here so core declares the capture seam while the
 *     plugin owns the actual capture — the renderers run the verb, never importing
 *     attachments. Disabling the plugin leaves the verb's no-op default.
 */
import { captureMediaVerb } from '@/paste/captureMediaVerb.js'
import { pasteDecisionVerb } from '@/paste/decision.js'
import { captureMediaFromFiles, reportCaptureFailures } from './assetUpload.js'

export const mediaPasteDecisionContribution = pasteDecisionVerb.decorator(
  next => request => (request.files && request.files.length > 0 ? { kind: 'media' } : next(request)),
  { source: 'attachments' },
)

export const captureMediaContribution = captureMediaVerb.impl(
  ({ repo, workspaceId, parentBlockId, files }) =>
    captureMediaFromFiles(repo, workspaceId, parentBlockId, files).then(reportCaptureFailures),
  { source: 'attachments' },
)
