// @vitest-environment node
/**
 * Fuzz suite for the two line-buffered stdout parsers in
 * `packages/agent-dispatch/src`:
 *  - `createStreamJsonParser` (runner.ts:155-303) — `claude --output-format
 *    stream-json`.
 *  - `createCodexJsonlParser` (codexRunner.ts:154-303) — `codex exec --json`.
 *
 * Both share the same `{feed(chunk), finish()}` shape and the same
 * documented contract: "Feed raw stdout chunks — they may split mid-line"
 * (runner.ts:150-151) and "Never throws: unparseable/unknown lines and
 * events are silently skipped" (runner.ts:152-154, codexRunner.ts:146-149).
 * This suite fuzzes exactly those two claims, plus the cumulative-text
 * growth invariant both parsers document (runner.ts:213-223,
 * codexRunner.ts:216-228).
 *
 * See `src/test/fuzz.ts` for smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions. This file lives in
 * `packages/agent-dispatch/test/` (this package's existing convention —
 * see `runner.test.ts`, `codexRunner.test.ts` — rather than colocated next
 * to `src/`, unlike the rest of the repo's `*.fuzz.test.ts` files) but is
 * collected by the SAME root `vitest run` as everything else: the root
 * `vitest.config.ts` `include`/`exclude` doesn't carve out `packages/`,
 * and this package has no `test` script or vitest config of its own (see
 * `packages/agent-dispatch/package.json`) — so it only ever runs through
 * the root project, which is also what makes `@/test/fuzz` resolve here
 * (the root config's `resolve.alias['@']`). `pnpm fuzz` (scripts/fuzz.mjs)
 * passes a bare `fuzz.test.` substring filter to that same root `vitest
 * run` with no path restriction, so it DOES pick this file up too —
 * verified live below, not assumed.
 *
 * ──── Chunk-split invariance, structurally ────
 *
 * Property (1) for each parser generates a sequence of well-formed lines
 * matching the parser's OWN expected line schema (read off `handleLine` in
 * each source file), serializes them exactly as the real CLI would
 * (`JSON.stringify(line) + '\n'`), then feeds the concatenated text to one
 * parser instance in ONE `feed()` call and to a second, fresh instance via
 * `feed()` calls at arbitrary cut points (including duplicate/edge cuts
 * that produce empty chunks, and — since cuts land at raw UTF-16 code-unit
 * offsets, not grapheme or escape boundaries — cuts that fall mid
 * surrogate-pair or mid JSON-escape-sequence for any astral/control
 * character the generator produced). Both must observe identical
 * `RunEvent`s and identical `finish()` output: `feed`/`finish` only ever
 * scan `buffer` for `\n` and slice it (runner.ts:281-297,
 * codexRunner.ts:259-291) — string concatenation is associative regardless
 * of where it's chopped, so this is a direct, code-grounded oracle, not a
 * restatement of the implementation.
 *
 * ──── Candidate property dropped ────
 *
 * A "chunk-split invariance under GARBAGE input" property (combining (1)
 * and (3)) was considered but dropped as redundant: (3) already splits
 * garbage at arbitrary cut points and asserts totality, and a garbage
 * stream has no cross-run semantic invariant to differential-test beyond
 * totality (unlike (1)'s well-formed streams, where the events/finish()
 * VALUE is meaningful and must match). (3)'s totality property already
 * exercises the same buffering code path on adversarial input.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { createStreamJsonParser, type RunEvent } from '../src/runner'
import { createCodexJsonlParser } from '../src/codexRunner'

type RawLine = Record<string, unknown>

const serializeLine = (obj: unknown): string => `${JSON.stringify(obj)}\n`

/** Split `fullText` into chunks at `cuts` (arbitrary UTF-16 code-unit
 *  offsets, not necessarily sorted or unique — duplicates/edges yield
 *  empty-string chunks, which `feed('')` must treat as a no-op). Feeding
 *  the resulting chunks in order via separate `feed()` calls reconstructs
 *  `fullText` exactly (string concatenation), so this is purely a
 *  buffering-boundary generator, not a content transform. */
