import {useMemo} from 'react'
import {html} from '@codemirror/lang-html'
import {BlockEditor} from '@/components/BlockEditor.js'
import {ReferenceLink} from '@/components/references/ReferenceLink.tsx'
import {useRepo} from '@/context/repo'
import {EXTENSION_TYPE} from '@/data/blockTypes'
import {useInEditMode} from '@/data/globalState.js'
import type {
  BlockContentRendererContribution,
  BlockLayout,
  BlockLayoutContribution,
} from '@/extensions/blockInteraction.js'
import {defineVariant} from '@/facets/variantFacet.js'
import {useContent} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'
import {BLOCK_EDITOR_BASIC_SETUP, createSourceEditorConfig} from '@/utils/codemirror.js'
import {HTML_DOCUMENT_TYPE} from './blockType.ts'
import {HtmlFrame} from './HtmlFrame.tsx'
import {sourceEditingKeys} from './sourceEditing.ts'

/** The strip above the frame is the app's own, drawn where a document cannot
 *  reach: it marks what is sandboxed, and it is the click target for editing,
 *  since clicks inside the frame never reach the block. Not a button: a plain
 *  click on it falls through to the block's own click-to-edit. */
const HtmlDocumentView = ({block}: BlockRendererProps) => {
  const source = useContent(block)
  const repo = useRepo()
  return (
    <div className="w-full overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground select-none">
        <span>HTML document (sandboxed)</span>
        {!repo.isReadOnly && <span>Edit source</span>}
      </div>
      <HtmlFrame source={source}/>
    </div>
  )
}

const HtmlSourceEditor = ({block}: BlockRendererProps) => {
  // Auto-closing doubles every closing tag typed by hand. Source stays as written.
  const extensions = useMemo(() => [...createSourceEditorConfig(html({autoCloseTags: false})), sourceEditingKeys], [])
  return (
    <BlockEditor
      block={block}
      extensions={extensions}
      className="w-full rounded-md border border-border"
      basicSetup={BLOCK_EDITOR_BASIC_SETUP}
      indentWithTab={false}
    />
  )
}

/** Picks at render time so the variant's identity stays stable across edit-mode
 *  toggles (see `plain-outliner/interactions.tsx`). Leaving the editor restarts
 *  the document, which picks up the edit. */
const HtmlDocumentContent: BlockRenderer = props =>
  useInEditMode(props.block.id)
    ? <HtmlSourceEditor {...props}/>
    : <HtmlDocumentView {...props}/>
HtmlDocumentContent.displayName = 'HtmlDocumentContent'

/** An extension's source is what its reviewer reads before trusting it, so a
 *  block that is also an extension stays in the extension viewer: tagging one
 *  must not swap that for a page of the tagger's choosing. */
export const htmlDocumentContentContribution: BlockContentRendererContribution = ctx =>
  ctx.types.includes(HTML_DOCUMENT_TYPE) && !ctx.types.includes(EXTENSION_TYPE)
    ? defineVariant('html-document.frame', 'HTML document', HtmlDocumentContent)
    : null

const HtmlDocumentReference: BlockLayout = ({block}) => (
  <ReferenceLink block={block}>HTML document</ReferenceLink>
)

/** A `((id))` citation reads the block's raw content, which here would drop the
 *  whole source into a line of text. An embed still gets the frame. */
export const htmlDocumentReferenceLayout: BlockLayoutContribution = ctx =>
  ctx.blockContext?.isReference && ctx.types.includes(HTML_DOCUMENT_TYPE)
    ? {id: 'html-document.reference', label: 'HTML document reference', render: HtmlDocumentReference}
    : null
