// @vitest-environment happy-dom
/**
 * Ownership fuzz for `ActiveContextsProvider` + its single declarative
 * funnel `useActionContextActivations`. See `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics and `docs/fuzzing.md` for conventions.
 * happy-dom because the target is React lifecycle, not pure logic — the
 * whole point is to drive REAL commits (effect destroy/create ordering,
 * StrictMode double-invoke) rather than to model them.
 *
 * ──── What is under test ────
 *
 * `ActiveContextsProvider` keys its state by context TYPE
 * (`Map<ActionContextType, BaseShortcutDependencies>`, ActiveContexts.tsx:20)
 * and `deactivate(type)` deletes that key with no check of WHO is
 * releasing it (ActiveContexts.tsx:114-121). Every declarative surface
 * registers through one funnel whose effect activates on mount /
 * dep-change and deactivates on cleanup
 * (useActionContext.ts:37-49), so whenever two surfaces claim the same
 * type at once, one surface's cleanup can delete the OTHER's live claim
 * — and nothing re-registers it, because the survivor's effect deps
 * never changed. Symptom: nobody owns the context, so the keyboard goes
 * dead rather than misrouted (docs/activeContexts-ownership-bug.md).
 *
 * Concurrent same-type claims are not hypothetical in this codebase:
 *  - `PanelRenderer`'s `PanelMultiSelectActionContext` claims
 *    MULTI_SELECT_MODE per PANEL (PanelRenderer.tsx:46-69), so any
 *    multi-pane layout with a selection in two panes has two claimants.
 *  - `TopLevelRenderer` claims GLOBAL per layout root
 *    (TopLevelRenderer.tsx:25).
 *  - the video-player surface claims its context on both a parent and a
 *    descendant inside the same `videoPlayerBlockId` scope — the
 *    original report.
 *  - a host keeping several layout sessions mounted (perspective
 *    keep-alive) multiplies all of the above, which is what makes the
 *    swap routine rather than rare.
 *
 * ──── Model of a "suspended" surface ────
 *
 * A surface is suspended by resolving its activations to NOTHING, which
 * makes the funnel's effect deactivate what it owns and re-register when
 * suspension lifts. Here that is spelled with `enabled: false` on every
 * activation (the `.filter(a => a.enabled !== false)` at
 * useActionContext.ts:27) — the same empty-array state that the
 * `ShortcutSurfaceSuspensionContext` proposal (upstream #582) produces
 * from a React context. The hazard predates that PR; this suite targets
 * the funnel's own lifecycle, so it needs no code from it.
 *
 * ──── Oracles ────
 *
 * Map key ORDER is load-bearing downstream, so both properties check it
 * alongside ownership: `computeInstallableContexts` takes the LAST modal
 * in iteration order and `compareContexts` breaks priority ties by
 * activation recency (resolve.ts:69-78, 104-118). The previous attempt
 * at ownership tracking (commit `a7483fa`, reverted as `c2a47ab`) built
 * the visible map by iterating a per-type stack map, which orders types
 * by FIRST claim rather than most recent — the most plausible reading of
 * why that rollout "broke shortcuts in production", and the regression
 * class these order checks exist to pin.
 *
 * 1. `a live surface always owns the context it claims` — the
 *    settled-state invariant, deliberately stated over STATE and not
 *    over any particular interleaving: after a batch of
 *    mount/unmount/suspend/unsuspend/retarget/deps-churn ops has
 *    committed, for every context type at least one LIVE (mounted,
 *    unsuspended) surface claims, the active map has an entry, and that
 *    entry belongs to one of that type's live claimants — never absent,
 *    never a dead or suspended surface. Conversely no entry may survive
 *    for a type no live surface claims. Plus: key order must be
 *    non-decreasing in the step at which each VISIBLE claim was last
 *    registered (`ClaimStamps`/`stampStep`, derived on the driver's side
 *    from when each surface's memo inputs moved — it never consults the
 *    provider's own ordering).
 *
 * 2. `preserves activation-recency key order when claims never overlap` —
 *    behavioural compatibility, as an exact differential against an
 *    independent reference model of the PRE-EXISTING semantics
 *    ("(re)activation re-inserts at the end, deactivation deletes").
 *    Restricted to disjoint per-surface type sets and one op per commit,
 *    where no ownership question arises at all — so it passes against
 *    the code as it stood before the ownership fix (verified when this
 *    suite first went red on property 1 alone), which is what makes it a
 *    compatibility pin rather than a restatement of the new code.
 */
