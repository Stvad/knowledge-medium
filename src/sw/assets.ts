/**
 * Which same-origin runtime assets the service worker serves cache-first from
 * the generation cache. Kept globals-free (primitives in, boolean out — no
 * `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
 * tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
 * (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
 *
 * `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
 * extension; the SW ALSO serves cache-first by `request.destination` (below), so
 * strictly the served set is a superset of the precached set. That superset is
 * empty in practice — every emitted dist asset carries a recognized extension,
 * so a destination-matched request always also matches by extension and was
 * precached. Importing the ONE extension definition here (instead of duplicating
 * the literal in the build script and diffing it in a test) keeps the two in
 * lockstep on the axis the precache is actually built from; the invariant that
 * closes the gap is "every served asset has a recognized extension", which holds
 * for our own emitted output.
 */
export const ASSET_EXTENSION =
  /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/

// request.destination values that are always static build assets (module
// imports, modulepreload, stylesheets, the wasm-sqlite worker, fonts, images).
const ASSET_DESTINATIONS = new Set(['script', 'style', 'worker', 'font', 'image'])

/**
 * True for a same-origin request the SW serves cache-first within the
 * generation. Match by `request.destination` first (covers the common cases a
 * browser labels) with an extension fallback for anything left as an empty
 * destination.
 */
export const isCacheableAsset = (
  destination: string,
  pathname: string,
  sameOrigin: boolean,
): boolean =>
  sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname))
