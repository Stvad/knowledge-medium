// @vitest-environment node
/**
 * Fuzz suite for the fail-closed E2EE-downgrade gate in
 * `src/sync/keys/workspaceAccess.ts` — `resolveWorkspaceAccess` (the pure
 * policy, workspaceAccess.ts:33-46) and `decideWorkspaceEntry` (the
 * row-replication-aware wrapper, workspaceAccess.ts:76-84). See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * ──── Contract, grounded at the call sites ────
 *
 * The module docblock (workspaceAccess.ts:10-24) documents the full
 * decision table for `resolveWorkspaceAccess(pin, serverEncryptionMode,
 * hasKey)`:
 *
 *   pin 'e2ee' + hasKey                → ready
 *   pin 'e2ee' + !hasKey               → locked: key-required
 *   pin 'plaintext' + server 'e2ee'    → locked: server-e2ee (converted in place)
 *   pin 'plaintext' + server !== 'e2ee' → ready
 *   pin null  + server 'e2ee'          → locked: server-e2ee (trust e2ee, fail closed)
 *   pin null  + server !== 'e2ee'      → locked: quarantine (never trust a "none" claim)
 *
 * The branch implementing this does a strict `=== 'e2ee'` string comparison
 * against `serverEncryptionMode`, which is untrusted server input ("untrusted,
 * but safe-in-one-direction"). That strict-equality comparison is exactly the
 * fail-closed property this suite is aimed at: every `serverEncryptionMode`
 * value that ISN'T the exact string `'e2ee'` — including near-miss casing,
 * whitespace, unicode homoglyphs, or empty/absent values — must quarantine an
 * unpinned workspace, never silently pass it as plaintext-safe and never
 * silently unlock; and only the exact string may make a pin stricter than it is. Hence the generator
 * below is weighted toward `fc.string({unit: 'binary'})` (arbitrary
 * unicode, including the empty string and long strings) rather than just
 * the two literals the existing example-based tests
 * (`workspaceAccess.test.ts`) already cover. `unit: 'binary'` is explicit
 * because fast-check 4.9's `fc.string()` defaults to `unit: 'grapheme-ascii'`
 * (printable ASCII only) — an unqualified call here would silently drop
 * the "unicode homoglyphs" case this docblock claims to cover.
 *
 * `decideWorkspaceEntry(pin, hasKey, row)` adds one more gate in front: when
 * the local `workspaces` row hasn't replicated yet (`row === null`) AND the pin
 * alone doesn't settle it (`canDecideWithoutRow`: only an e2ee pin with its
 * key does), it must return `{kind: 'waiting'}`
 * rather than falling through to `resolveWorkspaceAccess` with a guessed
 * server mode — the documented reason (workspaceAccess.ts:66-74) is that
 * proceeding here could bootstrap plaintext into a possibly-encrypted
 * workspace. When it DOES decide (row present, or the pin alone settles
 * it), the result must agree with `resolveWorkspaceAccess` fed the row's
 * `encryptionMode` (defaulting to `'none'` for a settled-without-row
 * decision, matching line 83's `row?.encryptionMode ?? 'none'`) — this
 * uses the independently-verified `resolveWorkspaceAccess` properties
 * below as a differential model for the wrapper, rather than restating its
 * branch structure.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import type { ModePin } from './modePin'
import { decideWorkspaceEntry, resolveWorkspaceAccess, type WorkspaceModeRow } from './workspaceAccess'

// ──── generators ────

/** pin ∈ {null, 'plaintext', 'e2ee'} — the full domain of `ModePin | null`. */
const pinArb: fc.Arbitrary<ModePin | null> = fc.constantFrom<ModePin | null>(null, 'plaintext', 'e2ee')

/** serverEncryptionMode: weighted toward the two literals the real server
 *  actually sends ('e2ee' / 'none'), but mostly arbitrary strings —
 *  unicode, empty, long — since the strict `=== 'e2ee'` comparison is the
 *  property under test and an adversarial/corrupted server value is exactly
 *  the case the fail-closed gate exists for. `unit: 'binary'` (full Unicode
 *  code-point range, excluding lone surrogates) rather than the default
 *  `'grapheme-ascii'`, so this actually reaches non-ASCII near-misses of
 *  `'e2ee'` (e.g. homoglyphs), not just printable ASCII. */
const serverEncryptionModeArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom('e2ee', 'none') },
  { weight: 1, arbitrary: fc.string({ maxLength: 500, unit: 'binary' }) },
  // Near-misses on the exact literal, to press on strict equality specifically.
  { weight: 1, arbitrary: fc.constantFrom('E2EE', 'e2ee ', ' e2ee', 'e2ee\x00', 'E2ee', '') },
)

const hasKeyArb: fc.Arbitrary<boolean> = fc.boolean()

const accessCaseArb = fc.record({
  pin: pinArb,
  serverEncryptionMode: serverEncryptionModeArb,
  hasKey: hasKeyArb,
})

