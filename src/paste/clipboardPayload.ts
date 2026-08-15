/**
 * What a copy/cut puts on the clipboard, beyond the text — and how a paste
 * gets it back.
 *
 * ## Why this exists
 *
 * A paste that should MOVE the copied blocks (cut→paste) has to answer
 * "which blocks is this clipboard content?". The obvious implementation —
 * remember the ids in a module variable when the user cuts — makes that
 * variable a second source of truth beside the OS clipboard, with no
 * transaction spanning the two. Keeping them in agreement is then manual,
 * and every gap is a bug: a copy that forgets to clear the variable, a cut
 * that resumes after a later one, a paste that restores a claim another
 * gesture already took. That shape went through twelve review rounds, four
 * of which were repairs to the previous repair.
 *
 * So the identity travels WITH the content instead. Both lookups below are
 * keyed by what is actually on the clipboard right now:
 *
 *   - `text/html` carries the payload inline (`encodePayloadHtml` /
 *     `decodePayloadHtml`). Any paste holding a real `DataTransfer` reads
 *     it straight off the event.
 *   - `rememberPayload` / `recallPayloadForText` is a lookup TABLE for the
 *     paste paths that can only see `text/plain` — a bare `p` keypress
 *     fires no paste event, so those must call
 *     `navigator.clipboard.readText()` and have no flavors to read.
 *
 * ## The property to preserve
 *
 * Neither path ever asks "which cut is the current one?", and neither
 * needs invalidating. Copy something else and the text no longer matches,
 * so the lookup misses on its own. Two cuts race and each paste resolves
 * against whatever text the OS actually ended up holding. A stale entry is
 * unreachable rather than dangerous. **If you find yourself adding a
 * "clear this when X happens" call, the design has regressed** — that is
 * exactly the manual-agreement problem this replaced.
 *
 * The table is deliberately NOT keyed by recency, NOT cleared on write,
 * and NOT consulted unless the full text matches.
 *
 * ## Browser support
 *
 * No capability detection anywhere, on purpose. `text/html` on both the
 * write (`ClipboardItem`) and the read (`DataTransfer.getData`) is
 * universally supported; `navigator.clipboard.read()` — which would let
 * the keyboard paths reach flavors too — is NOT, so it is not used at all
 * rather than used behind a branch that makes the feature work in some
 * browsers and not others.
 */
import { fnv1a32Hex } from '@/utils/fnv1a.js'

/** Bump when the shape below changes incompatibly. A payload whose version
 *  this build doesn't recognise is ignored, degrading to a text paste —
 *  the same thing that happens for clipboard content from any other app. */
const PAYLOAD_VERSION = 1

/** Identity of the blocks a clipboard payload was produced from. */
export interface ClipboardPayload {
  /** The roots that were serialized, in clipboard order. Descendants are
   *  NOT listed — they ride along inside their root's subtree. */
  readonly blockIds: readonly string[]
  /** Where those ids live. A paste in another workspace can read the
   *  payload but must not act on the ids. */
  readonly workspaceId: string
  /** Whether the source gesture intended the blocks to MOVE (a cut) or to
   *  be duplicated (a copy). Carried explicitly rather than inferred: the
   *  same payload shape serves both, and a reader that guessed from
   *  context would turn an ordinary copy into a move. */
  readonly intent: 'copy' | 'cut'
}

interface EncodedPayload extends ClipboardPayload {
  readonly v: number
}

/** Marker prefix. An HTML comment rather than a wrapper element or a data
 *  attribute: the OS clipboard stores the flavor verbatim, so there's no
 *  sanitiser to survive, and a comment can't affect how another app
 *  renders what it pastes. */
const MARKER_OPEN = '<!--knowledge-medium:'
const MARKER_CLOSE = '-->'

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/**
 * The `text/html` flavor for `data`: the marker, then the same markdown
 * the `text/plain` flavor carries, escaped and wrapped so a rich-text
 * target renders it as the plain text it is rather than as one run-on
 * line. Deliberately not a `<ul>` rendering — the plain-text flavor is the
 * canonical form, and emitting a second, differently-shaped rendering
 * would mean two things to keep in step.
 *
 * The marker holds ONLY ids and the intent, never content, so the JSON
 * can't contain the `-->` that delimits it. If a future field could, the
 * delimiter needs escaping — though note the failure direction is already
 * the safe one: a truncated marker fails `JSON.parse` and decodes to
 * `null`, i.e. a missed move rather than a wrong one.
 */
