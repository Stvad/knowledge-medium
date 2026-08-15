/**
 * What a copy/cut puts on the clipboard, beyond the text — and how a paste
 * gets it back.
 *
 * A paste that should MOVE the copied blocks has to answer "which blocks
 * is this clipboard content?". Identity therefore travels WITH the
 * content, through two lookups that are both keyed by what the clipboard
 * holds right now:
 *
 *   - `text/html` carries the payload inline. Any paste holding a real
 *     `DataTransfer` reads it straight off the event.
 *   - `rememberPayload` / `recallPayloadForText` is a table for the paths
 *     that only see `text/plain` — a bare `p` keypress fires no paste
 *     event, so those call `navigator.clipboard.readText()` and have no
 *     flavors to read.
 *
 * ## The rules
 *
 * **A write may only touch the entry for the exact text it wrote.** Every
 * write records what the clipboard now holds for its own content:
 * `writeToClipboard` a payload, `writeTextToClipboard` "no payload" via
 * `forgetPayload`. A call that clears entries for OTHER content — "the
 * user did something, drop the pending one" — is the thing to refuse.
 *
 * **Every reader applies `applyCompletion`**, not just the composed
 * `resolveClipboardPayload`. A reader that can hand back a spent cut is a
 * reader someone will use.
 *
 * The obvious simplification — remember the ids in a module variable on
 * cut — is wrong: that variable is a second source of truth beside the OS
 * clipboard with no transaction spanning the two, so agreement becomes
 * manual and every gap is a bug. Content addressing removes the question
 * "which cut is current?" rather than answering it.
 *
 * ## The limit
 *
 * A paste that carries NO html and whose text matches a remembered cut is
 * indistinguishable from that cut — so plain-text-only foreign content with
 * identical text still resolves to it. Inherent to fingerprinting a
 * text-only clipboard by content. Any paste carrying html is exact: ours
 * decodes (digest-bound to its text), anything else answers "not a cut".
 *
 * ## Browser support
 *
 * No capability detection, deliberately. `text/html` on write
 * (`ClipboardItem`) and read (`DataTransfer.getData`) is universally
 * supported; `navigator.clipboard.read()` is not, so it is not used at all
 * rather than behind a branch that works in some browsers and not others.
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
  /** Identifies THIS gesture, not the blocks it names. `completedCuts` is
   *  keyed by it, so re-cutting the same blocks is a new cut that no tab
   *  considers spent — without it, a second tab's fresh cut of the same
   *  ids is downgraded to a copy by the first tab's completion record,
   *  which that tab has no way to clear. */
  readonly cutId: string
}

interface EncodedPayload extends ClipboardPayload {
  readonly v: number
  /** Fingerprint of the markdown this marker shipped alongside. Checked in
   *  `resolveClipboardPayload` against the paste's actual `text/plain`.
   *
   *  What it stops: a rich-text app that round-trips our html — preserving
   *  the comment while the visible content changes — would otherwise hand
   *  back a marker claiming to describe text it no longer describes, and a
   *  paste would move blocks the user never cut.
   *
   *  What it does NOT stop: deliberate forgery. An attacker who writes the
   *  marker also writes the text, so they can make the two agree. What
   *  actually makes that impractical is that a forged payload needs the
   *  victim's real `workspaceId` and block ids, which aren't public, and
   *  the worst outcome is a local, undoable move of the user's own blocks
   *  — no read access, nothing leaves the device. A per-origin unforgeable
   *  token would close it properly; that's not worth the persistent state
   *  at this threat level, but it's the shape if it ever is. */
  readonly digest: string
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
  const encoded: EncodedPayload = {v: PAYLOAD_VERSION, ...payload, digest: fnv1a32Hex(markdown)}
  return `${MARKER_OPEN}${JSON.stringify(encoded)}${MARKER_CLOSE}`
    + `<div style="white-space:pre-wrap">${escapeHtml(markdown)}</div>`
}

/** Pull the payload back out of a `text/html` flavor, or `null` when the
 *  html isn't ours (every other app's clipboard html lands here too) or
 *  carries a version/shape this build doesn't recognise. Never throws —
 *  a malformed marker is just "not ours". */
