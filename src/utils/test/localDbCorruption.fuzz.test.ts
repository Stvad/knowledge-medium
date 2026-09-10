// @vitest-environment node
/**
 * Fuzz suite for `src/utils/localDbCorruption.ts`'s corruption classifiers —
 * `isLocalDbCorruptionError`, `isRuntimeDbCorruptionError`, and the
 * `toLocalDbOpenError` wrapper built on top of them (`messageChainOf` is
 * exercised only indirectly — it isn't exported). See
 * `src/data/test/syncedTableWriteGuard.fuzz.test.ts` for the house style and
 * `docs/fuzzing.md` for tier mechanics / conventions.
 *
 * ──── Why this classifier matters (grounded in localDbCorruption.ts:1-12) ────
 *
 * These functions route a bootstrap DB-open failure toward a DESTRUCTIVE
 * recovery UI (Export + Reset) vs. a benign retry path. A false positive
 * wipes a healthy database (see the never-auto-wipe policy); a false
 * negative leaves a genuinely corrupt DB stuck without the recovery offer.
 * Both `isLocalDbCorruptionError` and the tighter `isRuntimeDbCorruptionError`
 * exist because of real incidents: the iPad OPFS corruption (#284) and the
 * risk of a server-controlled error body routing a healthy session into
 * reset (localDbCorruption.ts:35-48).
 *
 * ──── What the code actually does (grounded in localDbCorruption.ts) ────
 *
 * `messageChainOf` (:72-89) concatenates an error's `.message` down its
 * `.cause` chain, handling both real `Error` instances and worker-boundary
 * plain objects `{message, cause}` (Comlink-serialized errors cross with
 * `instanceof Error` false — :66-71, :80-86). A plain object whose
 * `.message` is NOT a string falls through to `String(error)` WITHOUT
 * recursing into its `.cause` (:80-88) — only the `Error` branch and the
 * plain-object-with-string-message branch continue the chain. The
 * recursion is bounded to `depth` calls (default 5, decremented
 * unconditionally on every call regardless of cause identity, :72-89) — so
 * it terminates even on a CYCLIC `.cause` graph.
 *
 * `isLocalDbCorruptionError` (:100-101) / `isRuntimeDbCorruptionError`
 * (:107-108) both lower-case the chained message and substring-match
 * against a fixed list — `CORRUPTION_SUBSTRINGS` (:25-33, 7 entries) for
 * the broad open-path matcher, `RUNTIME_CORRUPTION_SUBSTRINGS` (:45-48, 2
 * entries) for the tighter runtime matcher. Both runtime entries
 * ('sqlite call returned corrupt', 'disk image is malformed') are ALSO
 * present verbatim in the broader list — RUNTIME_CORRUPTION_SUBSTRINGS ⊆
 * CORRUPTION_SUBSTRINGS by direct comparison of the two literal arrays in
 * the source, not by running the matcher.
 *
 * The corruption list deliberately excludes the bare token `malformed`
 * (:18-20): only the two full SQLite phrasings `'disk image is malformed'`
 * and `'malformed database schema'` are listed, so a benign "malformed
 * URL/JSON/UTF-8" error elsewhere in the app must never match (pinned by
 * example in localDbCorruption.test.ts's "does NOT match a benign
 * 'malformed X'" case; this suite generalizes it).
 *
 * `toLocalDbOpenError` (:156-160) is a no-op passthrough on an
 * already-recognised, VALIDLY wrapped error (`corruptErrorUserId(error) !==
 * null`, :131-148 — requires a non-empty `userId`) — the first branch,
 * short-circuiting before any substring match — so it never double-wraps.
 * (An empty-`userId` wrapped error is deliberately NOT recognised as
 * already-wrapped per :132-137's doc comment, so it's excluded from the
 * idempotency generator below rather than treated as a counterexample.)
 *
 * ──── Generator design ────
 *
 * Ground truth is BY CONSTRUCTION. The "bare malformed" decoys are built
 * from a fixed vocabulary (`BENIGN_WORDS`) that excludes every word
 * appearing in any `CORRUPTION_SUBSTRINGS` entry ('database', 'disk',
 * 'image', 'schema', 'sqlite', 'corrupt', 'notadb', 'corruption'), and at
 * most ONE word from that excluded set is ever placed immediately adjacent
 * to "malformed" — never two adjacent forbidden words — so no generated
 * string can spell out `'disk image is malformed'` or `'malformed database
 * schema'` (each needs 3 or 2 forbidden words adjacent, in order) by
 * accident. The monotonicity property's guaranteed-positive cases embed a
 * `RUNTIME_CORRUPTION_SUBSTRINGS` phrase verbatim (case-randomized) copied
 * directly from the source (:46-47), at a chain depth proven reachable
 * (index < 5) by tracing `messageChainOf`'s recursion above — never by
 * checking what the matcher itself accepts.
 *
 * The totality property also feeds in HOSTILE conversion shapes — a
 * revoked `Proxy` and objects with a throwing `Symbol.toStringTag` getter
 * and/or throwing/non-callable `toString`/`valueOf` — because `safeString`
 * (the unexported fallback `messageOf`/`messageChainOf` reach for a
 * non-Error, non-string-message value) used to have a SECOND throw point:
 * `String(x)` throwing is caught, but the fallback
 * `Object.prototype.toString.call(x)` can throw too (a revoked Proxy's
 * `[[Get]]` trap throws for `Symbol.toStringTag` itself; a throwing
 * `Symbol.toStringTag` getter propagates the same way, and since there's
 * no own `toString`/`valueOf` it also makes `String(x)` resolve to the
 * inherited `Object.prototype.toString` and throw the SAME error first).
 * `hostileConversionArb`/`revokedProxyArb` below reproduce both shapes
 * (and non-callable-`toString`/`valueOf` variants) so the fixed-string
 * final fallback is exercised, not just asserted.
 *
 * A FOURTH hostile shape, `protoForwardingThrowingGetProxyArb`, targets a
 * DIFFERENT gap: a `Proxy` whose `getPrototypeOf` trap forwards to a real
 * `Error.prototype` (so `instanceof Error` / `safeInstanceOf(error, Error)`
 * SUCCEEDS, unlike a revoked proxy where `getPrototypeOf` itself throws and
 * `safeInstanceOf` fails closed before reaching the `Error` branch at all)
 * but whose `get` trap throws for every property, including `message` and
 * `cause`. That reaches the `Error` branch of `messageOf`/`messageChainOf`
 * and used to read `(error as Error).message` directly — past a
 * successful `instanceof` check — which still threw. The fix routes that
 * read through `safeGet` (localDbCorruption.ts:117-127) exactly like every other
 * property read on a not-necessarily-honest `error` in this module.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import {
  LocalDatabaseCorruptError,
  isLocalDbCorruptionError,
  isRuntimeDbCorruptionError,
  toLocalDbOpenError,
} from '@/utils/localDbCorruption'

// ──── shared building blocks ────

/** The two RUNTIME_CORRUPTION_SUBSTRINGS entries, copied verbatim from
 *  localDbCorruption.ts:46-47 — used only to construct GUARANTEED positive
 *  cases, never to check what the matcher accepts. */