import { StrictMode, useEffect, useMemo, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'

const FAKE_UI_STATE_BLOCK = {id: 'ui-state-block'}

vi.mock('@/data/globalState.ts', () => ({
  useUIStateBlock: () => FAKE_UI_STATE_BLOCK,
}))

const {
  ActiveContextsProvider,
  useActiveContextsState,
} = await import('@/shortcuts/ActiveContexts.js')
const {useActionContextActivations} = await import('@/shortcuts/useActionContext.js')
const {actionContextsFacet} = await import('@/extensions/core.js')
const {resolveFacetRuntimeSync} = await import('@/facets/facet.js')
const {AppRuntimeContextProvider} = await import('@/extensions/runtimeContext.js')

type ActiveContextsMap = ReturnType<typeof useActiveContextsState>
type ActionContextType = string
type SurfaceDeps = {surfaceId: string; nonce: number}

/** Context types the generated surfaces claim. One is `modal` so the
 *  order oracle covers the modal-recency path resolve.ts depends on. */
const CONTEXT_TYPES = ['fuzz-ctx-a', 'fuzz-ctx-b', 'fuzz-ctx-c'] as const

/** Counts trips through the provider's validate step, which is on the
 *  `claim` path and nothing else — so it counts CLAIMS, and lets the
 *  canary below prove the StrictMode arm really double-invokes rather
 *  than merely being switched on. */
let claimCount = 0

const runtime = resolveFacetRuntimeSync(
  CONTEXT_TYPES.map((type, index) => actionContextsFacet.of({
    type,
    displayName: type,
    modal: index === 2,
    validateDependencies: (deps: unknown): deps is never => {
      claimCount += 1
      return typeof deps === 'object' && deps !== null && 'surfaceId' in deps
    },
  })),
)

// ─── harness components ───────────────────────────────────────────────

interface SurfaceState {
  readonly id: string
  readonly mounted: boolean
  readonly suspended: boolean
  /** Bumped to churn dependency identity without changing anything else —
   *  the "transient prop-change re-run of the activation effect" shape. */
  readonly nonce: number
  readonly types: readonly ActionContextType[]
}

function Surface({id, types, suspended, nonce}: Omit<SurfaceState, 'mounted'>) {
  const activations = useMemo(
    () => types.map(context => ({
      context,
      dependencies: {surfaceId: id, nonce} as unknown as Record<string, unknown>,
      enabled: !suspended,
    })),
    [types, id, nonce, suspended],
  )
  useActionContextActivations(activations)
  return null
}

function Observer({sinkRef}: {sinkRef: {current: ActiveContextsMap}}) {
  const active = useActiveContextsState()
  useEffect(() => {
    sinkRef.current = active
  }, [active, sinkRef])
  return null
}

function Harness(
  {surfaces, sinkRef}: {
    surfaces: readonly SurfaceState[]
    sinkRef: {current: ActiveContextsMap}
  },
) {
  return (
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <Observer sinkRef={sinkRef}/>
        {/* Fixed tree positions: an unmounted surface renders nothing in
            place rather than being filtered out, so sibling order (and
            hence React's effect order) stays stable across ops. */}
        {surfaces.map(surface => surface.mounted
          ? <Surface
            key={surface.id}
            id={surface.id}
            types={surface.types}
            suspended={surface.suspended}
            nonce={surface.nonce}
          />
          : <Nothing key={surface.id}/>)}
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  )
}

const Nothing = () => null

/**
 * StrictMode has to sit at the RENDER ROOT to do anything: React 19 gates
 * the mount/unmount/remount double-invoke of passive effects on the root's
 * strict flag, so a `<StrictMode>` returned from INSIDE a component renders
 * its subtree perfectly normally. Measured in this exact setup — nested: 1
 * effect run, root: 2 — and pinned by the non-vacuity canary at the bottom
 * of this file, because the vacuous version looks identical from the
 * outside: the flag is generated, the cases run, nothing is exercised.
 */
const mount = (
  strict: boolean,
  surfaces: readonly SurfaceState[],
  sinkRef: {current: ActiveContextsMap},
): ReactNode => {
  const tree: ReactNode = <Harness surfaces={surfaces} sinkRef={sinkRef}/>
  return strict ? <StrictMode>{tree}</StrictMode> : tree
}

// ─── generators ───────────────────────────────────────────────────────

/** Type arrays are interned so a surface's `useMemo` keeps identity when
 *  its claim set didn't change — otherwise every parent re-render would
 *  re-run every effect and the generated op would not be the only thing
 *  the commit does. */
const typeSetCache = new Map<string, readonly ActionContextType[]>()
const internTypes = (types: readonly ActionContextType[]): readonly ActionContextType[] => {
  const key = types.join('|')
  const hit = typeSetCache.get(key)
  if (hit) return hit
  typeSetCache.set(key, types)
  return types
}

type Op =
  | {kind: 'mount' | 'unmount' | 'suspend' | 'unsuspend' | 'bump'; surface: number}
  | {kind: 'retarget'; surface: number; types: readonly ActionContextType[]}

const applyOp = (surfaces: readonly SurfaceState[], op: Op): readonly SurfaceState[] =>
  surfaces.map((surface, index) => {
    if (index !== op.surface) return surface
    switch (op.kind) {
      case 'mount': return {...surface, mounted: true}
      case 'unmount': return {...surface, mounted: false}
      case 'suspend': return {...surface, suspended: true}
      case 'unsuspend': return {...surface, suspended: false}
      case 'bump': return {...surface, nonce: surface.nonce + 1}
      case 'retarget': return {...surface, types: internTypes(op.types)}
    }
  })

const typeSetArb = (pool: readonly ActionContextType[]) =>
  fc.uniqueArray(fc.constantFrom(...pool), {minLength: 1, maxLength: Math.min(2, pool.length)})
    .map(internTypes)

const opArb = (surfaceCount: number, pool: readonly ActionContextType[]) => fc.oneof(
  {arbitrary: fc.record({
    kind: fc.constantFrom('mount' as const, 'unmount' as const, 'suspend' as const,
      'unsuspend' as const, 'bump' as const),
    surface: fc.nat({max: surfaceCount - 1}),
  }), weight: 5},
  {arbitrary: fc.record({
    kind: fc.constant('retarget' as const),
    surface: fc.nat({max: surfaceCount - 1}),
    types: typeSetArb(pool),
  }), weight: 1},
)

/** The specific shape the hazard was inferred from: one surface goes
 *  dark while a sibling comes live IN THE SAME COMMIT. Generated
 *  explicitly (rather than hoping a random pair of ops lands together)
 *  and mixed with free-form batches so fast-check still explores. */
const swapStepArb = (surfaceCount: number) => fc
  .tuple(fc.nat({max: surfaceCount - 1}), fc.nat({max: surfaceCount - 1}))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): readonly Op[] => [
    {kind: 'suspend', surface: a},
    {kind: 'unsuspend', surface: b},
  ])

