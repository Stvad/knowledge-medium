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
 * (Cmd/Ctrl+Shift+V), or the chain captures the paste as media — whoever owns
 * the files decides that, so with capture off a spreadsheet's image doesn't
 * cost its table.
 */
export const richPasteDecisionContribution = pasteDecisionVerb.decorator(
  next => request => {
    if (request.intent === 'single-block' || !request.html) return next(request)
    if (hasOutlinerReferenceSyntax(request.text)) return next(request)
    const downstream = next(request) as PasteDecision
    if (downstream.kind === 'media') return downstream

    const converted = convertClipboardHtml(request.html)
    if (converted.kind === 'plain') return downstream
    if (converted.kind === 'outline') return {kind: 'split', blocks: converted.blocks}

    // A single line (a link or a few formatted words): let the chain decide
    // where it lands as for any one-line paste, but paste the markdown. The
    // renderer pastes `decision.text ?? <original text>`, so carry it.
    const decision = next({...request, text: converted.markdown}) as PasteDecision
    return decision.kind === 'media' ? decision : {...decision, text: decision.text ?? converted.markdown}
  },
  {source: 'rich-paste'},
)