const splitIntoChunks = (fullText: string, cuts: readonly number[]): string[] => {
  const points = [0, ...cuts, fullText.length].sort((a, b) => a - b)
  const chunks: string[] = []
  for (let i = 1; i < points.length; i++) chunks.push(fullText.slice(points[i - 1], points[i]))
  return chunks
}

/** Cut points into a string of length `len`: capped so deep-tier runs
 *  don't spend their time budget on absurdly fine-grained splits of long
 *  strings, but still reaches full byte-by-byte splitting for short ones. */
const cutsArb = (len: number): fc.Arbitrary<number[]> =>
  len <= 0 ? fc.constant([]) : fc.array(fc.integer({min: 0, max: len}), {maxLength: Math.min(len, 80)})

/** Text content generator: plain ASCII-ish strings, `grapheme`-unit
 *  strings (includes astral characters — real surrogate pairs, so an
 *  arbitrary cut point can land mid-pair), plus a fixed set of
 *  JSON-escape-stressing fixtures (quotes, backslashes, control chars that
 *  `JSON.stringify` turns into multi-character escapes like `\n`/`\t`, so a
 *  cut point can land mid-escape-sequence too). */
const textArb: fc.Arbitrary<string> = fc.oneof(
  {weight: 3, arbitrary: fc.string({maxLength: 12})},
  {weight: 2, arbitrary: fc.string({unit: 'grapheme', maxLength: 8})},
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '', '"quoted"', 'back\\slash', 'line\nbreak', 'tab\ttab',
      '🎉multi🎈byte', 'quote"in"middle', 'null\x00byte', '{"looks":"like json"}',
    ),
  },
)

// ════════════════════════════════════════════════════════════════════
// createStreamJsonParser (runner.ts) — claude `stream-json`
// ════════════════════════════════════════════════════════════════════

const claudeSessionIdArb = fc.string({minLength: 1, maxLength: 12})
const claudeToolNameArb = fc.constantFrom(
  'mcp__km__search', 'mcp__km__get_block', 'WebSearch', 'WebFetch', 'Bash', 'mcp__other__thing',
)

const claudeContentBlockArb: fc.Arbitrary<RawLine> = fc.oneof(
  fc.record({type: fc.constant('text'), text: textArb}),
  fc.record({type: fc.constant('tool_use'), name: claudeToolNameArb}),
)

/** One line of `handleLine`'s schema (runner.ts:184-262): system/init,
 *  stream_event (message_start / content_block_start tool_use /
 *  content_block_delta text_delta), assistant (multi-block content), and
 *  result. */
const claudeLineArb: fc.Arbitrary<RawLine> = fc.oneof(
  fc.record({type: fc.constant('system'), subtype: fc.constant('init'), session_id: claudeSessionIdArb}),
  fc.record({type: fc.constant('stream_event'), event: fc.record({type: fc.constant('message_start')})}),
  fc.record({
    type: fc.constant('stream_event'),
    event: fc.record({
      type: fc.constant('content_block_start'),
      content_block: fc.record({type: fc.constant('tool_use'), name: claudeToolNameArb}),
    }),
  }),
  fc.record({
    type: fc.constant('stream_event'),
    event: fc.record({
      type: fc.constant('content_block_delta'),
      delta: fc.record({type: fc.constant('text_delta'), text: textArb}),
    }),
  }),
  fc.record({
    type: fc.constant('assistant'),
    message: fc.record({content: fc.array(claudeContentBlockArb, {maxLength: 4})}),
  }),
  fc.record({
    type: fc.constant('result'),
    result: textArb,
    session_id: fc.option(claudeSessionIdArb, {nil: null}),
    is_error: fc.boolean(),
  }),
)

const claudeStreamCaseArb = fc.array(claudeLineArb, {maxLength: 20}).chain(lines => {
  const fullText = lines.map(serializeLine).join('')
  return fc.record({fullText: fc.constant(fullText), cuts: cutsArb(fullText.length)})
})