const decodeEncodedPayload = (html: string | undefined): EncodedPayload | null => {
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
    if (typeof parsed.digest !== 'string' || !parsed.digest) return null
    if (typeof parsed.cutId !== 'string' || !parsed.cutId) return null
    return {
      v: parsed.v,
      digest: parsed.digest,
      cutId: parsed.cutId,
      blockIds: parsed.blockIds,
      workspaceId: parsed.workspaceId,
      intent: parsed.intent,
    }
  } catch {
    return null
  }
}

/** Decode and verify against the text the marker arrived with. `null`
 *  whenever the html isn't ours, is malformed, or describes different
 *  content than `text` — see `EncodedPayload.digest`. */
export const decodePayloadHtml = (
  html: string | undefined,
  text: string,
): ClipboardPayload | null => {
  const encoded = decodeEncodedPayload(html)
  if (!encoded || encoded.digest !== fnv1a32Hex(text)) return null
  return applyCompletion({
    blockIds: encoded.blockIds,
    workspaceId: encoded.workspaceId,
    intent: encoded.intent,
    cutId: encoded.cutId,
  })
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
  // A fresh write of these blocks is a fresh cut, even if an identical
  // earlier one was already completed.
  completedCuts.delete(payloadKey(payload))
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
  return applyCompletion(entry && entry.text === text ? entry.payload : null)
}

/** Test-only: the table is process-global, so a test that writes to it
 *  would otherwise leak into the next one. Production code has no reason
 *  to call this — see the module doc on why "clear it when X" is the
 *  smell this design exists to remove. */
export const resetRememberedPayloads = (): void => {
  remembered.clear()
  completedCuts.clear()
}

/**
 * Cuts already completed as a move.
 *
 * A cut stays on the clipboard after it's pasted — nothing can rewrite the
 * OS clipboard from inside a paste handler — so without this a second
 * paste relocates the same blocks again, from the first destination to the
 * second, and the first paste looks undone. Downgrading the intent to
 * 'copy' makes that second ⌘V insert text, matching ⌘X⌘V⌘V anywhere else.
 *
 * Cleared by `rememberPayload`, so re-cutting the same blocks arms a fresh
 * cut. Per-tab: cutting in one tab, pasting in a second, then pasting
 * again in the FIRST moves twice; closing that needs cross-tab shared
 * state, which costs more than the case is worth.
 */
const completedCuts = new Set<string>()

const payloadKey = (payload: ClipboardPayload): string => payload.cutId

/** Called after a cut payload has actually been relocated. */
export const markCutCompleted = (payload: ClipboardPayload): void => {
  completedCuts.add(payloadKey(payload))
}

/** Applied at EVERY point a payload is read, not just in the composed
 *  `resolveClipboardPayload`. Putting it only there left
 *  `recallPayloadForText` handing out live cuts, and the one caller that
 *  used it directly (the keyboard paste path) went on relocating a spent
 *  cut — the exact bug `markCutCompleted` exists to prevent, surviving on
 *  the other surface. A reader that can return an un-downgraded payload is
 *  a reader someone will use. */
const applyCompletion = (payload: ClipboardPayload | null): ClipboardPayload | null => {
  if (!payload || payload.intent !== 'cut') return payload
  return completedCuts.has(payloadKey(payload)) ? {...payload, intent: 'copy'} : payload
}

/** Record that `text` is no longer a cut — used by the plain-text write
 *  path, which puts content on the clipboard carrying no block identity.
 *
 *  This is a WRITE recording what the clipboard now holds for that
 *  content, not an "invalidate on every gesture" hook. The distinction is
 *  the whole design: entries are still keyed by content, still never
 *  consulted unless the full text matches, and still have no notion of
 *  which one is current. See `writeTextToClipboard`. */
export const forgetPayload = (text: string): void => {
  remembered.delete(fnv1a32Hex(text))
}

/**
 * Two readers, chosen by what the CALLER can see — never by inspecting
 * the content:
 *
 *   - a paste EVENT holds a full `DataTransfer`, so `decodePayloadHtml`
 *     is exact. Our own writes always include the html flavor, which makes
 *     its ABSENCE just as conclusive as foreign html: no marker means not
 *     ours. An event surface must never consult the table, or plain text
 *     copied from another app that happens to match a remembered cut moves
 *     those blocks.
 *   - a keyboard paste has only `readText()`, so `recallPayloadForText` is
 *     all there is.
 *
 * There is deliberately no combined helper. One existed and branched on
 * whether html was truthy, which reads as the same rule but isn't: it made
 * an event with no html indistinguishable from a keyboard paste, and
 * reopened exactly the case above.
 */