const stepArb = (surfaceCount: number, pool: readonly ActionContextType[]) => fc.oneof(
  {arbitrary: fc.array(opArb(surfaceCount, pool), {minLength: 1, maxLength: 3}), weight: 3},
  {arbitrary: swapStepArb(surfaceCount), weight: 2},
)

// ─── oracles ──────────────────────────────────────────────────────────

const depsOf = (active: ActiveContextsMap, type: ActionContextType): SurfaceDeps | undefined =>
  active.get(type) as unknown as SurfaceDeps | undefined

const ownerOf = (active: ActiveContextsMap, type: ActionContextType): string | undefined =>
  depsOf(active, type)?.surfaceId

/** Types each LIVE surface claims → the set of surfaces entitled to own them. */
const liveClaims = (surfaces: readonly SurfaceState[]): Map<ActionContextType, Set<string>> => {
  const claims = new Map<ActionContextType, Set<string>>()
  for (const surface of surfaces) {
    if (!surface.mounted || surface.suspended) continue
    for (const type of surface.types) {
      const owners = claims.get(type) ?? new Set<string>()
      owners.add(surface.id)
      claims.set(type, owners)
    }
  }
  return claims
}

/**
 * Step at which each (surface, type) claim was last (re-)registered, tracked
 * from the DRIVER's side — a surface's funnel effect re-runs exactly when one
 * of its memo inputs moves (useActionContext.ts:26-35), and re-running means
 * releasing every token it held and claiming fresh ones. Independent of how
 * the provider stores order, which is what makes it usable as an oracle.
 */
