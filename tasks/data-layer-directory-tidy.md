# Follow-up: data-layer directory tidy (post-Phase 2)

**Status**: deferred. Schedule after Phase 2 lands so we can settle the layout
once `HandleStore` + handle factories + invalidation engine exist and the full
import graph is visible.

## Why this is needed

Two distinct things ended up under `src/data/internals/` during Phase 1, which
makes the directory look like a transitional artifact:

1. **Genuine internals** (intended permanent home per spec §5):
   `txEngine`, `commitPipeline`, `processorRunner`, `kernelMutators`,
   `kernelQueries`, `treeQueries`, `undoManager`, `parseReferencesProcessor`,
   `targets`, `txSnapshots`, `orderKey`, `facets`, `kernelDataExtension`,
   `coreProperties`, `clientSchema`.

2. **Files parked here to avoid colliding with the legacy data layer**
   (collision reason gone after commit fa28e65 deleted the legacy):
   `block.ts`, `repo.ts`. The header comment in `internals/block.ts` admits it:
   "The legacy `Block` class at `src/data/block.ts` stays in place until
   stage 1.6 sweeps the call sites…".

Top-level `src/data/` is a mixed bag with no clear convention:
- Internal-feeling: `blockCache.ts`, `blockSchema.ts`, `properties.ts`,
  `workspaceSchema.ts`.
- Host-facing facades / domain helpers: `dailyNotes.ts`, `globalState.ts`,
  `workspaces.ts`, `repoProvider.ts`.

## Proposed end-state

- `src/data/api/` — public interfaces consumed by plugins (`Handle`,
  `BlockData`, `Mutator`, `Query`, `PropertySchema`, …). Unchanged.
- `src/data/internals/` — all kernel / engine implementation. Move in:
  `blockCache.ts`, `blockSchema.ts`, `properties.ts`, `workspaceSchema.ts`.
  Plus whatever Phase 2 added (`handleStore.ts`, etc.) which already lands
  here.
- `src/data/` top-level — only host-facing facade modules:
  `repoProvider.ts`, `globalState.ts`, `dailyNotes.ts`, `workspaces.ts`.
  (Optionally move these to `src/data/host/` for symmetry — decide once we
  see the import graph after the move.)

## Work shape

Pure-rename PR. Mechanical, easy to review.

- Move files; update imports across the repo (tsserver / sed / IDE refactor).
- Run `tsc -b`, `vitest run`, `eslint`. No behavior changes.
- One commit, one PR.

## When to do it

After Phase 2 ships and is reviewed. Reasons for that ordering:

- Phase 2 adds new files and reshapes the import graph; doing the tidy
  beforehand would create churn we'd partly redo.
- Mixing rename noise with Phase 2's behavior changes would obscure the
  actual logic in review.
- A dedicated tidy commit is trivially reviewable on its own.

## Out of scope for this note

- The `api/` boundary itself (which exports become public to plugins) —
  that's settled in spec §5 and not under question here.
- Renaming any classes / interfaces — this is purely about file location.