const RUNTIME_PHRASES = ['sqlite call returned corrupt', 'disk image is malformed'] as const

/** Randomize per-character case on a fixed phrase — the matcher
 *  lower-cases the whole chained message before matching (:92), so this
 *  exercises that without changing which phrase is present. */
const randomCaseArb = (s: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map(bits =>
    [...s].map((c, i) => (bits[i] ? c.toUpperCase() : c.toLowerCase())).join(''),
  )

// ──── cause-chain construction (shared by totality + monotonicity) ────

type ChainKind = 'error' | 'plainWithMessage' | 'plainNoMessage' | 'primitiveMessage'

const chainKindArb: fc.Arbitrary<ChainKind> = fc.constantFrom(
  'error', 'plainWithMessage', 'plainNoMessage', 'primitiveMessage',
)

/** One node of a `.cause` chain, mirroring the shapes `messageChainOf`
 *  branches on (:74-88): a real `Error`, a worker-boundary plain object
 *  with a string `.message`, a plain object with NO `.message` at all, and
 *  a plain object whose `.message` is present but not a string (both of
 *  the latter two fall through to `String(error)` and stop recursing). */
function buildNode(kind: ChainKind, message: string, cause: unknown): unknown {
  switch (kind) {
    case 'error':
      return Object.assign(new Error(message), { cause })
    case 'plainWithMessage':
      return { message, cause }
    case 'plainNoMessage':
      return { cause }
    case 'primitiveMessage':
      return { message: message.length, cause }
  }
}

const leafArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.boolean(),
)