type ClaimStamps = Map<string, number>
const stampKey = (surfaceId: string, type: ActionContextType) => `${surfaceId} | ${type}`

const stampStep = (
  stamps: ClaimStamps,
  before: readonly SurfaceState[],
  after: readonly SurfaceState[],
  step: number,
) => {
  after.forEach((surface, index) => {
    const previous = before[index]
    const rerun = previous === undefined || previous.mounted !== surface.mounted ||
      previous.suspended !== surface.suspended || previous.nonce !== surface.nonce ||
      previous.types !== surface.types
    if (!rerun || !surface.mounted || surface.suspended) return
    for (const type of surface.types) stamps.set(stampKey(surface.id, type), step)
  })
}

const checkOwnership = (
  active: ActiveContextsMap,
  surfaces: readonly SurfaceState[],
  stamps: ClaimStamps,
  trace: readonly string[],
) => {
  const claims = liveClaims(surfaces)
  const context = () => JSON.stringify({
    trace,
    surfaces: surfaces.map(s => ({...s, types: [...s.types]})),
    active: [...active.keys()].map(type => [type, ownerOf(active, type)]),
  })

  const byId = new Map(surfaces.map(surface => [surface.id, surface]))

  for (const [type, owners] of claims) {
    expect(active.has(type), `no entry for live-claimed ${type} — ${context()}`).toBe(true)
    expect([...owners], `entry for ${type} owned by a non-live surface — ${context()}`)
      .toContain(ownerOf(active, type))
  }
  for (const type of active.keys()) {
    expect(claims.has(type), `stale entry for unclaimed ${type} — ${context()}`).toBe(true)
    // The visible entry must carry the owner's CURRENT dependencies, not an
    // older claim of its own left behind on the stack. A live surface
    // re-claims on every memo-input change, so anything but the current
    // nonce means a superseded claim of the SAME surface resurfaced — the
    // leak "Things to check on the next attempt" #1 warns about, which the
    // owner-identity check above cannot see.
    const deps = depsOf(active, type)
    expect(deps?.nonce, `stale deps for ${type} (owner re-claimed since) — ${context()}`)
      .toBe(byId.get(deps?.surfaceId ?? '')?.nonce)
  }

  // Key order = activation recency of the VISIBLE claim. resolve.ts reads it
  // (last modal in iteration order wins; recency breaks priority ties), and
  // it is what the previous ownership attempt got wrong by iterating a
  // per-type stack map, which orders types by their FIRST claim. Stated at
  // step granularity — ties are fine, an inversion is not.
  const stampsInKeyOrder = [...active.keys()].map(type => {
    const owner = ownerOf(active, type)
    const stamp = owner === undefined ? undefined : stamps.get(stampKey(owner, type))
    expect(stamp, `no recorded claim for ${owner} on ${type} — ${context()}`).toBeDefined()
    return stamp as number
  })
  expect(
    [...stampsInKeyOrder].sort((a, b) => a - b),
    `key order is not activation-recency order (${stampsInKeyOrder.join(',')}) — ${context()}`,
  ).toEqual(stampsInKeyOrder)
}

// ─── properties ───────────────────────────────────────────────────────

const initialSurfaces = (
  count: number,
  typesFor: (index: number) => readonly ActionContextType[],
): readonly SurfaceState[] =>
  Array.from({length: count}, (_, index) => ({
    id: `s${index}`,
    mounted: true,
    suspended: false,
    nonce: 0,
    types: internTypes(typesFor(index)),
  }))

