import { blockTypeRendererRegistration } from '@/components/renderer/BlockTypeBlockRenderer.js'
import { codeMirrorExtensionRendererRegistration } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { layoutRendererRegistration } from '@/components/renderer/LayoutRenderer.js'
import { missingDataRendererRegistration } from '@/components/renderer/MissingDataRenderer.js'
import { panelRendererRegistration } from '@/components/renderer/PanelRenderer.js'
import { propertySchemaRendererRegistration } from '@/components/renderer/PropertySchemaBlockRenderer.js'
import { topLevelRendererRegistration } from '@/components/renderer/TopLevelRenderer.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { definitionFanoutAppMountExtension } from '@/extensions/definitionFanoutAppMount.js'
import { blockRendererFacet, type BlockRendererRegistration } from '@/extensions/blockInteraction.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'

/**
 * Core's renderer ladder, weakest first. Precedence is the ranking — the
 * last registration that claims a block wins — so the numbers are the
 * whole story and are kept here rather than beside each component, where
 * you could not see what a renderer outranks.
 *
 * The plain block renderer sits at the implicit 0 and claims
 * unconditionally; everything above it self-gates. Plugins slot into the
 * same scale (breadcrumbs 10, media 5, the SRS deck and the recents page
 * 100), so a plugin renderer and a core one are ordered by one number
 * rather than by which layer registered them.
 *
 * An equal precedence is broken by registration order, so when two
 * renderers can claim ONE block the winner is whatever the extension graph
 * visits last. That is arbitrary and ACCEPTED, not an omission: the
 * registry this replaced broke the same tie by insertion order, equally
 * invisibly, so the only thing that can change is which arbitrary renderer
 * wins. Giving every theoretically-overlapping pair a distinct number is
 * O(pairs) of permanent weight that each new plugin has to honour, with
 * nothing able to enforce it — and the facet cannot detect the collision
 * for itself, since `combine` is handed values with the precedences already
 * applied and discarded.
 *
 * The two type editors differ by one anyway, because that pair is the one a
 * block might plausibly BE: both edit definition-shaped blocks, so carrying
 * `property-schema` and `block-type` at once is a composition someone could
 * attempt, and the schema editor is the one that always won it. The
 * marker-type page renderers (recents, SRS deck, Readwise backlog) sit at
 * 100 together and stay there: each marks a singleton kernel page that
 * `getOrCreateKernelPage` writes with exactly ONE marker, so no code path
 * produces a block two of them claim.
 */
export const coreRendererLadder: readonly (readonly [BlockRendererRegistration, number])[] = [
  [{id: 'default', label: 'Block', render: DefaultBlockRenderer}, 0],
  [missingDataRendererRegistration, 1],
  [codeMirrorExtensionRendererRegistration, 5],
  [panelRendererRegistration, 5],
  [topLevelRendererRegistration, 20],
  [layoutRendererRegistration, 20],
  [blockTypeRendererRegistration, 100],
  [propertySchemaRendererRegistration, 101],
]

export const defaultRenderersExtension = systemToggle({
  id: 'system:default-renderers',
  name: 'Default renderers',
  description: 'Block renderer registry and the fallback renderer used when no plugin claims a block.',
  essential: true,
}).of([
  // The type / property-schema renderers offer a delete button, and a big
  // enough delete opens a confirmation via `openDialog` — inert without
  // DialogHost mounted, which would leave the gesture waiting on a promise
  // nobody can resolve. The mount's `core.dialogs` id dedupes, so contributing
  // it from every extension that needs it registers DialogHost once.
  dialogAppMountExtension,
  // Same reasoning one step further on: the property-schema renderer's name
  // and type gestures OPEN a fan-out run once the user has agreed to wait for
  // one, and without this mount that run has nowhere to show. A confirmation
  // that promises progress and then shows none is worse than not asking.
  definitionFanoutAppMountExtension,
  markdownExtensionsFacet.of(gfmMarkdownExtension, {source: 'defaultRenderers'}),
  ...coreRendererLadder.map(([registration, precedence]) =>
    blockRendererFacet.of(registration, {precedence, source: 'defaultRenderers'}),
  ),
])