describe('createStreamJsonParser (runner.ts)', () => {
  it('chunk-split invariance: arbitrary-offset feed() splits of a well-formed stream produce identical events + finish() + sessionId() as one feed() call (runner.ts:264-303 buffering)', () => {
    fc.assert(
      fc.property(claudeStreamCaseArb, ({fullText, cuts}) => {
        const wholeEvents: RunEvent[] = []
        const wholeParser = createStreamJsonParser(e => wholeEvents.push(e))
        wholeParser.feed(fullText)
        const wholeResult = wholeParser.finish()
        const wholeSessionId = wholeParser.sessionId()

        const chunkEvents: RunEvent[] = []
        const chunkParser = createStreamJsonParser(e => chunkEvents.push(e))
        for (const chunk of splitIntoChunks(fullText, cuts)) chunkParser.feed(chunk)
        const chunkResult = chunkParser.finish()
        const chunkSessionId = chunkParser.sessionId()

        expect(chunkEvents).toEqual(wholeEvents)
        expect(chunkResult).toEqual(wholeResult)
        expect(chunkSessionId).toBe(wholeSessionId)
      }),
      fuzzParams(200),
    )
  })

  // Single message-turn generator for the monotonic-text property: exactly
  // one message_start (so textAccumulator resets at most once, at the
  // start — runner.ts:232-234), an arbitrary number of text deltas and
  // tool_use content-block-starts around them, an optional assistant
  // summary, an optional result line.
  const claudeTurnLinesArb: fc.Arbitrary<RawLine[]> = fc.record({
    includeInit: fc.boolean(),
    toolUseBefore: fc.array(claudeToolNameArb, {maxLength: 2}),
    deltas: fc.array(textArb, {maxLength: 10}),
    toolUseAfter: fc.array(claudeToolNameArb, {maxLength: 2}),
    assistantContent: fc.option(fc.array(claudeContentBlockArb, {maxLength: 4}), {nil: undefined}),
    includeResult: fc.boolean(),
  }).map(({includeInit, toolUseBefore, deltas, toolUseAfter, assistantContent, includeResult}) => {
    const lines: RawLine[] = []
    if (includeInit) lines.push({type: 'system', subtype: 'init', session_id: 'sess'})
    lines.push({type: 'stream_event', event: {type: 'message_start'}})
    for (const name of toolUseBefore) {
      lines.push({type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'tool_use', name}}})
    }
    for (const text of deltas) {
      lines.push({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text}}})
    }
    for (const name of toolUseAfter) {
      lines.push({type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'tool_use', name}}})
    }
    if (assistantContent) lines.push({type: 'assistant', message: {content: assistantContent}})
    if (includeResult) lines.push({type: 'result', result: 'done', session_id: 'sess', is_error: false})
    return lines
  })

  it('a single message-turn only ever grows the emitted cumulative text, never shrinks it (runner.ts:213-223: the finalized-message summary is adopted only when longer than the delta-built text; runner.ts:232-234: message_start is the only reset, and this generator fires it exactly once)', () => {
    fc.assert(
      fc.property(claudeTurnLinesArb, lines => {
        const events: RunEvent[] = []
        const parser = createStreamJsonParser(e => events.push(e))
        parser.feed(lines.map(serializeLine).join(''))
        parser.finish()

        const lengths = events.filter(e => e.kind === 'text').map(e => (e as {text: string}).text.length)
        for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1])
      }),
      fuzzParams(200),
    )
  })

  const claudeGarbageLineArb: fc.Arbitrary<string> = fc.oneof(
    fc.string({maxLength: 40}),
    fc.constantFrom(
      '{', '}', '[', ']', 'null', 'true', 'false', '42', '"unterminated',
      '{"type":"system"}', // missing subtype/session_id
      '{"type":"result"}', // missing result/session_id/is_error
      '{"type":"assistant"}', // missing message
      '{"type":"assistant","message":{}}', // message.content missing
      '{"type":"assistant","message":{"content":"not-an-array"}}',
      '{"type":"stream_event"}', // missing event
      '{"type":"stream_event","event":{}}', // missing event.type
      '{"type":"stream_event","event":{"type":"content_block_delta"}}', // missing delta
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{}}}', // delta missing type/text
      '{"type":"totally_unknown_type","payload":123}',
      '[1,2,3]', // valid JSON, not an object
      '"just a string"', // valid JSON, not an object
    ),
    fc.jsonValue({maxDepth: 2}).map(v => JSON.stringify(v)),
  )

  const claudeMixedStreamArb = fc
    .array(fc.oneof(claudeLineArb.map(obj => JSON.stringify(obj)), claudeGarbageLineArb), {maxLength: 25})
    .chain(rawLines => {
      const fullText = rawLines.map(l => `${l}\n`).join('')
      return fc.record({fullText: fc.constant(fullText), cuts: cutsArb(fullText.length)})
    })

  it('never throws on garbage/malformed lines interleaved with valid ones, split at arbitrary points (runner.ts:150-154, 264-297: feed/finish tolerate anything)', () => {
    fc.assert(
      fc.property(claudeMixedStreamArb, ({fullText, cuts}) => {
        const events: RunEvent[] = []
        const parser = createStreamJsonParser(e => events.push(e))
        for (const chunk of splitIntoChunks(fullText, cuts)) parser.feed(chunk)
        const result = parser.finish()
        expect(Array.isArray(events)).toBe(true)
        expect(result === null || typeof result === 'object').toBe(true)
        expect(typeof parser.sessionId() === 'string' || parser.sessionId() === null).toBe(true)
      }),
      fuzzParams(200),
    )
  })
})

