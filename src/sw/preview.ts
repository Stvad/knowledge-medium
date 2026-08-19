/**
 * PR-preview subtree gating. github.io is ONE origin for production
 * (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
 * production/root SW's scope is a PREFIX of every preview path, and since we
 * never `clients.claim()`, the production SW controls a freshly-opened preview
 * page until it reloads — and would otherwise cache the preview's shell +
 * assets under production's OWN keys, poisoning the offline production shell
 * with an unmerged build. So a SW refuses to serve/cache a preview subtree it
 * doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
 *
 * Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
 * directly and shared without dragging worker types.
 */
export const PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//

/**
 * True when this SW must NOT touch a request: the request targets a preview
 * subtree that this scope does not own. A preview-scoped SW (its own scope is
 * under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
 */
export const isForeignPreviewRequest = (
  ownScopeIsPreview: boolean,
  pathname: string,
): boolean => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname)