/** A `.cause` chain of 0-12 levels (deeper than the depth=5 bound), mixing
 *  all four node shapes and terminating in an arbitrary leaf (incl.
 *  primitives / null / undefined). Acyclic — see {@link cyclicChainArb} for
 *  the cyclic case. */
const deepChainArb: fc.Arbitrary<unknown> = fc.record({
  kinds: fc.array(chainKindArb, { maxLength: 12 }),
  messages: fc.array(fc.string({ maxLength: 30 }), { minLength: 12, maxLength: 12 }),
  leaf: leafArb,
}).map(({ kinds, messages, leaf }) => {
  let cause: unknown = leaf
  for (let i = kinds.length - 1; i >= 0; i--) {
    cause = buildNode(kinds[i], messages[i], cause)
  }
  return cause
})

/** Arbitrary values with no error-like shape at all: primitives,
 *  null/undefined, bigint, arrays, plain records. */
const primitiveArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.bigInt(),
  fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 }),
  fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 5 }), { maxKeys: 3 }),
)

/** A short `.cause` chain (length 1-4) whose LAST node's `.cause` points
 *  back into the chain (an earlier node, or itself when length is 1) —
 *  a manufactured CYCLIC graph. `messageChainOf`'s depth decrement is
 *  unconditional on cause identity (:72-89), so this must terminate
 *  rather than loop forever. */
const cyclicChainArb: fc.Arbitrary<unknown> = fc.record({
  length: fc.integer({ min: 1, max: 4 }),
  kinds: fc.array(fc.constantFrom<'error' | 'plain'>('error', 'plain'), { minLength: 4, maxLength: 4 }),
  messages: fc.array(fc.string({ maxLength: 20 }), { minLength: 4, maxLength: 4 }),
  cycleBackIndex: fc.nat({ max: 3 }),
}).map(({ length, kinds, messages, cycleBackIndex }) => {
  const nodes: unknown[] = []
  for (let i = 0; i < length; i++) {
    nodes.push(kinds[i] === 'error' ? new Error(messages[i]) : { message: messages[i] })
  }
  for (let i = 0; i < length - 1; i++) {
    (nodes[i] as { cause: unknown }).cause = nodes[i + 1]
  }
  ;(nodes[length - 1] as { cause: unknown }).cause = nodes[Math.min(cycleBackIndex, length - 1)]
  return nodes[0]
})

/** A revoked `Proxy`, wrapped in a one-element array — every `[[Get]]`/
 *  `[[Has]]` trap on a revoked proxy throws (TypeError), including for
 *  `toString`, `valueOf`, and `Symbol.toStringTag`. That makes BOTH
 *  `safeString`'s primary `String(x)` conversion AND its
 *  `Object.prototype.toString.call(x)` fallback throw.
 *
 *  The array wrapper isn't about the classifiers under test — it's so
 *  fast-check's OWN internals survive generating this value. Every
 *  arbitrary combinator (`map`, `oneof`, the tuple `fc.property` builds
 *  from its arguments) wraps its result in an internal `Value`, whose
 *  constructor eagerly does `Symbol.fastCheckClone in value` — an `in`
 *  check, which is itself a trap on a Proxy and throws for a REVOKED one,
 *  crashing fast-check's bookkeeping before our code ever runs. Wrapping
 *  the proxy in a plain array means every one of those internal checks
 *  lands on the (harmless) array; the raw proxy is unwrapped only inside
 *  the property body below, via a plain function call that never
 *  round-trips through fast-check's internals again. */
const revokedProxyArb: fc.Arbitrary<[unknown]> = fc.constant(undefined).map(() => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return [proxy] as [unknown]
})

type ConversionBehavior = 'default' | 'throws' | 'nonCallable'
const conversionBehaviorArb: fc.Arbitrary<ConversionBehavior> = fc.constantFrom(
  'default', 'throws', 'nonCallable',
)