export const encodePayloadHtml = (markdown: string, payload: ClipboardPayload): string => {
  const encoded: EncodedPayload = {v: PAYLOAD_VERSION, ...payload}
  return `${MARKER_OPEN}${JSON.stringify(encoded)}${MARKER_CLOSE}`
    + `<div style="white-space:pre-wrap">${escapeHtml(markdown)}</div>`
}

/** Pull the payload back out of a `text/html` flavor, or `null` when the
 *  html isn't ours (every other app's clipboard html lands here too) or
 *  carries a version/shape this build doesn't recognise. Never throws —
 *  a malformed marker is just "not ours". */
export const decodePayloadHtml = (html: string | undefined): ClipboardPayload | null => {
  if (!html) return null
  const start = html.indexOf(MARKER_OPEN)
  if (start === -1) return null
  const from = start + MARKER_OPEN.length
  const end = html.indexOf(MARKER_CLOSE, from)
  if (end === -1) return null

  try {
    const parsed = JSON.parse(html.slice(from, end)) as Partial<EncodedPayload>
    if (parsed.v !== PAYLOAD_VERSION) return null
    if (typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    if (parsed.intent !== 'copy' && parsed.intent !== 'cut') return null
    if (!Array.isArray(parsed.blockIds)) return null
    if (!parsed.blockIds.every(id => typeof id === 'string' && id)) return null
    return {
      blockIds: parsed.blockIds,
      workspaceId: parsed.workspaceId,
      intent: parsed.intent,
    }
  } catch {
    return null
  }
}

/**
 * The text-only fallback table.
 *
 * Bounded, and entries are evicted by INSERTION ORDER, never by "this one
 * is stale" — staleness isn't a thing here. An entry only ever matches
 * when the clipboard literally holds its text, so the worst an old entry
 * can do is be correct about a cut the user made a while ago.
 *
 * Keyed by hash for a bounded key size, but the hash is only an INDEX:
 * `recallPayloadForText` compares the full text before returning
 * anything. `fnv1a32Hex` is 32-bit and its doc requires callers to absorb
 * collisions — absorbing one here means a wrong MOVE, so the equality
 * check is doing the real work and the hash is just keeping the map small.
 */
const MAX_REMEMBERED = 20

interface RememberedEntry {
  readonly text: string
  readonly payload: ClipboardPayload
}

const remembered = new Map<string, RememberedEntry>()

export const rememberPayload = (text: string, payload: ClipboardPayload): void => {
  const key = fnv1a32Hex(text)
  // Re-insert so the eviction order below reflects insertion, not first
  // sight, when the same text is copied twice.
  remembered.delete(key)
  remembered.set(key, {text, payload})
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next()
    if (oldest.done) break
    remembered.delete(oldest.value)
  }
}

export const recallPayloadForText = (text: string): ClipboardPayload | null => {
  const entry = remembered.get(fnv1a32Hex(text))
  // Full-text equality, not just the hash — see MAX_REMEMBERED's doc.
  return entry && entry.text === text ? entry.payload : null
}

/** Test-only: the table is process-global, so a test that writes to it
 *  would otherwise leak into the next one. Production code has no reason
 *  to call this — see the module doc on why "clear it when X" is the
 *  smell this design exists to remove. */
export const resetRememberedPayloads = (): void => {
  remembered.clear()
}

/**
 * Resolve the payload for a paste, preferring the authoritative source.
 *
 * `html` is present exactly when the caller holds a real `DataTransfer`
 * (a paste EVENT). Keyboard-driven pastes pass `undefined` and fall to the
 * table. Both are content-addressed, so they can't disagree about
 * anything except availability.
 */
export const resolveClipboardPayload = (
  text: string,
  html: string | undefined,
): ClipboardPayload | null =>
  decodePayloadHtml(html) ?? recallPayloadForText(text)
