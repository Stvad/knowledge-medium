// @vitest-environment node
/**
 * Fuzz suite for `keysetPages` (`pages.ts`), the one way a conversion reads a
 * whole workspace: a row it skipped would never be sealed, a row it yielded
 * twice would be sealed twice.
 *
 * Each case is a server holding rows `1..n` that caps every response at
 * `cap` rows (PostgREST's cap: a page may be short before the end) and a
 * script of failures for successive reads — retryable ones, statement
 * timeouts, and refusals. The oracles read the trace of reads and yields,
 * not the paging loop:
 *
 * - Yields concatenate to a strictly ascending PREFIX of the rows (nothing
 *   skipped, nothing twice), no page is empty, and none exceeds the limit it
 *   was read with or the cap.
 * - Every read is by cursor: `after` is `first` or the last row yielded.
 * - Every limit is in `[1, pageSize]`; a timeout at limit L > 1 is re-read
 *   at ceil(L / 2) ("read again in halves"), and a page read at L is followed
 *   by a read at min(pageSize, 2L) ("grows back").
 * - It throws exactly when the last read was a refusal, or the fourth
 *   retryable failure since the last page arrived (a timeout at limit 1 can
 *   shrink no further, so it counts as one: 57014 with a 5xx classifies
 *   transient). What it throws is that read's own error. Every earlier
 *   retryable failure of that page waited 1s, 2s, 4s in turn.
 * - Otherwise it completes having yielded every row (every row up to `done`'s
 *   cursor, when one is given — reading past it within the last page is
 *   allowed).
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { keysetPages } from './pages.js'

type Event = 'ok' | 'retryable' | 'timeout' | 'refusal'

const failure = (code: string | undefined, status: number) =>
  Object.assign(new Error(`failed (${code ?? status})`), {code, status})

/** Failures `classifyUploadError` reads as transient (RETRYABLE), and as
 *  permanent or ambiguous (REFUSAL), which `keysetPages` does not retry. */
const RETRYABLE = [() => failure(undefined, 0), () => failure(undefined, 503), () => failure(undefined, 429), () => failure('PGRST301', 401)]
const REFUSAL = [() => failure('42501', 401), () => failure(undefined, 400), () => failure('PGRST116', 406)]
const TIMEOUT = () => failure('57014', 500)

const eventArb = fc.oneof(
  {arbitrary: fc.constant<Event>('ok'), weight: 4},
  {arbitrary: fc.constant<Event>('retryable'), weight: 3},
  {arbitrary: fc.constant<Event>('timeout'), weight: 3},
  {arbitrary: fc.constant<Event>('refusal'), weight: 1},
)

const caseArb = fc.record({
  n: fc.nat({max: 30}),
  pageSize: fc.integer({min: 1, max: 9}),
  cap: fc.integer({min: 1, max: 10}),
  // Bursts, so a page meets four retryable failures in a row often enough.
  script: fc
    .array(fc.tuple(eventArb, fc.nat(), fc.integer({min: 1, max: 5})), {maxLength: 10})
    .map(bursts => bursts.flatMap(([event, pick, times]) =>
      Array.from({length: times}, (_, i): [Event, number] => [event, pick + i]))),
  doneAt: fc.option(fc.nat({max: 32}), {nil: undefined}),
})

interface Read {
  after: number
  limit: number
  event: Event
  error: Error | null
  returned: number[]
}

describe('keysetPages', () => {
  it('yields every row once, in order, through retries, timeouts and short pages', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({n, pageSize, cap, script, doneAt}) => {
        const rows = Array.from({length: n}, (_, i) => i + 1)
        const reads: Read[] = []
        const sleeps: number[] = []
        const read = async (after: number, limit: number) => {
          // Bounds a paging loop that stopped advancing; the trace oracle
          // below then fails on the repeated cursor.
          if (reads.length > 500) throw new Error('runaway')
          const [event, pick] = script[reads.length] ?? ['ok', 0]
          const error = event === 'retryable' ? RETRYABLE[pick % RETRYABLE.length]()
            : event === 'refusal' ? REFUSAL[pick % REFUSAL.length]()
              : event === 'timeout' ? TIMEOUT()
                : null
          const returned = error ? [] : rows.filter(id => id > after).slice(0, Math.min(limit, cap))
          reads.push({after, limit, event, error, returned})
          if (error) throw error
          return returned.map(id => ({id}))
        }

        const pages: number[][] = []
        let thrown: unknown = null
        try {
          for await (const page of keysetPages({
            read,
            first: 0,
            cursorOf: row => row.id,
            pageSize,
            done: doneAt === undefined ? undefined : after => after >= doneAt,
            sleep: async ms => { sleeps.push(ms) },
          })) pages.push(page.map(row => row.id))
        } catch (error) {
          thrown = error
        }

        const yielded = pages.flat()
        expect(yielded).toEqual(rows.slice(0, yielded.length))
        for (const page of pages) {
          expect(page.length).toBeGreaterThan(0)
          expect(page.length).toBeLessThanOrEqual(Math.min(pageSize, cap))
        }

        // Walk the trace: cursor, limit and retry discipline per read.
        let cursor = 0
        let retryable = 0
        const expectedSleeps: number[] = []
        reads.forEach((r, i) => {
          expect(r.after).toBe(cursor)
          // Nothing is read past a cursor `done` called the last.
          if (doneAt !== undefined) expect(r.after).toBeLessThan(doneAt)
          expect(r.limit).toBeGreaterThanOrEqual(1)
          expect(r.limit).toBeLessThanOrEqual(pageSize)
          const next = reads[i + 1]
          if (r.error === null) {
            retryable = 0
            if (r.returned.length > 0) cursor = r.returned[r.returned.length - 1]
            if (next) expect(next.limit).toBe(Math.min(pageSize, r.limit * 2))
            return
          }
          if (r.event === 'timeout' && r.limit > 1) {
            if (next) expect(next.limit).toBe(Math.ceil(r.limit / 2))
            return
          }
          if (r.event === 'refusal') {
            expect(next).toBeUndefined()
            return
          }
          retryable++
          if (retryable === 4) expect(next).toBeUndefined()
          if (next) {
            expectedSleeps.push(1000 * 2 ** (retryable - 1))
            expect(next.limit).toBe(r.limit)
          }
        })
        expect(sleeps).toEqual(expectedSleeps)

        const last = reads.at(-1)
        const fatal = last !== undefined && last.error !== null &&
          (last.event === 'refusal' || retryable === 4)
        if (fatal) {
          expect(thrown).toBe(last.error)
          return
        }
        expect(thrown).toBeNull()
        // A failed read that is not fatal is always followed by another read.
        expect(last?.error ?? null).toBeNull()
        if (doneAt === undefined) {
          expect(yielded).toEqual(rows)
        } else {
          expect(yielded).toEqual(rows.slice(0, Math.max(yielded.length, Math.min(doneAt, n))))
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