/** An object with a randomized combination of hostile `toString`/`valueOf`/
 *  `Symbol.toStringTag` behaviors. A throwing `Symbol.toStringTag` getter
 *  alone is already enough to make BOTH `String(x)` (which resolves to the
 *  inherited `Object.prototype.toString` when there's no own
 *  `toString`/`valueOf`) and the explicit
 *  `Object.prototype.toString.call(x)` fallback throw — verified directly:
 *
 *    const o = {}; Object.defineProperty(o, Symbol.toStringTag, { get() { throw new Error() } })
 *    String(o)                          // throws
 *    Object.prototype.toString.call(o)  // throws too
 *
 *  This generator also crosses that with throwing/non-callable own
 *  `toString`/`valueOf` so `String(x)` can fail via a
 *  DIFFERENT path too (e.g. neither method is callable, so `ToPrimitive`
 *  itself throws "Cannot convert object to primitive value") while the tag
 *  getter independently breaks the fallback — a second, distinct way to
 *  reach `safeString`'s double-throw. */
const hostileConversionArb: fc.Arbitrary<unknown> = fc.record({
  toStringBehavior: conversionBehaviorArb,
  valueOfBehavior: conversionBehaviorArb,
  tagThrows: fc.boolean(),
  msg: fc.string({ maxLength: 20 }),
}).map(({ toStringBehavior, valueOfBehavior, tagThrows, msg }) => {
  const obj: Record<PropertyKey, unknown> = {}
  // `Object.defineProperty` (its descriptor `value` is untyped) rather than
  // plain assignment — `obj.toString = msg` fails to typecheck even though
  // `obj` is a `Record<PropertyKey, unknown>`: named-property access still
  // resolves through the inherited `Object.prototype.toString: () => string`
  // signature, not the index signature.
  if (toStringBehavior === 'throws') {
    Object.defineProperty(obj, 'toString', { value: () => { throw new Error(msg) }, configurable: true })
  } else if (toStringBehavior === 'nonCallable') {
    Object.defineProperty(obj, 'toString', { value: msg, configurable: true })
  }
  if (valueOfBehavior === 'throws') {
    Object.defineProperty(obj, 'valueOf', { value: () => { throw new Error(msg) }, configurable: true })
  } else if (valueOfBehavior === 'nonCallable') {
    Object.defineProperty(obj, 'valueOf', { value: msg, configurable: true })
  }
  if (tagThrows) {
    Object.defineProperty(obj, Symbol.toStringTag, { get() { throw new Error(msg) } })
  }
  return obj
})

/** A proxy that forwards `getPrototypeOf` to a REAL `Error.prototype` (so
 *  `instanceof Error` / `safeInstanceOf(error, Error)` SUCCEEDS) but
 *  throws from its `get` trap for every property, including `message` and
 *  `cause`. This is the shape a revoked proxy can't reach: a revoked
 *  proxy's `getPrototypeOf` throws too, so `safeInstanceOf` fails closed
 *  BEFORE the `Error` branch's direct property reads are ever exercised.
 *  Here `instanceof` genuinely succeeds and then a subsequent direct
 *  `.message`/`.cause` read (not routed through `safeGet`) would throw.
 *
 *  Array-wrapped for the same fast-check-internals reason as
 *  {@link revokedProxyArb} (see its doc comment) — this proxy only
 *  intercepts `get`/`getPrototypeOf` so fast-check's `in`-based
 *  bookkeeping wouldn't actually trip on it unwrapped, but wrapping keeps
 *  the pattern uniform and doesn't rely on that distinction holding. */
const protoForwardingThrowingGetProxyArb: fc.Arbitrary<[unknown]> = fc.constant(undefined).map(() => {
  const proxy = new Proxy({}, {
    getPrototypeOf: () => Error.prototype,
    get: () => { throw new Error('hostile get trap') },
  })
  return [proxy] as [unknown]
})

/** `hostileConversionArb`'s plain objects are safe for fast-check's
 *  internals to handle directly (an `in` check on a getter-bearing object
 *  reads property existence without invoking the getter) — only the
 *  revoked Proxy (and the proto-forwarding one) needs the array-wrapper
 *  trick. Wrapped here in the SAME one-element-array shape as
 *  {@link revokedProxyArb} purely so all three can share a single
 *  `fc.oneof` with one unwrap point in the property body. */
const hostileErrorArb: fc.Arbitrary<[unknown]> = fc.oneof(
  revokedProxyArb,
  protoForwardingThrowingGetProxyArb,
  hostileConversionArb.map(v => [v] as [unknown]),
)

// ──── totality ────