describe('ActiveContexts ownership under surface lifecycle churn', () => {
  afterEach(cleanup)

  it('a live surface always owns the context it claims', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 2, max: 4}),
        fc.boolean(),
        // Always four claim sets; `surfaceCount` picks how many are used, so
        // shrinking the count doesn't reshuffle the rest of the case.
        fc.array(typeSetArb(CONTEXT_TYPES), {minLength: 4, maxLength: 4}),
        fc.array(stepArb(4, CONTEXT_TYPES), {minLength: 1, maxLength: 8}),
        (surfaceCount, strict, initialTypes, steps) => {
          let surfaces = initialSurfaces(surfaceCount, index => initialTypes[index])
          const sinkRef = {current: new Map() as ActiveContextsMap}
          const stamps: ClaimStamps = new Map()
          const trace: string[] = []

          stampStep(stamps, [], surfaces, 0)
          const view = render(mount(strict, surfaces, sinkRef))
          try {
            checkOwnership(sinkRef.current, surfaces, stamps, trace)

            steps.forEach((step, index) => {
              const applicable = step.filter(op => op.surface < surfaceCount)
              if (!applicable.length) return
              const before = surfaces
              for (const op of applicable) surfaces = applyOp(surfaces, op)
              stampStep(stamps, before, surfaces, index + 1)
              trace.push(applicable.map(op => `${op.kind}:${op.surface}`).join('+'))

              const committed = surfaces
              act(() => {
                view.rerender(mount(strict, committed, sinkRef))
              })
              checkOwnership(sinkRef.current, surfaces, stamps, trace)
            })
          } finally {
            cleanup()
          }
        },
      ),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())

  it('preserves activation-recency key order when claims never overlap', () => {
    // Disjoint claim sets: surface i owns exactly CONTEXT_TYPES[i], so no
    // two surfaces ever contend and the expected map is unambiguous —
    // exactly the shape today's by-type deactivate handles correctly, and
    // therefore the compatibility surface an ownership fix must not move.
    const surfaceCount = CONTEXT_TYPES.length
    fc.assert(
      fc.property(
        fc.array(opArb(surfaceCount, CONTEXT_TYPES).filter(op => op.kind !== 'retarget'),
          {minLength: 1, maxLength: 10}),
        ops => {
          let surfaces = initialSurfaces(surfaceCount, index => [CONTEXT_TYPES[index]])
          const sinkRef = {current: new Map() as ActiveContextsMap}
          // Reference model of the CURRENT semantics: an activation
          // (re-)inserts its types at the end; a deactivation deletes them.
          const model = new Map<ActionContextType, string>()
          const isLive = (s: SurfaceState) => s.mounted && !s.suspended
          const applyToModel = (before: SurfaceState, after: SurfaceState) => {
            // React runs the effect's destroy before its create, and the
            // effect re-runs whenever any of the memo inputs move.
            const changed = before.mounted !== after.mounted ||
              before.suspended !== after.suspended || before.nonce !== after.nonce
            if (!changed) return
            if (isLive(before)) for (const type of before.types) model.delete(type)
            if (isLive(after)) {
              for (const type of after.types) {
                model.delete(type)
                model.set(type, after.id)
              }
            }
          }

          const view = render(mount(false, surfaces, sinkRef))
          try {
            for (const surface of surfaces) applyToModel({...surface, mounted: false}, surface)
            expect([...sinkRef.current.keys()].map(t => [t, ownerOf(sinkRef.current, t)]))
              .toEqual([...model.entries()].map(([t, id]) => [t, id]))

            for (const op of ops) {
              const before = surfaces[op.surface]
              surfaces = applyOp(surfaces, op)
              applyToModel(before, surfaces[op.surface])

              const committed = surfaces
              act(() => {
                view.rerender(mount(false, committed, sinkRef))
              })
              expect(
                [...sinkRef.current.keys()].map(t => [t, ownerOf(sinkRef.current, t)]),
                `after ${op.kind}:${op.surface}`,
              ).toEqual([...model.entries()].map(([t, id]) => [t, id]))
            }
          } finally {
            cleanup()
          }
        },
      ),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())

  it('non-vacuity: the StrictMode arm really double-invokes the funnel effect', () => {
    // The `strict` flag above is only worth generating if switching it on
    // actually exercises React's mount/unmount/remount of passive effects —
    // otherwise half the cases are silently the same as the other half, and
    // the double-invoke hazard "Things to check on the next attempt" #4
    // names would go untested while looking covered.
    const surfaces = initialSurfaces(1, () => [CONTEXT_TYPES[0]])
    const sinkRef = {current: new Map() as ActiveContextsMap}

    claimCount = 0
    render(mount(false, surfaces, sinkRef))
    const plain = claimCount
    cleanup()

    claimCount = 0
    render(mount(true, surfaces, sinkRef))
    const strict = claimCount
    cleanup()

    expect(plain).toBe(1)
    expect(strict).toBe(2)
  })
})