// ════════════════════════════════════════════════════════════════════
// createCodexJsonlParser (codexRunner.ts) — `codex exec --json`
// ════════════════════════════════════════════════════════════════════

const codexThreadIdArb = fc.string({minLength: 1, maxLength: 12})

/** One item payload for item.started/updated/completed (codexRunner.ts:
 *  192-232): agent_message (text only fires on item.completed, per
 *  activityForItem/handleLine — but the parser reads `itemRecord.type`
 *  the same on every item.* variant, so generating it on all three is a
 *  legitimate schema-conformant exercise of the dispatch, not just the
 *  completed case), command_execution, web_search, mcp_tool_call
 *  (multiple plausible shapes — the parser's own docblock says the real
 *  shape "wasn't observed live"), reasoning. */
const codexItemArb: fc.Arbitrary<RawLine> = fc.oneof(
  fc.record({type: fc.constant('agent_message'), text: textArb}),
  fc.record({type: fc.constant('command_execution')}),
  fc.record({type: fc.constant('web_search')}),
  fc.record({type: fc.constant('mcp_tool_call'), tool: fc.constantFrom('search', 'get_block')}),
  fc.record({type: fc.constant('mcp_tool_call'), name: fc.constantFrom('search', 'get_block')}),
  fc.record({
    type: fc.constant('mcp_tool_call'),
    server: fc.constantFrom('km', 'other'),
    toolName: fc.constantFrom('search', 'get_block'),
  }),
  fc.record({type: fc.constant('reasoning')}),
)

/** One line of `handleLine`'s schema (codexRunner.ts:200-256):
 *  thread.started, item.{started,updated,completed}, error,
 *  turn.completed, turn.failed. */
const codexLineArb: fc.Arbitrary<RawLine> = fc.oneof(
  fc.record({type: fc.constant('thread.started'), thread_id: codexThreadIdArb}),
  fc.record({
    type: fc.constantFrom('item.started', 'item.updated', 'item.completed'),
    item: codexItemArb,
  }),
  fc.record({type: fc.constant('error'), message: textArb}),
  fc.record({type: fc.constant('turn.completed')}),
  fc.record({type: fc.constant('turn.failed'), error: fc.record({message: textArb})}),
)

const codexStreamCaseArb = fc.array(codexLineArb, {maxLength: 20}).chain(lines => {
  const fullText = lines.map(serializeLine).join('')
  return fc.record({fullText: fc.constant(fullText), cuts: cutsArb(fullText.length)})
})

