import { pasteDecisionVerb, type PasteDecision } from '@/paste/decision.js'
import { convertClipboardHtml } from './htmlToOutline.js'

/** Outliner copies (Roam, Logseq) put their own `[[page]]` / `((block))`
 *  syntax in the plain text; any HTML beside it is a rendering that has lost
 *  those references, so the text is the better source. */
const hasOutlinerReferenceSyntax = (text: string): boolean => /\[\[|\(\(/.test(text)

/**
 * Paste clipboard HTML (web pages, Google Docs, chat answers) as structured
 * blocks rather than the browser's flattened plain text. Defers to the rest of
 * the chain whenever the HTML adds nothing, the user asked for plain text
 * (Cmd/Ctrl+Shift+V), or the paste carries files (media capture owns those).
 */
export const richPasteDecisionContribution = pasteDecisionVerb.decorator(
  next => request => {
    if (request.intent === 'single-block' || !request.html || request.files?.length) return next(request)
    if (hasOutlinerReferenceSyntax(request.text)) return next(request)

    const converted = convertClipboardHtml(request.html)
    if (converted.kind === 'plain') return next(request)
    if (converted.kind === 'outline') return {kind: 'split', blocks: converted.blocks}

    // A single line (a link or a few formatted words): let the chain decide
    // where it lands as for any one-line paste, but paste the markdown. The
    // renderer pastes `decision.text ?? <original text>`, so carry it.
    const decision = next({...request, text: converted.markdown}) as PasteDecision
    return decision.kind === 'media' ? decision : {...decision, text: decision.text ?? converted.markdown}
  },
  {source: 'rich-paste'},
)