describe('resolveWorkspaceAccess (workspaceAccess.ts:33-46)', () => {
  it('never throws on any pin × server-mode × hasKey combination', () => {
    fc.assert(
      fc.property(accessCaseArb, ({ pin, serverEncryptionMode, hasKey }) => {
        expect(() => resolveWorkspaceAccess(pin, serverEncryptionMode, hasKey)).not.toThrow()
      }),
      fuzzParams(300),
    )
  })

  it("pin 'plaintext' is ready unless the server says exactly 'e2ee', which gates it as server-e2ee — key irrelevant", () => {
    fc.assert(
      fc.property(serverEncryptionModeArb, hasKeyArb, (serverEncryptionMode, hasKey) => {
        expect(resolveWorkspaceAccess('plaintext', serverEncryptionMode, hasKey)).toEqual(
          serverEncryptionMode === 'e2ee' ? { kind: 'locked', reason: 'server-e2ee' } : { kind: 'ready' },
        )
      }),
      fuzzParams(200),
    )
  })

  it("pin 'e2ee' is ready iff hasKey, and locked key-required otherwise — server mode never consulted", () => {
    fc.assert(
      fc.property(serverEncryptionModeArb, hasKeyArb, (serverEncryptionMode, hasKey) => {
        const result = resolveWorkspaceAccess('e2ee', serverEncryptionMode, hasKey)
        if (hasKey) {
          expect(result).toEqual({ kind: 'ready' })
        } else {
          expect(result).toEqual({ kind: 'locked', reason: 'key-required' })
        }
      }),
      fuzzParams(200),
    )
  })

  it("pin null (unpinned) is NEVER ready; reason is 'server-e2ee' iff serverEncryptionMode === 'e2ee' exactly, else 'quarantine'", () => {
    fc.assert(
      fc.property(serverEncryptionModeArb, hasKeyArb, (serverEncryptionMode, hasKey) => {
        const result = resolveWorkspaceAccess(null, serverEncryptionMode, hasKey)
        expect(result.kind).toBe('locked')
        if (result.kind === 'locked') {
          expect(result.reason).toBe(serverEncryptionMode === 'e2ee' ? 'server-e2ee' : 'quarantine')
        }
        // hasKey is irrelevant on the unpinned path (only pin/server decide it) —
        // pin null never trusts a locally-cached key it hasn't validated yet.
        expect(resolveWorkspaceAccess(null, serverEncryptionMode, !hasKey)).toEqual(result)
      }),
      fuzzParams(200),
    )
  })
})

// ──── decideWorkspaceEntry ────

const rowArb: fc.Arbitrary<WorkspaceModeRow | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 2,
    arbitrary: serverEncryptionModeArb.map((encryptionMode): WorkspaceModeRow => ({ encryptionMode })),
  },
)

const entryCaseArb = fc.record({
  pin: pinArb,
  hasKey: hasKeyArb,
  row: rowArb,
})

describe('decideWorkspaceEntry (workspaceAccess.ts:76-84)', () => {
  it('never throws', () => {
    fc.assert(
      fc.property(entryCaseArb, ({ pin, hasKey, row }) => {
        expect(() => decideWorkspaceEntry(pin, hasKey, row)).not.toThrow()
      }),
      fuzzParams(300),
    )
  })

  it("waits iff the row is missing AND the pin alone can't decide (only e2ee+hasKey can)", () => {
    fc.assert(
      fc.property(entryCaseArb, ({ pin, hasKey, row }) => {
        const canDecideWithoutRow = pin === 'e2ee' && hasKey
        const result = decideWorkspaceEntry(pin, hasKey, row)
        const shouldWait = !canDecideWithoutRow && row === null
        expect(result.kind === 'waiting').toBe(shouldWait)
      }),
      fuzzParams(300),
    )
  })

  it('when it decides (does not wait), the result matches resolveWorkspaceAccess fed the row (or the documented "none" default) — differential against the already-verified pure policy (workspaceAccess.ts:83)', () => {
    fc.assert(
      fc.property(entryCaseArb, ({ pin, hasKey, row }) => {
        const result = decideWorkspaceEntry(pin, hasKey, row)
        if (result.kind === 'waiting') return // covered by the previous property
        const expected = resolveWorkspaceAccess(pin, row?.encryptionMode ?? 'none', hasKey)
        expect(result).toEqual(expected)
      }),
      fuzzParams(300),
    )
  })

  it("only pin 'e2ee'+hasKey decides immediately with row === null; a plaintext pin waits", () => {
    fc.assert(
      fc.property(hasKeyArb, (hasKey) => {
        expect(decideWorkspaceEntry('e2ee', true, null)).toEqual({ kind: 'ready' })
        expect(decideWorkspaceEntry('plaintext', hasKey, null)).toEqual({ kind: 'waiting' })
      }),
      fuzzParams(20),
    )
  })
})