describe('createCodexJsonlParser (codexRunner.ts)', () => {
  it('chunk-split invariance: arbitrary-offset feed() splits of a well-formed stream produce identical events + finish() as one feed() call (codexRunner.ts:259-291 buffering, mirrors runner.ts)', () => {
    fc.assert(
      fc.property(codexStreamCaseArb, ({fullText, cuts}) => {
        const wholeEvents: RunEvent[] = []
        const wholeParser = createCodexJsonlParser(e => wholeEvents.push(e))
        wholeParser.feed(fullText)
        const wholeResult = wholeParser.finish()

        const chunkEvents: RunEvent[] = []
        const chunkParser = createCodexJsonlParser(e => chunkEvents.push(e))
        for (const chunk of splitIntoChunks(fullText, cuts)) chunkParser.feed(chunk)
        const chunkResult = chunkParser.finish()

        expect(chunkEvents).toEqual(wholeEvents)
        expect(chunkResult).toEqual(wholeResult)
      }),
      fuzzParams(200),
    )
  })

  it('emitted cumulative text only ever grows across the whole run — unlike the claude parser there is no reset event at all (codexRunner.ts:216-228: every item.completed agent_message CONCATENATES onto resultText, never replaces it)', () => {
    fc.assert(
      fc.property(codexStreamCaseArb, ({fullText}) => {
        const events: RunEvent[] = []
        const parser = createCodexJsonlParser(e => events.push(e))
        parser.feed(fullText)
        parser.finish()

        const lengths = events.filter(e => e.kind === 'text').map(e => (e as {text: string}).text.length)
        for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThan(lengths[i - 1])
      }),
      fuzzParams(200),
    )
  })

  const codexGarbageLineArb: fc.Arbitrary<string> = fc.oneof(
    fc.string({maxLength: 40}),
    fc.constantFrom(
      '{', '}', '[', ']', 'null', 'true', 'false', '42', '"unterminated',
      '{"type":"thread.started"}', // missing thread_id
      '{"type":"item.completed"}', // missing item
      '{"type":"item.completed","item":{}}', // item missing type
      '{"type":"item.completed","item":{"type":"agent_message"}}', // missing text
      '{"type":"item.completed","item":{"type":"mcp_tool_call"}}', // no tool/name/server field
      '{"type":"error"}', // missing message
      '{"type":"turn.failed"}', // missing error
      '{"type":"turn.failed","error":"not-an-object"}',
      '{"type":"turn.started"}', // known-real-but-unhandled type (codexRunner.ts:256)
      '{"type":"totally_unknown_type","payload":123}',
      '[1,2,3]', '"just a string"',
    ),
    fc.jsonValue({maxDepth: 2}).map(v => JSON.stringify(v)),
  )

  const codexMixedStreamArb = fc
    .array(fc.oneof(codexLineArb.map(obj => JSON.stringify(obj)), codexGarbageLineArb), {maxLength: 25})
    .chain(rawLines => {
      const fullText = rawLines.map(l => `${l}\n`).join('')
      return fc.record({fullText: fc.constant(fullText), cuts: cutsArb(fullText.length)})
    })

  it('never throws on garbage/malformed lines interleaved with valid ones, split at arbitrary points, and finish() always returns a well-shaped (non-null) result (codexRunner.ts:142-153, 259-303)', () => {
    fc.assert(
      fc.property(codexMixedStreamArb, ({fullText, cuts}) => {
        const events: RunEvent[] = []
        const parser = createCodexJsonlParser(e => events.push(e))
        for (const chunk of splitIntoChunks(fullText, cuts)) parser.feed(chunk)
        const result = parser.finish()
        expect(Array.isArray(events)).toBe(true)
        // Unlike the claude parser, codexRunner's finish() is documented to
        // have no "result line" sentinel at all (codexRunner.ts:151-152) —
        // its return type is unconditionally ParsedCodexResult, never null.
        expect(typeof result).toBe('object')
        expect(result).not.toBeNull()
        expect(typeof result.sawTurnCompleted).toBe('boolean')
        expect(typeof result.failed).toBe('boolean')
      }),
      fuzzParams(200),
    )
  })
})