describe('totality — never throws for arbitrary error shapes (localDbCorruption.ts:69-191)', () => {
  it('isLocalDbCorruptionError / isRuntimeDbCorruptionError / toLocalDbOpenError never throw', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          deepChainArb.map(v => [v] as [unknown]),
          primitiveArb.map(v => [v] as [unknown]),
          hostileErrorArb,
        ),
        ([error]) => {
          expect(() => isLocalDbCorruptionError(error)).not.toThrow()
          expect(() => isRuntimeDbCorruptionError(error)).not.toThrow()
          expect(() => toLocalDbOpenError(error, 'user-1')).not.toThrow()
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('never throws for a revoked Proxy or a hostile toString/valueOf/Symbol.toStringTag shape (safeString\'s fallback, localDbCorruption.ts:69-79)', () => {
    fc.assert(
      fc.property(hostileErrorArb, ([error]) => {
        expect(() => isLocalDbCorruptionError(error)).not.toThrow()
        expect(() => isRuntimeDbCorruptionError(error)).not.toThrow()
        expect(() => toLocalDbOpenError(error, 'user-1')).not.toThrow()
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('never throws for a Proxy whose instanceof succeeds but whose get trap throws for message/cause (PR #447 review comment 3676752542, localDbCorruption.ts:117-127)', () => {
    fc.assert(
      fc.property(protoForwardingThrowingGetProxyArb, ([error]) => {
        expect(() => isLocalDbCorruptionError(error)).not.toThrow()
        expect(() => isRuntimeDbCorruptionError(error)).not.toThrow()
        expect(() => toLocalDbOpenError(error, 'user-1')).not.toThrow()
      }),
      fuzzParams(50),
    )
  }, fuzzTestTimeout())

  it('terminates on a manufactured CYCLIC .cause chain instead of hanging', () => {
    fc.assert(
      fc.property(cyclicChainArb, (error) => {
        expect(() => isLocalDbCorruptionError(error)).not.toThrow()
        expect(() => isRuntimeDbCorruptionError(error)).not.toThrow()
        expect(() => toLocalDbOpenError(error, 'user-1')).not.toThrow()
      }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())
})

// ──── monotonicity: isRuntimeDbCorruptionError(e) ⟹ isLocalDbCorruptionError(e) ────

/** Embeds a RUNTIME_CORRUPTION_SUBSTRINGS phrase, case-randomized, at chain
 *  level `depthIndex` (0-4 — all five reachable within the depth=5 bound,
 *  traced in the module docblock above), using only the two node kinds
 *  that continue `messageChainOf`'s recursion ('error' /
 *  'plainWithMessage'). Other levels carry arbitrary filler text. */
const runtimeCorruptionCaseArb: fc.Arbitrary<unknown> = fc.record({
  phrase: fc.constantFrom(...RUNTIME_PHRASES),
  depthIndex: fc.integer({ min: 0, max: 4 }),
  kinds: fc.array(fc.constantFrom<'error' | 'plainWithMessage'>('error', 'plainWithMessage'), { minLength: 5, maxLength: 5 }),
  fillerMessages: fc.array(fc.string({ maxLength: 15 }), { minLength: 5, maxLength: 5 }),
  prefix: fc.string({ maxLength: 10 }),
  suffix: fc.string({ maxLength: 10 }),
}).chain(({ phrase, depthIndex, kinds, fillerMessages, prefix, suffix }) =>
  randomCaseArb(phrase).map((cased) => {
    const messages = [...fillerMessages]
    messages[depthIndex] = `${prefix} ${cased} ${suffix}`
    let cause: unknown = undefined
    for (let i = 4; i >= 0; i--) {
      cause = kinds[i] === 'error'
        ? Object.assign(new Error(messages[i]), { cause })
        : { message: messages[i], cause }
    }
    return cause
  }),
)

describe('isRuntimeDbCorruptionError(e) ⟹ isLocalDbCorruptionError(e) — RUNTIME_CORRUPTION_SUBSTRINGS ⊆ CORRUPTION_SUBSTRINGS', () => {
  it('holds for arbitrary error shapes', () => {
    fc.assert(
      fc.property(fc.oneof(deepChainArb, primitiveArb, runtimeCorruptionCaseArb), (error) => {
        if (isRuntimeDbCorruptionError(error)) {
          expect(isLocalDbCorruptionError(error)).toBe(true)
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('holds — non-vacuously — for cases constructed to trigger the runtime matcher', () => {
    fc.assert(
      fc.property(runtimeCorruptionCaseArb, (error) => {
        // Sanity: the construction actually lands a runtime-positive case.
        expect(isRuntimeDbCorruptionError(error)).toBe(true)
        expect(isLocalDbCorruptionError(error)).toBe(true)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

// ──── bare "malformed" without the exact SQLite phrase never matches ────

/** Vocabulary deliberately EXCLUDING every word that appears in any
 *  CORRUPTION_SUBSTRINGS entry — see the module docblock above for the
 *  exact exclusion list and why it's sufficient. */
const BENIGN_WORDS = [
  'URL', 'JSON', 'input', 'response', 'UTF-8', 'data', 'request', 'config',
  'user', 'value', 'header', 'token', 'payload', 'query', 'path', 'record',
  'field', 'text', 'string', 'buffer', 'packet', 'document', 'session',
  'format', 'encoding', 'timestamp', 'version', 'checksum',
] as const

const benignWordArb = fc.constantFrom(...BENIGN_WORDS)

/** A single word taken from either forbidden phrase, placed AT MOST ONCE
 *  immediately adjacent to "malformed" on a given side — never two of
 *  these together, so neither phrase's required 2-word ('database
 *  schema') or 3-word ('disk image is') adjacent run can assemble. */
const optionalForbiddenWordArb = fc.constantFrom(
  undefined, 'disk', 'image', 'is', 'database', 'schema',
)

/** One decoy message: "malformed" (case-randomized, 1-2 occurrences) with
 *  benign filler words around it and at most one lone forbidden word
 *  immediately before/after — provably never spells `'disk image is
 *  malformed'` or `'malformed database schema'`. */
const malformedDecoyArb: fc.Arbitrary<string> = fc.record({
  malformedCased: randomCaseArb('malformed'),
  repeatCount: fc.integer({ min: 1, max: 2 }),
  before: fc.array(benignWordArb, { maxLength: 3 }),
  after: fc.array(benignWordArb, { maxLength: 3 }),
  wordRightBefore: optionalForbiddenWordArb,
  wordRightAfter: optionalForbiddenWordArb,
}).map(({ malformedCased, repeatCount, before, after, wordRightBefore, wordRightAfter }) => {
  const core = [
    ...(wordRightBefore ? [wordRightBefore] : []),
    ...Array(repeatCount).fill(malformedCased),
    ...(wordRightAfter ? [wordRightAfter] : []),
  ]
  return [...before, ...core, ...after].join(' ')
})

/** Wrap the decoy message as a plain top-level Error, or bury it behind a
 *  generic outer message via `.cause` — either way it must not match. */
const wrappedDecoyArb: fc.Arbitrary<unknown> = malformedDecoyArb.chain(msg =>
  fc.oneof(
    fc.constant(new Error(msg)),
    fc.constant(new Error('boot failed', { cause: new Error(msg) })),
    fc.constant({ message: msg }),
  ),
)

describe('bare "malformed" without the exact SQLite phrase never matches (localDbCorruption.ts:18-20, :25-33)', () => {
  it('rejects "malformed" embedded in text that never spells out the full forbidden phrase', () => {
    fc.assert(
      fc.property(wrappedDecoyArb, (error) => {
        expect(isLocalDbCorruptionError(error)).toBe(false)
        expect(isRuntimeDbCorruptionError(error)).toBe(false)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

// ──── toLocalDbOpenError — idempotent on an already-wrapped error ────

describe('toLocalDbOpenError — idempotent on an already-wrapped error (localDbCorruption.ts:156-160, :131-148)', () => {
  it('returns the SAME reference for a validly-wrapped LocalDatabaseCorruptError, regardless of the userId passed this time', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (userId, causeMessage, newUserId) => {
          const wrapped = new LocalDatabaseCorruptError(
            userId,
            causeMessage === undefined ? undefined : { cause: new Error(causeMessage) },
          )
          expect(toLocalDbOpenError(wrapped, newUserId)).toBe(wrapped)
        },
      ),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('also short-circuits on a structurally-equal lookalike across an instanceof boundary', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (userId, newUserId) => {
          const lookalike = { name: 'LocalDatabaseCorruptError', userId, message: 'x' }
          expect(toLocalDbOpenError(lookalike, newUserId)).toBe(lookalike)
        },
      ),
      fuzzParams(100),
    )
  }, fuzzTestTimeout())
})
